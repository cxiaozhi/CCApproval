'use strict';
/**
 * Anthropic ⇄ OpenAI bridge tests.
 *
 * Two halves: pure conversion units (no I/O), and an integration pass where a fake
 * upstream deliberately answers /v1/messages with 404 and only serves
 * /v1/chat/completions — the shape of the real gateway that made `k3` unselectable.
 * No real network involved.
 */
const http = require('http');
const {
  anthropicToOpenAI, openAIToAnthropic, anthropicError, errorMessage,
  createStreamTranslator, mapStopReason, messagesToOpenAI, systemToText, syntheticSignature
} = require('../src/anthropic-openai');
const { createGateway } = require('../src/gateway');

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log('✔ ' + label); return; }
  failures++;
  console.error('✘ ' + label + (detail ? ' — ' + detail : ''));
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, `got ${a} want ${e}`);
}

// -- units: Anthropic → OpenAI ------------------------------------------------

eq('system 字符串原样', systemToText('be brief'), 'be brief');
eq('system 块数组取 text', systemToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b', cache_control: {} }]), 'a\n\nb');
eq('system 空数组为 null', systemToText([]), null);

{
  const msgs = messagesToOpenAI([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '晴 25℃' }] },
        { type: 'text', text: '谢谢' }
      ]
    },
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }
  ]);

  eq('assistant 文本落到 content', msgs[1].content, 'calling');
  eq('tool_use 变成 tool_calls 且参数是 JSON 字符串', msgs[1].tool_calls, [
    { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }
  ]);
  check('thinking 块被丢弃', !JSON.stringify(msgs).includes('reasoning'));
  eq('tool_result 变成 role:tool', msgs[2], { role: 'tool', tool_call_id: 'toolu_1', content: '晴 25℃' });
  eq('同一 user 里的文本另起一条 user 消息', msgs[3], { role: 'user', content: [{ type: 'text', text: '谢谢' }] });
  eq('image 块变成 data URI', msgs[4].content[0].image_url.url, 'data:image/png;base64,AAA');
  eq('消息条数', msgs.length, 5);
}

{
  const out = anthropicToOpenAI({
    system: [{ type: 'text', text: 'sys' }],
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    temperature: 0.5,
    top_p: 0.9,
    stop_sequences: ['</end>'],
    tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' },
    thinking: { type: 'enabled', budget_tokens: 1024 },
    stream: true
  }, 'k3');

  eq('system 提升为 system 消息', out.messages[0], { role: 'system', content: 'sys' });
  eq('model 为上游真实 id', out.model, 'k3');
  eq('数值透传', [out.max_tokens, out.temperature, out.top_p], [128, 0.5, 0.9]);
  eq('stop_sequences → stop', out.stop, ['</end>']);
  eq('tools 包装成 function', out.tools[0].function.name, 'get_weather');
  eq('tool_choice any → required', out.tool_choice, 'required');
  eq('stream 带 usage', [out.stream, out.stream_options], [true, { include_usage: true }]);
  check('thinking 参数不下发', !('thinking' in out));
}

eq('tool_choice tool → function', anthropicToOpenAI({ messages: [], tools: [{ name: 'x' }], tool_choice: { type: 'tool', name: 'x' } }, 'm').tool_choice,
  { type: 'function', function: { name: 'x' } });
eq('没有 tools 时不发 tool_choice', anthropicToOpenAI({ messages: [], tool_choice: { type: 'auto' } }, 'm').tool_choice, undefined);
eq('无 tools 时不下发空数组', 'tools' in anthropicToOpenAI({ messages: [] }, 'm'), false);

// -- units: OpenAI → Anthropic ------------------------------------------------

eq('finish_reason 映射', ['stop', 'length', 'tool_calls', 'weird'].map(mapStopReason), ['end_turn', 'max_tokens', 'tool_use', 'end_turn']);

{
  const res = openAIToAnthropic({
    id: 'chatcmpl-1',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: '需要查天气',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }]
      }
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } }
  }, 'claude-fable-5');

  eq('response.model 用客户端请求的路由名', res.model, 'claude-fable-5');
  eq('type/role', [res.type, res.role], ['message', 'assistant']);
  eq('stop_reason', res.stop_reason, 'tool_use');
  eq('thinking 块带签名', [res.content[0].type, res.content[0].thinking, typeof res.content[0].signature], ['thinking', '需要查天气', 'string']);
  check('签名非空', res.content[0].signature.length > 0);
  eq('tool_use 输入已解析', res.content[1], { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } });
  check('content 为空串时不产出空文本块', !res.content.some(b => b.type === 'text'));
  eq('usage 映射含缓存读取', res.usage, {
    input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 64, cache_creation_input_tokens: 0
  });
}

{
  const empty = openAIToAnthropic({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }, 'm');
  eq('空回复仍有合法 content', empty.content, [{ type: 'text', text: '' }]);
  eq('usage 缺失时归零', empty.usage, {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0
  });
}

