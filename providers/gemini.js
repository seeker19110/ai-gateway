const BaseProvider = require('./base');
const { UpstreamError } = require('../lib/errors');
const { parseSSEJson } = require('../lib/sse');
const { readRateLimit, retryDelayFromGoogleError } = require('../lib/ratelimit');
const { toGemini } = require('../lib/params');
const { toAlternating } = require('../lib/messages');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

class GeminiProvider extends BaseProvider {
  constructor(options = {}) {
    super('gemini', 'Google Gemini', {
      model: 'gemini-2.0-flash',
      maxRPM: 15,
      dialect: 'gemini',
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
      ...options
    });
  }

  translateParams(params = {}) {
    return toGemini(params, { allow: this.paramSupport, ranges: this.paramRanges });
  }

  /**
   * Google không gửi `Retry-After`; số giây phải chờ nằm trong `error.details[].retryDelay`.
   * Đọc được nó là khác biệt giữa nghỉ 27 giây và nghỉ nguyên một tiếng theo mặc định.
   */
  retryAfterFromBody(body) {
    return retryDelayFromGoogleError(body);
  }

  async chat(messages, apiKey, { model, params = {} } = {}) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Google Gemini', 401);

    // API key đi ở header, không ở query string: query string bị ghi vào log truy cập và
    // lịch sử proxy, nên key trên URL là key đã rò.
    const { data, rateLimit } = await this.request(
      `${BASE_URL}/${model || this.model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(this.buildBody(messages, params))
      }
    );

    const text = readText(data);
    if (!text) throw blockedError(data);

    return { text, usage: geminiUsage(data.usageMetadata), rateLimit };
  }

  async *stream(messages, apiKey, { model, params = {} } = {}) {
    if (!apiKey) throw new UpstreamError('Cần có API key cho Google Gemini', 401);

    const response = await this.requestRaw(
      `${BASE_URL}/${model || this.model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(this.buildBody(messages, params))
      }
    );

    yield { rateLimit: readRateLimit(response.headers) };

    // Gemini nhắc lại `usageMetadata` ở MỌI mẩu, với con số cộng dồn. Phát từng mẩu một
    // sẽ đẩy ra hàng chục sự kiện usage cho một câu trả lời, và client cộng chúng lại sẽ
    // ra một tổng vô nghĩa. Chỉ giữ mẩu cuối — đó mới là tổng thật.
    let usage = null;
    let sawText = false;

    for await (const { payload } of parseSSEJson(response)) {
      const text = readText(payload);
      if (text) {
        sawText = true;
        yield { text };
      }
      if (payload?.usageMetadata) usage = geminiUsage(payload.usageMetadata);

      // Gemini chặn nội dung bằng HTTP 200: stream mở ra bình thường rồi đóng lại với
      // `finishReason: SAFETY` và không một chữ nào. Im lặng ở đây sẽ hiện ra ở client
      // như một câu trả lời rỗng không lý do.
      const finish = payload?.candidates?.[0]?.finishReason;
      if (!sawText && finish && finish !== 'STOP') throw blockedError(payload);
    }

    if (usage) yield { usage };
  }

  buildBody(messages, params) {
    const { system, turns } = toAlternating(messages);

    const body = {
      contents: turns.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      ...this.translateParams(params)
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return body;
  }
}

function readText(payload) {
  return payload?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    .filter(Boolean)
    .join('') || '';
}

/**
 * Gemini chặn nội dung bằng HTTP 200 kèm `finishReason: SAFETY` — không có mã lỗi nào để
 * bắt, nên phải đọc lý do ra và nói rõ, thay vì báo chung chung "phản hồi rỗng".
 */
function blockedError(payload) {
  const reason = payload?.candidates?.[0]?.finishReason || payload?.promptFeedback?.blockReason;
  return new UpstreamError(
    reason
      ? `Gemini không trả nội dung (lý do: ${reason})`
      : 'Gemini trả về phản hồi rỗng hoặc sai định dạng',
    502
  );
}

function geminiUsage(meta = {}) {
  return {
    prompt_tokens: Number(meta.promptTokenCount) || 0,
    completion_tokens: Number(meta.candidatesTokenCount) || 0,
    total_tokens: Number(meta.totalTokenCount) || 0
  };
}

module.exports = GeminiProvider;
