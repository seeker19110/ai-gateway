const BaseProvider = require('./base');
const { UpstreamError } = require('../lib/errors');
const { parseSSEJson } = require('../lib/sse');
const { readRateLimit } = require('../lib/ratelimit');
const { toAnthropic } = require('../lib/params');
const { toAlternating } = require('../lib/messages');

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

    if (!text) {
      throw new UpstreamError('Claude trả về phản hồi rỗng hoặc sai định dạng', 502);
    }

    return { text, usage: anthropicUsage(data.usage), rateLimit };
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

    for await (const { payload } of parseSSEJson(response)) {
      switch (payload?.type) {
        case 'message_start':
          promptTokens = Number(payload.message?.usage?.input_tokens) || 0;
          break;
        case 'content_block_delta':
          if (payload.delta?.type === 'text_delta' && payload.delta.text) {
            yield { text: payload.delta.text };
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
    const { system, turns } = toAlternating(messages);
    const body = {
      model: model || this.model,
      // `max_tokens` là trường BẮT BUỘC của API này — thiếu nó là 400 chứ không phải một
      // giá trị mặc định nào đó của họ.
      ...this.translateParams(params),
      messages: turns
    };
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

function anthropicUsage(usage = {}) {
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

module.exports = ClaudeProvider;
module.exports.isSubscriptionToken = isSubscriptionToken;
