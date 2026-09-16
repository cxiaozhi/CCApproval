#!/usr/bin/env node
'use strict';
/**
 * CCApproval server: local web dashboard + decision endpoint + notification dispatcher.
 *
 *   node src/server.js
 *
 * Endpoints:
 *   GET  /                     dashboard (requires ?t=<secret> or Authorization: Bearer <secret>)
 *   GET  /api/requests         list pending requests
 *   POST /api/requests         create request (called by the hook; loopback only)
 *   POST /api/decide           { id, action: 'allow'|'deny', reason?, updatedInput? }
 *   GET  /d?id=..&a=allow|deny&t=..   one-click decision link (from email/webhook)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { notifyAll, decisionLinks } = require('./notify');
const { renderDashboard, renderDecisionResult } = require('./dashboard');

const cfg = loadConfig();
const store = new Store(cfg.dataDir, cfg.historyLimit);

function authed(req, url) {
  if (url.searchParams.get('t') === cfg.secret) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${cfg.secret}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

async function decide(id, action, reason, updatedInput) {
  const reqRecord = store.getRequest(id);
  if (!reqRecord) return { ok: false, error: 'unknown request id' };
  if (reqRecord.status !== 'pending') return { ok: false, error: `already ${reqRecord.status}` };
  store.writeDecision(id, { action, reason, updatedInput });
  store.markStatus(id, action === 'allow' ? 'approved' : 'denied', { reason });
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    // --- hook API: loopback only ---
    if (path === '/api/requests' && req.method === 'POST') {
      const remote = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
        return json(res, 403, { error: 'loopback only' });
      }
      const body = await readBody(req);
      const record = store.createRequest(body);
      // notify in background
      notifyAll(cfg, record).then(channels => {
        store.log({ type: 'notified', id: record.id, channels });
      });
      return json(res, 200, { id: record.id, links: decisionLinks(cfg, record.id) });
    }

    // --- one-click decision link ---
    if (path === '/d' && req.method === 'GET') {
      if (!authed(req, url)) return html(res, 401, '<h1>401 — bad token</h1>');
      const id = url.searchParams.get('id');
      const action = url.searchParams.get('a');
      if (!['allow', 'deny'].includes(action)) return html(res, 400, '<h1>400 — bad action</h1>');
      const result = await decide(id, action, 'via email link');
      return html(res, result.ok ? 200 : 409, renderDecisionResult(id, action, result));
    }

    // --- dashboard + JSON API (token required) ---
    if (!authed(req, url)) return json(res, 401, { error: 'unauthorized — append ?t=<secret>' });

    if (path === '/' && req.method === 'GET') {
      return html(res, 200, renderDashboard(store, cfg));
    }
    if (path === '/api/requests' && req.method === 'GET') {
      return json(res, 200, { pending: store.listPending(), recent: store.listRequests(50) });
    }
    if (path === '/api/decide' && req.method === 'POST') {
      const body = await readBody(req);
      if (!['allow', 'deny'].includes(body.action)) return json(res, 400, { error: 'action must be allow|deny' });
      const result = await decide(body.id, body.action, body.reason || 'via dashboard', body.updatedInput);
      return json(res, result.ok ? 200 : 409, result);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

store.gc();
setInterval(() => store.gc(), 3600 * 1000).unref();

server.listen(cfg.port, cfg.host, () => {
  const pidFile = path.join(cfg.dataDir, 'server.pid');
  fs.writeFileSync(pidFile, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(pidFile); } catch { /* ignore */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  console.log(`[ccapproval] listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[ccapproval] dashboard: ${cfg.publicUrl}/?t=${cfg.secret}`);
});
