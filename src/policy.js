'use strict';
/**
 * Policy engine: decides what to do with a Claude Code tool call.
 *
 * Verdicts (first match wins, order: deny > ask > allow > default):
 *   deny  — refuse immediately, no prompt
 *   allow — approve immediately, no prompt
 *   ask   — hand the call back to Claude Code's own permission prompt
 *
 * This project never asks a human itself; 'ask' means Claude Code decides.
 * The default for unmatched calls is 'allow' (fully autonomous mode) and can be
 * changed via config `unmatchedDefault: 'ask'` if you prefer to review unknowns.
 *
 * Rule shape:
 *   { tool: 'Bash|Write|Edit',           // regex matched against tool name
 *     command: 'regex',                  // matched against Bash command
 *     path: 'regex',                     // matched against file_path / notebook_path
 *     pattern: 'regex',                  // matched against the full JSON input (catch-all)
 *     reason: 'why this rule exists' }
 */
/**
 * Rules carrying a `command` match both shells. Keyed on the tool name, so a
 * shell missing from this list bypasses every command rule — PowerShell used to
 * fall straight through to the unmatched default.
 */
const SHELL_TOOLS = '^(Bash|PowerShell)$';

const DEFAULT_RULES = {
  deny: [
    { tool: SHELL_TOOLS, command: '\\b(mkfs|dd\\s+if=|:\\(\\)\\s*\\{)', reason: 'destructive system command' },
    { tool: SHELL_TOOLS, command: '(rm|del|Remove-Item).*(\\s/\\s*$|\\s/\\*|C:\\\\?$|C:\\\\Windows)', reason: 'delete of a critical/root path' }
  ],
  ask: [
    { tool: SHELL_TOOLS, command: '\\b(rm|del|rmdir|Remove-Item|shred)\\b', reason: 'file deletion' },
    { tool: SHELL_TOOLS, command: '\\bgit\\s+(push|reset\\s+--hard|clean\\s+-[fd])', reason: 'history-affecting git operation' },
    { tool: SHELL_TOOLS, command: '\\b(npm|pnpm|yarn|pip)\\s+(publish|unpublish)\\b', reason: 'package publishing' },
    { tool: SHELL_TOOLS, command: '\\b(kubectl|helm|terraform)\\s+(apply|delete|destroy)\\b', reason: 'infrastructure change' },
    { tool: SHELL_TOOLS, command: '\\b(curl|wget|Invoke-WebRequest)\\b.*\\|\\s*(sh|bash|powershell)', reason: 'pipe-remote-script-to-shell' },
    { tool: SHELL_TOOLS, command: '\\b(shutdown|reboot|Restart-Computer|Stop-Computer)\\b', reason: 'power operation' }
  ],
  allow: [
    { tool: '^(Read|Glob|Grep|LS|TodoWrite|WebSearch|WebFetch|NotebookRead)$', reason: 'read-only tool' },
    { tool: '^ExitPlanMode$', reason: 'plan proposal — nothing has been executed yet' },
    { tool: SHELL_TOOLS, command: '^\\s*(ls|dir|pwd|cd|echo|cat|type|which|where|whoami|date)\\b[^&|;]*$', reason: 'read-only shell builtin (no chaining)' },
    { tool: SHELL_TOOLS, command: '^\\s*git\\s+(status|diff|log|show|branch|fetch|blame|stash list)\\b', reason: 'read-only git' },
    { tool: SHELL_TOOLS, command: '^\\s*(node|python|python3|npm|npx|pnpm|yarn|pip)\\s+[^&|;]*$', reason: 'local runtime/package command without shell chaining' },
    { tool: SHELL_TOOLS, command: '^\\s*(mkdir|touch|cp|copy|mv|move|find|rg|grep|findstr)\\b', reason: 'common safe file/search op' }
  ]
};

function fieldOf(toolInput, keys) {
  for (const k of keys) {
    if (typeof toolInput?.[k] === 'string') return toolInput[k];
  }
  return '';
}

/** Strip harmless output redirections so they don't break chaining checks. */
function normalizeCommand(cmd) {
  return String(cmd || '')
    .replace(/\s*2>\s*&1/g, '')
    .replace(/\s*1>\s*&2/g, '')
    .replace(/\s*2>\s*(nul|\/dev\/null)/gi, '');
}

function matchRule(rule, toolName, toolInput) {
  if (rule.tool) {
    let re;
    try { re = new RegExp(rule.tool, 'i'); } catch { return false; }
    if (!re.test(toolName || '')) return false;
  }
  const checks = [];
  if (rule.command) checks.push([rule.command, normalizeCommand(fieldOf(toolInput, ['command']))]);
  if (rule.path) checks.push([rule.path, fieldOf(toolInput, ['file_path', 'notebook_path', 'path'])]);
  if (rule.pattern) checks.push([rule.pattern, JSON.stringify(toolInput || {})]);
  if (checks.length === 0) return true; // tool-only rule
  return checks.every(([rx, val]) => {
    try { return new RegExp(rx, 'is').test(val); } catch { return false; }
  });
}

function summarize(toolName, toolInput) {
  const input = toolInput || {};
  switch (toolName) {
    case 'Bash': return input.command || '';
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return `${toolName} → ${input.file_path || input.notebook_path || ''}`;
    case 'Task': return `Task: ${input.description || input.prompt?.slice(0, 80) || ''}`;
    default: {
      const s = JSON.stringify(input);
      return `${toolName}: ${s.length > 200 ? s.slice(0, 200) + '…' : s}`;
    }
  }
}

/**
 * @param {string} unmatchedDefault verdict when no rule matches: 'allow' (default) or 'ask'
 * @returns {{verdict: 'allow'|'deny'|'ask', reason: string, matched: object|null,
 *            source: 'rule'|'builtin'|'unmatchedDefault'}}
 *   source distinguishes your own rules from the built-in dangerous patterns, so the
 *   caller can let an explicit `ask` rule win over the `dangerousDefault` switch.
 */
function evaluate(toolName, toolInput, rules, unmatchedDefault = 'allow') {
  // user rules precede built-ins within each tier, so index < userCount means "yours"
  const tiers = [
    ['deny', rules?.deny, DEFAULT_RULES.deny],
    ['ask', rules?.ask, DEFAULT_RULES.ask],
    ['allow', rules?.allow, DEFAULT_RULES.allow]
  ];
  for (const [verdict, userRules, builtinRules] of tiers) {
    const mine = userRules || [];
    const list = [...mine, ...builtinRules];
    for (let i = 0; i < list.length; i++) {
      if (matchRule(list[i], toolName, toolInput)) {
        return {
          verdict,
          reason: list[i].reason || `matched ${verdict} rule`,
          matched: list[i],
          source: i < mine.length ? 'rule' : 'builtin'
        };
      }
    }
  }
  return unmatchedDefault === 'ask'
    ? { verdict: 'ask', reason: 'no rule matched — handing to Claude Code', matched: null, source: 'unmatchedDefault' }
    : { verdict: 'allow', reason: 'no dangerous pattern matched — auto-approved', matched: null, source: 'unmatchedDefault' };
}

module.exports = { evaluate, summarize, DEFAULT_RULES };
