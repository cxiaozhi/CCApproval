'use strict';
/**
 * Redaction for the audit log.
 *
 * Every tool input is recorded verbatim, so anything that passes through a tool
 * call — a curl header, an .env write, a settings.json edit — would otherwise be
 * persisted in plaintext and be visible in the log panel's hover tooltip.
 *
 * Deliberately conservative: it masks credential *shapes* and the values of
 * credential-looking keys, rather than trying to detect secrets in general.
 * Over-redacting normal content would make the log useless.
 */

/** Field names whose value is a credential. Must not match `author`. */
const SECRET_KEY = /(^|[^a-z])(token|secret|passwd|password|api[_-]?key|auth|credential)([^a-z]|$)/i;

/** Credential literals: provider prefixes, Bearer headers, JWTs, AWS keys. */
const SECRET_LITERAL = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/gi;

/** `token: "abc"` / `token=abc` style assignments. */
const SECRET_ASSIGN = /([A-Za-z0-9_.-]*(?:token|secret|passwd|password|api[_-]?key|auth)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)([^\s"',;&|)]{4,})\2/gi;

const MARK = '***REDACTED***';

function redactString(value) {
  return String(value ?? '')
    .replace(SECRET_LITERAL, m => (m.startsWith('Bearer') ? 'Bearer ' : m.slice(0, 3)) + MARK)
    .replace(SECRET_ASSIGN, (_, head, quote) => head + quote + MARK + quote);
}

/** Same redaction, walked through a tool_input object. */
function redactValue(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? MARK : redactValue(v);
    return out;
  }
  return value;
}

module.exports = { redactString, redactValue, MARK };
