const BaseProvider = require('./base');
const { UpstreamError } = require('../lib/errors');
const { parseSSEJson } = require('../lib/sse');

class ClaudeProvider extends BaseProvider {
  constructor() {
    super('claude', 'Anthropic Claude', {
      model: 'claude-3-haiku-20240307',
      maxRPM: 5
    });
  }

  async chat(messages, apiKey) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Anthropic Claude', 401);

    const data = await this.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify(buildAnthropicBody(messages, this.model))
    });

    const text = (data?.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (!text) {
      throw new UpstreamError('Claude trả về phản hồi rỗng hoặc sai định dạng', 502);
    }

    return { text, usage: anthropicUsage(data.usage) };
  }

  async *stream(messages, apiKey) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Anthropic Claude', 401);

    const response = await this.requestRaw('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { ...anthropicHeaders(apiKey), Accept: 'text/event-stream' },
      body: JSON.stringify({ ...buildAnthropicBody(messages, this.model), stream: true })
    });

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
          // Anthropic báo lỗi giữa stream bằng một sự kiện, HTTP vẫn là 200.
          throw new UpstreamError(
            `Claude lỗi giữa stream: ${payload.error?.message || 'không rõ'}`,
            502
          );
      }
    }
  }
}

function anthropicHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
}

function buildAnthropicBody(messages, model) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

  const body = {
    model,
    max_tokens: 4096,
    messages: messages.filter((m) => m.role !== 'system')
  };
  if (system) body.system = system;
  return body;
}

function anthropicUsage(usage = {}) {
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

module.exports = ClaudeProvider;
