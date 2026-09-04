const BaseProvider = require('./base');
const { UpstreamError } = require('../lib/errors');
const { parseSSEJson } = require('../lib/sse');
const { readRateLimit } = require('../lib/ratelimit');
const { toCohere } = require('../lib/params');
const { flattenContent } = require('../lib/messages');

const URL = 'https://api.cohere.com/v2/chat';

class CohereProvider extends BaseProvider {
  constructor(options = {}) {
    super('cohere', 'Cohere', {
      model: 'command-r7b-12-2024',
      maxRPM: 10,
      dialect: 'cohere',
      // Cohere v2 gọi `top_p` là `p` và `top_k` là `k`; `user` thì không có.
      paramSupport: [
        'temperature',
        'top_p',
        'top_k',
        'max_tokens',
        'stop',
        'seed',
        'presence_penalty',
        'frequency_penalty',
        'response_format'
      ],
      paramRanges: { temperature: [0, 1], top_p: [0.01, 0.99], top_k: [0, 500] },
      ...options
    });
  }

  translateParams(params = {}) {
    return toCohere(params, { allow: this.paramSupport, ranges: this.paramRanges });
  }

  async chat(messages, apiKey, { model, params = {} } = {}) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Cohere', 401);

    const { data, rateLimit } = await this.request(URL, {
      method: 'POST',
      headers: cohereHeaders(apiKey),
      body: JSON.stringify(this.buildBody(messages, params, model))
    });

    const text = (data?.message?.content || [])
      .map((c) => c.text)
      .filter(Boolean)
      .join('');

    if (!text) {
      throw new UpstreamError('Cohere trả về phản hồi rỗng hoặc sai định dạng', 502);
    }

    return { text, usage: cohereUsage(data.usage), rateLimit };
  }

  async *stream(messages, apiKey, { model, params = {} } = {}) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Cohere', 401);

    const response = await this.requestRaw(URL, {
      method: 'POST',
      headers: { ...cohereHeaders(apiKey), Accept: 'text/event-stream' },
      body: JSON.stringify({ ...this.buildBody(messages, params, model), stream: true })
    });

    yield { rateLimit: readRateLimit(response.headers) };

    for await (const { payload } of parseSSEJson(response)) {
      if (payload?.type === 'content-delta') {
        const text = payload.delta?.message?.content?.text;
        if (text) yield { text };
      } else if (payload?.type === 'message-end') {
        yield { usage: cohereUsage(payload.delta?.usage) };
      }
    }
  }

  buildBody(messages, params, model) {
    return {
      model: model || this.model,
      messages: messages.map((m) => ({
        role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user',
        content: flattenContent(m.content) ?? ''
      })),
      ...this.translateParams(params)
    };
  }
}

function cohereHeaders(apiKey) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

/**
 * Cohere v2 trả hai bộ đếm: `tokens` là số token thật, `billed_units` là số token bị tính
 * tiền (đã trừ phần cache/không tính phí). Ưu tiên `tokens` vì lớp trên đang báo cáo
 * "usage" theo nghĩa của OpenAI — số token của lượt gọi, không phải hóa đơn.
 */
function cohereUsage(usage = {}) {
  const counts = usage?.tokens || usage?.billed_units || {};
  const prompt = Number(counts.input_tokens) || 0;
  const completion = Number(counts.output_tokens) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

module.exports = CohereProvider;
