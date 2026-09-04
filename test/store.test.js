const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CooldownStore } = require('../lib/store');
const SmartRouter = require('../lib/router');
const { fakePool, acct, silentLogger } = require('./helpers');

/** Store trỏ vào một file tạm riêng cho mỗi test. */
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-test-'));
  return { store: new CooldownStore(path.join(dir, 'cooldowns.json')), dir };
}

test('file chưa tồn tại thì đọc ra rỗng, không ném lỗi', () => {
  const { store } = tempStore();
  assert.deepEqual(store.read(), { accounts: {}, providers: {} });
});

test('cooldown sống qua một vòng ghi/đọc', () => {
  const { store } = tempStore();
  const { pool } = fakePool({ a: [], b: [] });
  acct(pool, 'a').markUnavailable(429);

  store.persist(pool);

  const fresh = fakePool({ a: [], b: [] }).pool;
  assert.equal(store.restore(fresh), 1);
  assert.equal(acct(fresh, 'a').isCoolingDown(), true);
  assert.equal(acct(fresh, 'a').lastFailureStatus, 429);
  assert.equal(acct(fresh, 'b').isCoolingDown(), false, 'b không cooldown thì không được khôi phục');
});

test('cooldown gắn với KEY, nên đổi thứ tự key trong .env không nạp nhầm', () => {
  const { store } = tempStore();
  const first = fakePool({ a: { k1: [], k2: [] } }).pool;
  acct(first, 'a', 1).markUnavailable(429); // key thứ hai bị khóa
  store.persist(first);

  // Lần chạy sau, hai key đảo chỗ trong `.env`.
  const second = fakePool({ a: { k2: [], k1: [] } }).pool;
  assert.equal(store.restore(second), 1);

  const restored = second.list().find((a) => a.isCoolingDown());
  assert.equal(restored.apiKey, 'k2', 'phải là đúng key đã bị khóa, không phải "key thứ hai"');
});

test('cooldown đã hết hạn trong lúc gateway tắt thì không khôi phục', () => {
  const { store } = tempStore();
  const { pool } = fakePool({ a: [] });
  store.write({ [acct(pool, 'a').id]: { cooldownUntil: Date.now() - 10_000, lastFailureStatus: 429 } });

  assert.equal(store.restore(pool), 0);
  assert.equal(acct(pool, 'a').isCoolingDown(), false, 'cooldown quá hạn thì không được nạp lại');
  assert.equal(acct(pool, 'a').cooldownUntil, 0);
});

test('tài khoản không còn trong cấu hình thì bỏ qua, không vỡ', () => {
  const { store } = tempStore();
  store.write({ 'a:khong_con_ton_tai': { cooldownUntil: Date.now() + 60_000 } });

  assert.equal(store.restore(fakePool({ a: [] }).pool), 0);
});

test('file phiên bản 1 (khóa theo nhà cung cấp) vẫn được hiểu', () => {
  const { store } = tempStore();
  // Bản cũ chỉ biết một key mỗi nhà, nên "gemini đang nghỉ" nghĩa là key duy nhất đó nghỉ.
  // Bỏ qua file cũ thì lần nâng cấp đầu tiên sẽ bắn thẳng vào nhà vừa hết quota.
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
  fs.writeFileSync(
    store.filePath,
    JSON.stringify({ version: 1, providers: { a: { cooldownUntil: Date.now() + 60_000, lastFailureStatus: 429 } } })
  );

  const { pool } = fakePool({ a: [], b: [] });
  assert.equal(store.restore(pool), 1);
  assert.equal(acct(pool, 'a').isCoolingDown(), true);
  assert.equal(acct(pool, 'b').isCoolingDown(), false);
});

test('file hỏng thì bắt đầu lại từ rỗng thay vì chặn khởi động', () => {
  const { store } = tempStore();
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
  fs.writeFileSync(store.filePath, 'đây không phải JSON');

  assert.deepEqual(store.read(), { accounts: {}, providers: {} });
  assert.equal(store.restore(fakePool({ a: [] }).pool), 0);
});

test('ghi nguyên tử: không để lại file tạm', () => {
  const { store, dir } = tempStore();
  store.write({ 'a:abc': { cooldownUntil: Date.now() + 1000 } });

  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'file tạm phải được rename đi, không còn sót');
});

test('file cooldown chỉ chủ sở hữu đọc được', { skip: process.platform === 'win32' }, () => {
  const { store } = tempStore();
  store.write({ 'a:abc': { cooldownUntil: Date.now() + 1000 } });

  const mode = fs.statSync(store.filePath).mode & 0o777;
  assert.equal(mode, 0o600, `quyền file là ${mode.toString(8)}`);
});

test('persist chỉ ghi cooldown, KHÔNG ghi API key', () => {
  const { store } = tempStore();
  const { pool } = fakePool({ a: { 'sk-bi-mat-khong-duoc-ghi': [] } });
  acct(pool, 'a').markUnavailable(429);

  store.persist(pool);
  const raw = fs.readFileSync(store.filePath, 'utf8');
  assert.doesNotMatch(raw, /sk-bi-mat/, 'file trạng thái không phải chỗ chứa bí mật');
  assert.match(raw, /"a:[0-9a-f]{16}"/, 'khóa là dấu vân tay một chiều của key');
});

test('router ghi cooldown xuống đĩa khi có tài khoản bị cho nghỉ', async () => {
  const { store } = tempStore();
  const { pool } = fakePool({ a: [{ status: 429 }], b: [{ ok: 'từ b' }] });
  const router = new SmartRouter(pool, { logger: silentLogger(), store });

  await router.chat([{ role: 'user', content: 'chào' }]);

  const saved = store.read().accounts;
  assert.ok(saved[acct(pool, 'a').id]?.cooldownUntil > Date.now(), 'cooldown của a phải nằm trên đĩa');
  assert.equal(saved[acct(pool, 'b').id], undefined, 'b phục vụ được thì không có gì để lưu');
});

test('router xóa cooldown trên đĩa khi reset', async () => {
  const { store } = tempStore();
  const { pool } = fakePool({ a: [] });
  const router = new SmartRouter(pool, { logger: silentLogger(), store });
  const id = acct(pool, 'a').id;

  acct(pool, 'a').markUnavailable(429);
  store.persist(pool);
  assert.ok(store.read().accounts[id]);

  router.reset('a');
  assert.equal(store.read().accounts[id], undefined);
});

test('không ghi được đĩa thì request vẫn chạy, chỉ ghi log cảnh báo', async () => {
  const { pool } = fakePool({ a: [{ status: 429 }], b: [{ ok: 'từ b' }] });
  const logger = silentLogger();
  const brokenStore = {
    restore: () => 0,
    persist: () => { throw new Error('đĩa đầy'); }
  };
  const router = new SmartRouter(pool, { logger, store: brokenStore });

  const result = await router.chat([{ role: 'user', content: 'chào' }]);
  assert.equal(result.provider, 'b', 'mất chỗ lưu không được làm hỏng một request phục vụ được');
  assert.ok(logger.lines.some((l) => /Không lưu được cooldown/.test(l)));
});

test('không có store thì router vẫn chạy bình thường', async () => {
  const { pool } = fakePool({ a: [{ ok: 'ổn' }] });
  const router = new SmartRouter(pool, { logger: silentLogger() });

  assert.equal((await router.chat([{ role: 'user', content: 'chào' }])).text, 'ổn');
});
