/**
 * Đọc tín hiệu hạn mức mà nhà cung cấp tự gửi kèm mỗi phản hồi.
 *
 * Không có phần này thì cách duy nhất để biết một key đã cạn hạn mức là **đâm vào nó**:
 * gửi một request nữa, ăn 429, rồi mới cho nghỉ. Với một tài khoản thì đó chỉ là một lượt
 * chậm; với mười tài khoản thì đó là mười lượt 429 — và vài nhà cung cấp tính cả request
 * bị từ chối vào hạn mức, nên cách đó tự kéo dài đúng cái nó đang cố tránh.
 *
 * Ba họ header, vì không nhà nào chịu giống nhà nào:
 * - `x-ratelimit-remaining-requests` / `-reset-requests` — OpenAI, Groq, Together, DeepSeek.
 * - `anthropic-ratelimit-requests-remaining` / `-reset` — Anthropic (reset là mốc RFC-3339).
 * - `ratelimit-remaining` / `ratelimit-reset` — bản nháp IETF, OpenRouter và vài nhà khác dùng.
 */

const FAMILIES = [
  { remaining: 'x-ratelimit-remaining-requests', reset: 'x-ratelimit-reset-requests' },
  { remaining: 'x-ratelimit-remaining-tokens', reset: 'x-ratelimit-reset-tokens' },
  { remaining: 'anthropic-ratelimit-requests-remaining', reset: 'anthropic-ratelimit-requests-reset' },
  { remaining: 'anthropic-ratelimit-tokens-remaining', reset: 'anthropic-ratelimit-tokens-reset' },
  { remaining: 'ratelimit-remaining', reset: 'ratelimit-reset' },
  { remaining: 'x-ratelimit-remaining', reset: 'x-ratelimit-reset' }
];

/**
 * `{ remaining, resetSeconds }` của hạn mức CĂNG NHẤT đang có, hoặc `null` nếu upstream
 * không nói gì. Lấy cái căng nhất vì hạn mức nào chạm trần trước thì hạn mức đó chặn —
 * còn dư 5000 token mà hết lượt request thì vẫn là hết.
 */
function readRateLimit(headers) {
  if (!headers || typeof headers.get !== 'function') return null;

  let best = null;
  for (const family of FAMILIES) {
    const remainingRaw = headers.get(family.remaining);
    if (remainingRaw === null || remainingRaw === undefined || remainingRaw === '') continue;

    const remaining = Number(remainingRaw);
    if (!Number.isFinite(remaining)) continue;

    const resetSeconds = parseReset(headers.get(family.reset));
    if (!best || remaining < best.remaining) best = { remaining, resetSeconds };
  }
  return best;
}

/**
 * Mốc reset có ba dạng ngoài đời và không dạng nào đoán được từ dạng kia:
 * số giây (`60`), khoảng thời gian kiểu Go của OpenAI/Groq (`2m59.56s`, `88ms`), và mốc
 * thời gian RFC-3339 của Anthropic (`2026-09-04T12:00:00Z`).
 */
function parseReset(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();

  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber > 0 ? Math.ceil(asNumber) : 0;

  const duration = parseDuration(raw);
  if (duration !== null) return duration;

  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, Math.ceil((asDate - now) / 1000));

  return null;
}

const DURATION_UNITS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400 };

/** `1h2m3s`, `2m59.56s`, `88ms` → số giây. Trả `null` nếu chuỗi không phải khoảng thời gian. */
function parseDuration(raw) {
  const matches = [...raw.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (!matches.length) return null;

  // Chuỗi phải là NGUYÊN các cặp số+đơn vị; còn sót ký tự nào thì đây là thứ khác (một mốc
  // thời gian chẳng hạn) và đoán bừa sẽ ra một cooldown vô nghĩa.
  if (matches.reduce((sum, m) => sum + m[0].length, 0) !== raw.length) return null;

  const seconds = matches.reduce((sum, m) => sum + Number(m[1]) * DURATION_UNITS[m[2]], 0);
  return Math.ceil(seconds);
}

/**
 * Google không gửi `Retry-After`. Thay vào đó, body lỗi 429 mang một khối `RetryInfo`
 * với `retryDelay: "27s"`.
 *
 * Đọc được nó là khác biệt giữa nghỉ 27 giây và nghỉ một tiếng (mặc định của bảng cooldown
 * cho 429): hạn mức phút của Gemini hồi lại sau chưa tới một phút, nên bỏ qua trường này
 * đồng nghĩa với việc tự loại Gemini khỏi pool suốt một giờ vì một nhịp nghẽn 27 giây.
 */
function retryDelayFromGoogleError(body) {
  if (!body) return null;
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return null;
  }

  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return null;

  for (const detail of details) {
    const delay = detail?.retryDelay;
    if (typeof delay === 'string') {
      const seconds = parseDuration(delay) ?? Number(delay);
      if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
    }
  }
  return null;
}

module.exports = { readRateLimit, parseReset, parseDuration, retryDelayFromGoogleError };
