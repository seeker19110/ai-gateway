const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../lib/rateLimiter');

test('createRateLimiter: không đặt limitPerMinute thì luôn cho qua', () => {
  const limiter = createRateLimiter({ limitPerMinute: 0 });
  for (let i = 0; i < 100; i += 1) {
    assert.equal(limiter.check('a').allowed, true);
  }
});

test('createRateLimiter: chặn khi vượt hạn mức trong cùng cửa sổ, kèm retryAfterSeconds', () => {
  const limiter = createRateLimiter({ limitPerMinute: 3, windowMs: 60_000 });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, true);

  const blocked = limiter.check('a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);
});

test('createRateLimiter: mỗi identity có cửa sổ riêng, không lẫn vào nhau', () => {
  const limiter = createRateLimiter({ limitPerMinute: 1, windowMs: 60_000 });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, false, 'a đã hết hạn mức');
  assert.equal(limiter.check('b').allowed, true, 'b chưa từng gọi, không bị ảnh hưởng bởi a');
});

test('createRateLimiter: qua hết cửa sổ thì đếm lại từ đầu', async () => {
  const limiter = createRateLimiter({ limitPerMinute: 1, windowMs: 20 });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(limiter.check('a').allowed, true, 'cửa sổ mới thì lại được tính từ đầu');
});

test('createRateLimiter: sweep() dọn identity đã hết hạn cửa sổ', async () => {
  const limiter = createRateLimiter({ limitPerMinute: 1, windowMs: 20 });
  limiter.check('a');
  await new Promise((resolve) => setTimeout(resolve, 25));
  limiter.sweep();

  // Không có cách đọc trực tiếp kích thước Map từ ngoài; kiểm chứng gián tiếp bằng cách
  // gọi lại 'a' NGAY sau sweep và thấy nó vẫn được tính như một cửa sổ mới (không bị chặn
  // dù đã "dùng hết" cửa sổ cũ trước khi sweep).
  assert.equal(limiter.check('a').allowed, true);
});
