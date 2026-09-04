const { UpstreamError, upstreamErrorMessage } = require('../lib/errors');
const { cooldownFor } = require('../lib/failover');
const { parseSSEJson } = require('../lib/sse');

const RPM_WINDOW_MS = 60_000;

/**
 * Một nhà cung cấp trong pool.
 *
 * Provider chỉ làm hai việc: gọi upstream, và ném `UpstreamError` mang mã HTTP thật.
 * Provider KHÔNG tự quyết định cooldown — đó là việc của router, nơi duy nhất nhìn thấy
 * cả pool. Trước đây mỗi provider tự gọi `setCooldown(60)` cho riêng mình, nên không có
 * chỗ nào áp được một chính sách nhất quán.
 */
class BaseProvider {
  constructor(name, displayName, options = {}) {
    this.name = name;
    this.displayName = displayName;
    this.model = options.model || '';
    this.maxRPM = options.maxRPM || 10;

    this.status = 'inactive'; // inactive | active | rate_limited | error
    this.lastError = null;
    this.lastFailureStatus = 0;
    this.cooldownUntil = 0;

    // Cửa sổ đếm request trượt theo thời gian, tính lười khi cần.
    // Bản cũ dùng `setInterval` mỗi 60s cho MỖI provider và không bao giờ `clearInterval`:
    // 10 timer sống mãi, giữ process không thoát được và làm test treo.
    this.requestCount = 0;
    this.windowStartedAt = Date.now();

    // Lần cuối được chọn làm ứng viên đầu tiên. Router xoay vòng theo LRU trên trường này.
    this.lastUsedAt = 0;
  }

  /** Dọn cửa sổ RPM nếu đã qua 60s kể từ mốc bắt đầu. */
  _rollRequestWindow(now = Date.now()) {
    if (now - this.windowStartedAt >= RPM_WINDOW_MS) {
      this.requestCount = 0;
      this.windowStartedAt = now;
    }
  }

  isCoolingDown(now = Date.now()) {
    return this.cooldownUntil > now;
  }

  /** Còn bao nhiêu giây nữa thì hết cooldown (0 nếu đang sẵn sàng). */
  cooldownRemaining(now = Date.now()) {
    return this.isCoolingDown(now) ? Math.ceil((this.cooldownUntil - now) / 1000) : 0;
  }

  isAvailable(now = Date.now()) {
    if (this.status === 'inactive') return false;
    if (this.isCoolingDown(now)) return false;
    this._rollRequestWindow(now);
    if (this.requestCount >= this.maxRPM) return false;
    return true;
  }

  /**
   * Cho nhà cung cấp nghỉ sau một lỗi. `Retry-After` của upstream ghi đè bảng mặc định:
   * upstream biết rõ hơn ta khi nào nó sẵn sàng trở lại.
   */
  markUnavailable(statusCode, retryAfter = null, now = Date.now()) {
    const seconds = cooldownFor(statusCode, retryAfter, now);
    this.cooldownUntil = now + seconds * 1000;
    this.lastFailureStatus = Number(statusCode) || 0;
    this.status = 'rate_limited';
    return seconds;
  }

  /** Xóa cooldown thủ công (endpoint `/api/providers/reset`). */
  markHealthy() {
    this.cooldownUntil = 0;
    this.lastFailureStatus = 0;
    this.lastError = null;
    if (this.status !== 'inactive') this.status = 'active';
  }

  /**
   * Ghi nhận một lượt thành công.
   *
   * KHÔNG đụng tới `lastUsedAt`: dấu LRU do router đóng (`_stampUsed`) và phải đơn điệu
   * tăng. Gán lại `Date.now()` ở đây sẽ ghi đè dấu đó bằng một mốc thô — hai lượt rơi vào
   * cùng mili-giây là khóa LRU hòa nhau, thứ tự tụt về thứ tự khai báo, và pool kẹt vào
   * đúng một nhà cung cấp trong khi log vẫn trông bình thường.
   */
  markSuccess() {
    this.status = 'active';
    this.lastError = null;
    this.lastFailureStatus = 0;
  }

