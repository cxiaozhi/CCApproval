#!/usr/bin/env node
'use strict';
/**
 * Registers the CCApproval PreToolUse hook in Claude Code settings.
 *
 *   node install.js [--global] [--uninstall]
 *
 * Default: writes to ./.claude/settings.json (project-local).
 * --global: writes to ~/.claude/settings.json (all projects).
 *
 * Existing hooks are preserved; the matcher list covers mutating tools.
 * Read-only tools are auto-allowed by policy but we still let the hook see
 * everything via the empty-matcher catch-all entry — remove it if you only
 * want to intercept risky tools.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_CMD = `node ${path.join(__dirname, 'src', 'hook.js').replace(/\\/g, '/')}`;

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
settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];

// remove any previous ccapproval entries
settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(entry =>
  !(entry.hooks || []).some(h => (h.command || '').includes('ccapproval') || (h.command || '').includes(path.join('CCApproval', 'src', 'hook.js').replace(/\\/g, '/')))
);

if (!uninstall) {
  settings.hooks.PreToolUse.push({
    matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|Task',
    hooks: [{ type: 'command', command: HOOK_CMD, timeout: 300 }]
  });
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log(uninstall
  ? `✔ CCApproval hook removed from ${settingsPath}`
  : `✔ CCApproval hook registered in ${settingsPath}\n  command: ${HOOK_CMD}\n\nNext steps:\n  1. copy config.example.json → config.json and fill in SMTP/webhook\n  2. node src/server.js   (or just let the hook auto-start it)\n  3. run Claude Code and try a risky command like: rm test.txt`);
