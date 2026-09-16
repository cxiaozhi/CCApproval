'use strict';
/** Verify the exact command from the user's screenshot now routes to remote approval. */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const secret = fs.readFileSync(path.join(os.homedir(), '.ccapproval', 'secret'), 'utf8').trim();
const CMD = 'cd "F:/workspace/two/gridborn_tool/策划表格" && PYTHONIOENCODING=utf-8 python -c "import sys; print(1)" 2>&1';

const hook = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'hook.js')]);
let out = '';
hook.stdout.on('data', c => (out += c));
hook.on('close', () => {
  const d = JSON.parse(out).hookSpecificOutput;
  console.log('hook 最终决定:', d.permissionDecision, '|', d.permissionDecisionReason);
  process.exit(d.permissionDecision === 'allow' && /approved remotely/.test(d.permissionDecisionReason) ? 0 : 1);
});
hook.stdin.end(JSON.stringify({
  session_id: 'verify-real', cwd: 'F:/workspace/two/gridborn_tool',
  tool_name: 'Bash', tool_input: { command: CMD }
}));

// poll for the pending request and approve it (simulating 手机点批准)
const iv = setInterval(() => {
  http.get(`http://127.0.0.1:4317/api/requests?t=${secret}`, res => {
    let b = ''; res.on('data', c => (b += c));
    res.on('end', () => {
      const p = (JSON.parse(b).pending || []).find(x => x.sessionId === 'verify-real');
      if (!p) return;
      clearInterval(iv);
      console.log('✔ 已进入远程审批队列:', p.summary.slice(0, 50) + '…');
      const payload = JSON.stringify({ id: p.id, action: 'allow' });
      const r = http.request({
        host: '127.0.0.1', port: 4317, path: `/api/decide?t=${secret}`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, res2 => res2.resume());
      r.end(payload);
    });
  }).on('error', () => { /* server starting */ });
}, 500);
setTimeout(() => { clearInterval(iv); console.error('✘ 超时'); process.exit(1); }, 30000);
