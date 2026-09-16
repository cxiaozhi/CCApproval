'use strict';
/**
 * End-to-end: start server on a test port, simulate hook → remote approve.
 */
const { spawn, execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 14399;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapproval-test-'));
const env = {
  ...process.env,
  CCAPPROVAL_PORT: String(PORT),
  CCAPPROVAL_TIMEOUT_MS: '15000',
  CCAPPROVAL_FALLBACK: 'ask',
  CCAPPROVAL_REMOTE_ACTION: 'remote',   // exercise the human-approval flow in this test
  CCAPPROVAL_DATA_DIR: dataDir,
  HOME: os.homedir()
};

function post(port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

function runHook(toolInput, envOverride) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'hook.js')], { env: { ...env, ...envOverride } });
    let out = '';
    child.stdout.on('data', c => (out += c));
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('hook output: ' + out)); } });
    child.stdin.end(JSON.stringify({
      session_id: 'test-session', cwd: process.cwd(),
      tool_name: toolInput.tool, tool_input: toolInput.input
    }));
    // approve via API as soon as the request appears
    const iv = setInterval(async () => {
      try {
        const secret = fs.readFileSync(path.join(dataDir, 'secret'), 'utf8').trim();
        const r = await get(PORT, '/api/requests?t=' + secret);
        const pending = JSON.parse(r.body).pending || [];
        const mine = pending.find(x => x.sessionId === 'test-session');
        if (mine) {
          clearInterval(iv);
          await post(PORT, '/api/decide?t=' + secret, { id: mine.id, action: 'allow' });
        }
      } catch { /* server not up yet */ }
    }, 400);
    setTimeout(() => clearInterval(iv), 20000).unref();
  });
}

(async () => {
  // 1. policy-only path (no server needed): safe command auto-allowed
  const safe = await runHook({ tool: 'Bash', input: { command: 'git status' } });
  console.assert(safe.hookSpecificOutput.permissionDecision === 'allow', 'safe cmd should auto-allow');
  console.log('✔ auto-allow path');

  // 2. remote path: server should be auto-spawned by hook; we approve via API
  const risky = await runHook({ tool: 'Bash', input: { command: 'rm -rf build-output' } });
  console.assert(risky.hookSpecificOutput.permissionDecision === 'allow', 'remote-approved should allow');
  console.assert(/approved remotely/.test(risky.hookSpecificOutput.permissionDecisionReason), 'reason');
  console.log('✔ remote approve path');

  // 3. deny path
  const denied = await runHook({ tool: 'Bash', input: { command: 'rm -rf /' } });
  console.assert(denied.hookSpecificOutput.permissionDecision === 'deny', 'policy deny');
  console.log('✔ policy deny path');

  // 4. fully-automatic mode (the default): dangerous ops auto-approve, no server needed
  const auto = await runHook(
    { tool: 'Bash', input: { command: 'git push origin master' } },
    { CCAPPROVAL_REMOTE_ACTION: 'allow', CCAPPROVAL_PORT: '14999' } // port with no server: must NOT hang
  );
  console.assert(auto.hookSpecificOutput.permissionDecision === 'allow', 'dangerous op should auto-allow');
  console.assert(/dangerous op/.test(auto.hookSpecificOutput.permissionDecisionReason), 'reason');
  console.log('✔ fully-automatic mode (git push auto-approved)');

  process.exit(0);
})().catch(e => { console.error('✘ e2e failed:', e.message); process.exit(1); });
