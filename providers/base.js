const { UpstreamError, upstreamErrorMessage } = require('../lib/errors');
const { parseSSEJson } = require('../lib/sse');
const { readRateLimit } = require('../lib/ratelimit');
const { CANONICAL, toOpenAI } = require('../lib/params');

/**
 * Một nhà cung cấp: bộ chuyển ngữ sang API của một hãng.
 *
 * Provider làm ba việc: gọi upstream, ném `UpstreamError` mang mã HTTP thật, và **khai
 * báo nó nói được phương ngữ gì**. Nó KHÔNG giữ trạng thái của lượt gọi — cooldown, cửa
 * sổ RPM, dấu LRU đều nằm ở `Account`, vì hạn mức được cấp cho từng API key chứ không cho
 * cả hãng. Trước đây trạng thái nằm ở đây, nên một key hết quota là cả hãng chết theo, kể
 * cả khi ba key còn lại vẫn nguyên hạn mức.
 *
 * `paramSupport` là phần "đúng chuẩn cho từng nhà cung cấp": mỗi hãng nhận một tập tham
 * số khác nhau và vài hãng (Cerebras) trả 400 cho tham số lạ thay vì bỏ qua. Gửi bừa cả
 * bộ tham số OpenAI cho tất cả nghĩa là những hãng khắt khe nhất sẽ hỏng ở đúng những
 * request có đặt tham số.
 */
class BaseProvider {
  constructor(name, displayName, options = {}) {
    this.name = name;
    this.displayName = displayName;
    this.model = options.model || '';
    this.maxRPM = options.maxRPM || 10;

    // Phương ngữ body/response: openai | gemini | anthropic | cohere.
    this.dialect = options.dialect || 'openai';
    // Tham số hãng này thật sự nhận (mặc định: cả bộ của OpenAI).
    this.paramSupport = options.paramSupport || CANONICAL;
    // Tên khác cho cùng một tham số, ví dụ Mistral gọi `seed` là `random_seed`.
    this.paramRename = options.paramRename || {};
    // Khoảng giá trị hẹp hơn mặc định, ví dụ Anthropic chỉ nhận `temperature` tới 1.
    this.paramRanges = options.paramRanges || undefined;
    // `stream_options: {include_usage:true}` — chỉ hãng nào hiểu mới được nhận, hãng khác
    // hoặc bỏ qua (mất gì đâu) hoặc trả 400 (mất cả request).
    this.streamUsage = options.streamUsage !== false;
    // Nhà cung cấp có nói được `tools`/`tool_choice` (function calling) không? Mặc định
    // theo phương ngữ `openai` là có (đúng chuẩn), phương ngữ khác phải tự khai báo vì mỗi
    // nhà một cách biểu diễn khác nhau. Router lọc pool theo cờ này khi request có `tools`:
    // ghim một request có function calling vào một nhà chưa nói được nó sẽ ra một câu trả
    // lời bỏ qua tool im lặng — hỏng tệ hơn cả việc thu hẹp pool.
    this.supportsTools = options.supportsTools !== undefined ? options.supportsTools : this.dialect === 'openai';
  }

  /** Dịch tham số chuẩn OpenAI sang phương ngữ của hãng này. */
  translateParams(params = {}) {
    return toOpenAI(params, {
      allow: this.paramSupport,
      rename: this.paramRename,
      ranges: this.paramRanges
    });
  }

  /**
   * Nhà cung cấp có đọc được số giây phải chờ từ THÂN lỗi không?
   *
   * Google là ca duy nhất bắt buộc: họ không gửi `Retry-After` mà giấu `retryDelay` trong
   * `error.details`. Mặc định trả `null` để mọi hãng khác giữ nguyên đường cũ (header).
   */
  retryAfterFromBody() {
    return null;
  }

  async chat() {
    throw new Error(`Provider ${this.name} chưa cài đặt chat()`);
  }

  /**
   * Thử một API key. Không đụng tới trạng thái nào: cùng một provider phục vụ nhiều tài
   * khoản, nên ghi kết quả của một key lên object dùng chung sẽ dán nhãn "hỏng" cho những
   * key chưa từng được thử.
   */
  async testConnection(apiKey) {
    try {
      await this.chat([{ role: 'user', content: 'Say "hello" only.' }], apiKey, {
        params: { max_tokens: 16 }
      });
      return { ok: true, message: 'Kết nối thành công!' };
    } catch (error) {
      return { ok: false, message: error.message, status: error.statusCode || 0 };
    }
  }

  // ---------- gọi HTTP ----------

