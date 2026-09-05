const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  Account,
  fingerprint,
  maskKey,
  parseKeyList,
  discoverKeys,
  discoverClaudeCliCredential,
  discoverGatewayClaudeCredential
} = require('../lib/accounts');
const claudeOAuth = require('../lib/claudeOAuth');
const { AccountPool, interleaveByProvider } = require('../lib/pool');
const { fakePool, acct } = require('./helpers');

/** Thư mục CLI giả: `<dir>/.credentials.json`, để không đụng tới `~/.claude` thật khi test. */
function fakeCliDir(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-cli-'));
  if (content !== undefined) {
    fs.writeFileSync(path.join(dir, '.credentials.json'), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

// ---------- tìm key ----------

test('ba dạng biến môi trường đều được đọc', () => {
  const found = discoverKeys('gemini', {
    env: {
      GEMINI_API_KEY: 'k-mot',
      GEMINI_API_KEYS: 'k-hai, k-ba',
      GEMINI_API_KEY_2: 'k-bon'
    }
  });
  assert.deepEqual(found.map((f) => f.key), ['k-mot', 'k-hai', 'k-ba', 'k-bon']);
});

test('key trùng nhau bị loại — dán nhầm hai chỗ không được thành hai tài khoản', () => {
  const found = discoverKeys('groq', {
    env: { GROQ_API_KEY: 'trung', GROQ_API_KEYS: 'trung,khac' }
  });
  // Hai "tài khoản" cùng một key sẽ chia đôi lưu lượng vào cùng một hạn mức rồi ăn 429 sớm
  // gấp đôi, trong khi bảng trạng thái vẫn báo có hai tài khoản khỏe mạnh.
  assert.deepEqual(found.map((f) => f.key), ['trung', 'khac']);
});

test('`..._API_KEY_10` xếp sau `..._API_KEY_9`, không theo thứ tự chuỗi', () => {
  const env = {};
  for (const i of [10, 2, 9, 1]) env[`OPENAI_API_KEY_${i}`] = `k${i}`;
  assert.deepEqual(discoverKeys('openai', { env }).map((f) => f.key), ['k1', 'k2', 'k9', 'k10']);
});

test('cú pháp `nhãn=key` đặt tên cho tài khoản', () => {
  const found = parseKeyList('ca-nhan=sk-key-mot-that-dai, cong-ty=sk-key-hai-that-dai, sk-khong-co-nhan');
  assert.deepEqual(found, [
    { label: 'ca-nhan', key: 'sk-key-mot-that-dai' },
    { label: 'cong-ty', key: 'sk-key-hai-that-dai' },
    { label: '', key: 'sk-khong-co-nhan' }
  ]);
});

test('dấu `=` bên trong key không bị hiểu nhầm là nhãn', () => {
  // Đuôi đệm base64 và vài định dạng key khác có dấu `=`; cắt bừa ở đó là làm hỏng key.
  const found = parseKeyList('abc123def456==');
  assert.deepEqual(found, [{ label: '', key: 'abc123def456==' }]);
});

test('xuống dòng cũng là dấu ngăn — secret nhiều dòng của Docker/K8s', () => {
  assert.deepEqual(parseKeyList('k1\nk2\n\nk3').map((f) => f.key), ['k1', 'k2', 'k3']);
});

test('key gửi kèm request đi trước key trong .env', () => {
  const found = discoverKeys('groq', {
    env: { GROQ_API_KEY: 'tu-env' },
    apiKeys: { groq: 'tu-giao-dien' }
  });
  assert.deepEqual(found.map((f) => f.key), ['tu-giao-dien', 'tu-env']);
});

test('giao diện gửi được cả mảng key lẫn chuỗi nhiều key', () => {
  assert.deepEqual(
    discoverKeys('groq', { env: {}, apiKeys: { groq: ['k1', 'k2'] } }).map((f) => f.key),
    ['k1', 'k2']
  );
  assert.deepEqual(
    discoverKeys('groq', { env: {}, apiKeys: { groq: 'k1,k2' } }).map((f) => f.key),
    ['k1', 'k2']
  );
});

// ---------- danh tính và bí mật ----------

test('dấu vân tay ổn định và một chiều', () => {
  assert.equal(fingerprint('sk-abc'), fingerprint('sk-abc'));
  assert.notEqual(fingerprint('sk-abc'), fingerprint('sk-abd'));
  assert.match(fingerprint('sk-abc'), /^[0-9a-f]{16}$/);
  assert.doesNotMatch(fingerprint('sk-abc'), /abc/, 'không được chứa mẩu nào của key');
});

test('key hiện ra ngoài luôn ở dạng đã che', () => {
  assert.equal(maskKey('sk-proj-1234567890abcd'), 'sk-p…abcd');
  assert.equal(maskKey('ngan'), '••••', 'key ngắn thì che sạch, 4 đầu 4 cuối là lộ gần hết');

  const account = new Account('openai', 'sk-proj-1234567890abcd', { label: 'ca-nhan' });
  const status = JSON.stringify(account.getStatus());
  assert.doesNotMatch(status, /1234567890/, 'trạng thái không được mang key thật');
});

// ---------- sức khỏe từng tài khoản ----------

test('cửa sổ RPM tự trượt, không cần setInterval', () => {
  const account = new Account('groq', 'k', { maxRPM: 2 });
  const t0 = Date.now();

  account.trackRequest(t0);
  account.trackRequest(t0);
  assert.equal(account.isAvailable(t0), false, 'đã chạm trần RPM');
  assert.equal(account.statusName(t0), 'throttled');
  assert.equal(account.isAvailable(t0 + 61_000), true, 'qua 60s là cửa sổ mới');
});

test('cooldown theo tín hiệu hạn mức không bị coi là một lần thất bại', () => {
  const account = new Account('groq', 'k');
  account.cooldown(30, 'quota_header');

  assert.equal(account.isCoolingDown(), true);
  assert.equal(account.lastFailureStatus, 0, 'tài khoản này hoàn toàn khỏe mạnh, chỉ là hết lượt');
  assert.equal(account.cooldownReason, 'quota_header');
});

test('cooldown mới không được rút ngắn cooldown đang dài hơn', () => {
  const account = new Account('groq', 'k');
  account.markUnavailable(429); // 1 giờ
  const long = account.cooldownUntil;

  account.cooldown(10, 'quota_header');
  assert.equal(account.cooldownUntil, long, 'tín hiệu xấu hơn luôn thắng');
});

// ---------- pool ----------

test('cấu hình lại pool KHÔNG xóa cooldown đang có', () => {
  const { pool } = fakePool({ a: { k1: [], k2: [] } });
  acct(pool, 'a', 0).markUnavailable(429);

  // `/api/chat` cấu hình lại pool ở mỗi request. Dựng lại tài khoản mỗi lần là xóa sạch
  // cooldown sau đúng một lượt — pool sẽ không bao giờ nhớ được key nào vừa hết quota.
  pool.configure();
  assert.equal(acct(pool, 'a', 0).isCoolingDown(), true);
});

test('key bị gỡ khỏi cấu hình rồi thêm lại vẫn giữ nguyên cooldown', () => {
  const providers = fakePool({ a: { k1: [] } }).providers;
  const pool = new AccountPool(providers, { env: { A_API_KEYS: 'k1' } });
  acct(pool, 'a').markUnavailable(429);
  const until = acct(pool, 'a').cooldownUntil;

  pool.env = {};
  pool.configure();
  assert.equal(pool.list().length, 0);

  pool.env = { A_API_KEYS: 'k1' };
  pool.configure();
  assert.equal(acct(pool, 'a').cooldownUntil, until, 'dán lại key không xóa được khoảng nghỉ của nó');
});

test('xen kẽ giữ nguyên ứng viên đầu nhưng trải phần còn lại ra nhiều nhà', () => {
  const mk = (provider, i) => ({ provider, id: `${provider}${i}` });
  const order = interleaveByProvider([mk('g', 1), mk('g', 2), mk('g', 3), mk('o', 1), mk('c', 1)]);

  assert.equal(order[0].id, 'g1', 'ứng viên đầu do LRU quyết định, xen kẽ không được đụng vào');
  assert.deepEqual(order.map((a) => a.id), ['g1', 'o1', 'c1', 'g2', 'g3']);
});

test('trạng thái gộp theo nhà nhưng vẫn chỉ ra từng key', () => {
  const { pool } = fakePool({ a: { k1: [], k2: [] } });
  acct(pool, 'a', 0).markUnavailable(429);

  const status = pool.statuses().a;
  // "gemini: rate_limited" một mình không cho biết một trong bốn key hỏng hay cả bốn — mà
  // đó chính là câu hỏi duy nhất cần trả lời trước khi đi mua thêm key.
  assert.equal(status.status, 'active');
  assert.equal(status.accountCount, 2);
  assert.equal(status.readyCount, 1);
  assert.deepEqual(status.accounts.map((a) => a.status), ['rate_limited', 'active']);
});

test('mọi key của một nhà đều nghỉ thì nhà đó mới là rate_limited', () => {
  const { pool } = fakePool({ a: { k1: [], k2: [] } });
  pool.accountsOf('a').forEach((account) => account.markUnavailable(429));
  assert.equal(pool.statuses().a.status, 'rate_limited');
});

test('nhà chưa có key nào là `inactive`, khác hẳn hết quota', () => {
  const providers = fakePool({ a: [] }).providers;
  const pool = new AccountPool(providers, { env: {} });
  assert.equal(pool.statuses().a.status, 'inactive');
  assert.equal(pool.hasAnyAccount(), false);
});

// ---------- tài khoản subscription Claude (CLI + gateway tự đăng nhập) ----------

test('discoverClaudeCliCredential: không có file thì trả null, không ném lỗi', () => {
  const env = { CLAUDE_CONFIG_DIR: fakeCliDir() };
  assert.equal(discoverClaudeCliCredential(env), null);
});

test('discoverClaudeCliCredential: đọc đúng accessToken từ claudeAiOauth', () => {
  const env = {
    CLAUDE_CONFIG_DIR: fakeCliDir({ claudeAiOauth: { accessToken: 'sk-ant-oat-cli', expiresAt: Date.now() + 60_000 } })
  };
  const found = discoverClaudeCliCredential(env);
  assert.deepEqual(found, { label: 'claude-cli', key: 'sk-ant-oat-cli' });
});

test('discoverClaudeCliCredential: token hết hạn thì bỏ qua, y như chưa đăng nhập', () => {
  const env = {
    CLAUDE_CONFIG_DIR: fakeCliDir({ claudeAiOauth: { accessToken: 'sk-ant-oat-cli', expiresAt: Date.now() - 1000 } })
  };
  assert.equal(discoverClaudeCliCredential(env), null);
});

test('discoverClaudeCliCredential: thiếu accessToken hoặc file hỏng JSON đều trả null', () => {
  assert.equal(discoverClaudeCliCredential({ CLAUDE_CONFIG_DIR: fakeCliDir({ claudeAiOauth: {} }) }), null);
  assert.equal(discoverClaudeCliCredential({ CLAUDE_CONFIG_DIR: fakeCliDir('{không phải json') }), null);
});

test('discoverClaudeCliCredential: cache TTL — sửa file trong vài giây đầu vẫn thấy giá trị cũ', () => {
  const dir = fakeCliDir({ claudeAiOauth: { accessToken: 'v1', expiresAt: Date.now() + 60_000 } });
  const env = { CLAUDE_CONFIG_DIR: dir };
  assert.equal(discoverClaudeCliCredential(env).key, 'v1');

  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'v2', expiresAt: Date.now() + 60_000 } }));
  // Vẫn trong cửa sổ cache (mặc định vài giây): đọc lại ngay chưa thấy giá trị mới — đây là
  // đánh đổi có chủ đích để không `readFileSync` trên mọi request chat.
  assert.equal(discoverClaudeCliCredential(env).key, 'v1');
});

