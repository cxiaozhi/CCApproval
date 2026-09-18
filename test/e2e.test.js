'use strict';
/**
 * End-to-end: drive the hook directly off stdin. No server is involved —
 * the policy decides, the hook answers, and one audit line is appended.
 *
 * The through-line is the whitelist: only a call on the escalate list may turn
 * into a prompt, and no environment variable can turn that off.
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
    let err = '';
    child.stdout.on('data', c => (out += c));
    child.stderr.on('data', c => (err += c));
    child.on('close', () => {
      const elapsed = Date.now() - started;
      try { resolve({ decision: out ? JSON.parse(out).hookSpecificOutput : null, elapsed, err }); }
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
  // 1. ordinary work never prompts
  const safe = await runHook('Bash', { command: 'git status' });
  check('safe command auto-allows',
    safe.decision.permissionDecision === 'allow', safe.decision.permissionDecisionReason);

  // 2. destructive-but-routine work is not on the whitelist, so it is silent too.
  //    This is the behaviour the whitelist was adopted for: `rm -rf build` must
  //    not bother anyone.
  const risky = await runHook('Bash', { command: 'rm -rf build-output' });
  check('routine destructive command auto-allows without prompting',
    risky.decision.permissionDecision === 'allow' &&
    /not on the escalate list/.test(risky.decision.permissionDecisionReason),
    risky.decision.permissionDecisionReason);

  const push = await runHook('Bash', { command: 'git push origin main' });
  check('git push auto-allows without prompting',
    push.decision.permissionDecision === 'allow', push.decision.permissionDecisionReason);

  // 3. catastrophe: surfaced to Claude Code's own prompt, never waved through silently
  //    There is no deny tier any more — the guard's two answers are "auto-approve"
  //    and "hand it back". Claude Code refuses to auto-approve critical-path rm
  //    whatever a hook says, so this still cannot be clicked past by accident.
  const catastrophic = await runHook('Bash', { command: 'rm -rf /' });
  check('catastrophic command is handed back, not auto-approved',
    catastrophic.decision.permissionDecision === 'ask', catastrophic.decision.permissionDecisionReason);

  // 4. credentials-file writes are on the whitelist
  const secret = await runHook('Write', { file_path: '.env', content: 'x' });
  check('writing a credentials file is escalated',
    secret.decision.permissionDecision === 'ask' &&
    /credentials/.test(secret.decision.permissionDecisionReason),
    secret.decision.permissionDecisionReason);

  // A tool that exists to ask the user must reach the user. Answering for it makes
  // the question appear and vanish (the flicker), which is the bug this guards.
  const question = await runHook('AskUserQuestion',
    { questions: [{ question: '提交到仓库？', header: '提交范围', options: [], multiSelect: false }] });
  check('AskUserQuestion is escalated to the native prompt',
    question.decision.permissionDecision === 'ask' &&
    /asks the user/.test(question.decision.permissionDecisionReason),
    question.decision.permissionDecisionReason);

  // 5. PowerShell must be judged like Bash, not waved through
  const psCatastrophic = await runHook('PowerShell', { command: 'Remove-Item -Recurse C:\\Windows' });
  check('PowerShell catastrophic command is handed back',
    psCatastrophic.decision.permissionDecision === 'ask', psCatastrophic.decision.permissionDecisionReason);

  // 6. an unreadable payload must fail closed, not auto-approve
  const broken = await runHookRaw('{not json');
  check('malformed payload fails closed (ask)',
    broken.decision.permissionDecision === 'ask', broken.decision.permissionDecisionReason);

  // 7. the plan card is a form the user fills in, so it is on the whitelist and
  //    reaches Claude Code's own prompt
  const planPre = await runHook('ExitPlanMode', { plan: 'x' });
  check('plan card is escalated on the PreToolUse path too',
    planPre.decision.permissionDecision === 'ask', planPre.decision.permissionDecisionReason);

  // 8. destructive MCP ops are on the whitelist
  const delSession = await runHook('mcp__ccd_session_mgmt__delete_session', { session_ids: ['a'] });
  check('destructive MCP op is escalated, not auto-approved',
    delSession.decision.permissionDecision === 'ask', delSession.decision.permissionDecisionReason);
  const listSessions = await runHook('mcp__ccd_session_mgmt__list_sessions', {});
  check('ordinary MCP op auto-allows',
    listSessions.decision.permissionDecision === 'allow', listSessions.decision.permissionDecisionReason);

  // An install from before this version also registered the hook on PermissionRequest.
  // Answering on that event is what made Claude Desktop render a dialog per call and
  // then withdraw it — visible flicker — so the mode answers nothing and logs nothing
  // (the PreToolUse row already covers the call).
  const rowsBefore = logEntries().length;
  for (const raw of [
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
    JSON.stringify({ tool_name: 'mcp__ccd_session_mgmt__delete_session', tool_input: { session_ids: ['a'] } }),
    '{bad'
  ]) {
    const stale = await runHookRaw(raw, ['permission']);
    check('PermissionRequest mode answers nothing (' + raw.slice(0, 24) + '…)',
      stale.decision === null, JSON.stringify(stale.decision));
  }
  check('PermissionRequest mode writes no audit rows',
    logEntries().length === rowsBefore, `${rowsBefore} → ${logEntries().length}`);

  // 9. the whitelist has no escape hatch. The old CCAPPROVAL_DANGEROUS_DEFAULT
  //    switch used to auto-approve anything dangerous; it must not suppress an
  //    escalation any more.
  const noEscape = await runHook('mcp__ccd_session_mgmt__delete_session', { session_ids: ['a'] },
    { CCAPPROVAL_DANGEROUS_DEFAULT: 'allow', CCAPPROVAL_UNMATCHED: 'allow' });
  check('no environment variable can suppress an escalation',
    noEscape.decision.permissionDecision === 'ask', noEscape.decision.permissionDecisionReason);

  // 10. a config still using the old `rules.ask` name must keep escalating (and say so),
  //     not silently drop the rule. os.homedir() honours USERPROFILE on Windows.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapproval-home-'));
  fs.mkdirSync(path.join(fakeHome, '.ccapproval'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.ccapproval', 'config.json'), JSON.stringify({
    rules: { ask: [{ tool: 'Bash', command: 'deployprod', reason: 'legacy ask rule' }] }
  }));
  const legacy = await runHook('Bash', { command: 'deployprod' }, {
    USERPROFILE: fakeHome, HOME: fakeHome
  });
  check('a stale rules.ask config still escalates',
    legacy.decision.permissionDecision === 'ask' &&
    /legacy ask rule/.test(legacy.decision.permissionDecisionReason),
    legacy.decision.permissionDecisionReason);
  check('...and warns about the rename',
    /rules\.ask. is now `rules\.escalate`/.test(legacy.err), JSON.stringify(legacy.err));

  // A config still carrying `rules.deny` must not silently decide nothing: the deny
  // tier is gone, and those rules are folded into the escalate list (a refusal that
  // becomes a prompt is weaker but visible — silently dropping them would not be).
  const denyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapproval-denyhome-'));
  fs.mkdirSync(path.join(denyHome, '.ccapproval'), { recursive: true });
  fs.writeFileSync(path.join(denyHome, '.ccapproval', 'config.json'), JSON.stringify({
    rules: { deny: [{ tool: 'Bash', command: 'legacyrefusal', reason: 'legacy deny rule' }] }
  }));
  const legacyDeny = await runHook('Bash', { command: 'legacyrefusal' }, {
    USERPROFILE: denyHome, HOME: denyHome
  });
  check('a stale rules.deny config escalates instead of silently deciding nothing',
    legacyDeny.decision.permissionDecision === 'ask' &&
    /legacy deny rule/.test(legacyDeny.decision.permissionDecisionReason),
    legacyDeny.decision.permissionDecisionReason);
  check('...and warns that the deny tier is gone',
    /rules\.deny. no longer exists/.test(legacyDeny.err), JSON.stringify(legacyDeny.err));

  // 11. nothing waits on a server any more
  const slowest = Math.max(safe.elapsed, risky.elapsed, push.elapsed, catastrophic.elapsed,
    secret.elapsed, question.elapsed, psCatastrophic.elapsed, broken.elapsed, planPre.elapsed,
    delSession.elapsed, legacy.elapsed);
  check(`every call returns well under ${BUDGET_MS}ms (slowest ${slowest}ms)`, slowest < BUDGET_MS);

  // 12. both outcomes land in the audit log — and only those two exist
  const statuses = logEntries().map(e => e.status);
  for (const s of ['auto-approved', 'escalated']) {
    check(`log records a ${s} entry`, statuses.includes(s), JSON.stringify(statuses));
  }
  check('no denied verdict is recorded any more',
    !statuses.includes('policy-denied'), JSON.stringify(statuses));

  // 13. credentials must not survive into the audit log
  const FAKE = 'sk-FAKEfakeFAKEfake1234';
  await runHook('Bash', { command: `curl -H "Authorization: Bearer ${FAKE}" https://example.com` });
  const raw = fs.readFileSync(path.join(dataDir, 'history.jsonl'), 'utf8');
  check('credentials are redacted before being persisted', !raw.includes(FAKE));

  console.log('');
  if (failures) { console.error(`✘ e2e: ${failures} failed`); process.exit(1); }
  console.log('✔ e2e passed (whitelist escalation, fail-closed, legacy config and redaction all covered)');
  process.exit(0);
})().catch(e => { console.error('✘ e2e failed:', e.message); process.exit(1); });
