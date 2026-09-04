const BaseProvider = require('./base');
const { UpstreamError } = require('../lib/errors');
const { parseSSEJson } = require('../lib/sse');

class CohereProvider extends BaseProvider {
  constructor() {
    super('cohere', 'Cohere', {
      model: 'command-r7b-12-2024',
      maxRPM: 10
    });
  }

  async chat(messages, apiKey) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Cohere', 401);

    const data = await this.request('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: cohereHeaders(apiKey),
      body: JSON.stringify({ model: this.model, messages: normalizeCohereMessages(messages) })
    });

    const text = (data?.message?.content || [])
      .map((c) => c.text)
      .filter(Boolean)
      .join('');

    if (!text) {
      throw new UpstreamError('Cohere trả về phản hồi rỗng hoặc sai định dạng', 502);
    }

    return { text, usage: cohereUsage(data.usage) };
  }

  async *stream(messages, apiKey) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Cohere', 401);

    const response = await this.requestRaw('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: { ...cohereHeaders(apiKey), Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: this.model,
        messages: normalizeCohereMessages(messages),
        stream: true
      })
    });

    for await (const { payload } of parseSSEJson(response)) {
      if (payload?.type === 'content-delta') {
        const text = payload.delta?.message?.content?.text;
        if (text) yield { text };
      } else if (payload?.type === 'message-end') {
        yield { usage: cohereUsage(payload.delta?.usage) };
      }
    }
  }
}

function cohereHeaders(apiKey) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

function normalizeCohereMessages(messages) {
  return messages.map((m) => ({
    role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));
}

function cohereUsage(usage = {}) {
  const billed = usage?.billed_units || usage?.tokens || {};
  const prompt = Number(billed.input_tokens) || 0;
  const completion = Number(billed.output_tokens) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

module.exports = CohereProvider;
