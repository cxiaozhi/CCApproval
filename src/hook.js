#!/usr/bin/env node
'use strict';
/**
 * CCApproval hook for Claude Code. Two modes, both registered in
 * .claude/settings.json (see install.js):
 *
 *   node hook.js              PreToolUse — every tool call
 *   node hook.js permission   PermissionRequest — scoped to ExitPlanMode
 *
 * Claude Code pipes a JSON payload on stdin ({ session_id, cwd, tool_name,
 * tool_input, ... }) and expects a decision on stdout:
 *   PreToolUse        { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *                         permissionDecision: 'allow'|'deny'|'ask',
 *                         permissionDecisionReason: '...' } }
 *   PermissionRequest { hookSpecificOutput: { hookEventName: 'PermissionRequest',
 *                         decision: { behavior: 'allow'|'deny' } } }
 *
 * Everything is local: evaluate the policy, answer, append one audit line.
 * No server, no network, no waiting. A call the policy can't settle is handed
 * back to Claude Code's own permission prompt via 'ask' — this project never
 * asks a human itself.
 */
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { evaluate, summarize } = require('./policy');

const MODE = process.argv[2] === 'permission' ? 'permission' : 'preToolUse';

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const LOG = path.join(cfg.dataDir, 'hook.log');

/** Trim oversized tool_input before persisting (audit records stay small). */
function trimInput(input) {
  try {
    if (JSON.stringify(input).length <= 4000) return input;
    const out = {};
    for (const [k, v] of Object.entries(input || {})) {
      out[k] = typeof v === 'string' && v.length > 1000 ? v.slice(0, 1000) + `…[truncated ${v.length} chars]` : v;
    }
    return out;
  } catch { return {}; }
}

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

function answer(decision, reason, updatedInput) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  };
  if (updatedInput && decision === 'allow') out.hookSpecificOutput.updatedInput = updatedInput;
  process.stdout.write(JSON.stringify(out));
}

/** PermissionRequest events answer with a decision object instead of a permissionDecision. */
function permissionAnswer(behavior) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } }
  }));
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => (data += c));
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    setTimeout(() => resolve({}), 5000).unref(); // don't hang forever on broken stdin
  });
}

(async () => {
  const payload = await readStdin();

  // A payload we could not parse has no tool_name — broken stdin, truncated JSON,
  // or a schema we don't know. Guessing 'allow' there would auto-approve whatever
  // Claude Code was about to run, so fail closed instead.
  if (!payload.tool_name) {
    log('unreadable payload — failing closed');
    if (MODE === 'permission') return; // no output → Claude Code shows its own prompt
    return answer('ask', 'ccapproval: unreadable hook payload — asking directly');
  }

  // PermissionRequest. The matcher scopes this entry to ExitPlanMode, so approval
  // is unconditional: a plan is a proposal, not an action, and the tool calls that
  // actually mutate anything still go through the policy engine below.
  if (MODE === 'permission') {
    const toolName = payload.tool_name;
    const toolInput = payload.tool_input || {};
    log(`${toolName} → plan auto-accepted (PermissionRequest)`);
    store.record({
      id: store.newId(), status: 'auto-approved',
      toolName, toolInput: trimInput(toolInput), summary: summarize(toolName, toolInput),
      reason: 'plan proposal auto-accepted', verdict: 'allow', source: 'planMode',
      cwd: payload.cwd, sessionId: payload.session_id
    });
    return permissionAnswer('allow');
  }

  const toolName = payload.tool_name || '';
  const toolInput = payload.tool_input || {};
  const summary = summarize(toolName, toolInput);

  const { verdict, reason, source } = evaluate(toolName, toolInput, cfg.rules, cfg.unmatchedDefault);
  log(`${toolName} → ${verdict} (${reason}) :: ${summary.slice(0, 200)}`);

  // One audit line per call, whatever the outcome. `escalated` is the row that
  // shows what the policy gave up on and Claude Code had to prompt for.
  const audit = (status, note, src = source) => store.record({
    id: store.newId(), status,
    toolName, toolInput: trimInput(toolInput), summary,
    reason: note, verdict, source: src,
    cwd: payload.cwd, sessionId: payload.session_id
  });

  if (verdict === 'deny') {
    audit('policy-denied', reason);
    return answer('deny', `ccapproval policy deny: ${reason}`);
  }
  if (verdict === 'allow') {
    audit('auto-approved', reason);
    return answer('allow', `ccapproval auto-allow: ${reason}`);
  }

  // verdict === 'ask', reached three ways:
  //   your own `ask` rule matched      → always hand over (explicit config beats the switch)
  //   a built-in dangerous pattern     → dangerousDefault decides
  //   nothing matched, unmatchedDefault === 'ask' → always hand over
  if (source === 'builtin' && cfg.dangerousDefault === 'allow') {
    log(`${toolName} dangerous op auto-approved (${reason})`);
    audit('auto-approved', `dangerous op auto-approved: ${reason}`, 'dangerousDefault');
    return answer('allow', `ccapproval auto-allow (dangerous op): ${reason}`);
  }
  audit('escalated', reason);
  return answer('ask', `ccapproval: handing to Claude Code — ${reason}`);
})().catch(e => {
  log('fatal: ' + (e.stack || e.message));
  // never block the user on hook failure: PreToolUse falls back to 'ask',
  // PermissionRequest emits nothing so Claude Code shows its own prompt
  if (MODE === 'permission') return;
  answer('ask', 'ccapproval hook error — asking directly');
});
