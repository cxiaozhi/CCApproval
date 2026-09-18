'use strict';
/**
 * install.js writes into the user's real Claude Code settings, and since it also
 * manages `permissions.allow` it can widen what Claude Code approves without asking.
 * So the contract under test is mostly about *not* damaging what is already there:
 * other keys survive, the user's own permissions survive, re-running is idempotent,
 * and uninstall takes back exactly what was added and no more.
 *
 * Every case runs against a throwaway directory — install.js resolves the project
 * path from cwd, so nothing here can touch the real repository settings.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const INSTALL = path.join(__dirname, '..', 'install.js');
let failures = 0;

function check(label, cond, detail = '') {
  if (cond) { console.log('✔ ' + label); return; }
  failures++;
  console.error('✘ ' + label + (detail ? ' — ' + detail : ''));
}

function run(cwd, args = []) {
  const r = spawnSync(process.execPath, [INSTALL, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`install.js exited ${r.status}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function readSettings(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
}

/** A directory with a pre-existing settings file that looks like a real one. */
function fixture(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapproval-install-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (settings) {
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  }
  return dir;
}

const real = fixture({
  permissions: { allow: ['WebSearch', 'Bash'], deny: ['Bash(rm -rf /)'] },
  model: 'opus',
  hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hi' }] }] }
});
const out = run(real);
const after = readSettings(real);

// 1. PreToolUse is registered, catching everything — and nothing is registered on
//    PermissionRequest any more (registering it is what made every call flash a
//    dialog the hook then withdrew; see install.js)
const entry = (after.hooks.PreToolUse || [])[0];
check('PreToolUse is registered with the catch-all matcher',
  entry?.matcher === '.*' && /hook\.js/.test(entry.hooks[0].command),
  JSON.stringify(entry));
check('no PermissionRequest entry is registered',
  !(after.hooks.PermissionRequest || []).length, JSON.stringify(after.hooks.PermissionRequest));

// 2. settings we do not own are left alone
check('an unrelated top-level key survives', after.model === 'opus', after.model);
check('a pre-existing hook survives',
  after.hooks.PostToolUse?.[0]?.hooks?.[0]?.command === 'echo hi',
  JSON.stringify(after.hooks.PostToolUse));
check('an unrelated permission entry survives',
  after.permissions.allow.includes('WebSearch'), JSON.stringify(after.permissions.allow));
check('permissions.deny is untouched', after.permissions.deny?.[0] === 'Bash(rm -rf /)',
  JSON.stringify(after.permissions.deny));

// 3. the allow entries the guard depends on are present, and `Bash` is not duplicated
//    even though the fixture already listed it
for (const tool of ['Bash', 'PowerShell']) {
  check(`permissions.allow gains ${tool}`, after.permissions.allow.includes(tool),
    JSON.stringify(after.permissions.allow));
}
check('an already-present entry is not duplicated',
  after.permissions.allow.filter(t => t === 'Bash').length === 1,
  JSON.stringify(after.permissions.allow));

// 4. re-running must not stack hooks or duplicates
run(real);
const twice = readSettings(real);
check('re-installing does not stack PreToolUse entries', twice.hooks.PreToolUse.length === 1,
  JSON.stringify(twice.hooks.PreToolUse.length));
check('re-installing still leaves PermissionRequest empty',
  !(twice.hooks.PermissionRequest || []).length, JSON.stringify(twice.hooks.PermissionRequest));
check('re-installing does not duplicate allow entries', twice.permissions.allow.length === 3,
  JSON.stringify(twice.permissions.allow));

// 5. uninstall takes back only what install added. Leaving `Bash` allowed with no
//    policy engine behind it would auto-approve every shell command in the project.
run(real, ['--uninstall']);
const uninstalled = readSettings(real);
check('uninstall removes the hooks it added',
  !uninstalled.hooks.PreToolUse,
  JSON.stringify(uninstalled.hooks));
check('uninstall removes the allow entries it added',
  !uninstalled.permissions.allow.includes('Bash') && !uninstalled.permissions.allow.includes('PowerShell'),
  JSON.stringify(uninstalled.permissions.allow));
check('uninstall keeps the entries it did not add',
  uninstalled.permissions.allow.join(',') === 'WebSearch',
  JSON.stringify(uninstalled.permissions.allow));
check('uninstall keeps permissions.deny', uninstalled.permissions.deny?.[0] === 'Bash(rm -rf /)',
  JSON.stringify(uninstalled.permissions.deny));
check('uninstall keeps unrelated hooks',
  uninstalled.hooks.PostToolUse?.[0]?.hooks?.[0]?.command === 'echo hi',
  JSON.stringify(uninstalled.hooks.PostToolUse));

// 6. with nothing else in the file, uninstall must not leave empty husks behind
const bare = fixture({});
run(bare);
run(bare, ['--uninstall']);
const emptied = readSettings(bare);
check('uninstall leaves no empty permissions/hooks keys',
  !('permissions' in emptied) && !('hooks' in emptied), JSON.stringify(emptied));

// 7. installing into a project with no settings file at all must work
const fresh = fixture(null);
run(fresh);
const created = readSettings(fresh);
check('installing with no settings file creates one',
  created.hooks.PreToolUse.length === 1 && created.permissions.allow.includes('Bash'),
  JSON.stringify(created));

// 8. an entry left behind by an earlier install is cleaned up. The PermissionRequest
//    entry is the one that matters: leaving it registered means every call renders a
//    dialog that the hook then withdraws.
const legacy = fixture({
  hooks: {
    PreToolUse: [
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo foreign' }] },
      { matcher: '.*', hooks: [{ type: 'command', command: 'node F:/workspace/CCApproval/src/hook.js' }] }
    ],
    PermissionRequest: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node F:/workspace/CCApproval/src/hook.js' }] }]
  }
});
run(legacy);
const migrated = readSettings(legacy);
check('a stale PermissionRequest entry is removed on install',
  !(migrated.hooks.PermissionRequest || []).length, JSON.stringify(migrated.hooks.PermissionRequest));
check('the stale PreToolUse entry is replaced, not duplicated',
  migrated.hooks.PreToolUse.length === 2, JSON.stringify(migrated.hooks.PreToolUse));
check('a foreign PreToolUse entry survives the migration',
  migrated.hooks.PreToolUse[0].hooks[0].command === 'echo foreign',
  JSON.stringify(migrated.hooks.PreToolUse[0]));

console.log('');
if (failures) { console.error(`✘ install: ${failures} failed`); process.exit(1); }
console.log('✔ install passed (merge, idempotence and uninstall all covered)');
