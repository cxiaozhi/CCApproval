'use strict';
/**
 * Policy engine: decides what to do with a Claude Code tool call.
 *
 * This is a whitelist, not a blacklist. There are exactly two outcomes:
 *
 *   escalate — the call is on the escalate list → hand it to Claude Code's own
 *              permission prompt. This list is the *only* thing that can produce
 *              a prompt.
 *   allow    — everything else. Auto-approved, no prompt.
 *
 * So the question "will this bother me?" reduces to "is it in the escalate list?".
 * Adding a rule there is the single lever; nothing else widens or narrows it.
 *
 * There is deliberately no `deny` tier. A hard refusal has no recovery path — a
 * false positive cannot be clicked through — and the operations that would justify
 * one are already un-approvable upstream: Claude Code refuses to auto-approve
 * critical-path `rm` and writes to `.claude/**` whatever a hook answers. Escalating
 * those reaches a prompt the user can still say yes to; denying them just removes
 * the option.
 *
 * This project never asks a human itself; 'escalate' means Claude Code decides.
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

/**
 * A command position: the start of the string, right after a separator, or right
 * after a shell keyword. The catastrophic-command rules anchor here, so a dangerous
 * command that is merely *quoted* — in a commit message, an echo, a doc file —
 * doesn't turn into a prompt.
 */
const CMD_POS = '(?:^|[;&|()\\n]|\\b(?:then|do|else)\\b)\\s*(?:sudo\\s+|doas\\s+)*';

/**
 * Starter contents of the escalate list: the operations that cannot be undone.
 * Everything here deletes a session, throws away uncommitted work, hands the agent
 * more authority than the user gave it, or wipes the machine — worth one prompt
 * each. Ordinary destructive shell work (rm -rf build, git push, package
 * publishing) is deliberately NOT here: it is routine, and the guard's whole point
 * is to stay out of the way.
 */
const DESTRUCTIVE_MCP = '^mcp__.*__(delete|clear|archive|discard|clean_up|detach|stop|set_session_permission_mode|set_auto_merge|set_remote_control)[a-z_]*$';

/** Writing a credentials file: silently clobbering one is hard to notice and hard to undo. */
const SECRET_FILE_TOOLS = '^(Write|Edit|NotebookEdit)$';
const SECRET_FILE_PATH = '(^|[/\\\\])\\.env(\\.[a-z]+)?$|\\.(pem|key|p12|pfx|keystore)$';

/**
 * Tools whose entire purpose is to reach the human. Auto-approving one is
 * self-defeating: the guard would be silencing the very dialog that exists to ask
 * the user something. Worse, the dialog is rendered before the hook answers, so
 * approving it makes the question appear and then vanish.
 *
 * This list is what defines a "real ask" — Claude Code hands the user something to
 * fill in or submit, and only these reach that dialog:
 *   AskUserQuestion — the questions/options form
 *   ExitPlanMode    — the plan card, where the user approves or rejects the plan
 */
const USER_INTERACTION_TOOLS = '^(AskUserQuestion|ExitPlanMode)$';

const DEFAULT_RULES = {
  escalate: [
    { tool: USER_INTERACTION_TOOLS, reason: 'the tool itself asks the user' },
    { tool: SHELL_TOOLS, command: CMD_POS + '(mkfs|dd\\s+if=|:\\(\\)\\s*\\{)', reason: 'destructive system command' },
    { tool: SHELL_TOOLS, command: CMD_POS + '(rm|del|Remove-Item)\\b[^;&|]*(\\s/\\s*$|\\s/\\*|\\s~\\s*$|C:\\\\?$|C:\\\\Windows)', reason: 'delete of a critical/root path' },
    { tool: DESTRUCTIVE_MCP, reason: 'destructive MCP operation' },
    { tool: SECRET_FILE_TOOLS, path: SECRET_FILE_PATH, reason: 'writing a credentials file' }
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
 * @returns {{verdict: 'allow'|'escalate', reason: string, matched: object|null,
 *            source: 'rule'|'builtin'|'default'}}
 *   source distinguishes your own rules from the built-in escalate list, so the log
 *   can show whether a prompt was one you asked for or one shipped as a default.
 */
function evaluate(toolName, toolInput, rules) {
  // user rules precede built-ins, so index < mine.length means "yours"
  const mine = rules?.escalate || [];
  const list = [...mine, ...DEFAULT_RULES.escalate];
  for (let i = 0; i < list.length; i++) {
    if (matchRule(list[i], toolName, toolInput)) {
      return {
        verdict: 'escalate',
        reason: list[i].reason || 'matched an escalate rule',
        matched: list[i],
        source: i < mine.length ? 'rule' : 'builtin'
      };
    }
  }
  // Not on the whitelist: approve without asking.
  return { verdict: 'allow', reason: 'not on the escalate list', matched: null, source: 'default' };
}

module.exports = { evaluate, summarize, DEFAULT_RULES };
