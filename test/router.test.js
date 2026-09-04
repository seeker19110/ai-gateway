const test = require('node:test');
const assert = require('node:assert/strict');

const SmartRouter = require('../lib/router');
const { UpstreamError } = require('../lib/errors');
const { fakePool, silentLogger } = require('./helpers');

const MSG = [{ role: 'user', content: 'chào' }];

/** Router trên pool giả, mọi provider đều coi như đã có key. */
function makeRouter(spec) {
  const providers = fakePool(spec);
  const logger = silentLogger();
  const router = new SmartRouter(providers, { logger });
  // Bỏ qua việc dò key thật: test không đụng tới biến môi trường.
  router.resolveApiKey = () => 'test-key';
  return { router, providers, logger };
}

test('lượt trơn tru: nhà đầu tiên phục vụ, không ai bị đụng tới', async () => {
  const { router, providers } = makeRouter({ a: [{ ok: 'xong' }], b: [] });
  const result = await router.chat(MSG);

  assert.equal(result.text, 'xong');
  assert.equal(result.provider, 'a');
  assert.equal(providers.b.calls, 0);
});

test('429 thì cho nghỉ và xoay sang nhà kế', async () => {
  const { router, providers } = makeRouter({ a: [{ status: 429 }], b: [{ ok: 'từ b' }] });
  const result = await router.chat(MSG);

  assert.equal(result.provider, 'b');
  assert.equal(providers.a.isCoolingDown(), true, 'a phải đang cooldown');
  assert.equal(providers.a.cooldownRemaining() > 3000, true, '429 mặc định nghỉ 1 giờ');
});

test('Retry-After của upstream quyết định thời gian nghỉ', async () => {
  const { router, providers } = makeRouter({
    a: [{ status: 429, retryAfter: '30' }],
    b: [{ ok: 'từ b' }]
  });
  await router.chat(MSG);

  const remaining = providers.a.cooldownRemaining();
  assert.ok(remaining > 25 && remaining <= 30, `nghỉ ${remaining}s, đáng lẽ ~30s`);
});

test('lỗi mạng thì bỏ qua lượt này, KHÔNG cooldown', async () => {
  const { router, providers } = makeRouter({ a: [{ network: true }], b: [{ ok: 'từ b' }] });
  const result = await router.chat(MSG);

  assert.equal(result.provider, 'b');
  assert.equal(providers.a.isCoolingDown(), false, 'một nhịp mạng chập chờn không được làm nguội cả pool');
  assert.equal(providers.a.isAvailable(), true);
});

test('5xx thì sang nhà kế nhưng KHÔNG cooldown', async () => {
  const { router, providers } = makeRouter({ a: [{ status: 503 }], b: [{ ok: 'từ b' }] });
  const result = await router.chat(MSG);

  assert.equal(result.provider, 'b');
  assert.equal(providers.a.isCoolingDown(), false);
});

test('4xx phía client thì trả lỗi ngay, không đốt các nhà còn lại', async () => {
  const { router, providers } = makeRouter({
    a: [{ status: 400, body: '{"error":{"message":"messages sai định dạng"}}' }],
    b: [{ ok: 'không bao giờ tới đây' }]
  });

  await assert.rejects(
    () => router.chat(MSG),
    (err) => err instanceof UpstreamError && err.statusCode === 400
  );
  assert.equal(providers.b.calls, 0, 'nhà khác cũng sẽ từ chối y hệt — không được thử');
  assert.equal(providers.a.isCoolingDown(), false, '400 là lỗi của người gọi, không phải của nhà cung cấp');
});

test('400 kèm body báo hết quota thì vẫn xoay vòng', async () => {
  const { router, providers } = makeRouter({
    a: [{ status: 400, body: 'RESOURCE_EXHAUSTED: quota' }],
    b: [{ ok: 'từ b' }]
  });
  const result = await router.chat(MSG);

  assert.equal(result.provider, 'b');
  assert.equal(providers.a.isCoolingDown(), true);
});

test('hết ứng viên thì trả 429 kèm số giây phải chờ', async () => {
  const { router } = makeRouter({
    a: [{ status: 429, retryAfter: '60' }],
    b: [{ status: 429, retryAfter: '90' }]
  });

  await assert.rejects(
    () => router.chat(MSG),
    (err) => {
      assert.equal(err.statusCode, 429);
      assert.match(err.message, /Thử lại sau khoảng \d+s/);
      return true;
    }
  );
});

test('pool đang cooldown toàn bộ thì báo ngay, không gọi ai', async () => {
  const { router, providers } = makeRouter({ a: [], b: [] });
  providers.a.markUnavailable(429);
  providers.b.markUnavailable(429);

  await assert.rejects(
    () => router.chat(MSG),
    (err) => err.statusCode === 429 && /cooldown/.test(err.message)
  );
  assert.equal(providers.a.calls, 0);
});

