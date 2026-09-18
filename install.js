#!/usr/bin/env node
'use strict';
/**
 * Registers the CCApproval hooks in Claude Code settings.
 *
 *   node install.js [--global] [--uninstall]
 *
 * Default: writes to ./.claude/settings.json (project-local).
 * --global: writes to ~/.claude/settings.json (all projects).
 *
 * One entry is registered: PreToolUse, on every tool call (matcher `.*`), decided by
 * the policy engine. A previously registered PermissionRequest entry is removed —
 * see WHY_REGISTER_ONLY_PRETOOLUSE.
 *
 * It also writes the `permissions.allow` entries the hook cannot substitute for —
 * see ALLOW below for why that is load-bearing rather than a convenience.
 *
 * Existing hooks and permissions are preserved.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_CMD = `node ${path.join(__dirname, 'src', 'hook.js').replace(/\\/g, '/')}`;

/**
 * Why nothing is registered on PermissionRequest any more.
 *
 * It was added for the plan card, which arrives as a PermissionRequest rather than a
 * PreToolUse. That reason is gone: ExitPlanMode is on the escalate whitelist now, so
 * PreToolUse answers `ask` for it and the native prompt appears on its own.
 *
 * What is left on that event is only downside. Claude Desktop ≥ 2.x renders the
 * authorization dialog as soon as the event fires, *before* the hook answers, so a
 * hook `allow` arrives as a visible withdrawal — measured 2026-09-18 as continuous
 * flicker in a `bypassPermissions` session: 120 consecutive calls answered `allow`
 * within milliseconds, a dialog rendered and yanked for each. Staying silent instead
 * leaves the dialog stranded on screen. There is no third answer.
 *
 * So the event is left alone: PreToolUse decides, and the application's own mode
 * handles whatever reaches the permission system afterwards.
 */

/**
 * The tools Claude Code must stop asking about before the hook ever gets a say.
 *
 * A hook `allow` only suppresses prompts the permission system was willing to let it
 * decide. When the *mode* itself requires permission for a tool — `acceptEdits`
 * accepts file edits but still asks for every shell command — that requirement
 * outranks the hook, and the prompt appears no matter what we answer. Measured
 * evidence: in an `acceptEdits` session the hook returned `allow` for a `curl`, was
 * ignored, and the native dialog appeared carrying a `permission_suggestions` entry
 * proposing exactly this rule.
 *
 * So the entry is not a convenience, it is the only thing that removes the ask. It
 * is also safe to write broadly: the hook still runs on every call, and a hook `ask`
 * outranks a settings `allow`, so everything on the escalate list keeps prompting.
 *
 * Bare tool names on purpose — `"Bash"` covers every Bash call, and wildcards like
 * `"mcp__*"` are not supported here (Claude Code skips them).
 */
const ALLOW = ['Bash', 'PowerShell'];

/**
 * Catch-all: every tool call reaches the policy engine.
 *
 * This is the whole point of the whitelist. An enumerated matcher can only ever
 * be incomplete, and each tool missing from it silently falls through to Claude
 * Code's own prompt — that is exactly how approvals "leaked" (Skill, WebSearch,
 * TodoWrite, every MCP server, …). Since the policy now escalates only what is
 * written on the list, there is nothing left for the matcher to filter, so it
 * deliberately filters nothing.
 *
 * `.*` is a regex, not an exact string — a bare `mcp__server` would be treated as
 * an exact match and cover nothing.
 */
const MATCHER = '.*';

const args = process.argv.slice(2);
const global_ = args.includes('--global');
const uninstall = args.includes('--uninstall');

const settingsPath = global_
  ? path.join(os.homedir(), '.claude', 'settings.json')
  : path.join(process.cwd(), '.claude', 'settings.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

const settings = readJson(settingsPath);
settings.hooks = settings.hooks || {};

const isOurs = entry => (entry.hooks || []).some(h =>
  (h.command || '').includes('ccapproval') ||
  (h.command || '').includes(path.join('CCApproval', 'src', 'hook.js').replace(/\\/g, '/'))
);

// drop any previous ccapproval entries from both events
for (const event of ['PreToolUse', 'PermissionRequest']) {
  const kept = (settings.hooks[event] || []).filter(e => !isOurs(e));
  if (kept.length) settings.hooks[event] = kept;
  else delete settings.hooks[event];
}

if (!uninstall) {
  settings.hooks.PreToolUse = [
    ...(settings.hooks.PreToolUse || []),
    { matcher: MATCHER, hooks: [{ type: 'command', command: HOOK_CMD, timeout: 30 }] }
  ];
  settings.permissions = settings.permissions || {};
  const allowed = new Set(settings.permissions.allow || []);
  for (const tool of ALLOW) allowed.add(tool);
  settings.permissions.allow = [...allowed];
} else {
  // Leaving the allow entries behind after removing the guard would be the worst of
  // both worlds: no policy engine, but shell commands still auto-approved. Drop them.
  const allow = (settings.permissions || {}).allow;
  if (Array.isArray(allow)) {
    const kept = allow.filter(t => !ALLOW.includes(t));
    if (kept.length) settings.permissions.allow = kept;
    else delete settings.permissions.allow;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log(uninstall
  ? `✔ CCApproval hooks removed from ${settingsPath}
  also dropped from permissions.allow: ${ALLOW.join(', ')} (without the guard they would
  auto-approve every shell command — add them back by hand if you relied on them)`
  : `✔ CCApproval hook registered in ${settingsPath}
  PreToolUse:        ${HOOK_CMD}
  permissions.allow: ${ALLOW.join(', ')}
  (any PermissionRequest entry from an earlier install has been removed — it was what
  made every call flash a dialog that the hook then withdrew)

Next steps:
  1. copy config.example.json → config.json and adjust the rules
  2. npm run launch        (optional — 只读日志面板，装不装都不影响审批)
  3. run Claude Code — 每次工具调用都在本地判定并记入日志`);