  async chat(messages, apiKey) {
    throw new Error(`Provider ${this.name} chưa cài đặt chat()`);
  }

  async testConnection(apiKey) {
    try {
      await this.chat([{ role: 'user', content: 'Say "hello" only.' }], apiKey);
      this.markHealthy();
      this.status = 'active';
      return true;
    } catch (error) {
      this.lastError = error.message;
      this.lastFailureStatus = error.statusCode || 0;
      return false;
    }
  }

  trackRequest(now = Date.now()) {
    this._rollRequestWindow(now);
    this.requestCount++;
  }

  getStatus(now = Date.now()) {
    this._rollRequestWindow(now);
    return {
      name: this.name,
      displayName: this.displayName,
      status: this.isCoolingDown(now) ? 'rate_limited' : this.status,
      model: this.model,
      requestCount: this.requestCount,
      maxRPM: this.maxRPM,
      cooldownUntil: this.cooldownUntil || null,
      cooldownRemaining: this.cooldownRemaining(now),
      lastFailureStatus: this.lastFailureStatus || null,
      lastError: this.lastError
    };
  }

  // ---------- gọi HTTP ----------

  /**
   * Gọi upstream và chuẩn hóa mọi lỗi thành `UpstreamError`.
   *
   * Lỗi mạng được đánh dấu `isNetworkError` để router phân biệt "upstream từ chối" với
   * "ta không hỏi tới nơi" — hai thứ này đáng bị xử lý khác nhau.
   */
  async requestRaw(url, init, { timeoutMs = 120_000 } = {}) {
    this.trackRequest();

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
        retryAfter: response.headers.get('retry-after'),
        body
      });
    }

    return response;
  }

  async request(url, init, options = {}) {
    const response = await this.requestRaw(url, init, options);
    const raw = await response.text();
    try {
      return JSON.parse(raw);
    } catch {
      throw new UpstreamError(`${this.displayName} trả về JSON không hợp lệ`, 502, { body: raw });
    }
  }

  /**
   * Thân chung cho các nhà cung cấp nói chuẩn OpenAI Chat Completions
   * (Groq, OpenAI, OpenRouter, Mistral, Cerebras, DeepSeek, Together).
   */
  async openAICompatibleChat(messages, apiKey, { url, headers = {}, body = {} } = {}) {
    if (!apiKey) throw new UpstreamError(`Cần có API key cho ${this.displayName}`, 401);

    const data = await this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...headers
      },
      body: JSON.stringify({ model: this.model, messages, ...body })
    });

    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text) {
      throw new UpstreamError(`${this.displayName} trả về phản hồi rỗng hoặc sai định dạng`, 502);
    }
    return { text, usage: normalizeUsage(data.usage) };
  }

  // ---------- stream ----------

  /**
   * Phát câu trả lời theo từng mẩu.
   *
   * Là async generator: thân hàm chưa chạy cho tới lượt `next()` đầu tiên, nên lỗi lúc mở
   * kết nối vẫn ném ra ở lần lặp đầu và router bắt được để xoay vòng. Đó là điều kiện để
   * failover trước mẩu đầu tiên hoạt động.
   */
  async *stream(messages, apiKey) {
    throw new UpstreamError(`${this.displayName} chưa hỗ trợ stream`, 501);
  }

  /** Thân stream chung cho các nhà cung cấp chuẩn OpenAI. */
  async *streamOpenAICompatible(messages, apiKey, { url, headers = {}, body = {} } = {}) {
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
        model: this.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...body
      })
    });

    for await (const { payload } of parseSSEJson(response)) {
      const delta = payload?.choices?.[0]?.delta?.content;
      if (delta) yield { text: delta };
      // Mẩu cuối của OpenAI mang `usage` và `choices` rỗng.
      if (payload?.usage) yield { usage: normalizeUsage(payload.usage) };
    }
  }
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
module.exports.RPM_WINDOW_MS = RPM_WINDOW_MS;