  /**
   * Gọi upstream và chuẩn hóa mọi lỗi thành `UpstreamError`.
   *
   * Lỗi mạng được đánh dấu `isNetworkError` để router phân biệt "upstream từ chối" với
   * "ta không hỏi tới nơi" — hai thứ này đáng bị xử lý khác nhau.
   */
  async requestRaw(url, init, { timeoutMs = 120_000 } = {}) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const message = error.name === 'TimeoutError'
        ? `Quá hạn ${Math.round(timeoutMs / 1000)}s khi gọi ${this.displayName}`
        : `Lỗi mạng khi gọi ${this.displayName}: ${error.message}`;
      throw new UpstreamError(message, 503, { isNetworkError: true });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new UpstreamError(upstreamErrorMessage(response.status, body), response.status, {
        // Header trước, thân sau: `Retry-After` là câu trả lời chính thức, còn đọc thân là
        // đường vòng chỉ dành cho hãng không gửi header nào.
        retryAfter: response.headers.get('retry-after') ?? this.retryAfterFromBody(body),
        body,
        rateLimit: readRateLimit(response.headers)
      });
    }

    return response;
  }

  /** Như `requestRaw` nhưng parse JSON; trả kèm tín hiệu hạn mức đọc từ header. */
  async request(url, init, options = {}) {
    const response = await this.requestRaw(url, init, options);
    const rateLimit = readRateLimit(response.headers);
    const raw = await response.text();
    try {
      return { data: JSON.parse(raw), rateLimit };
    } catch {
      throw new UpstreamError(`${this.displayName} trả về JSON không hợp lệ`, 502, { body: raw });
    }
  }

  /**
   * Thân chung cho các nhà cung cấp nói chuẩn OpenAI Chat Completions
   * (Groq, OpenAI, OpenRouter, Mistral, Cerebras, DeepSeek, Together).
   */
  async openAICompatibleChat(messages, apiKey, { url, headers = {}, body = {}, model, params = {} } = {}) {
    if (!apiKey) throw new UpstreamError(`Cần có API key cho ${this.displayName}`, 401);

    const { data, rateLimit } = await this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...headers
      },
      body: JSON.stringify({
        model: model || this.model,
        messages,
        ...this.translateParams(params),
        ...this.translateTools(params),
        ...body
      })
    });

    const message = data?.choices?.[0]?.message;
    const text = message?.content;
    const toolCalls = normalizeToolCalls(message?.tool_calls);
    if ((typeof text !== 'string' || !text) && !toolCalls) {
      throw new UpstreamError(`${this.displayName} trả về phản hồi rỗng hoặc sai định dạng`, 502);
    }
    return { text: typeof text === 'string' ? text : '', toolCalls, usage: normalizeUsage(data.usage), rateLimit };
  }

  /** `tools`/`tool_choice` chỉ được gửi tới nhà cung cấp khai báo `supportsTools`. */
  translateTools(params = {}) {
    if (!this.supportsTools || !params.tools) return {};
    return {
      tools: params.tools,
      ...(params.tool_choice !== undefined ? { tool_choice: params.tool_choice } : {})
    };
  }

  // ---------- stream ----------

  /**
   * Phát câu trả lời theo từng mẩu.
   *
   * Là async generator: thân hàm chưa chạy cho tới lượt `next()` đầu tiên, nên lỗi lúc mở
   * kết nối vẫn ném ra ở lần lặp đầu và router bắt được để xoay vòng. Đó là điều kiện để
   * failover trước mẩu đầu tiên hoạt động.
   */
  async *stream() {
    throw new UpstreamError(`${this.displayName} chưa hỗ trợ stream`, 501);
  }

  /** Thân stream chung cho các nhà cung cấp chuẩn OpenAI. */
  async *streamOpenAICompatible(messages, apiKey, { url, headers = {}, body = {}, model, params = {} } = {}) {
    if (!apiKey) throw new UpstreamError(`Cần có API key cho ${this.displayName}`, 401);

    const response = await this.requestRaw(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
        ...headers
      },
      body: JSON.stringify({
        model: model || this.model,
        messages,
        stream: true,
        // Cerebras và Mistral không có tham số này: Cerebras trả 400 cho trường lạ, nên
        // gửi kèm là hỏng đúng những request đang muốn đếm token.
        ...(this.streamUsage ? { stream_options: { include_usage: true } } : {}),
        ...this.translateParams(params),
        ...this.translateTools(params),
        ...body
      })
    });

    yield { rateLimit: readRateLimit(response.headers) };

    // Lời gọi hàm tới theo mẩu: mỗi mẩu chỉ mang một PHẦN của tên hàm hoặc tham số JSON,
    // ghép theo `index` cho tới mẩu cuối cùng. Không có ranh giới rõ ràng như `usage`, nên
    // phải gom tới hết stream rồi mới phát ra một lần.
    const toolCalls = new Map();
    for await (const { payload } of parseSSEJson(response)) {
      const delta = payload?.choices?.[0]?.delta;
      if (delta?.content) yield { text: delta.content };
      if (delta?.tool_calls) accumulateToolCallDeltas(toolCalls, delta.tool_calls);
      // Mẩu cuối của OpenAI mang `usage` và `choices` rỗng.
      if (payload?.usage) yield { usage: normalizeUsage(payload.usage) };
    }

    if (toolCalls.size) {
      yield {
        toolCalls: [...toolCalls.keys()]
          .sort((a, b) => a - b)
          .map((i) => toolCalls.get(i))
      };
    }
  }
}

/** Gom các mẩu `delta.tool_calls` (OpenAI) theo `index` thành lời gọi hàm đầy đủ. */
function accumulateToolCallDeltas(acc, deltas) {
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    if (!acc.has(index)) acc.set(index, { id: '', type: 'function', function: { name: '', arguments: '' } });
    const entry = acc.get(index);
    if (delta.id) entry.id = delta.id;
    if (delta.function?.name) entry.function.name += delta.function.name;
    if (delta.function?.arguments) entry.function.arguments += delta.function.arguments;
  }
}

/** Kiểm tra `tool_calls` trong PHẢN HỒI (không phải delta stream); `null` nếu không có. */
function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  return toolCalls
    .filter((c) => c && c.function && typeof c.function.name === 'string')
    .map((c) => ({
      id: c.id || '',
      type: 'function',
      function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : '{}' }
    }));
}

/** Chuẩn hóa `usage` về đúng ba khóa của OpenAI để lớp trên ghi log không phải đoán. */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens ?? prompt + completion) || prompt + completion
  };
}

module.exports = BaseProvider;
module.exports.normalizeUsage = normalizeUsage;
module.exports.normalizeToolCalls = normalizeToolCalls;
