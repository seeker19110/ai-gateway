const BaseProvider = require('../providers/base');
const { UpstreamError, upstreamErrorMessage } = require('../lib/errors');
const { AccountPool } = require('../lib/pool');

/** Logger im lặng, có ghi lại dòng log để test khẳng định được nội dung. */
function silentLogger() {
  const lines = [];
  const push = (level) => (msg) => lines.push(`${level} ${msg}`);
  return { lines, info: push('INFO'), warn: push('WARN'), error: push('ERROR') };
}

/**
 * Provider giả: mỗi API key có một hàng kịch bản riêng, mỗi lượt gọi lấy một cái.
 *
 * Kịch bản theo KEY chứ không theo provider, vì đó chính là thứ cần kiểm chứng ở bản này:
 * hai key của cùng một nhà cung cấp phải hỏng và hồi phục độc lập với nhau.
 *
 * Mỗi bước là `{ ok: 'text' }`, `{ status, body?, retryAfter?, rateLimit? }`,
 * `{ network: true }`, hoặc (chỉ cho stream) `{ chunks: [...], thenFail? }`.
 */
class FakeProvider extends BaseProvider {
  constructor(name, scripts = {}, options = {}) {
    super(name, name.toUpperCase(), { model: `${name}-model`, maxRPM: options.maxRPM || 100 });
    this.scripts = new Map(Object.entries(scripts).map(([key, steps]) => [key, [...steps]]));
    this.calls = 0;
    this.callsByKey = new Map();
    this.seenParams = [];
    this.seenModels = [];
  }

  _next(apiKey, options = {}) {
    this.calls++;
    this.callsByKey.set(apiKey, (this.callsByKey.get(apiKey) || 0) + 1);
    this.seenParams.push(options.params || {});
    this.seenModels.push(options.model || this.model);

    const queue = this.scripts.get(apiKey);
    const step = (queue && queue.shift()) || { ok: `${this.name} mặc định` };

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
        retryAfter: step.retryAfter || null,
        rateLimit: step.rateLimit || null
      });
    }
    return step;
  }

  async chat(messages, apiKey, options = {}) {
    const step = this._next(apiKey, options);
    return {
      text: step.ok,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      rateLimit: step.rateLimit || null
    };
  }

  async *stream(messages, apiKey, options = {}) {
    const step = this._next(apiKey, options);
    yield { rateLimit: step.rateLimit || null };

    for (const text of step.chunks || [step.ok]) {
      yield { text };
    }
    if (step.thenFail) {
      throw new UpstreamError(`${this.name} đứt giữa stream`, step.thenFail);
    }
    yield { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }
}

/**
 * Dựng pool giả từ một đặc tả gọn.
 *
 * `{ a: [kịch bản] }`                → nhà `a` với đúng một tài khoản (`key-a-1`).
 * `{ a: { 'k1': [...], 'k2': [...] } }` → nhà `a` với hai tài khoản, mỗi key một kịch bản.
 */
function fakePool(spec, { strategy = 'account', env = {} } = {}) {
  const providers = {};
  const fakeEnv = { ...env };

  for (const [name, value] of Object.entries(spec)) {
    const scripts = Array.isArray(value) ? { [`key-${name}-1`]: value } : value;
    providers[name] = new FakeProvider(name, scripts);
    fakeEnv[`${name.toUpperCase()}_API_KEYS`] = Object.keys(scripts).join(',');
  }

  const pool = new AccountPool(providers, { env: fakeEnv, strategy });
  return { providers, pool, env: fakeEnv };
}

/** Tài khoản thứ `index` của một nhà cung cấp — chỗ giữ cooldown/RPM trong pool. */
function acct(pool, name, index = 0) {
  return pool.accountsOf(name)[index];
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

module.exports = { FakeProvider, fakePool, acct, silentLogger, stubFetch, jsonResponse };
