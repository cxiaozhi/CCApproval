'use strict';
/**
 * Append-only audit log shared by two processes: the hook appends one entry per
 * tool call, the log panel server reads the tail. No locking needed — appends
 * are atomic enough at this size and readers only ever want recent lines.
 *
 * Layout under <dataDir>:
 *   history.jsonl   — one JSON object per tool call
 *   secret          — dashboard token (written by config.js on first run)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LINES = 5000;

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.historyFile = path.join(dataDir, 'history.jsonl');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  newId() {
    return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  }

  /** Append one entry. Never throws — audit logging must not block a decision. */
  record(entry) {
    try {
      fs.appendFileSync(this.historyFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
      return true;
    } catch { return false; }
  }

  /** Most recent entries, newest first. Legacy lines predate the `status` field. */
  list(limit = 200) {
    let text;
    try { text = fs.readFileSync(this.historyFile, 'utf8'); } catch { return []; }
    const lines = text.split('\n');
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        // The old per-file store also wrote its internal event stream (type:
        // 'decision'|'notified') into this same file. Those carry no tool call
        // and no outcome, so they would render as blank rows.
        if (rec.type) continue;
        out.push({ status: 'unknown', ...rec });
      } catch { /* skip malformed line */ }
    }
    return out;
  }

  /** Keep only the last maxLines entries. Called on server start and hourly. */
  trim(maxLines = MAX_LINES) {
    let lines;
    try {
      lines = fs.readFileSync(this.historyFile, 'utf8').split('\n').filter(l => l.trim());
    } catch { return; }
    if (lines.length <= maxLines) return;
    try {
      const tmp = this.historyFile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, lines.slice(-maxLines).join('\n') + '\n');
      fs.renameSync(tmp, this.historyFile);
    } catch { /* non-fatal */ }
  }
}

module.exports = { Store };
