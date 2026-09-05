const BaseProvider = require('./base');
const { UpstreamError } = require('../lib/errors');
const { parseSSEJson } = require('../lib/sse');
const { readRateLimit } = require('../lib/ratelimit');
const { toAnthropic } = require('../lib/params');
const { toAlternating, splitSystem, dropLeadingAssistant } = require('../lib/messages');

const URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MAX_TOKENS = 4096;

class ClaudeProvider extends BaseProvider {
  constructor(options = {}) {
    super('claude', 'Anthropic Claude', {
      model: 'claude-3-haiku-20240307',
      maxRPM: 5,
      dialect: 'anthropic',
      // Anthropic không có `seed`, `presence_penalty`, `frequency_penalty` hay `user` —
      // và trả 400 cho trường lạ, nên gửi kèm là làm hỏng cả request.
      paramSupport: ['temperature', 'top_p', 'top_k', 'max_tokens', 'stop'],
      // `temperature` của Anthropic chỉ tới 1, trong khi chuẩn OpenAI cho tới 2.
      paramRanges: { temperature: [0, 1], top_p: [0, 1], top_k: [1, 500] },
      supportsTools: true,
      ...options
    });
    this.defaultMaxTokens = options.defaultMaxTokens || DEFAULT_MAX_TOKENS;
  }

  translateParams(params = {}) {
    return toAnthropic(params, {
      allow: this.paramSupport,
      ranges: this.paramRanges,
      defaultMaxTokens: this.defaultMaxTokens
    });
  }

  async chat(messages, apiKey, { model, params = {} } = {}) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Anthropic Claude', 401);

    const { data, rateLimit } = await this.request(URL, {
      method: 'POST',
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify(this.buildBody(messages, params, model, apiKey))
    });

    const text = (data?.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = anthropicToolCalls(data?.content);

    if (!text && !toolCalls) {
      throw new UpstreamError('Claude trả về phản hồi rỗng hoặc sai định dạng', 502);
    }

    return { text, toolCalls, usage: anthropicUsage(data.usage), rateLimit };
  }

  async *stream(messages, apiKey, { model, params = {} } = {}) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Anthropic Claude', 401);

    const response = await this.requestRaw(URL, {
      method: 'POST',
      headers: { ...anthropicHeaders(apiKey), Accept: 'text/event-stream' },
      body: JSON.stringify({ ...this.buildBody(messages, params, model, apiKey), stream: true })
    });

    yield { rateLimit: readRateLimit(response.headers) };

    // Anthropic đếm token đầu vào ở `message_start` và token đầu ra ở `message_delta`;
    // gộp lại mới ra usage đầy đủ.
    let promptTokens = 0;
    // Lời gọi hàm tới theo `content_block_start` (mở khối, mang id + tên) rồi
    // `content_block_delta` kiểu `input_json_delta` (mảnh JSON của tham số) — khác hẳn
    // khuôn `tool_calls` một cục của OpenAI, nên phải gom theo `index` tới `message_stop`.
    const toolBlocks = new Map();

    for await (const { payload } of parseSSEJson(response)) {
      switch (payload?.type) {
        case 'message_start':
          promptTokens = Number(payload.message?.usage?.input_tokens) || 0;
          break;
        case 'content_block_start':
          if (payload.content_block?.type === 'tool_use') {
            toolBlocks.set(payload.index, {
              id: payload.content_block.id,
              name: payload.content_block.name,
              args: ''
            });
          }
          break;
        case 'content_block_delta':
          if (payload.delta?.type === 'text_delta' && payload.delta.text) {
            yield { text: payload.delta.text };
          } else if (payload.delta?.type === 'input_json_delta' && toolBlocks.has(payload.index)) {
            toolBlocks.get(payload.index).args += payload.delta.partial_json || '';
          }
          break;
        case 'message_delta': {
          const completion = Number(payload.usage?.output_tokens) || 0;
          yield {
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completion,
              total_tokens: promptTokens + completion
            }
          };
          break;
        }
        case 'message_stop':
          if (toolBlocks.size) {
            yield {
              toolCalls: [...toolBlocks.values()].map((t) => ({
                id: t.id,
                type: 'function',
                function: { name: t.name, arguments: t.args || '{}' }
              }))
            };
          }
          break;
        case 'error':
          // Anthropic báo lỗi giữa stream bằng một sự kiện, HTTP vẫn là 200. `overloaded_error`
          // là ca thường gặp nhất và nó đáng được xoay vòng như một 529, nên phải mang đúng
          // mã đó ra ngoài chứ không gộp hết vào 502.
          throw new UpstreamError(
            `Claude lỗi giữa stream: ${payload.error?.message || 'không rõ'}`,
            payload.error?.type === 'overloaded_error' ? 529 : 502
          );
      }
    }
  }

  buildBody(messages, params, model, apiKey) {
    const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
    const { system, turns } = hasTools ? toAnthropicTurns(messages) : toAlternating(messages);
    const body = {
      model: model || this.model,
      // `max_tokens` là trường BẮT BUỘC của API này — thiếu nó là 400 chứ không phải một
      // giá trị mặc định nào đó của họ.
      ...this.translateParams(params),
      messages: turns
    };
    if (hasTools) {
      body.tools = params.tools.map(toAnthropicTool);
      const choice = toAnthropicToolChoice(params.tool_choice);
      if (choice) body.tool_choice = choice;
    }
    // Token subscription (Claude Pro/Max) không đi qua Console nên không mang `system` của
    // riêng nhà phát triển — Anthropic đòi request phải tự xưng là Claude Code, nếu không
    // trả 401. API key thường (`sk-ant-api...`) không có ràng buộc này.
    if (isSubscriptionToken(apiKey)) {
      body.system = [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }, ...(system ? [{ type: 'text', text: system }] : [])];
    } else if (system) {
      body.system = system;
    }
    return body;
  }
}

