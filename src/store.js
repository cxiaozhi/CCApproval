'use strict';
/**
 * File-based request/decision store shared by the hook process and the server.
 *
 * Layout under <dataDir>:
 *   pending/<id>.json    — approval request created by a hook
 *   decisions/<id>.json  — decision written by the server (approve/deny [+ updatedInput])
 *   history.jsonl        — append-only audit log
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dataDir, historyLimit = 200) {
    this.dataDir = dataDir;
    this.pendingDir = path.join(dataDir, 'pending');
    this.decisionsDir = path.join(dataDir, 'decisions');
    this.historyFile = path.join(dataDir, 'history.jsonl');
    this.historyLimit = historyLimit;
    for (const d of [this.pendingDir, this.decisionsDir]) fs.mkdirSync(d, { recursive: true });
  }

  newId() {
    return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  }

  writeJsonAtomic(file, obj) {
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  }

  createRequest(req) {
    const id = this.newId();
    const record = { id, status: 'pending', createdAt: new Date().toISOString(), ...req };
    this.writeJsonAtomic(path.join(this.pendingDir, id + '.json'), record);
    this.log({ type: 'request', id, tool: req.toolName, summary: req.summary });
    return record;
  }

  getRequest(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.pendingDir, id + '.json'), 'utf8')); }
    catch { return null; }
  }

  markStatus(id, status, extra = {}) {
    const req = this.getRequest(id);
    if (!req) return null;
    const updated = { ...req, status, decidedAt: new Date().toISOString(), ...extra };
    this.writeJsonAtomic(path.join(this.pendingDir, id + '.json'), updated);
    return updated;
  }

  writeDecision(id, decision) {
    // decision: { action: 'allow'|'deny', reason?, updatedInput? }
    this.writeJsonAtomic(path.join(this.decisionsDir, id + '.json'), {
      id, ...decision, decidedAt: new Date().toISOString()
    });
    this.log({ type: 'decision', id, action: decision.action, reason: decision.reason });
  }

  getDecision(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.decisionsDir, id + '.json'), 'utf8')); }
    catch { return null; }
  }

  listPending() {
    return fs.readdirSync(this.pendingDir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(this.pendingDir, f), 'utf8')); } catch { return null; } })
      .filter(r => r && r.status === 'pending')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  listRequests(limit = 100) {
    return fs.readdirSync(this.pendingDir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(this.pendingDir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  log(entry) {
    try {
      fs.appendFileSync(this.historyFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch { /* non-fatal */ }
  }

  /** Remove stale pending/decision files older than maxAgeMs (default 24h). */
  gc(maxAgeMs = 24 * 3600 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const dir of [this.pendingDir, this.decisionsDir]) {
      for (const f of fs.readdirSync(dir)) {
        try {
          const st = fs.statSync(path.join(dir, f));
          if (st.mtimeMs < cutoff) fs.unlinkSync(path.join(dir, f));
        } catch { /* ignore */ }
      }
    }
  }
}

module.exports = { Store };
