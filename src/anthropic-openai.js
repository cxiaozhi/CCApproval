'use strict';
/**
 * Anthropic Messages ⇄ OpenAI Chat Completions bridge.
 *
 * Why this exists: an upstream gateway can expose the same model on both protocols
 * and still not on both routes. Ours carries `k3` only on the OpenAI one —
 * POST /v1/messages answers 404 "The requested resource was not found" while
 * POST /v1/chat/completions works. Claude Code speaks Anthropic and validates a
 * model switch by actually calling the model, so a model it cannot reach is a model
 * it refuses to select ("Model 'claude-fable-5' not found", record restored).
 *
 * So for the upstream ids listed in `gateway.openaiOnlyModels` the proxy translates:
 * request down to chat completions, response (JSON or SSE) back up to messages.
 *
 * Only the shapes Claude Code actually sends are modelled: system prompts, text /
 * image / tool_use / tool_result blocks, tools + tool_choice, and streamed text,
 * tool calls and reasoning. Unknown block types are dropped rather than guessed at —
 * dropping a field degrades a turn, mis-mapping one breaks it.
 */
const crypto = require('crypto');

// -- shared helpers -----------------------------------------------------------

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function parseToolArguments(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A model that emits malformed JSON args still has to produce a usable block;
    // an empty object lets the tool call run and fail loudly on its own terms.
    return {};
  }
}

/**
 * Anthropic thinking blocks carry a signature the Anthropic API verifies when the
 * block is replayed. The OpenAI shape has no signature field, so synthesise a stable
 * one. It never needs to verify: anthropicToOpenAI() drops thinking blocks on the way
 * back up, so the upstream never sees it.
 */
function syntheticSignature(text) {
  return crypto.createHash('sha256').update(text || '').digest('base64').slice(0, 44);
}

// -- Anthropic → OpenAI -------------------------------------------------------

function systemToText(system) {
  if (!system) return null;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    const parts = system
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text);
    return parts.length ? parts.join('\n\n') : null;
  }
  return null;
}

function imagePart(block) {
  const src = (block && block.source) || {};
  if (src.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
  if (src.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map(part => {
    if (!part) return '';
    if (part.type === 'text') return part.text || '';
    if (part.type === 'image') return '[image]'; // a tool message body is a plain string
    return '';
  }).filter(Boolean).join('\n');
}

/**
 * Anthropic keeps tool results inside a user message; OpenAI wants them as their own
 * `tool` messages directly after the assistant turn that requested them. Order is
 * therefore preserved block-by-block, and any text/image the user added alongside a
 * tool result is appended as a following user message rather than interleaved.
 */
function messagesToOpenAI(messages) {
  const out = [];
  for (const msg of messages || []) {
    if (!msg) continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: msg.content == null ? '' : String(msg.content) }];

    if (role === 'assistant') {
      const text = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'text') text.push(b.text || '');
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || newId('call'),
            type: 'function',
            function: { name: b.name || 'unknown', arguments: JSON.stringify(b.input || {}) }
          });
        }
        // thinking / redacted_thinking are dropped: the OpenAI side has no field for
        // them, and replaying reasoning is not needed to keep the turn coherent.
      }
      const m = { role: 'assistant', content: text.join('') || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
      continue;
    }

    const rest = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: toolResultText(b.content) });
      } else if (b.type === 'text') {
        rest.push({ type: 'text', text: b.text || '' });
      } else if (b.type === 'image') {
        const part = imagePart(b);
        if (part) rest.push(part);
      } else if (b.type === 'document') {
        rest.push({ type: 'text', text: '[document omitted]' });
      }
    }
    if (rest.length) out.push({ role: 'user', content: rest });
  }
  return out;
}

function toolsToOpenAI(tools) {
  return (tools || []).filter(t => t && t.name).map(t => {
    const fn = { name: t.name, parameters: t.input_schema || { type: 'object', properties: {} } };
    if (t.description) fn.description = t.description;
    return { type: 'function', function: fn };
  });
}

function toolChoiceToOpenAI(choice) {
  if (!choice || typeof choice !== 'object') return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } };
  return undefined;
}