/**
 * Token subscription (đăng nhập Claude Pro/Max qua OAuth) khác hẳn API key Console:
 * `sk-ant-oat...` thay vì `sk-ant-api...`. Loại token này không dùng `x-api-key` mà dùng
 * `Authorization: Bearer` kèm header beta `oauth-2025-04-20` — đúng thứ Claude Code (CLI)
 * gửi khi người dùng đăng nhập bằng tài khoản subscription thay vì dán API key.
 */
function isSubscriptionToken(apiKey) {
  return /^sk-ant-oat/i.test(String(apiKey || ''));
}

const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

function anthropicHeaders(apiKey) {
  if (isSubscriptionToken(apiKey)) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20'
    };
  }
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
}

/**
 * Chuyển hội thoại có function calling sang khối nội dung Anthropic.
 *
 * `toAlternating` (dùng cho lượt chat thường) gộp mọi content về CHUỖI — không đủ chỗ chứa
 * `tool_use`/`tool_result`, hai loại khối bắt buộc phải mang `id` gắn với đúng lời gọi.
 * Nên khi request có `tools`, hội thoại đi qua đường riêng này: build khối trước, merge
 * lượt liên tiếp sau (nối MẢNG thay vì nối chuỗi).
 */
function toAnthropicTurns(messages) {
  const { system, chat } = splitSystem(messages);
  const blocks = dropLeadingAssistant(chat.map(messageToAnthropicBlocks));
  const turns = mergeAnthropicConsecutive(blocks);
  if (!turns.length) {
    throw new UpstreamError('Hội thoại phải có ít nhất một lượt của user', 400);
  }
  return { system, turns };
}

function messageToAnthropicBlocks(m) {
  if (m.role === 'tool') {
    // Kết quả hàm là một khối `tool_result` gắn trong lượt USER kế tiếp — Anthropic không
    // có vai `tool` riêng, tool_result đứng chung hàng với input của người dùng.
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || '' }] };
  }
  if (m.role === 'assistant' && m.tool_calls) {
    const content = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const call of m.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(call.function.arguments || '{}');
      } catch {
        input = {};
      }
      content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
    }
    return { role: 'assistant', content };
  }
  return { role: m.role, content: [{ type: 'text', text: m.content || '' }] };
}

/** Như `mergeConsecutive` nhưng nối MẢNG khối thay vì nối chuỗi. */
function mergeAnthropicConsecutive(chat) {
  const out = [];
  for (const m of chat) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = last.content.concat(m.content);
    } else {
      out.push({ role: m.role, content: m.content.slice() });
    }
  }
  return out;
}

/** Khai báo hàm chuẩn OpenAI → phương ngữ Anthropic (`input_schema` thay vì `parameters`). */
function toAnthropicTool(tool) {
  return {
    name: tool.function.name,
    description: tool.function.description || '',
    input_schema: tool.function.parameters || { type: 'object', properties: {} }
  };
}

/**
 * `tool_choice` chuẩn OpenAI → Anthropic. `"none"` không có tương đương trực tiếp (Anthropic
 * chỉ tắt được tool bằng cách không gửi `tools`), nên bị bỏ qua ở đây — an toàn hơn từ chối
 * cả request vì model vẫn có thể chọn không gọi hàm nào với `type:"auto"`.
 */
function toAnthropicToolChoice(choice) {
  if (!choice || choice === 'auto' || choice === 'none') return undefined;
  if (choice === 'required') return { type: 'any' };
  if (typeof choice === 'object' && choice.type === 'function') {
    return { type: 'tool', name: choice.function.name };
  }
  return undefined;
}

/** Khối `tool_use` trong phản hồi → `tool_calls` chuẩn OpenAI; `null` nếu không có. */
function anthropicToolCalls(content) {
  const blocks = (content || []).filter((b) => b.type === 'tool_use');
  if (!blocks.length) return null;
  return blocks.map((b) => ({
    id: b.id,
    type: 'function',
    function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
  }));
}

function anthropicUsage(usage = {}) {
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

module.exports = ClaudeProvider;
module.exports.isSubscriptionToken = isSubscriptionToken;
