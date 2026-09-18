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
  dataDir: HOME_DIR,
  historyLimit: 10,          // how many entries the log panel shows
  // loopback inference gateway proxy (see src/gateway.js): lets Claude Desktop 3p
  // mode use a plain-HTTP LAN gateway — the desktop app requires https or http on
  // loopback, and model names that are Anthropic routes (rewritten per modelMap).
  gateway: {
    enabled: false,
    port: 15721,
    host: '127.0.0.1',       // keep loopback: non-loopback http fails desktop validation
    upstream: null,          // e.g. "http://192.168.50.101:3000"
    apiKey: null,            // injected as Bearer; when null the client's header passes through
    timeoutMs: 120000,
    modelMap: {},            // { "claude-sonnet-5": "deepseek-v4.1-flash", ... }
    openaiOnlyModels: []     // upstream ids that only answer on /v1/chat/completions
  },
  rules: {
    // The whitelist handed back to Claude Code's own prompt. Everything else is
    // auto-approved — there is no switch that can widen or narrow that, only what
    // you put in this array.
    escalate: []
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
  if (process.env.CCAPPROVAL_GATEWAY_ENABLED) cfg.gateway.enabled = /^(1|true|yes)$/i.test(process.env.CCAPPROVAL_GATEWAY_ENABLED);
  if (process.env.CCAPPROVAL_GATEWAY_PORT) cfg.gateway.port = Number(process.env.CCAPPROVAL_GATEWAY_PORT);
  if (process.env.CCAPPROVAL_GATEWAY_UPSTREAM) cfg.gateway.upstream = process.env.CCAPPROVAL_GATEWAY_UPSTREAM;
  if (process.env.CCAPPROVAL_GATEWAY_API_KEY) cfg.gateway.apiKey = process.env.CCAPPROVAL_GATEWAY_API_KEY;
  if (process.env.CCAPPROVAL_GATEWAY_OPENAI_ONLY_MODELS) {
    cfg.gateway.openaiOnlyModels = process.env.CCAPPROVAL_GATEWAY_OPENAI_ONLY_MODELS
      .split(',').map(s => s.trim()).filter(Boolean);
  }

  // `rules.ask` was renamed to `rules.escalate`. A config still using the old name
  // would silently stop escalating whatever it listed, so carry it over and say so.
  if (Array.isArray(cfg.rules.ask)) {
    if (cfg.rules.ask.length) {
      cfg.rules.escalate = [...cfg.rules.ask, ...(cfg.rules.escalate || [])];
      console.error('[ccapproval] config: `rules.ask` is now `rules.escalate` — please rename it');
    }
    delete cfg.rules.ask;
  }

  // `rules.deny` is gone: the guard only decides "auto-approve" or "hand to the
  // native prompt" now. A config still carrying deny rules gets them escalated
  // instead — the refusal becomes a prompt, which is strictly weaker but visible,
  // and silently dropping them would be neither.
  if (Array.isArray(cfg.rules.deny)) {
    if (cfg.rules.deny.length) {
      cfg.rules.escalate = [...cfg.rules.deny, ...(cfg.rules.escalate || [])];
      console.error('[ccapproval] config: `rules.deny` no longer exists — moved to `rules.escalate` (it will prompt instead of refusing)');
    }
    delete cfg.rules.deny;
  }

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
