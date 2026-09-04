const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CooldownStore } = require('../lib/store');
const SmartRouter = require('../lib/router');
const { fakePool, silentLogger } = require('./helpers');

/** Store trỏ vào một file tạm riêng cho mỗi test. */
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-test-'));
  return { store: new CooldownStore(path.join(dir, 'cooldowns.json')), dir };
}

test('file chưa tồn tại thì đọc ra rỗng, không ném lỗi', () => {
  const { store } = tempStore();
  assert.deepEqual(store.read(), {});
});

test('cooldown sống qua một vòng ghi/đọc', () => {
  const { store } = tempStore();
  const providers = fakePool({ a: [], b: [] });
  providers.a.markUnavailable(429);

  store.persist(providers);

  const fresh = fakePool({ a: [], b: [] });
  assert.equal(store.restore(fresh), 1);
  assert.equal(fresh.a.isCoolingDown(), true);
  assert.equal(fresh.a.lastFailureStatus, 429);
  assert.equal(fresh.b.isCoolingDown(), false, 'b không cooldown thì không được khôi phục');
});

test('cooldown đã hết hạn trong lúc gateway tắt thì không khôi phục', () => {
  const { store } = tempStore();
  store.write({ a: { cooldownUntil: Date.now() - 10_000, lastFailureStatus: 429 } });

  const providers = fakePool({ a: [] });
  assert.equal(store.restore(providers), 0);
  assert.equal(providers.a.isCoolingDown(), false, 'cooldown quá hạn thì không được nạp lại');
  assert.equal(providers.a.cooldownUntil, 0);
});

test('nhà cung cấp đã bị gỡ khỏi code thì bỏ qua, không vỡ', () => {
  const { store } = tempStore();
  store.write({ khong_con_ton_tai: { cooldownUntil: Date.now() + 60_000 } });

  const providers = fakePool({ a: [] });
  assert.equal(store.restore(providers), 0);
});

test('file hỏng thì bắt đầu lại từ rỗng thay vì chặn khởi động', () => {
  const { store } = tempStore();
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
  fs.writeFileSync(store.filePath, 'đây không phải JSON');

  assert.deepEqual(store.read(), {});
  assert.equal(store.restore(fakePool({ a: [] })), 0);
});

test('ghi nguyên tử: không để lại file tạm', () => {
  const { store, dir } = tempStore();
  store.write({ a: { cooldownUntil: Date.now() + 1000 } });

  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'file tạm phải được rename đi, không còn sót');
});

test('file cooldown chỉ chủ sở hữu đọc được', { skip: process.platform === 'win32' }, () => {
  const { store } = tempStore();
  store.write({ a: { cooldownUntil: Date.now() + 1000 } });

  const mode = fs.statSync(store.filePath).mode & 0o777;
  assert.equal(mode, 0o600, `quyền file là ${mode.toString(8)}`);
});

test('persist chỉ ghi cooldown, KHÔNG ghi API key', () => {
  const { store } = tempStore();
  const providers = fakePool({ a: [] });
  providers.a.apiKey = 'sk-bi-mat-khong-duoc-ghi';
  providers.a.markUnavailable(429);

  store.persist(providers);
  const raw = fs.readFileSync(store.filePath, 'utf8');
  assert.doesNotMatch(raw, /sk-bi-mat/, 'file trạng thái không phải chỗ chứa bí mật');
});

test('router ghi cooldown xuống đĩa khi có nhà cung cấp bị cho nghỉ', async () => {
  const { store } = tempStore();
  const providers = fakePool({ a: [{ status: 429 }], b: [{ ok: 'từ b' }] });
  const router = new SmartRouter(providers, { logger: silentLogger(), store });
  router.resolveApiKey = () => 'key';

  await router.chat([{ role: 'user', content: 'chào' }]);

  const saved = store.read();
  assert.ok(saved.a?.cooldownUntil > Date.now(), 'cooldown của a phải nằm trên đĩa');
  assert.equal(saved.b, undefined, 'b phục vụ được thì không có gì để lưu');
});

test('router xóa cooldown trên đĩa khi reset', async () => {
  const { store } = tempStore();
  const providers = fakePool({ a: [] });
  const router = new SmartRouter(providers, { logger: silentLogger(), store });

  providers.a.markUnavailable(429);
  store.persist(providers);
  assert.ok(store.read().a);

  router.resetProvider('a');
  assert.equal(store.read().a, undefined);
});

test('không ghi được đĩa thì request vẫn chạy, chỉ ghi log cảnh báo', async () => {
  const providers = fakePool({ a: [{ status: 429 }], b: [{ ok: 'từ b' }] });
  const logger = silentLogger();
  const brokenStore = {
    restore: () => 0,
    persist: () => { throw new Error('đĩa đầy'); }
  };
  const router = new SmartRouter(providers, { logger, store: brokenStore });
  router.resolveApiKey = () => 'key';

  const result = await router.chat([{ role: 'user', content: 'chào' }]);
  assert.equal(result.provider, 'b', 'mất chỗ lưu không được làm hỏng một request phục vụ được');
  assert.ok(logger.lines.some((l) => /Không lưu được cooldown/.test(l)));
});

test('không có store thì router vẫn chạy bình thường', async () => {
  const providers = fakePool({ a: [{ ok: 'ổn' }] });
  const router = new SmartRouter(providers, { logger: silentLogger() });
  router.resolveApiKey = () => 'key';

  assert.equal((await router.chat([{ role: 'user', content: 'chào' }])).text, 'ổn');
});
