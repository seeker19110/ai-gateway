const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldFailOver,
  isClientFault,
  parseRetryAfter,
  cooldownFor,
  COOLDOWN_FALLBACK
} = require('../lib/failover');
const { upstreamErrorMessage, UPSTREAM_ERROR_MAX_CHARS } = require('../lib/errors');

test('401/402/403/429 và 5xx thì xoay vòng được', () => {
  for (const status of [401, 402, 403, 429, 500, 502, 503]) {
    assert.equal(shouldFailOver(status), true, `HTTP ${status} phải xoay vòng`);
  }
});

test('4xx thường không xoay vòng', () => {
  for (const status of [400, 404, 422]) {
    assert.equal(shouldFailOver(status), false, `HTTP ${status} không nên xoay vòng`);
    assert.equal(isClientFault(status), true);
  }
});

test('body báo hết quota thì xoay vòng dù mã HTTP là 400', () => {
  assert.equal(shouldFailOver(400, '{"error":{"code":"RESOURCE_EXHAUSTED"}}'), true);
  assert.equal(shouldFailOver(400, 'You exceeded your current quota'), true);
  assert.equal(shouldFailOver(400, 'Rate limit reached for requests'), true);
  // và khi đó không còn bị coi là lỗi phía client
  assert.equal(isClientFault(400, 'quota exceeded'), false);
});

test('cooldown theo bảng: 401 ngắn, quota dài, còn lại 60s', () => {
  assert.equal(cooldownFor(401), 300);
  assert.equal(cooldownFor(429), 3600);
  assert.equal(cooldownFor(402), 3600);
  assert.equal(cooldownFor(403), 3600);
  assert.equal(cooldownFor(500), COOLDOWN_FALLBACK);
});

test('Retry-After ghi đè bảng mặc định', () => {
  assert.equal(cooldownFor(429, '30'), 30);
  assert.equal(cooldownFor(401, '5'), 5);
});

test('Retry-After dạng HTTP-date được quy về số giây', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const later = new Date(now + 45_000).toUTCString();
  assert.equal(parseRetryAfter(later, now), 45);
});

test('Retry-After vô nghĩa thì bỏ qua, không làm hỏng cooldown', () => {
  assert.equal(parseRetryAfter('rất lâu'), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(null), null);
  // mốc quá khứ: đã qua rồi, không phải chờ
  assert.equal(parseRetryAfter('-10'), null);
  assert.equal(cooldownFor(429, 'rất lâu'), 3600);
});

test('thông điệp lỗi lấy error.message, không dội nguyên body', () => {
  const msg = upstreamErrorMessage(429, '{"error":{"message":"Quota exceeded","type":"rate_limit"}}');
  assert.match(msg, /HTTP 429/);
  assert.match(msg, /Quota exceeded/);
  assert.doesNotMatch(msg, /rate_limit/);
});

test('body quá dài bị cắt', () => {
  const msg = upstreamErrorMessage(500, 'x'.repeat(5000));
  assert.ok(msg.length < UPSTREAM_ERROR_MAX_CHARS + 60, `dài ${msg.length}`);
  assert.match(msg, /…$/);
});

test('body không phải JSON vẫn ra thông điệp đọc được', () => {
  assert.match(upstreamErrorMessage(502, '<html>Bad Gateway</html>'), /Bad Gateway/);
  assert.match(upstreamErrorMessage(500, ''), /không có nội dung lỗi/);
});
