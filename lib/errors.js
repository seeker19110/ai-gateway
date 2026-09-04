/**
 * Lỗi mang theo mã HTTP thật của upstream.
 *
 * Điều này là nền của toàn bộ cơ chế xoay vòng: nếu lỗi chỉ còn là một chuỗi text thì
 * router buộc phải đoán ý định bằng cách so chuỗi ("có chứa chữ 429 không?"), và mọi
 * phân loại phía sau đều dựa trên một phỏng đoán.
 */
class UpstreamError extends Error {
  constructor(message, statusCode = 500, options = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.statusCode = Number(statusCode) || 500;
    this.retryAfter = options.retryAfter || null;
    this.body = options.body || '';
    // Lỗi mạng (timeout, DNS, socket đứt): không phải upstream từ chối, mà là ta không
    // hỏi tới nơi. Phân biệt được hai thứ này mới tránh cho một nhịp mạng chập chờn
    // làm nguội cả pool.
    this.isNetworkError = Boolean(options.isNetworkError);
  }
}

const UPSTREAM_ERROR_MAX_CHARS = 500;

/**
 * Thông điệp lỗi trả cho client: lấy `error.message` của upstream (hoặc body thô nếu
 * không phải JSON), gộp khoảng trắng, cắt tối đa 500 ký tự.
 *
 * Không dội nguyên body của nhà cung cấp ra ngoài: body có thể rất dài và đôi khi mang
 * chi tiết nội bộ (endpoint, id tổ chức, thậm chí một phần API key trong thông báo lỗi).
 */
function upstreamErrorMessage(statusCode, body) {
  const text = typeof body === 'string' ? body : String(body ?? '');
  let message = text.trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed === 'object') {
    const err = parsed.error;
    if (err && typeof err === 'object' && typeof err.message === 'string') {
      message = err.message;
    } else if (typeof err === 'string') {
      message = err;
    } else if (typeof parsed.message === 'string') {
      message = parsed.message;
    }
  }

  message = message.split(/\s+/).filter(Boolean).join(' ');
  if (message.length > UPSTREAM_ERROR_MAX_CHARS) {
    message = `${message.slice(0, UPSTREAM_ERROR_MAX_CHARS - 1)}…`;
  }
  if (!message) {
    message = 'không có nội dung lỗi';
  }
  return `Upstream lỗi HTTP ${statusCode}: ${message}`;
}

module.exports = { UpstreamError, upstreamErrorMessage, UPSTREAM_ERROR_MAX_CHARS };
