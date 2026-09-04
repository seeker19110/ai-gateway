/**
 * Phân loại lỗi upstream: nhà cung cấp khác có cứu được lượt này không, và nếu phải
 * cho nghỉ thì nghỉ bao lâu.
 *
 * Đây là chỗ quyết định chất lượng của failover. Gom tất cả về một bảng để đọc được
 * bằng mắt, thay vì rải `if (message.includes('429'))` khắp nơi.
 */

/**
 * Cooldown mặc định theo mã lỗi (giây).
 * - 401: key sai/hết hạn — chờ ngắn, có thể người dùng đang sửa key.
 * - 402/403/429: hết quota, hết tiền, bị chặn — chờ 1 giờ, trừ khi upstream nói `Retry-After`.
 * - Còn lại: 60s, đủ để qua một nhịp trục trặc mà không loại hẳn nhà cung cấp.
 */
const COOLDOWN_DEFAULTS = { 401: 300, 402: 3600, 403: 3600, 429: 3600 };
const COOLDOWN_FALLBACK = 60;

/**
 * Nhiều nhà cung cấp trả 200 hoặc 400 kèm body báo hết quota thay vì đúng mã 429.
 * Đọc cả body mới không bỏ sót những ca đó.
 */
const QUOTA_MARKERS = [
  'resource_exhausted',
  'rate limit',
  'rate_limit',
  'ratelimit',
  'quota',
  'too many requests',
  'insufficient_quota',
  'billing',
  'credit balance',
  'overloaded'
];

/** Nhà cung cấp khác có thể cứu được lỗi này không? */
function shouldFailOver(statusCode, body = '') {
  const status = Number(statusCode) || 0;
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  if (status >= 500) return true;
  const text = String(body || '').toLowerCase();
  return QUOTA_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Lỗi 4xx không liên quan tới tài khoản (payload hỏng, model không tồn tại, JSON sai).
 * Nhà cung cấp khác cũng sẽ từ chối y hệt — xoay vòng chỉ đốt quota và làm chậm câu trả
 * lời cho một lỗi mà người gọi phải tự sửa.
 */
function isClientFault(statusCode, body = '') {
  const status = Number(statusCode) || 0;
  return status >= 400 && status < 500 && !shouldFailOver(status, body);
}

/**
 * Parse `Retry-After`: có thể là số giây, hoặc một mốc thời gian HTTP-date.
 * Trả về số giây, hoặc null nếu không đọc được.
 */
function parseRetryAfter(retryAfter, now = Date.now()) {
  if (retryAfter === null || retryAfter === undefined || retryAfter === '') return null;

  const raw = String(retryAfter).trim();
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    return asNumber > 0 ? Math.max(1, Math.round(asNumber)) : null;
  }

  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    const seconds = Math.round((asDate - now) / 1000);
    return seconds > 0 ? seconds : null;
  }
  return null;
}

/** Thời gian cooldown (giây) cho một lỗi. `Retry-After` của upstream luôn thắng bảng mặc định. */
function cooldownFor(statusCode, retryAfter = null, now = Date.now()) {
  const fromHeader = parseRetryAfter(retryAfter, now);
  if (fromHeader !== null) return fromHeader;
  return COOLDOWN_DEFAULTS[Number(statusCode)] ?? COOLDOWN_FALLBACK;
}

module.exports = {
  COOLDOWN_DEFAULTS,
  COOLDOWN_FALLBACK,
  QUOTA_MARKERS,
  shouldFailOver,
  isClientFault,
  parseRetryAfter,
  cooldownFor
};