test('discoverKeys("claude"): có CLI thì ưu tiên CLI, không đếm trùng với token gateway', () => {
  const cliDir = fakeCliDir({ claudeAiOauth: { accessToken: 'cli-token', expiresAt: Date.now() + 60_000 } });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-state-'));
  claudeOAuth.saveCredential({ accessToken: 'gateway-token', expiresAt: Date.now() + 60_000 }, { GATEWAY_STATE_DIR: stateDir });

  const env = { CLAUDE_CONFIG_DIR: cliDir, GATEWAY_STATE_DIR: stateDir };
  const found = discoverKeys('claude', { env });
  assert.deepEqual(found.map((f) => f.key), ['cli-token'], 'chỉ lấy CLI, không cộng thêm token gateway');
});

test('discoverGatewayClaudeCredential: không có CLI thì rơi về token gateway tự đăng nhập', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-state-'));
  const env = { CLAUDE_CONFIG_DIR: fakeCliDir(), GATEWAY_STATE_DIR: stateDir };

  assert.equal(discoverGatewayClaudeCredential(env), null, 'chưa đăng nhập gateway thì chưa có gì');

  claudeOAuth.saveCredential({ accessToken: 'gateway-token', expiresAt: Date.now() + 60_000 }, env);
  assert.deepEqual(discoverGatewayClaudeCredential(env), { label: 'claude-subscription', key: 'gateway-token' });

  const found = discoverKeys('claude', { env });
  assert.deepEqual(found.map((f) => f.key), ['gateway-token']);
});

test('discoverGatewayClaudeCredential: token gateway hết hạn thì bỏ qua', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-state-'));
  const env = { GATEWAY_STATE_DIR: stateDir };
  claudeOAuth.saveCredential({ accessToken: 'expired', expiresAt: Date.now() - 1000 }, env);
  assert.equal(discoverGatewayClaudeCredential(env), null);
});
