const BaseProvider = require('./base');
const { UpstreamError } = require('../lib/errors');
const { parseSSEJson } = require('../lib/sse');

class GeminiProvider extends BaseProvider {
  constructor() {
    super('gemini', 'Google Gemini', {
      model: 'gemini-2.0-flash',
      maxRPM: 15
    });
  }

  async chat(messages, apiKey) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Google Gemini', 401);

    // API key đi ở header, không ở query string: query string bị ghi vào log truy cập và
    // lịch sử proxy, nên key trên URL là key đã rò.
    const data = await this.request(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(buildGeminiBody(messages))
      }
    );

    const text = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text)
      .filter(Boolean)
      .join('');

    if (!text) {
      // Gemini chặn nội dung bằng HTTP 200 kèm `finishReason: SAFETY` — không có mã lỗi nào
      // để bắt, nên phải đọc lý do ra và nói rõ, thay vì báo chung chung "phản hồi rỗng".
      const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
      throw new UpstreamError(
        reason
          ? `Gemini không trả nội dung (lý do: ${reason})`
          : 'Gemini trả về phản hồi rỗng hoặc sai định dạng',
        502
      );
    }

    return { text, usage: geminiUsage(data.usageMetadata) };
  }

  async *stream(messages, apiKey) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Google Gemini', 401);

    const response = await this.requestRaw(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(buildGeminiBody(messages))
      }
    );

    for await (const { payload } of parseSSEJson(response)) {
      const text = payload?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join('');
      if (text) yield { text };
      if (payload?.usageMetadata) yield { usage: geminiUsage(payload.usageMetadata) };
    }
  }
}

/** Dịch messages chuẩn OpenAI sang body của Gemini. */
function buildGeminiBody(messages) {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

  const body = {
    contents: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }))
  };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  return body;
}

function geminiUsage(meta = {}) {
  return {
    prompt_tokens: Number(meta.promptTokenCount) || 0,
    completion_tokens: Number(meta.candidatesTokenCount) || 0,
    total_tokens: Number(meta.totalTokenCount) || 0
  };
}

module.exports = GeminiProvider;
