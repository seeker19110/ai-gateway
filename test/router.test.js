const test = require('node:test');
const assert = require('node:assert/strict');

const SmartRouter = require('../lib/router');
const { UpstreamError } = require('../lib/errors');
const { fakePool, acct, silentLogger } = require('./helpers');

const MSG = [{ role: 'user', content: 'chào' }];

/** Router trên pool giả. */
function makeRouter(spec, options = {}) {
  const { providers, pool } = fakePool(spec, options);
  const logger = silentLogger();
  const router = new SmartRouter(pool, { logger, ...options.router });
  return { router, providers, pool, logger };
}

test('lượt trơn tru: ứng viên đầu tiên phục vụ, không ai bị đụng tới', async () => {
  const { router, providers } = makeRouter({ a: [{ ok: 'xong' }], b: [] });
  const result = await router.chat(MSG);

  assert.equal(result.text, 'xong');
  assert.equal(result.provider, 'a');
  assert.equal(providers.b.calls, 0);
});

test('429 thì cho nghỉ và xoay sang ứng viên kế', async () => {
  const { router, pool } = makeRouter({ a: [{ status: 429 }], b: [{ ok: 'từ b' }] });
  const result = await router.chat(MSG);

  assert.equal(result.provider, 'b');
  assert.equal(acct(pool, 'a').isCoolingDown(), true, 'a phải đang cooldown');
  assert.equal(acct(pool, 'a').cooldownRemaining() > 3000, true, '429 mặc định nghỉ 1 giờ');
});

test('Retry-After của upstream quyết định thời gian nghỉ', async () => {
  const { router, pool } = makeRouter({
    a: [{ status: 429, retryAfter: '30' }],
    b: [{ ok: 'từ b' }]
  });
  await router.chat(MSG);

  const remaining = acct(pool, 'a').cooldownRemaining();
  assert.ok(remaining > 25 && remaining <= 30, `nghỉ ${remaining}s, đáng lẽ ~30s`);
});

test('lỗi mạng thì bỏ qua lượt này, KHÔNG cooldown', async () => {
  const { router, pool } = makeRouter({ a: [{ network: true }], b: [{ ok: 'từ b' }] });
  const result = await router.chat(MSG);

  assert.equal(result.provider, 'b');
  assert.equal(acct(pool, 'a').isCoolingDown(), false, 'một nhịp mạng chập chờn không được làm nguội cả pool');
  assert.equal(acct(pool, 'a').isAvailable(), true);
});

test('5xx thì sang ứng viên kế nhưng KHÔNG cooldown', async () => {
  const { router, pool } = makeRouter({ a: [{ status: 503 }], b: [{ ok: 'từ b' }] });
  const result = await router.chat(MSG);

  assert.equal(result.provider, 'b');
  assert.equal(acct(pool, 'a').isCoolingDown(), false);
});

test('mã lỗi không phân loại được (ví dụ 3xx) vẫn xoay sang ứng viên kế, không cooldown', async () => {
  // Không phải lỗi mạng, không phải 4xx-phía-client (dưới 400), không phải 5xx, không có
  // dấu hiệu hết quota trong thân — rơi vào nhánh "không phân loại được" của `_classify`.
  const { router, pool } = makeRouter({ a: [{ status: 300 }], b: [{ ok: 'từ b' }] });
  const result = await router.chat(MSG);

  assert.equal(result.provider, 'b');
  assert.equal(acct(pool, 'a').isCoolingDown(), false, 'mã không rõ nghĩa không đáng bị cho nghỉ dài');
});

test('4xx phía client thì trả lỗi ngay, không đốt các ứng viên còn lại', async () => {
  const { router, providers, pool } = makeRouter({
    a: [{ status: 400, body: '{"error":{"message":"messages sai định dạng"}}' }],
    b: [{ ok: 'không bao giờ tới đây' }]
  });

  await assert.rejects(
    () => router.chat(MSG),
    (err) => err instanceof UpstreamError && err.statusCode === 400
  );
  assert.equal(providers.b.calls, 0, 'nhà khác cũng sẽ từ chối y hệt — không được thử');
  assert.equal(acct(pool, 'a').isCoolingDown(), false, '400 là lỗi của người gọi, không phải của tài khoản');
});