{
  const bad = openAIToAnthropic({ choices: [{ message: { tool_calls: [{ function: { name: 'x', arguments: '{not json' } }] } }] }, 'm');
  eq('坏 JSON 参数退化为空对象', bad.content[0].input, {});
  check('缺 id 时补一个', typeof bad.content[0].id === 'string' && bad.content[0].id.length > 0);
}

eq('errorMessage 取上游 error.message', errorMessage('{"error":{"message":"boom"}}', 400), 'boom');
eq('errorMessage 兜底', errorMessage('not json', 502), 'upstream returned 502');
eq('anthropicError 形状', anthropicError(429, 'slow down'), { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });

// -- unit: stream translator --------------------------------------------------

function sseEvents(text) {
  return text.split('\n\n').filter(Boolean).map(frame => {
    const lines = frame.split('\n');
    return { event: lines[0].replace('event: ', ''), data: JSON.parse(lines[1].replace('data: ', '')) };
  });
}
const chunk = (delta, extra = {}) => `data: ${JSON.stringify({
  id: 'chatcmpl-1', choices: [{ index: 0, delta, finish_reason: null }], ...extra
})}\n\n`;

{
  const t = createStreamTranslator('claude-fable-5');
  // split mid-frame on purpose: the translator must re-assemble partial lines
  let out = t.feed('data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"rol');
  check('半截帧不产出事件', out === '', JSON.stringify(out));
  out += t.feed('e":"assistant","content":""},"finish_reason":null}]}\n\n');
  out += t.feed(chunk({ reasoning_content: '想' }));
  out += t.feed(chunk({ content: '你' }));
  out += t.feed(chunk({ content: '好' }));
  out += t.feed('data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":3}}}\n\n');
  out += t.feed('data: [DONE]\n\n');
  out += t.end();

  const evs = sseEvents(out);
  eq('事件序列', evs.map(e => e.event), [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop'
  ]);
  eq('message_start 形状', evs[0].data.message.model, 'claude-fable-5');
  eq('thinking 块先开', [evs[1].data.index, evs[1].data.content_block.type], [0, 'thinking']);
  eq('thinking 增量', evs[2].data.delta, { type: 'thinking_delta', thinking: '想' });
  eq('thinking 关闭前补签名', [evs[3].data.index, evs[3].data.delta.type], [0, 'signature_delta']);
  eq('thinking 块关闭', evs[4].data, { type: 'content_block_stop', index: 0 });
  eq('文本块 index 递增', [evs[5].data.index, evs[5].data.content_block], [1, { type: 'text', text: '' }]);
  eq('文本增量', [evs[6].data.delta.text, evs[7].data.delta.text], ['你', '好']);
  eq('stop_reason', evs[9].data.delta.stop_reason, 'end_turn');
  eq('usage 落在 message_delta', evs[9].data.usage, {
    input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3
  });
  eq('末事件是 message_stop', evs[10].data.type, 'message_stop');
}