/**
 * @param {object} body  an Anthropic /v1/messages request body
 * @param {string} model the resolved upstream model id to call
 * @returns {object} an OpenAI /v1/chat/completions request body
 */
function anthropicToOpenAI(body, model) {
  const src = body || {};
  const messages = messagesToOpenAI(src.messages);
  const system = systemToText(src.system);
  if (system) messages.unshift({ role: 'system', content: system });

  const out = { model, messages };
  if (src.max_tokens != null) out.max_tokens = src.max_tokens;
  if (src.temperature != null) out.temperature = src.temperature;
  if (src.top_p != null) out.top_p = src.top_p;
  if (Array.isArray(src.stop_sequences) && src.stop_sequences.length) out.stop = src.stop_sequences;

  const tools = toolsToOpenAI(src.tools);
  if (tools.length) {
    out.tools = tools;
    const choice = toolChoiceToOpenAI(src.tool_choice);
    if (choice) out.tool_choice = choice;
  }

  if (src.stream) {
    out.stream = true;
    // without this the OpenAI stream carries no usage and Claude Code loses its
    // context accounting for the turn
    out.stream_options = { include_usage: true };
  }
  // src.thinking is dropped: OpenAI-compatible reasoning models stream
  // reasoning_content unconditionally, and there is no equivalent budget field.
  return out;
}

// -- OpenAI → Anthropic -------------------------------------------------------

const STOP_REASONS = { length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

function mapStopReason(finishReason) {
  return STOP_REASONS[finishReason] || 'end_turn';
}

function usageFrom(usage) {
  const u = usage || {};
  const details = u.prompt_tokens_details || {};
  return {
    input_tokens: Number(u.input_tokens != null ? u.input_tokens : u.prompt_tokens) || 0,
    output_tokens: Number(u.output_tokens != null ? u.output_tokens : u.completion_tokens) || 0,
    cache_read_input_tokens: Number(u.cache_read_input_tokens != null ? u.cache_read_input_tokens : details.cached_tokens) || 0
  };
}

function anthropicUsage(usage) {
  const u = usageFrom(usage);
  return { ...u, cache_creation_input_tokens: 0 };
}

function messageContentFrom(msg) {
  const content = [];
  if (msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: syntheticSignature(msg.reasoning_content) });
  }
  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    const text = msg.content.map(p => (p && p.text) || '').join('');
    if (text) content.push({ type: 'text', text });
  }
  for (const tc of msg.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: (tc && tc.id) || newId('toolu'),
      name: (tc && tc.function && tc.function.name) || 'unknown',
      input: parseToolArguments(tc && tc.function && tc.function.arguments)
    });
  }
  // An empty content array is not a valid assistant message; a reasoning-only turn
  // (tiny max_tokens) reaches this branch and still has to render as something.
  if (!content.length) content.push({ type: 'text', text: '' });
  return content;
}

/**
 * @param {object} json   an OpenAI chat completion response
 * @param {string} model  the Anthropic route name the client asked for
 * @returns {object} an Anthropic message response
 */
function openAIToAnthropic(json, model) {
  const body = json || {};
  const choice = (body.choices || [])[0] || {};
  const msg = choice.message || {};
  return {
    id: body.id || newId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content: messageContentFrom(msg),
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: anthropicUsage(body.usage)
  };
}

/** Wrap an upstream error so Claude Code sees the shape it knows how to report. */
function anthropicError(status, message) {
  const type = status === 401 || status === 403 ? 'authentication_error'
    : status === 404 ? 'not_found_error'
      : status === 429 ? 'rate_limit_error'
        : status >= 500 ? 'api_error'
          : 'invalid_request_error';
  return { type: 'error', error: { type, message: message || `upstream returned ${status}` } };
}

