'use strict';
/**
 * Gateway proxy tests: stand up a fake upstream on an ephemeral port, run the
 * loopback proxy in front of it, and assert model rewriting / auth injection /
 * pass-through behaviour. No real network involved.
 */
const http = require('http');
const { createGateway, rewriteModel } = require('../src/gateway');

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log('✔ ' + label); return; }
  failures++;
  console.error('✘ ' + label + (detail ? ' — ' + detail : ''));
}

// -- unit: rewriteModel -------------------------------------------------------
{
  const buf = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5', messages: [] }));
  const out = JSON.parse(rewriteModel(buf, 'application/json', { 'claude-sonnet-5': 'real-model' }).toString());
  check('rewriteModel 改写已知路由', out.model === 'real-model');

  const unknown = JSON.parse(rewriteModel(buf, 'application/json', { other: 'x' }).toString());
  check('rewriteModel 不动未知模型', unknown.model === 'claude-sonnet-5');

  const raw = Buffer.from('not json at all');
  check('rewriteModel 放过非 JSON 体', rewriteModel(raw, 'text/plain', { a: 'b' }).equals(raw));

  // Claude Code sends dated ids that are not keys in modelMap. Unresolved, they reach
  // the upstream verbatim and fail there with "No available channel for model …".
  const json = model => Buffer.from(JSON.stringify({ model }));
  const dated = JSON.parse(rewriteModel(json('claude-haiku-4-5-20251001'), 'application/json',
    { 'claude-haiku-4-5': 'gpt-5.6-sol' }).toString());
  check('rewriteModel 把带日期后缀的 id 归到路由上', dated.model === 'gpt-5.6-sol', dated.model);

  const overlapping = JSON.parse(rewriteModel(json('claude-sonnet-5-1-preview'), 'application/json',
    { 'claude-sonnet-5': 'short', 'claude-sonnet-5-1': 'long' }).toString());
  check('rewriteModel 重叠路由取最长匹配', overlapping.model === 'long', overlapping.model);

  const boundary = JSON.parse(rewriteModel(json('claude-sonnet-50'), 'application/json',
    { 'claude-sonnet-5': 'a' }).toString());
  check('rewriteModel 不在非边界处误匹配', boundary.model === 'claude-sonnet-50', boundary.model);

  // Claude Code's 1M-context marker is client-side only; left on, the id matches no
  // route and reaches the upstream verbatim, which fails there.
  const marked = JSON.parse(rewriteModel(json('claude-fable-5[1m]'), 'application/json',
    { 'claude-fable-5': 'k3' }).toString());
  check('rewriteModel 剥掉 [1m] 标记', marked.model === 'k3', marked.model);

  const markedUpper = JSON.parse(rewriteModel(json('claude-sonnet-5[1M]'), 'application/json',
    { 'claude-sonnet-5': 'deepseek-v4.1-flash' }).toString());
  check('rewriteModel 剥掉大写 [1M] 标记', markedUpper.model === 'deepseek-v4.1-flash', markedUpper.model);

  const markedDated = JSON.parse(rewriteModel(json('claude-haiku-4-5-20251001[1m]'), 'application/json',
    { 'claude-haiku-4-5': 'gpt-5.6-sol' }).toString());
  check('rewriteModel 日期后缀与 [1m] 同时存在', markedDated.model === 'gpt-5.6-sol', markedDated.model);
}

// -- integration: proxy in front of a fake upstream ---------------------------
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  let seen = null;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen = { method: req.method, path: req.url, auth: req.headers.authorization, body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upstreamPort = await listen(upstream);

  const gw = createGateway({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    apiKey: 'injected-key',
    modelMap: { 'claude-sonnet-5': 'deepseek-v4.1-flash' }
  });
  const gwPort = await listen(gw);

  // model rewrite + api key injection
  let r = await post(gwPort, '/v1/messages', { model: 'claude-sonnet-5', max_tokens: 8, messages: [] });
  check('POST 转发成功', r.status === 200 && JSON.parse(r.body).ok);
  check('model 被改写为上游真实模型', seen && JSON.parse(seen.body).model === 'deepseek-v4.1-flash', seen && seen.body);
  check('请求路径原样转发', seen && seen.path === '/v1/messages');
  check('注入 upstream apiKey', seen && seen.auth === 'Bearer injected-key');

  // unknown model passes through unchanged
  await post(gwPort, '/v1/messages', { model: 'mystery-model', messages: [] });
  check('未映射的 model 原样透传', JSON.parse(seen.body).model === 'mystery-model');

  // the reported failure: a dated id was forwarded verbatim and the upstream 503'd
  await post(gwPort, '/v1/messages', { model: 'claude-sonnet-5-20251101', messages: [] });
  check('带日期的 model id 改写后才发往上游',
    JSON.parse(seen.body).model === 'deepseek-v4.1-flash', seen.body);

  // upstream path prefix in the upstream URL is honoured
  const gw2 = createGateway({ upstream: `http://127.0.0.1:${upstreamPort}/prefix`, modelMap: {} });
  const gw2Port = await listen(gw2);
  await post(gw2Port, '/v1/messages', { model: 'x' });
  check('upstream URL 的路径前缀被保留', seen.path === '/prefix/v1/messages', seen.path);

  // unreachable upstream -> 502 json, not a hang
  const gw3 = createGateway({ upstream: 'http://127.0.0.1:1', timeoutMs: 1000 });
  const gw3Port = await listen(gw3);
  r = await post(gw3Port, '/v1/messages', { model: 'x' });
  check('上游不可达返回 502 JSON', r.status === 502 && JSON.parse(r.body).error.type === 'gateway_unreachable');

  upstream.close(); gw.close(); gw2.close(); gw3.close();

  // -- GET /v1/models: ids rewritten to route names, missing routes appended --
  const modelsUpstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'deepseek-v4.1-flash', object: 'model' },
      { id: 'unrelated-model', object: 'model' }
    ] }));
  });
  const mUpPort = await listen(modelsUpstream);
  const gw4 = createGateway({
    upstream: `http://127.0.0.1:${mUpPort}`,
    modelMap: { 'claude-sonnet-5': 'deepseek-v4.1-flash', 'claude-fable-5': 'k3' }
  });
  const gw4Port = await listen(gw4);
  const models = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: gw4Port, path: '/v1/models' }, res => {
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    }).on('error', reject);
  });
  const ids = JSON.parse(models.body).data.map(m => m.id);
  check('模型列表里上游 id 被改写成路由名', ids.includes('claude-sonnet-5') && !ids.includes('deepseek-v4.1-flash'), ids.join(','));
  check('上游没有的路由也会被补上', ids.includes('claude-fable-5'), ids.join(','));
  check('未映射的上游模型保持原样', ids.includes('unrelated-model'), ids.join(','));
  modelsUpstream.close(); gw4.close();

  console.log(failures ? `\n${failures} 项失败` : '\ngateway 全部通过');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
