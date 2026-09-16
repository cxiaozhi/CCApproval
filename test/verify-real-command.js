'use strict';
/** Verify the exact command from the user's screenshot is now AUTO-approved. */
const { spawn } = require('child_process');
const path = require('path');

const CMD = 'cd "F:/workspace/two/gridborn_tool/策划表格" && PYTHONIOENCODING=utf-8 python -c "import sys; print(1)" 2>&1';

const hook = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'hook.js')]);
let out = '';
hook.stdout.on('data', c => (out += c));
hook.on('close', () => {
  const d = JSON.parse(out).hookSpecificOutput;
  console.log('hook 决定:', d.permissionDecision, '|', d.permissionDecisionReason);
  const ok = d.permissionDecision === 'allow' && /auto-/.test(d.permissionDecisionReason);
  console.log(ok ? '✔ 截图中的命令现在直接自动放行，无需任何点击' : '✘ 未自动放行');
  process.exit(ok ? 0 : 1);
});
hook.stdin.end(JSON.stringify({
  session_id: 'verify-real', cwd: 'F:/workspace/two/gridborn_tool',
  tool_name: 'Bash', tool_input: { command: CMD }
}));
setTimeout(() => { console.error('✘ 超时（不应等待远程审批）'); process.exit(1); }, 10000);