test('400 kèm body báo hết quota thì vẫn xoay vòng', async () => {
  const { router, pool } = makeRouter({
    a: [{ status: 400, body: 'RESOURCE_EXHAUSTED: quota' }],
    b: [{ ok: 'từ b' }]
  });
  const result = await router.chat(MSG);

  assert.equal(result.provider, 'b');
  assert.equal(acct(pool, 'a').isCoolingDown(), true);
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
  const { router, providers, pool } = makeRouter({ a: [], b: [] });
  acct(pool, 'a').markUnavailable(429);
  acct(pool, 'b').markUnavailable(429);

  await assert.rejects(
    () => router.chat(MSG),
    (err) => err.statusCode === 429 && /cooldown/.test(err.message)
  );
  assert.equal(providers.a.calls, 0);
});

test('chưa cấu hình key nào thì nói rõ là thiếu key, không phải hết quota', async () => {
  const { providers } = fakePool({ a: [], b: [] });
  const { AccountPool } = require('../lib/pool');
  const pool = new AccountPool(providers, { env: {} }); // không có biến môi trường nào
  const router = new SmartRouter(pool, { logger: silentLogger() });

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
  const { router, pool } = makeRouter({ a: [{ ok: '1' }], b: [{ ok: '2' }] });

  // Đóng băng đồng hồ: nếu dấu LRU chỉ gán Date.now() thì hai tài khoản hòa nhau và
  // thứ tự tụt về thứ tự khai báo — pool kẹt vào 'a' mãi mãi.
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const first = (await router.chat(MSG)).provider;
    const second = (await router.chat(MSG)).provider;
    assert.notEqual(first, second, 'đồng hồ thô không được làm hỏng xoay vòng');
    assert.ok(acct(pool, 'a').lastUsedAt !== acct(pool, 'b').lastUsedAt);
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
  const { router, pool } = makeRouter({ a: [{ ok: 'từ a' }], b: [] });
  acct(pool, 'b').markUnavailable(429);

  const result = await router.chat(MSG, { preferred: 'b' });
  assert.equal(result.provider, 'a');
});

test('vòng lặp dừng đúng số ứng viên, không lặp vô hạn', async () => {
  const { router, providers } = makeRouter({
    a: [{ status: 500 }, { status: 500 }],
    b: [{ status: 500 }, { status: 500 }]
  });

  await assert.rejects(() => router.chat(MSG));
  assert.equal(providers.a.calls, 1, 'mỗi tài khoản đúng một lượt');
  assert.equal(providers.b.calls, 1);
});

test('attempts ghi lại đường đi của lượt gọi, kèm tài khoản nào', async () => {
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
  assert.deepEqual(result.attempts.map((a) => a.account), ['a#1', 'b#1', 'c#1']);
});

