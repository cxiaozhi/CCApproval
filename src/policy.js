'use strict';
/**
 * Policy engine: decides what to do with a Claude Code tool call.
 *
 * Verdicts (first match wins, order: deny > remote > allow > default):
 * The default for unmatched calls is 'allow' (fully autonomous mode) and can be
 * changed via config `unmatchedDefault: 'remote'` if you prefer to review unknowns.
 *   deny   — refuse immediately, no prompt
 *   allow  — approve immediately, no prompt
 *   remote — ask the human via email/web dashboard
 *
 * Rule shape:
 *   { tool: 'Bash|Write|Edit',           // regex matched against tool name
 *     command: 'regex',                  // matched against Bash command
 *     path: 'regex',                     // matched against file_path / notebook_path
 *     pattern: 'regex',                  // matched against the full JSON input (catch-all)
 *     reason: 'why this rule exists' }
 */
const DEFAULT_RULES = {
  deny: [
    { tool: 'Bash', command: '\\b(mkfs|dd\\s+if=|:\\(\\)\\s*\\{)', reason: 'destructive system command' },
    { tool: 'Bash', command: '(rm|del|Remove-Item).*(\\s/\\s*$|\\s/\\*|C:\\\\?$|C:\\\\Windows)', reason: 'delete of a critical/root path' }
  ],
  remote: [
    { tool: 'Bash', command: '\\b(rm|del|rmdir|Remove-Item|shred)\\b', reason: 'file deletion' },
    { tool: 'Bash', command: '\\bgit\\s+(push|reset\\s+--hard|clean\\s+-[fd])', reason: 'history-affecting git operation' },
    { tool: 'Bash', command: '\\b(npm|pnpm|yarn|pip)\\s+(publish|unpublish)\\b', reason: 'package publishing' },
    { tool: 'Bash', command: '\\b(kubectl|helm|terraform)\\s+(apply|delete|destroy)\\b', reason: 'infrastructure change' },
    { tool: 'Bash', command: '\\b(curl|wget|Invoke-WebRequest)\\b.*\\|\\s*(sh|bash|powershell)', reason: 'pipe-remote-script-to-shell' },
    { tool: 'Bash', command: '\\b(shutdown|reboot|Restart-Computer|Stop-Computer)\\b', reason: 'power operation' }
  ],
  allow: [
    { tool: '^(Read|Glob|Grep|LS|TodoWrite|WebSearch|WebFetch|NotebookRead)$', reason: 'read-only tool' },
    { tool: 'Bash', command: '^\\s*(ls|dir|pwd|cd|echo|cat|type|which|where|whoami|date)\\b[^&|;]*$', reason: 'read-only shell builtin (no chaining)' },
    { tool: 'Bash', command: '^\\s*git\\s+(status|diff|log|show|branch|fetch|blame|stash list)\\b', reason: 'read-only git' },
    { tool: 'Bash', command: '^\\s*(node|python|python3|npm|npx|pnpm|yarn|pip)\\s+[^&|;]*$', reason: 'local runtime/package command without shell chaining' },
    { tool: 'Bash', command: '^\\s*(mkdir|touch|cp|copy|mv|move|find|rg|grep|findstr)\\b', reason: 'common safe file/search op' }
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
 * @param {string} unmatchedDefault verdict when no rule matches: 'allow' (default) or 'remote'
 * @returns {{verdict: 'allow'|'deny'|'remote', reason: string, matched: object|null}}
 */
function evaluate(toolName, toolInput, rules, unmatchedDefault = 'allow') {
  const merged = {
    deny: [...DEFAULT_RULES.deny, ...(rules?.deny || [])],
    remote: [...(rules?.remote || []), ...DEFAULT_RULES.remote], // user remote rules take precedence
    allow: [...(rules?.allow || []), ...DEFAULT_RULES.allow]
  };
  for (const [verdict, list] of [['deny', merged.deny], ['remote', merged.remote], ['allow', merged.allow]]) {
    for (const rule of list) {
      if (matchRule(rule, toolName, toolInput)) {
        return { verdict, reason: rule.reason || `matched ${verdict} rule`, matched: rule };
      }
    }
  }
  return unmatchedDefault === 'remote'
    ? { verdict: 'remote', reason: 'no rule matched — requires human review', matched: null }
    : { verdict: 'allow', reason: 'no dangerous pattern matched — auto-approved', matched: null };
}

module.exports = { evaluate, summarize, DEFAULT_RULES };
