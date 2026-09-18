'use strict';
/**
 * End-to-end: drive the hook directly off stdin. No server is involved any more —
 * the policy decides, the hook answers, and one audit line is appended.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapproval-e2e-'));
const BUDGET_MS = 5000;
let failures = 0;

function check(label, cond, detail = '') {
  if (cond) { console.log('✔ ' + label); return; }
  failures++;
  console.error('✘ ' + label + (detail ? ' — ' + detail : ''));
}

function runHookRaw(raw, args = [], envOverride = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'hook.js'), ...args], {
      env: { ...process.env, CCAPPROVAL_DATA_DIR: dataDir, ...envOverride }
    });
    let out = '';
    child.stdout.on('data', c => (out += c));
    child.on('close', () => {
      const elapsed = Date.now() - started;
      try { resolve({ decision: out ? JSON.parse(out).hookSpecificOutput : null, elapsed }); }
      catch { reject(new Error('hook output: ' + out)); }
    });
    child.stdin.end(raw);
  });
}

function runHook(toolName, toolInput, envOverride = {}) {
  return runHookRaw(JSON.stringify({
    session_id: 'e2e', cwd: process.cwd(),
    tool_name: toolName, tool_input: toolInput
  }), [], envOverride);
}

function logEntries() {
  try {
    return fs.readFileSync(path.join(dataDir, 'history.jsonl'), 'utf8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  } catch { return []; }
}

(async () => {
  // 1. safe command: auto-allowed
  const safe = await runHook('Bash', { command: 'git status' });
  check('safe command auto-allows',
    safe.decision.permissionDecision === 'allow', safe.decision.permissionDecisionReason);

  // 2. dangerous op: dangerousDefault=allow keeps the zero-interruption behaviour
  const risky = await runHook('Bash', { command: 'rm -rf build-output' });
  check('dangerous op auto-allows under dangerousDefault=allow',
    risky.decision.permissionDecision === 'allow' && /dangerous op/.test(risky.decision.permissionDecisionReason),
    risky.decision.permissionDecisionReason);

  // 3. the same op with dangerousDefault=ask hands over to Claude Code instead
  const handoff = await runHook('Bash', { command: 'rm -rf build-output' }, { CCAPPROVAL_DANGEROUS_DEFAULT: 'ask' });
  check('dangerous op hands to Claude Code under dangerousDefault=ask',
    handoff.decision.permissionDecision === 'ask' &&
    !/approved remotely/.test(handoff.decision.permissionDecisionReason),
    handoff.decision.permissionDecisionReason);

  // 4. catastrophe: hard-denied, never downgraded to a prompt
  const denied = await runHook('Bash', { command: 'rm -rf /' });
  check('catastrophic command is policy-denied',
    denied.decision.permissionDecision === 'deny', denied.decision.permissionDecisionReason);

  // 5. an explicit user `ask` rule wins over dangerousDefault=allow
  //    (config.json protects .env/.pem/.key writes via rules.ask)
  const userAsk = await runHook('Write', { file_path: '.env', content: 'x' });
  check('explicit rules.ask wins over dangerousDefault=allow',
    userAsk.decision.permissionDecision === 'ask', userAsk.decision.permissionDecisionReason);

  // 6. PowerShell must be judged like Bash, not waved through
  const psDeny = await runHook('PowerShell', { command: 'Remove-Item -Recurse C:\\Windows' });
  check('PowerShell catastrophic command is policy-denied',
    psDeny.decision.permissionDecision === 'deny', psDeny.decision.permissionDecisionReason);

  // 7. an unreadable payload must fail closed, not auto-approve
  const broken = await runHookRaw('{not json');
  check('malformed payload fails closed (ask)',
    broken.decision.permissionDecision === 'ask', broken.decision.permissionDecisionReason);

  // 8. plan approval arrives as a PermissionRequest, not a PreToolUse
  const plan = await runHookRaw(
    JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } }), ['permission']);
  check('PermissionRequest auto-accepts plan proposals',
    plan.decision.decision?.behavior === 'allow', JSON.stringify(plan.decision));
  const badPlan = await runHookRaw('{bad', ['permission']);
  check('PermissionRequest emits nothing when the payload is unreadable',
    badPlan.decision === null, JSON.stringify(badPlan.decision));

  // 9. nothing waits on a server any more
  const slowest = Math.max(safe.elapsed, risky.elapsed, handoff.elapsed, denied.elapsed,
    userAsk.elapsed, psDeny.elapsed, broken.elapsed, plan.elapsed);
  check(`every call returns well under ${BUDGET_MS}ms (slowest ${slowest}ms)`, slowest < BUDGET_MS);

  // 10. all three outcomes land in the audit log
  const statuses = logEntries().map(e => e.status);
  for (const s of ['auto-approved', 'policy-denied', 'escalated']) {
    check(`log records a ${s} entry`, statuses.includes(s), JSON.stringify(statuses));
  }

  console.log('');
  if (failures) { console.error(`✘ e2e: ${failures} failed`); process.exit(1); }
  console.log('✔ e2e passed (decision paths, plan approval and fail-closed all covered)');
  process.exit(0);
})().catch(e => { console.error('✘ e2e failed:', e.message); process.exit(1); });
