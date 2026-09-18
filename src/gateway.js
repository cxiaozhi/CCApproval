'use strict';
/**
 * Loopback inference gateway proxy.
 *
 * Why this exists: Claude Desktop (3p mode) validates `inferenceGatewayBaseUrl`
 * as "https, or http on loopback only". A plain-HTTP LAN gateway like
 * http://192.168.x.x:3000 is rejected. It also requires `inferenceModels` names
 * to be Anthropic model routes (e.g. claude-sonnet-5) — the real upstream model
 * IDs are not accepted.
 *
 * This proxy solves both: it listens on 127.0.0.1 (loopback ⇒ config passes
 * validation) and forwards to the real upstream, rewriting the JSON `model`
 * field from the Anthropic route name to the real upstream model id.
 *
 *   Claude Desktop ──► 127.0.0.1:15721 ──► http://192.168.50.101:3000
 *        model: "claude-sonnet-5"   rewrite   model: "deepseek-v4.1-flash"
 *
 * Started alongside the log panel by src/server.js when gateway.enabled.
 */
const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const {
  anthropicToOpenAI, openAIToAnthropic, anthropicError, errorMessage, createStreamTranslator
} = require('./anthropic-openai');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'host'
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Claude Code may carry its 1M-context marker on the id (`claude-fable-5[1m]`, and it
 * has been seen doing so on model switches). That suffix is a client-side declaration,
 * not part of any upstream name, and no route is keyed with it — left on, the id
 * matches nothing and is forwarded verbatim, which fails upstream.
 */
function stripContextMarker(model) {
  return typeof model === 'string' ? model.replace(/\[1m\]$/i, '') : model;
}

/**
 * Resolve a requested model id to a configured route's real model.
 *
 * Exact match first. Then the longest route the id extends: Claude Code sends dated
 * ids (`claude-haiku-4-5-20251001`, `claude-3-5-sonnet-20241022`) that were never keys
 * in modelMap, and an unresolved id is forwarded upstream verbatim — which fails there,
 * because the upstream serves its own names, not Anthropic's:
 *
 *   503 No available channel for model claude-haiku-4-5-20251001 under group default
 *
 * Longest route wins so overlapping routes resolve predictably, and the match must sit
 * on a `-` boundary, so `claude-sonnet-50` does not resolve to a `claude-sonnet-5` route.
 */
function resolveRoute(model, modelMap) {
  if (!model || !modelMap) return null;
  const id = stripContextMarker(model);
  if (modelMap[id]) return modelMap[id];
  let best = null;
  let bestLen = 0;
  for (const route of Object.keys(modelMap)) {
    if (route.length > bestLen && id.startsWith(route + '-')) { best = route; bestLen = route.length; }
  }
  return best ? modelMap[best] : null;
}

/**
 * Rewrite the `model` field of a JSON request body per modelMap.
 * Returns the (possibly unchanged) body. Non-JSON bodies pass through untouched.
 */
function rewriteModel(body, contentType, modelMap) {
  if (!body.length || !modelMap || !Object.keys(modelMap).length) return body;
  if (!/json/i.test(contentType || '')) return body;
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return body; }
  const real = parsed && typeof parsed.model === 'string' ? resolveRoute(parsed.model, modelMap) : null;
  if (real) {
    parsed.model = real;
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  }
  return body;
}

/**
 * Rewrite a GET /v1/models response: replace upstream model ids with the
 * Anthropic route names, and make sure every configured route is listed.
 * The desktop app validates model switches against this list — passing the
 * upstream's raw ids through makes every route "not found".
 */
function rewriteModelsList(body, modelMap) {
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!parsed || !Array.isArray(parsed.data)) return null;
  const reverse = {};
  for (const [route, real] of Object.entries(modelMap || {})) reverse[real] = route;
  const seen = new Set();
  for (const item of parsed.data) {
    if (item && reverse[item.id]) {
      item.id = reverse[item.id];
      seen.add(item.id);
    }
  }
  for (const route of Object.keys(modelMap || {})) {
    if (!seen.has(route)) {
      parsed.data.push({ id: route, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'ccapproval-gateway' });
    }
  }
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

function isModelsRequest(req) {
  return req.method === 'GET' && /^\/v\d+\/models(\?|$)/.test(req.url || '');
}

/** Anthropic Messages calls only — /v1/messages/count_tokens must not match. */
function isMessagesRequest(req) {
  return req.method === 'POST' && /^\/v\d+\/messages(\?|$)/.test(req.url || '');
}

function isEventStream(proxyRes) {
  return /text\/event-stream/i.test(proxyRes.headers['content-type'] || '');
}

/**
 * Decide how a request goes upstream.
 *
 * Normally it is forwarded on its own path with just the `model` field rewritten.
 * But when the resolved upstream model only exists on the OpenAI route (see
 * `gateway.openaiOnlyModels`), the request has to be translated and re-pointed at
 * /v1/chat/completions — that is the whole reason this proxy knows two protocols.
 *
 * Returns null for "forward as-is", or a bridge plan for "translate".
 */
function planRequest(req, body, gw) {
  const openaiOnly = Array.isArray(gw.openaiOnlyModels) ? gw.openaiOnlyModels : [];
  if (!openaiOnly.length) return null;
  if (!isMessagesRequest(req) || !/json/i.test(req.headers['content-type'] || '')) return null;

  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
  const realModel = parsed && typeof parsed.model === 'string' ? resolveRoute(parsed.model, gw.modelMap) : null;
  if (!realModel || !openaiOnly.includes(realModel)) return null;

  return {
    bridge: true,
    route: parsed.model,   // what the client asked for; echoed back as response.model
    realModel,             // what the upstream serves, on the other protocol
    path: '/v1/chat/completions',
    body: Buffer.from(JSON.stringify(anthropicToOpenAI(parsed, realModel)), 'utf8')
  };
}

