'use strict';
/**
 * Configuration loader.
 *
 * Resolution order (later wins):
 *   1. built-in defaults
 *   2. <project>/config.json            (next to package.json)
 *   3. ~/.ccapproval/config.json        (per-user overrides)
 *   4. environment variables CCAPPROVAL_*
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_DIR = path.join(os.homedir(), '.ccapproval');
const PROJECT_DIR = path.join(__dirname, '..');

const DEFAULTS = {
  port: 4317,
  host: '0.0.0.0',           // bind address for the approval server
  publicUrl: null,           // e.g. http://192.168.1.10:4317 — used in email links; defaults to http://<lan-ip>:<port>
  secret: null,              // token required on decision links/API; generated on first run
  timeoutMs: 180000,         // how long the hook waits for a remote decision
  pollMs: 1000,              // decision poll interval
  fallback: 'ask',           // what to do on timeout: 'ask' | 'deny' | 'allow'
  unmatchedDefault: 'allow', // no rule matched: 'allow' (autonomous) | 'remote' (review everything unknown)
  remoteAction: 'allow',     // dangerous-but-not-forbidden ops: 'allow' (fully automatic) | 'remote' (human approval)
  dataDir: HOME_DIR,
  historyLimit: 200,
  notify: {
    email: null,             // { host, port, secure, auth:{user,pass}, from, to }
    webhook: null            // generic webhook URL (Feishu/DingTalk/custom bot) — receives JSON POST
  },
  rules: {
    // evaluated in order: deny > remote > allow > default('remote')
    deny: [],
    remote: [],
    allow: []
  }
};

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override !== undefined ? override : base;
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out = { ...base };
    for (const k of Object.keys(override)) out[k] = deepMerge(base[k], override[k]);
    return out;
  }
  return override !== undefined ? override : base;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadConfig() {
  let cfg = DEFAULTS;
  cfg = deepMerge(cfg, readJson(path.join(PROJECT_DIR, 'config.json')) || {});
  cfg = deepMerge(cfg, readJson(path.join(HOME_DIR, 'config.json')) || {});

  if (process.env.CCAPPROVAL_PORT) cfg.port = Number(process.env.CCAPPROVAL_PORT);
  if (process.env.CCAPPROVAL_SECRET) cfg.secret = process.env.CCAPPROVAL_SECRET;
  if (process.env.CCAPPROVAL_TIMEOUT_MS) cfg.timeoutMs = Number(process.env.CCAPPROVAL_TIMEOUT_MS);
  if (process.env.CCAPPROVAL_FALLBACK) cfg.fallback = process.env.CCAPPROVAL_FALLBACK;
  if (process.env.CCAPPROVAL_DATA_DIR) cfg.dataDir = process.env.CCAPPROVAL_DATA_DIR;
  if (process.env.CCAPPROVAL_UNMATCHED) cfg.unmatchedDefault = process.env.CCAPPROVAL_UNMATCHED;
  if (process.env.CCAPPROVAL_REMOTE_ACTION) cfg.remoteAction = process.env.CCAPPROVAL_REMOTE_ACTION;

  fs.mkdirSync(cfg.dataDir, { recursive: true });

  // persistent secret
  if (!cfg.secret) {
    const secretFile = path.join(cfg.dataDir, 'secret');
    try { cfg.secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch { /* first run */ }
    if (!cfg.secret) {
      cfg.secret = require('crypto').randomBytes(24).toString('hex');
      fs.writeFileSync(secretFile, cfg.secret, { mode: 0o600 });
    }
  }

  if (!cfg.publicUrl) {
    const ip = lanIp();
    cfg.publicUrl = `http://${ip}:${cfg.port}`;
  }
  return cfg;
}

function lanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

module.exports = { loadConfig, HOME_DIR, PROJECT_DIR };
