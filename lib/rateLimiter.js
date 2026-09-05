/**
 * Giới hạn số request/phút mà một CLIENT của gateway được gọi vào — khác với cửa sổ RPM đã
 * có sẵn trong `lib/accounts.js` (đo hạn mức của từng TÀI KHOẢN upstream). Không có phần
 * này thì một client lỗi (vòng lặp retry hỏng, script quên rate-limit riêng) có thể gọi
 * gateway nhanh tùy ý — `GATEWAY_API_KEY` chỉ chặn được truy cập TRÁI PHÉP, không chặn được
 * lạm dụng từ một client vốn có key hợp lệ.
 *
 * Cửa sổ cố định (fixed window) trong bộ nhớ, không phải sliding window: đơn giản hơn, và đủ
 * chính xác cho mục đích "chặn một client hỏng" — sai số ở biên cửa sổ (dồn gần gấp đôi hạn
 * mức nếu request rơi đúng lúc giao cửa sổ) không đáng để đổi lấy một thuật toán phức tạp hơn.
 */
function createRateLimiter({ limitPerMinute, windowMs = 60_000 }) {
  const hits = new Map();

  function check(identity) {
    if (!limitPerMinute) return { allowed: true };

    const now = Date.now();
    const entry = hits.get(identity);
    if (!entry || now - entry.windowStart >= windowMs) {
      hits.set(identity, { count: 1, windowStart: now });
      return { allowed: true };
    }

    entry.count += 1;
    if (entry.count > limitPerMinute) {
      const retryAfterSeconds = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
    }
    return { allowed: true };
  }

  /** Dọn định kỳ — không có phần này thì `hits` phình vô hạn theo số IP/key từng thấy. */
  function sweep() {
    const now = Date.now();
    for (const [identity, entry] of hits) {
      if (now - entry.windowStart >= windowMs) hits.delete(identity);
    }
  }

  return { check, sweep };
}

module.exports = { createRateLimiter };