test('log ghi rõ lượt nào đi tài khoản nào — chỗ duy nhất kiểm chứng được xoay vòng', async () => {
  const { router, logger } = makeRouter({ a: [{ status: 429 }], b: [{ ok: 'từ b' }] });
  await router.chat(MSG);

  assert.ok(logger.lines.some((l) => /a#1 trả 429.*cho nghỉ/.test(l)), logger.lines.join('\n'));
  assert.ok(logger.lines.some((l) => /b#1 phục vụ thành công \(lần thử 2\/2\)/.test(l)), logger.lines.join('\n'));
});

test('hết cooldown thì tự quay lại pool', async () => {
  const { pool } = makeRouter({ a: [{ ok: 'từ a' }], b: [] });
  acct(pool, 'a').markUnavailable(429, '1'); // nghỉ 1 giây
  assert.equal(acct(pool, 'a').isAvailable(), false);

  const later = Date.now() + 2000;
  assert.equal(acct(pool, 'a').isAvailable(later), true, 'hết hạn cooldown là sẵn sàng trở lại');
});

test('reset xóa cooldown thủ công', async () => {
  const { router, pool } = makeRouter({ a: [], b: [] });
  acct(pool, 'a').markUnavailable(429);
  assert.equal(acct(pool, 'a').isCoolingDown(), true);

  assert.deepEqual(router.reset('a'), [acct(pool, 'a').id]);
  assert.equal(acct(pool, 'a').isCoolingDown(), false);
  assert.equal(router.reset('không-có'), null);
});

test('vượt maxRPM thì tạm rút khỏi pool', async () => {
  const { router, providers, pool } = makeRouter({ a: [{ ok: '1' }], b: [{ ok: '2' }] });
  // Hạn mức là thuộc tính của nhà cung cấp; pool chép nó xuống từng tài khoản ở mỗi lần
  // cấu hình, nên sửa thẳng trên tài khoản sẽ bị ghi đè ngay lượt gọi sau.
  providers.a.maxRPM = 1;
  router.configureProviders();
  acct(pool, 'a').trackRequest();

  assert.equal(acct(pool, 'a').isAvailable(), false);
  assert.equal((await router.chat(MSG)).provider, 'b');
});

// ---------- nhiều tài khoản ----------

test('một key hết quota KHÔNG kéo theo key thứ hai của cùng nhà cung cấp', async () => {
  const { router, pool } = makeRouter({
    a: { 'key-1': [{ status: 429 }], 'key-2': [{ ok: 'key thứ hai vẫn sống' }] }
  });

  const result = await router.chat(MSG);

  assert.equal(result.text, 'key thứ hai vẫn sống');
  assert.equal(acct(pool, 'a', 0).isCoolingDown(), true, 'key hết quota phải nghỉ');
  assert.equal(acct(pool, 'a', 1).isCoolingDown(), false, 'key còn lại giữ nguyên hạn mức của nó');
  assert.equal(pool.statuses().a.status, 'active', 'nhà cung cấp vẫn dùng được vì còn key');
});

test('nhiều tài khoản xoay vòng đều, mỗi key một lượt', async () => {
  const { router } = makeRouter({
    a: { 'k1': [{ ok: 'k1' }], 'k2': [{ ok: 'k2' }], 'k3': [{ ok: 'k3' }] }
  });

  const served = [];
  for (let i = 0; i < 3; i++) served.push((await router.chat(MSG)).account);

  assert.deepEqual(served.slice().sort(), ['a#1', 'a#2', 'a#3'], 'không key nào bị bỏ quên');
});

test('nhà nhiều key nhận nhiều lưu lượng hơn — đúng bằng tỉ lệ hạn mức thật', async () => {
  const { router } = makeRouter({ a: { k1: [], k2: [], k3: [] }, b: { k9: [] } });

  const served = [];
  for (let i = 0; i < 8; i++) served.push((await router.chat(MSG)).provider);

  const aCount = served.filter((p) => p === 'a').length;
  assert.equal(aCount, 6, `a có 3 key thì phải nhận 3/4 lưu lượng, nhận ${aCount}/8`);
});

test('failover đi sang nhà KHÁC trước, không đốt hết key của nhà đang hỏng', async () => {
  // Cả ba key của `a` đều hỏng; thứ tự thử phải là a → b → a → a, để một sự cố ở phía `a`
  // (chứ không phải ở riêng một key) chỉ tốn một lần thử trước khi chạm tới nhà thứ hai.
  const { router, providers } = makeRouter({
    a: { k1: [{ status: 500 }], k2: [{ status: 500 }], k3: [{ status: 500 }] },
    b: { k9: [{ ok: 'từ b' }] }
  });

  const result = await router.chat(MSG);
  assert.equal(result.provider, 'b');
  assert.equal(providers.a.calls, 1, 'chỉ một key của a bị thử trước khi sang b');
});

test('nhà được ghim thì thử hết key của nhà đó trước khi rơi sang nhà khác', async () => {
  const { router, providers } = makeRouter({
    a: { k1: [{ status: 429 }], k2: [{ ok: 'key thứ hai của đúng nhà được ghim' }] },
    b: { k9: [{ ok: 'từ b' }] }
  });

  const result = await router.chat(MSG, { preferred: 'a' });

  // Người gọi đã nói rõ họ muốn nhà nào; key thứ hai của chính nhà đó bám sát ý định ấy
  // hơn hẳn một nhà khác.
  assert.equal(result.text, 'key thứ hai của đúng nhà được ghim');
  assert.equal(providers.b.calls, 0);
});

test('ghim một nhà đã hết sạch key dùng được thì vẫn rơi về pool', async () => {
  const { router, pool } = makeRouter({ a: { k1: [], k2: [] }, b: [{ ok: 'từ b' }] });
  pool.accountsOf('a').forEach((account) => account.markUnavailable(429));

  assert.equal((await router.chat(MSG, { preferred: 'a' })).provider, 'b');
});

test('chế độ `provider` chia đều theo nhà cung cấp thay vì theo tài khoản', async () => {
  const { router } = makeRouter(
    { a: { k1: [], k2: [], k3: [] }, b: { k9: [] } },
    { strategy: 'provider' }
  );

  const served = [];
  for (let i = 0; i < 6; i++) served.push((await router.chat(MSG)).provider);

  assert.deepEqual(served, ['a', 'b', 'a', 'b', 'a', 'b'], 'mỗi nhà một nửa, bất kể có mấy key');
});

test('trần số lần thử giữ độ trễ có giới hạn khi cả pool đang hỏng', async () => {
  const { router, providers } = makeRouter(
    { a: { k1: [{ status: 500 }], k2: [{ status: 500 }] }, b: { k3: [{ status: 500 }] } },
    { router: { maxAttempts: 2 } }
  );

  await assert.rejects(() => router.chat(MSG));
  assert.equal(providers.a.calls + providers.b.calls, 2, 'dừng đúng ở trần, không đi hết pool');
});

// ---------- tín hiệu hạn mức ----------

test('header báo hết lượt thì cho nghỉ dù lượt vừa rồi THÀNH CÔNG', async () => {
  const { router, pool } = makeRouter({
    a: [{ ok: 'xong', rateLimit: { remaining: 0, resetSeconds: 45 } }],
    b: []
  });

  const result = await router.chat(MSG);
  assert.equal(result.provider, 'a', 'lượt này vẫn phải được phục vụ bình thường');

  const account = acct(pool, 'a');
  assert.equal(account.isCoolingDown(), true, 'hết lượt là nghỉ, không cần chờ ăn 429');
  assert.ok(account.cooldownRemaining() > 40 && account.cooldownRemaining() <= 45);
  assert.equal(account.cooldownReason, 'quota_header');
  assert.equal(account.lastFailureStatus, 0, 'đây không phải một lần thất bại');
});

test('còn lượt thì header không làm gì cả', async () => {
  const { router, pool } = makeRouter({
    a: [{ ok: 'xong', rateLimit: { remaining: 12, resetSeconds: 45 } }]
  });
  await router.chat(MSG);
  assert.equal(acct(pool, 'a').isCoolingDown(), false);
});

test('429 không có Retry-After thì dùng mốc reset trong header hạn mức', async () => {
  const { router, pool } = makeRouter({
    a: [{ status: 429, rateLimit: { remaining: 0, resetSeconds: 20 } }],
    b: [{ ok: 'từ b' }]
  });
  await router.chat(MSG);

  const remaining = acct(pool, 'a').cooldownRemaining();
  assert.ok(remaining > 15 && remaining <= 20, `nghỉ ${remaining}s, đáng lẽ ~20s chứ không phải 1 giờ`);
});

// ---------- tham số và model ----------

test('tham số sinh văn bản được chuyển xuống nhà cung cấp', async () => {
  const { router, providers } = makeRouter({ a: [{ ok: 'xong' }] });
  await router.chat(MSG, { params: { temperature: 0.2, max_tokens: 50 } });

  assert.deepEqual(providers.a.seenParams[0], { temperature: 0.2, max_tokens: 50 });
});

test('model do client ghim chỉ áp cho đúng nhà cung cấp được ghim', async () => {
  const { router, providers } = makeRouter({
    a: [{ status: 500 }],
    b: [{ ok: 'từ b' }]
  });

  await router.chat(MSG, { preferred: 'a', model: 'model-rieng' });

  assert.equal(providers.a.seenModels[0], 'model-rieng');
  assert.equal(providers.b.seenModels[0], 'b-model', 'tên model của nhà này vô nghĩa với nhà kia');
});