/** Pull the most useful human-readable string out of an upstream error body. */
function errorMessage(bodyText, status) {
  try {
    const parsed = JSON.parse(bodyText);
    const err = parsed && parsed.error;
    if (err && typeof err.message === 'string') return err.message;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch { /* not JSON */ }
  return `upstream returned ${status}`;
}

// -- SSE: OpenAI chunks → Anthropic events ------------------------------------

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Translate one OpenAI chat-completion SSE stream into Anthropic message events.
 *
 * The OpenAI stream reports usage only on its final chunk, so `message_start` goes
 * out with zero usage and `message_delta` carries the real numbers — the reverse of
 * what Anthropic does, but the same field the client reads either way.
 *
 * tool_use blocks are emitted complete instead of as input_json_delta: OpenAI
 * splinters the function name and its JSON arguments across chunks, and a block whose
 * name has not arrived yet cannot be opened (and a closed block cannot be reopened).
 */
function createStreamTranslator(model) {
  let started = false;
  let open = null;            // 'text' | 'thinking' | null
  let blockIndex = -1;
  let blocks = 0;
  let thinkingText = '';
  let messageId = null;
  let finishReason = null;
  let usage = null;
  let buffer = '';
  let pending = [];
  const toolCalls = new Map(); // OpenAI tool_call index → accumulated call

  function emit(event, data) { pending.push(sse(event, data)); }
  function drain() { const out = pending.join(''); pending = []; return out; }

  function start() {
    if (started) return;
    started = true;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId || newId('msg'),
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  function closeBlock() {
    if (!open) return;
    if (open === 'thinking') {
      // Anthropic always signs off a thinking block; the OpenAI shape has no
      // signature, so a synthetic one stands in (see syntheticSignature).
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'signature_delta', signature: syntheticSignature(thinkingText) }
      });
    }
    emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    open = null;
  }

  function openBlock(type) {
    if (open === type) return;
    closeBlock();
    start();
    blockIndex += 1;
    blocks += 1;
    open = type;
    if (type === 'thinking') {
      thinkingText = '';
      emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '' } });
    } else {
      emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
    }
  }

  function handleChunk(chunk) {
    if (!chunk) return;
    if (!messageId && typeof chunk.id === 'string') messageId = chunk.id;
    if (chunk.usage) usage = chunk.usage; // only the final chunk carries it
    const choice = (chunk.choices || [])[0];
    if (!choice) return;
    start();

    const delta = choice.delta || {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      openBlock('thinking');
      thinkingText += delta.reasoning_content;
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
      });
    }
    if (typeof delta.content === 'string' && delta.content) {
      openBlock('text');
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: delta.content }
      });
    }
    for (const tc of delta.tool_calls || []) {
      const key = typeof tc.index === 'number' ? tc.index : 0;
      const acc = toolCalls.get(key) || { id: null, name: '', args: '' };
      if (tc.id) acc.id = tc.id;
      if (tc.function && tc.function.name) acc.name += tc.function.name;
      if (tc.function && typeof tc.function.arguments === 'string') acc.args += tc.function.arguments;
      toolCalls.set(key, acc);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  function parseLine(raw) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line.startsWith('data:')) return; // ignore event:/id:/: comments
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
    handleChunk(chunk);
  }

  return {
    /** @param {string} text a decoded piece of the upstream SSE stream */
    feed(text) {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // last element is an incomplete line (or '')
      for (const line of lines) parseLine(line);
      return drain();
    },
    /** close the stream: pending tool calls, stop reason, usage, message_stop */
    end() {
      if (buffer) { parseLine(buffer); buffer = ''; }
      start();
      closeBlock();
      for (const key of [...toolCalls.keys()].sort((a, b) => a - b)) {
        const tc = toolCalls.get(key);
        blockIndex += 1;
        blocks += 1;
        emit('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: tc.id || newId('toolu'),
            name: tc.name || 'unknown',
            input: parseToolArguments(tc.args)
          }
        });
        emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      }
      if (!blocks) {
        // A turn with no content blocks at all is not a valid message.
        emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        emit('content_block_stop', { type: 'content_block_stop', index: 0 });
      }
      const u = usageFrom(usage);
      let stopReason = mapStopReason(finishReason);
      if (toolCalls.size && !finishReason) stopReason = 'tool_use';
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens }
      });
      emit('message_stop', { type: 'message_stop' });
      return drain();
    }
  };
}

module.exports = {
  anthropicToOpenAI,
  openAIToAnthropic,
  anthropicError,
  anthropicUsage,
  errorMessage,
  createStreamTranslator,
  mapStopReason,
  messagesToOpenAI,
  systemToText,
  syntheticSignature
};
