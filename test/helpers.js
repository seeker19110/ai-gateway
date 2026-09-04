const BaseProvider = require('../providers/base');
const { UpstreamError, upstreamErrorMessage } = require('../lib/errors');

/** Logger im lặng, có ghi lại dòng log để test khẳng định được nội dung. */
function silentLogger() {
  const lines = [];
  const push = (level) => (msg) => lines.push(`${level} ${msg}`);
  return { lines, info: push('INFO'), warn: push('WARN'), error: push('ERROR') };
}

/**
 * Provider giả: đưa vào một hàng kịch bản, mỗi lượt gọi lấy một cái.
 * Kịch bản là `{ ok: 'text' }`, hoặc `{ status, body?, retryAfter? }`, hoặc `{ network: true }`.
 */
class FakeProvider extends BaseProvider {
  constructor(name, script = [], options = {}) {
    super(name, name.toUpperCase(), { model: `${name}-model`, maxRPM: options.maxRPM || 100 });
    this.script = [...script];
    this.calls = 0;
    this.status = 'active';
  }

  async chat() {
    this.calls++;
    const step = this.script.shift() || { ok: `${this.name} mặc định` };

    if (step.network) {
      throw new UpstreamError(`mạng hỏng ở ${this.name}`, 503, { isNetworkError: true });
    }
    if (step.status) {
      // Dùng đúng `upstreamErrorMessage` như provider thật, để test khẳng định được nội
      // dung thông điệp mà không phải tin vào một định dạng riêng của đồ giả.
      const message = step.body
        ? upstreamErrorMessage(step.status, step.body)
        : `${this.name} lỗi ${step.status}`;
      throw new UpstreamError(message, step.status, {
        body: step.body || '',
        retryAfter: step.retryAfter || null
      });
    }
    return { text: step.ok, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }

  /**
   * Kịch bản stream thêm hai dạng:
   * - `{ chunks: ['a','b'] }` — phát từng mẩu rồi kết thúc bình thường.
   * - `{ chunks: [...], thenFail: 500 }` — phát vài mẩu rồi đứt GIỮA stream.
   */
  async *stream() {
    this.calls++;
    const step = this.script.shift() || { ok: `${this.name} mặc định` };

    if (step.network) {
      throw new UpstreamError(`mạng hỏng ở ${this.name}`, 503, { isNetworkError: true });
    }
    if (step.status) {
      const message = step.body
        ? upstreamErrorMessage(step.status, step.body)
        : `${this.name} lỗi ${step.status}`;
      throw new UpstreamError(message, step.status, {
        body: step.body || '',
        retryAfter: step.retryAfter || null
      });
    }

    for (const text of step.chunks || [step.ok]) {
      yield { text };
    }
    if (step.thenFail) {
      throw new UpstreamError(`${this.name} đứt giữa stream`, step.thenFail);
    }
    yield { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }
}

/** Pool provider giả theo thứ tự khai báo. */
function fakePool(spec) {
  const pool = {};
  for (const [name, script] of Object.entries(spec)) {
    pool[name] = new FakeProvider(name, script);
  }
  return pool;
}

/** Thay `global.fetch` bằng một hàm kịch bản; trả về hàm hoàn tác. */
function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

/** Dựng một Response giả đủ dùng cho `BaseProvider.request`. */
function jsonResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => text
  };
}

module.exports = { FakeProvider, fakePool, silentLogger, stubFetch, jsonResponse };