{
  const t = createStreamTranslator('claude-fable-5');
  let out = t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_', arguments: '' } }] }));
  out += t.feed(chunk({ tool_calls: [{ index: 0, function: { name: 'weather', arguments: '{"city":' } }] }));
  out += t.feed(chunk({ tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] }));
  out += t.feed('data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  out += t.end();

  const evs = sseEvents(out);
  const start = evs.find(e => e.event === 'content_block_start');
  eq('tool_use 块名拼接完整', start.data.content_block.name, 'get_weather');
  eq('tool_use 参数跨帧拼回 JSON', start.data.content_block.input, { city: '北京' });
  eq('tool_use id', start.data.content_block.id, 'call_1');
  eq('tool_use stop_reason', evs.find(e => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
  eq('无文本块', evs.filter(e => e.event === 'content_block_start' && e.data.content_block.type === 'text').length, 0);
}

{
  const t = createStreamTranslator('m');
  const out = t.end(); // upstream produced nothing at all
  const evs = sseEvents(out);
  eq('空流也有合法块', evs.filter(e => e.event === 'content_block_start').length, 1);
  eq('空流块类型', evs[1].data.content_block.type, 'text');
  eq('空流也收尾', evs[evs.length - 1].event, 'message_stop');
}

check('签名随文本变化', syntheticSignature('a') !== syntheticSignature('b'));

// -- integration: gateway in front of an OpenAI-only upstream -----------------

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const SSE_CHUNKS = [
  { id: 'chatcmpl-9', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  { id: 'chatcmpl-9', choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }] },
  { id: 'chatcmpl-9', choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
  { id: 'chatcmpl-9', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }
];

(async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url, body: body ? JSON.parse(body) : null });
      // the real upstream behaviour: the model has no Anthropic channel
      if (req.url.startsWith('/v1/messages') && !req.url.startsWith('/v1/messages/count')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'The requested resource was not found' } }));
      }
      if (req.url.startsWith('/v1/chat/completions')) {
        const parsed = JSON.parse(body);
        if (!parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: 'chatcmpl-9',
            choices: [{
              finish_reason: parsed.tools ? 'tool_calls' : 'stop',
              message: parsed.tools
                ? { content: '', tool_calls: [{ id: 'call_9', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] }
                : { content: '你好', reasoning_content: '先打招呼' }
            }],
            usage: { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } }
          }));
        }
        // stream, deliberately cut mid-character and mid-frame
        const payload = Buffer.from(
          SSE_CHUNKS.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', 'utf8');
        const cut = payload.indexOf(Buffer.from('你', 'utf8')) + 1; // 1 byte into a 3-byte char
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(payload.subarray(0, cut));
        setTimeout(() => res.end(payload.subarray(cut)), 5);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  const upstreamPort = await listen(upstream);

  const gw = createGateway({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    apiKey: 'injected',
    modelMap: { 'claude-fable-5': 'k3', 'claude-sonnet-5': 'deepseek-v4.1-flash' },
    openaiOnlyModels: ['k3']
  });
  const gwPort = await listen(gw);

  // 1. the reported failure, end to end: the switch-validation probe
  let r = await post(gwPort, '/v1/messages?beta=true', {
    model: 'claude-fable-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }]
  });
  check('k3 探测返回 200（切模型校验通过）', r.status === 200, r.body.slice(0, 200));
  const probe = JSON.parse(r.body);
  eq('回给客户端的是 Anthropic 形状', [probe.type, probe.role], ['message', 'assistant']);
  eq('response.model 回显路由名', probe.model, 'claude-fable-5');
  eq('上游收到的是 /v1/chat/completions', seen[seen.length - 1].path, '/v1/chat/completions');
  eq('上游收到的是真实模型 id', seen[seen.length - 1].body.model, 'k3');
  eq('thinking 保留在响应里', probe.content[0].type, 'thinking');
  eq('usage 映射', probe.usage, { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 });

  // 1b. the same probe with Claude Code's 1M-context marker still reaches the bridge
  r = await post(gwPort, '/v1/messages?beta=true', {
    model: 'claude-fable-5[1m]', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }]
  });
  check('带 [1m] 标记的 k3 探测同样 200', r.status === 200, r.body.slice(0, 200));
  eq('[1m] 标记下上游仍收到 k3', seen[seen.length - 1].body.model, 'k3');
  eq('response.model 保留客户端原写法', JSON.parse(r.body).model, 'claude-fable-5[1m]');

  // 2. tools survive the round trip
  r = await post(gwPort, '/v1/messages', {
    model: 'claude-fable-5', max_tokens: 64,
    messages: [{ role: 'user', content: '北京天气' }],
    tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }]
  });
  const toolRes = JSON.parse(r.body);
  eq('tools 转换成 OpenAI function', seen[seen.length - 1].body.tools[0].function.name, 'get_weather');
  eq('返回 tool_use 块', toolRes.content[0], { type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: '北京' } });
  eq('stop_reason=tool_use', toolRes.stop_reason, 'tool_use');

  // 3. streaming, with the upstream splitting a multi-byte character
  r = await post(gwPort, '/v1/messages', {
    model: 'claude-fable-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }]
  });
  check('流式返回 SSE', /text\/event-stream/.test(r.headers['content-type'] || ''), r.headers['content-type']);
  const streamEvents = sseEvents(r.body);
  eq('流式事件序列', streamEvents.map(e => e.event), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop'
  ]);
  eq('跨 chunk 中文未乱码', streamEvents.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text), ['你', '好']);
  eq('流式 usage 收尾', streamEvents.find(e => e.event === 'message_delta').data.usage, {
    input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0
  });
  eq('流式 stop_reason', streamEvents.find(e => e.event === 'message_delta').data.delta.stop_reason, 'end_turn');

  // 4. models not listed in openaiOnlyModels keep the plain passthrough path
  const before = seen.length;
  r = await post(gwPort, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });
  eq('非 openai-only 模型仍走 /v1/messages', seen[before].path, '/v1/messages');
  eq('非 openai-only 模型仍被改写', seen[before].body.model, 'deepseek-v4.1-flash');
  eq('上游 404 原样透传（非桥接路径不改写错误体）', [r.status, r.body],
    [404, '{"error":{"message":"The requested resource was not found"}}']);

  // 5. bridged upstream errors are re-shaped too
  const errUpstream = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad max_tokens' } }));
  });
  const errPort = await listen(errUpstream);
  const gw2 = createGateway({
    upstream: `http://127.0.0.1:${errPort}`, modelMap: { 'claude-fable-5': 'k3' }, openaiOnlyModels: ['k3']
  });
  const gw2Port = await listen(gw2);
  r = await post(gw2Port, '/v1/messages', { model: 'claude-fable-5', messages: [] });
  eq('桥接错误保留状态码', r.status, 400);
  eq('桥接错误转 Anthropic 形状', JSON.parse(r.body), { type: 'error', error: { type: 'invalid_request_error', message: 'bad max_tokens' } });

  upstream.close(); gw.close(); errUpstream.close(); gw2.close();

  console.log(failures ? `\n${failures} 项失败` : '\nbridge 全部通过');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
