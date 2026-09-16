#!/usr/bin/env node
'use strict';
/**
 * CCApproval PreToolUse hook for Claude Code.
 *
 * Register in .claude/settings.json (see install.js). Claude Code pipes a JSON
 * payload on stdin:
 *   { session_id, cwd, tool_name, tool_input, ... }
 * and expects a JSON decision on stdout:
 *   { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *       permissionDecision: 'allow'|'deny'|'ask',
 *       permissionDecisionReason: '...', updatedInput?: {...} } }
 *
 * Flow:
 *   1. evaluate policy locally
 *   2. allow/deny → answer immediately
 *   3. remote → (re)start server if needed, POST request, poll decision file,
 *      on timeout fall back to cfg.fallback (default 'ask' = normal CC prompt)
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { evaluate, summarize } = require('./policy');

const cfg = loadConfig();
const store = new Store(cfg.dataDir, cfg.historyLimit);
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

function pingServer() {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: cfg.port, path: '/api/requests', method: 'GET',
      headers: { Authorization: `Bearer ${cfg.secret}` }, timeout: 1500
    }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function ensureServer() {
  if (await pingServer()) return true;
  log('server not running — spawning detached');
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    detached: true,
    stdio: ['ignore', fs.openSync(path.join(cfg.dataDir, 'server.out.log'), 'a'), fs.openSync(path.join(cfg.dataDir, 'server.err.log'), 'a')],
    windowsHide: true
  });
  child.unref();
  // wait for it to come up
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (await pingServer()) return true;
  }
  return false;
}

function postRequest(record) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(record);
    const req = http.request({
      host: '127.0.0.1', port: cfg.port, path: '/api/requests', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000
    }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('bad response: ' + body)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function waitForDecision(id) {
  const deadline = Date.now() + cfg.timeoutMs;
  while (Date.now() < deadline) {
    const d = store.getDecision(id);
    if (d) return d;
    await new Promise(r => setTimeout(r, cfg.pollMs));
  }
  return null;
}

(async () => {
  const payload = await readStdin();
  const toolName = payload.tool_name || '';
  const toolInput = payload.tool_input || {};
  const summary = summarize(toolName, toolInput);

  const { verdict, reason } = evaluate(toolName, toolInput, cfg.rules, cfg.unmatchedDefault);
  log(`${toolName} → ${verdict} (${reason}) :: ${summary.slice(0, 200)}`);

  if (verdict === 'allow' || verdict === 'deny') {
    // record locally so the dashboard 最近记录 shows auto decisions too
    try {
      const rec = store.createRequest({
        toolName, toolInput: trimInput(toolInput), summary, reason,
        cwd: payload.cwd, sessionId: payload.session_id
      });
      store.markStatus(rec.id, verdict === 'allow' ? 'auto-approved' : 'policy-denied', { reason });
    } catch { /* auditing must never block the decision */ }
    if (verdict === 'allow') return answer('allow', `ccapproval auto-allow: ${reason}`);
    return answer('deny', `ccapproval policy deny: ${reason}`);
  }

  // remote approval
  const record = {
    toolName, toolInput, summary, reason,
    cwd: payload.cwd, sessionId: payload.session_id,
    transcriptPath: payload.transcript_path
  };

  let id = null;
  try {
    if (await ensureServer()) {
      const res = await postRequest(record);
      id = res.id;
    } else {
      log('server unavailable — falling back');
    }
  } catch (e) {
    log('request post failed: ' + e.message);
  }

  if (!id) {
    return answer(cfg.fallback, `ccapproval server unreachable — ${cfg.fallback}`);
  }

  log(`waiting for remote decision on ${id} (timeout ${cfg.timeoutMs}ms)`);
  const decision = await waitForDecision(id);

  if (!decision) {
    store.markStatus(id, 'timeout');
    return answer(cfg.fallback, `ccapproval: no response within ${Math.round(cfg.timeoutMs / 1000)}s — ${cfg.fallback}`);
  }
  if (decision.action === 'allow') {
    return answer('allow', `ccapproval: approved remotely${decision.reason ? ' (' + decision.reason + ')' : ''}`, decision.updatedInput);
  }
  return answer('deny', `ccapproval: denied remotely${decision.reason ? ' (' + decision.reason + ')' : ''}`);
})().catch(e => {
  log('fatal: ' + (e.stack || e.message));
  // never block the user on hook failure
  answer('ask', 'ccapproval hook error — asking user directly');
});
