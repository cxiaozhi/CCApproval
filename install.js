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
 * Two entries are registered:
 *   PreToolUse        — the tool calls listed in MATCHER, decided by the policy engine
 *   PermissionRequest — scoped to ExitPlanMode, because Claude Code asks
 *                       "approve this plan?" through that event rather than
 *                       PreToolUse, so a PreToolUse rule alone never sees it
 *
 * Existing hooks are preserved.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_CMD = `node ${path.join(__dirname, 'src', 'hook.js').replace(/\\/g, '/')}`;
const PERMISSION_CMD = `${HOOK_CMD} permission`;

/**
 * Anchored alternatives, so e.g. `Write` does not also match `TodoWrite`.
 * The `mcp__…` arm is a regex — a bare `mcp__server` matcher is treated as an
 * exact string and would match nothing. Only the browser-preview server is
 * listed; other MCP servers (session management and friends) keep their own
 * native prompts.
 */
const MATCHER = '^(Bash|PowerShell|Read|Glob|Grep|Write|Edit|NotebookEdit|WebFetch|Agent|ExitPlanMode|mcp__Claude_Browser__.*)$';

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
  settings.hooks.PermissionRequest = [
    ...(settings.hooks.PermissionRequest || []),
    { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: PERMISSION_CMD, timeout: 30 }] }
  ];
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log(uninstall
  ? `✔ CCApproval hooks removed from ${settingsPath}`
  : `✔ CCApproval hooks registered in ${settingsPath}\n  PreToolUse:        ${HOOK_CMD}\n  PermissionRequest: ${PERMISSION_CMD}\n\nNext steps:\n  1. copy config.example.json → config.json and adjust the rules\n  2. npm run launch        (optional — 只读日志面板，装不装都不影响审批)\n  3. run Claude Code — 每次工具调用都在本地判定并记入日志`);