test('chưa cấu hình nhà nào thì nói rõ là thiếu key, không phải hết quota', async () => {
  const providers = fakePool({ a: [], b: [] });
  const router = new SmartRouter(providers, { logger: silentLogger() });
  router.resolveApiKey = () => ''; // không có key nào

  await assert.rejects(
    () => router.chat(MSG),
    (err) => err.statusCode === 503 && /Chưa cấu hình/.test(err.message)
  );
});

test('xoay vòng LRU: ba lượt liên tiếp đi ba nhà khác nhau', async () => {
  const { router } = makeRouter({
    a: [{ ok: '1' }, { ok: '4' }],
    b: [{ ok: '2' }],
    c: [{ ok: '3' }]
  });

  const served = [];
  for (let i = 0; i < 3; i++) served.push((await router.chat(MSG)).provider);

  assert.deepEqual(served, ['a', 'b', 'c'], 'phải xoay đều, không kẹt vào một nhà');
});

test('LRU không kẹt khi nhiều lượt rơi vào cùng một mili-giây', async () => {
  const { router, providers } = makeRouter({ a: [{ ok: '1' }], b: [{ ok: '2' }] });

  // Đóng băng đồng hồ: nếu dấu LRU chỉ gán Date.now() thì hai nhà hòa nhau và
  // thứ tự tụt về thứ tự khai báo — pool kẹt vào 'a' mãi mãi.
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const first = (await router.chat(MSG)).provider;
    const second = (await router.chat(MSG)).provider;
    assert.notEqual(first, second, 'đồng hồ thô không được làm hỏng xoay vòng');
    assert.ok(providers.a.lastUsedAt !== providers.b.lastUsedAt);
  } finally {
    Date.now = realNow;
  }
});

test('preferred được ưu tiên lên đầu', async () => {
  const { router } = makeRouter({ a: [{ ok: 'từ a' }], b: [{ ok: 'từ b' }] });
  const result = await router.chat(MSG, { preferred: 'b' });
  assert.equal(result.provider, 'b');
});

test('preferred đang cooldown thì rơi về pool, không lỗi', async () => {
  const { router, providers } = makeRouter({ a: [{ ok: 'từ a' }], b: [] });
  providers.b.markUnavailable(429);

  const result = await router.chat(MSG, { preferred: 'b' });
  assert.equal(result.provider, 'a');
});

test('vòng lặp dừng đúng số ứng viên, không lặp vô hạn', async () => {
  const { router, providers } = makeRouter({
    a: [{ status: 500 }, { status: 500 }],
    b: [{ status: 500 }, { status: 500 }]
  });

  await assert.rejects(() => router.chat(MSG));
  assert.equal(providers.a.calls, 1, 'mỗi nhà đúng một lượt');
  assert.equal(providers.b.calls, 1);
});

test('attempts ghi lại đường đi của lượt gọi', async () => {
  const { router } = makeRouter({
    a: [{ status: 429 }],
    b: [{ network: true }],
    c: [{ ok: 'cuối cùng' }]
  });
  const result = await router.chat(MSG);

  assert.deepEqual(
    result.attempts.map((a) => [a.provider, a.outcome]),
    [['a', 'cooldown'], ['b', 'network'], ['c', 'ok']]
  );
});

test('log ghi rõ lượt nào đi nhà nào — chỗ duy nhất kiểm chứng được xoay vòng', async () => {
  const { router, logger } = makeRouter({ a: [{ status: 429 }], b: [{ ok: 'từ b' }] });
  await router.chat(MSG);

  assert.ok(logger.lines.some((l) => /a trả 429.*cho nghỉ/.test(l)), logger.lines.join('\n'));
  assert.ok(logger.lines.some((l) => /b phục vụ thành công \(lần thử 2\/2\)/.test(l)), logger.lines.join('\n'));
});

test('hết cooldown thì tự quay lại pool', async () => {
  const { router, providers } = makeRouter({ a: [{ ok: 'từ a' }], b: [] });
  providers.a.markUnavailable(429, '1'); // nghỉ 1 giây
  assert.equal(providers.a.isAvailable(), false);

  const later = Date.now() + 2000;
  assert.equal(providers.a.isAvailable(later), true, 'hết hạn cooldown là sẵn sàng trở lại');
});

test('reset xóa cooldown thủ công', async () => {
  const { router, providers } = makeRouter({ a: [], b: [] });
  providers.a.markUnavailable(429);
  assert.equal(providers.a.isCoolingDown(), true);

  assert.equal(router.resetProvider('a'), true);
  assert.equal(providers.a.isCoolingDown(), false);
  assert.equal(router.resetProvider('không-có'), false);
});

test('vượt maxRPM thì tạm rút khỏi pool', async () => {
  const { router, providers } = makeRouter({ a: [{ ok: '1' }], b: [{ ok: '2' }] });
  providers.a.maxRPM = 1;
  providers.a.trackRequest();

  assert.equal(providers.a.isAvailable(), false);
  assert.equal((await router.chat(MSG)).provider, 'b');
});
