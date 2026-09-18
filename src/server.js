#!/usr/bin/env node
'use strict';
/**
 * CCApproval log panel: a read-only view over the audit log the hook appends to.
 * This server never decides anything — it only reads history.jsonl.
 *
 *   node src/server.js
 *
 * Endpoints:
 *   GET  /              log panel (requires ?t=<secret> or Authorization: Bearer <secret>)
 *   GET  /api/requests  recent entries as JSON
 *   GET  /api/fragment  log rows as an HTML fragment
 *   GET  /api/events    SSE stream — a `change` event whenever the log grows
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { renderDashboard, renderRows } = require('./dashboard');

const cfg = loadConfig();
const store = new Store(cfg.dataDir);

function authed(req, url) {
  if (url.searchParams.get('t') === cfg.secret) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${cfg.secret}`;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

/**
 * Live updates. The hook is a separate process appending to history.jsonl, so
 * watch the directory rather than emitting in-process — an in-process emitter
 * would see nothing. Watching the directory (rather than the file) also
 * survives the rename that trim() performs.
 */
const sseClients = new Set();
let broadcastTimer = null;

function broadcast() {
  for (const res of sseClients) {
    try { res.write('event: change\ndata: {}\n\n'); }
    catch { sseClients.delete(res); }
  }
}

// one append can fire several watch events; coalesce them
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => { broadcastTimer = null; broadcast(); }, 60);
}

// keep a reference: a dropped FSWatcher silently stops watching
const watcher = (() => {
  try {
    return fs.watch(store.dataDir, (event, filename) => {
      if (!filename || filename === 'history.jsonl') scheduleBroadcast();
    });
  } catch { return null; }
})();
if (watcher) watcher.on('error', () => { /* keep serving even if watching fails */ });

// comment-only heartbeat so an idle connection isn't reaped mid-session
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
  }
}, 25000).unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (!authed(req, url)) return json(res, 401, { error: 'unauthorized — append ?t=<secret>' });

    if (path === '/' && req.method === 'GET') {
      return html(res, 200, renderDashboard(store, cfg));
    }
    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      // sync immediately so a reconnect also picks up whatever happened while disconnected
      res.write('event: change\ndata: {}\n\n');
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (path === '/api/fragment' && req.method === 'GET') {
      const entries = store.list(cfg.historyLimit);
      return json(res, 200, { count: entries.length, rows: renderRows(entries) });
    }
    if (path === '/api/requests' && req.method === 'GET') {
      return json(res, 200, { recent: store.list(cfg.historyLimit) });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

store.trim();
setInterval(() => store.trim(), 3600 * 1000).unref();

server.listen(cfg.port, cfg.host, () => {
  const pidFile = path.join(cfg.dataDir, 'server.pid');
  fs.writeFileSync(pidFile, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(pidFile); } catch { /* ignore */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  console.log(`[ccapproval] log panel listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[ccapproval] open: http://${cfg.host}:${cfg.port}/?t=${cfg.secret}`);
});