/**
 * Turn the upstream's OpenAI response back into the Anthropic shape the client asked
 * for: JSON for a buffered reply, SSE event-by-event for a streamed one. Status codes
 * pass through untouched — Claude Code branches on them, and a model-level failure
 * should still read as one.
 */
function bridgeResponse(req, res, proxyRes, plan, started) {
  const status = proxyRes.statusCode;
  const label = `[anthropic→openai bridge: ${plan.realModel}]`;
  const write = s => { if (s && !res.writableEnded) res.write(s); };

  if (status >= 400 || !isEventStream(proxyRes)) {
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let out = raw;
      if (status >= 400) {
        out = JSON.stringify(anthropicError(status, errorMessage(raw, status)));
      } else {
        try { out = JSON.stringify(openAIToAnthropic(JSON.parse(raw), plan.route)); } catch { /* leave raw */ }
      }
      const buf = Buffer.from(out, 'utf8');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
      res.end(buf);
      console.log(`[gateway] ${req.method} ${req.url} -> ${status} (${Date.now() - started}ms) ${label}`);
    });
    return;
  }

  // multi-byte characters straddle chunk boundaries; decoding per-chunk corrupts them
  const decoder = new StringDecoder('utf8');
  const translator = createStreamTranslator(plan.route);
  res.writeHead(status, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  proxyRes.on('data', chunk => write(translator.feed(decoder.write(chunk))));
  proxyRes.on('end', () => {
    write(translator.feed(decoder.end()));
    write(translator.end());
    if (!res.writableEnded) res.end();
    console.log(`[gateway] ${req.method} ${req.url} -> ${status} (${Date.now() - started}ms) ${label} [stream]`);
  });
  proxyRes.on('error', () => { if (!res.writableEnded) res.end(); });
}

function createGateway(gw) {
  const upstream = new URL(gw.upstream);
  const transport = upstream.protocol === 'https:' ? https : http;
  const basePath = upstream.pathname.replace(/\/+$/, '');

  return http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      let body = await readBody(req);
      const plan = planRequest(req, body, gw);
      body = plan ? plan.body : rewriteModel(body, req.headers['content-type'], gw.modelMap);

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
      }
      headers.host = upstream.host;
      headers['content-length'] = body.length;
      if (gw.apiKey) headers.authorization = `Bearer ${gw.apiKey}`;

      const proxyReq = transport.request({
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: basePath + (plan ? plan.path : req.url),
        method: req.method,
        headers,
        timeout: (gw.timeoutMs || 120000)
      }, proxyRes => {
        const resHeaders = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v;
        }
        if (plan && plan.bridge) {
          bridgeResponse(req, res, proxyRes, plan, started);
          return;
        }
        if (isModelsRequest(req) && gw.modelMap && Object.keys(gw.modelMap).length) {
          // buffer + rewrite the model list so the desktop sees route names
          const chunks = [];
          proxyRes.on('data', c => chunks.push(c));
          proxyRes.on('end', () => {
            const rewritten = rewriteModelsList(Buffer.concat(chunks), gw.modelMap);
            const out = rewritten || Buffer.concat(chunks);
            if (rewritten) {
              delete resHeaders['content-encoding']; // body no longer matches original encoding
              resHeaders['content-type'] = 'application/json; charset=utf-8';
            }
            resHeaders['content-length'] = out.length;
            res.writeHead(proxyRes.statusCode, resHeaders);
            res.end(out);
            console.log(`[gateway] ${req.method} ${req.url} -> ${proxyRes.statusCode} (${Date.now() - started}ms)${rewritten ? ' [model list rewritten]' : ''}`);
          });
          return;
        }
        res.writeHead(proxyRes.statusCode, resHeaders);
        proxyRes.pipe(res);
        console.log(`[gateway] ${req.method} ${req.url} -> ${proxyRes.statusCode} (${Date.now() - started}ms)`);
      });
      proxyReq.on('timeout', () => proxyReq.destroy(new Error('upstream timeout')));
      proxyReq.on('error', e => {
        console.error(`[gateway] ${req.method} ${req.url} -> 502 ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ error: { type: 'gateway_unreachable', message: e.message } }));
      });
      proxyReq.end(body);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: { type: 'gateway_error', message: e.message } }));
    }
  });
}

/**
 * Start the gateway if configured. Returns the server (or null when disabled).
 * Never throws: a gateway failure must not take the log panel down with it.
 * Runtime state is tracked in gatewayState so the dashboard can show it.
 */
const gatewayState = { status: 'disabled', error: null };

function startGateway(cfg) {
  const gw = cfg.gateway || {};
  if (!gw.enabled) return null;
  if (!gw.upstream) {
    gatewayState.status = 'error';
    gatewayState.error = 'gateway.upstream 未配置';
    console.error('[gateway] enabled but gateway.upstream is not set — skipping');
    return null;
  }
  gatewayState.status = 'starting';
  gatewayState.error = null;
  const server = createGateway(gw);
  server.on('error', e => {
    gatewayState.status = 'error';
    gatewayState.error = e.message;
    console.error(`[gateway] listen failed on ${gw.host}:${gw.port}: ${e.message}`);
  });
  server.listen(gw.port, gw.host, () => {
    gatewayState.status = 'listening';
    console.log(`[gateway] loopback proxy on http://${gw.host}:${gw.port} -> ${gw.upstream}`);
    const routes = Object.keys(gw.modelMap || {});
    if (routes.length) console.log(`[gateway] model routes: ${routes.join(', ')}`);
  });
  return server;
}

function getGatewayState() { return gatewayState; }

module.exports = { createGateway, startGateway, getGatewayState, rewriteModel, rewriteModelsList, stripContextMarker };
