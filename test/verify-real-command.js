'use strict';
/** Verify the exact command from the user's screenshot is now AUTO-approved, with no waiting. */
const { spawn } = require('child_process');
const path = require('path');

const CMD = 'cd "F:/workspace/two/gridborn_tool/策划表格" && PYTHONIOENCODING=utf-8 python -c "import sys; print(1)" 2>&1';
const BUDGET_MS = 5000;

const started = Date.now();
const hook = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'hook.js')]);
let out = '';
hook.stdout.on('data', c => (out += c));
hook.on('close', () => {
  const elapsed = Date.now() - started;
  const d = JSON.parse(out).hookSpecificOutput;
  console.log('hook 决定:', d.permissionDecision, '|', d.permissionDecisionReason);
  console.log('耗时:', elapsed + 'ms');
  const ok = d.permissionDecision === 'allow'
    && /auto-/.test(d.permissionDecisionReason)
    && elapsed < BUDGET_MS;
  console.log(ok ? '✔ 截图中的命令现在直接自动审批，无需任何点击和等待' : '✘ 未自动审批或耗时过长');
  process.exit(ok ? 0 : 1);
});
hook.stdin.end(JSON.stringify({
  session_id: 'verify-real', cwd: 'F:/workspace/two/gridborn_tool',
  tool_name: 'Bash', tool_input: { command: CMD }
}));
setTimeout(() => { console.error(`✘ 超时（超过 ${BUDGET_MS}ms —— 判定应该纯本地、立即返回）`); process.exit(1); }, BUDGET_MS + 2000);
