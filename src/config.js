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
  host: '127.0.0.1',         // bind address for the log panel
  secret: null,              // token required to view the log; generated on first run
  unmatchedDefault: 'allow', // no rule matched: 'allow' (autonomous) | 'ask' (hand to Claude Code)
  dangerousDefault: 'allow', // dangerous-but-not-forbidden ops: 'allow' (automatic) | 'ask' (hand to Claude Code)
  dataDir: HOME_DIR,
  historyLimit: 10,          // how many entries the log panel shows
  rules: {
    // evaluated in order: deny > ask > allow > default
    deny: [],
    ask: [],
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
  if (process.env.CCAPPROVAL_HOST) cfg.host = process.env.CCAPPROVAL_HOST;
  if (process.env.CCAPPROVAL_SECRET) cfg.secret = process.env.CCAPPROVAL_SECRET;
  if (process.env.CCAPPROVAL_DATA_DIR) cfg.dataDir = process.env.CCAPPROVAL_DATA_DIR;
  if (process.env.CCAPPROVAL_UNMATCHED) cfg.unmatchedDefault = process.env.CCAPPROVAL_UNMATCHED;
  if (process.env.CCAPPROVAL_DANGEROUS_DEFAULT) cfg.dangerousDefault = process.env.CCAPPROVAL_DANGEROUS_DEFAULT;

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

  return cfg;
}

module.exports = { loadConfig, HOME_DIR, PROJECT_DIR };
