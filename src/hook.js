#!/usr/bin/env node
'use strict';
/**
 * CCApproval hook for Claude Code: PreToolUse, on every tool call. Registered in
 * .claude/settings.json (see install.js).
 *
 * Claude Code pipes a JSON payload on stdin ({ session_id, cwd, tool_name,
 * tool_input, ... }) and expects a decision on stdout:
 *   { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *       permissionDecision: 'allow'|'ask', permissionDecisionReason: '...' } }
 *
 * Everything is local: evaluate the policy, answer, append one audit line.
 * No server, no network, no waiting. Two outcomes only — calls on the escalate
 * whitelist are handed back to Claude Code's own prompt, everything else is
 * auto-approved; nothing is refused outright. This project never asks a human
 * itself.
 *
 * `node hook.js permission` is a tombstone, kept because an earlier install
 * registered this same script on PermissionRequest. Answering on that event is what
 * made Claude Desktop flash a dialog per call — it renders the dialog when the event
 * fires, then the answer withdraws it — so this mode stays answering nothing. A
 * registration left in some other settings file must not be able to bring it back.
 */
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { evaluate, summarize } = require('./policy');
const { redactString, redactValue } = require('./redact');

const STALE_PERMISSION_MODE = process.argv[2] === 'permission';

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
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${redactString(msg)}\n`); } catch { /* ignore */ }
}

/** Trim for size, then mask anything credential-shaped before it is persisted. */
function auditInput(input) {
  return redactValue(trimInput(input));
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

  // A stale registration on PermissionRequest (see the header). Say nothing, and write
  // no *audit* row: the call already has its PreToolUse row, and a second one per call
  // would make the panel unreadable. A line still goes to hook.log, because "that event
  // fired for this call" is the one thing only this path can witness — the app renders
  // the dialog on it, and the answer decides whether the dialog flashes (allow) or stays
  // put (silence). Seeing these lines at all means a registration is still live.
  if (STALE_PERMISSION_MODE) {
    log(`permission event (stale registration) :: ${summarize(payload.tool_name || '?', payload.tool_input || {}).slice(0, 200)}`);
    return;
  }

  // A payload we could not parse has no tool_name — broken stdin, truncated JSON,
  // or a schema we don't know. Guessing 'allow' there would auto-approve whatever
  // Claude Code was about to run, so fail closed instead.
  if (!payload.tool_name) {
    log('unreadable payload — failing closed');
    return answer('ask', 'ccapproval: unreadable hook payload — asking directly');
  }

  const toolName = payload.tool_name;
  const toolInput = payload.tool_input || {};
  const summary = summarize(toolName, toolInput);

  const { verdict, reason, source } = evaluate(toolName, toolInput, cfg.rules);
  log(`${toolName} → ${verdict} (${reason}) :: ${summary.slice(0, 200)}`);

  // One audit line per call, whatever the outcome. `escalated` is the row that
  // shows which whitelisted calls went to Claude Code's own prompt.
  const audit = (status, note, src = source) => store.record({
    id: store.newId(), status,
    toolName, toolInput: auditInput(toolInput), summary: redactString(summary),
    reason: note, verdict, source: src,
    cwd: payload.cwd, sessionId: payload.session_id
  });

  if (verdict === 'escalate') {
    audit('escalated', reason);
    return answer('ask', `ccapproval: handing to Claude Code — ${reason}`);
  }
  audit('auto-approved', reason);
  return answer('allow', `ccapproval auto-allow: ${reason}`);
})().catch(e => {
  log('fatal: ' + (e.stack || e.message));
  // never block the user on hook failure: anything we cannot judge gets asked
  if (STALE_PERMISSION_MODE) return;
  answer('ask', 'ccapproval hook error — asking directly');
});
