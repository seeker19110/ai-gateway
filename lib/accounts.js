const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cooldownFor } = require('./failover');

const RPM_WINDOW_MS = 60_000;

/** Số ký tự hex giữ lại của dấu vân tay. 16 hex = 64 bit, đủ để không đụng nhau. */
const FINGERPRINT_CHARS = 16;

/**
 * Dấu vân tay của một API key: SHA-256 rồi cắt ngắn.
 *
 * Đây là thứ được ghi xuống đĩa thay cho key, và là định danh của tài khoản trong mọi
 * log/endpoint. Phải là hàm một chiều: file trạng thái và log là nơi ai cũng đọc được,
 * còn key thì không được rời khỏi bộ nhớ. Vân tay cũng ổn định qua các lần khởi động và
 * qua việc đổi thứ tự key trong `.env` — nên cooldown nạp lại đúng tài khoản, không phải
 * "tài khoản thứ hai" của lần chạy trước.
 */
function fingerprint(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, FINGERPRINT_CHARS);
}

/**
 * Rút gọn key để hiện ra UI/log: `AIza…7f2a`.
 *
 * Đủ để người vận hành nhận ra "key nào trong bốn key của tôi đang bị khóa" mà không in
 * ra thứ có thể dùng lại được. Key quá ngắn thì che sạch, vì 4 đầu + 4 cuối của một chuỗi
 * 10 ký tự là đã lộ gần hết.
 */
function maskKey(apiKey) {
  const key = String(apiKey || '');
  if (key.length < 12) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Một tài khoản: một API key kèm sức khỏe riêng của nó.
 *
 * Đây là thay đổi cốt lõi so với bản trước, nơi cooldown và cửa sổ RPM nằm trên
 * *nhà cung cấp*. Quota, rate limit và việc bị khóa đều gắn với **key**, không gắn với
 * nhà cung cấp: một key Gemini hết hạn mức phút không nói gì về key Gemini thứ hai của
 * một dự án khác. Gộp chung như trước nghĩa là một key hết quota làm chết cả nhà cung
 * cấp — đúng thứ mà nhiều tài khoản sinh ra để tránh.
 */
class Account {
  constructor(providerName, apiKey, { label = '', maxRPM = 10, model = '' } = {}) {
    this.provider = providerName;
    this.apiKey = String(apiKey);
    this.fingerprint = fingerprint(this.apiKey);
    this.id = `${providerName}:${this.fingerprint}`;
    this.label = label || `${providerName}#1`;
    this.maskedKey = maskKey(this.apiKey);
    this.maxRPM = maxRPM;
    this.model = model || ''; // rỗng = dùng model mặc định của nhà cung cấp

    this.enabled = true;
    this.lastError = null;
    this.lastFailureStatus = 0;
    this.cooldownUntil = 0;
    this.cooldownReason = null;

    // Cửa sổ đếm request trượt theo thời gian, tính lười khi cần (không timer nào).
    this.requestCount = 0;
    this.windowStartedAt = Date.now();

    // Dấu LRU do pool đóng; phải đơn điệu tăng, xem `AccountPool.stampUsed`.
    this.lastUsedAt = 0;
    this.successCount = 0;
    this.failureCount = 0;
  }

  _rollRequestWindow(now = Date.now()) {
    if (now - this.windowStartedAt >= RPM_WINDOW_MS) {
      this.requestCount = 0;
      this.windowStartedAt = now;
    }
  }

  isCoolingDown(now = Date.now()) {
    return this.cooldownUntil > now;
  }

  cooldownRemaining(now = Date.now()) {
    return this.isCoolingDown(now) ? Math.ceil((this.cooldownUntil - now) / 1000) : 0;
  }

  isAvailable(now = Date.now()) {
    if (!this.enabled) return false;
    if (this.isCoolingDown(now)) return false;
    this._rollRequestWindow(now);
    return this.requestCount < this.maxRPM;
  }

  /** `active | rate_limited | throttled | disabled` — đủ để UI vẽ và người vận hành đọc. */
  statusName(now = Date.now()) {
    if (!this.enabled) return 'disabled';
    if (this.isCoolingDown(now)) return 'rate_limited';
    this._rollRequestWindow(now);
    if (this.requestCount >= this.maxRPM) return 'throttled';
    return 'active';
  }

  /**
   * Cho tài khoản này nghỉ sau một lỗi. `Retry-After` của upstream ghi đè bảng mặc định:
   * upstream biết rõ hơn ta khi nào nó sẵn sàng trở lại.
   */
  markUnavailable(statusCode, retryAfter = null, now = Date.now()) {
    const seconds = cooldownFor(statusCode, retryAfter, now);
    this.cooldownUntil = now + seconds * 1000;
    this.lastFailureStatus = Number(statusCode) || 0;
    this.cooldownReason = 'error';
    return seconds;
  }

  /**
   * Nghỉ theo tín hiệu hạn mức của chính upstream (header `*-ratelimit-*`), tức là nghỉ
   * TRƯỚC khi ăn 429 chứ không phải sau.
   *
   * Tách khỏi `markUnavailable` vì đây không phải một lần thất bại: lượt vừa rồi vẫn
   * thành công, chỉ là nhà cung cấp vừa nói "hết lượt tới đây". Ghi nó thành `lastFailureStatus`
   * sẽ làm mọi bảng trạng thái báo lỗi cho một tài khoản đang hoàn toàn khỏe mạnh.
   */
  cooldown(seconds, reason = 'quota') {
    const secs = Math.max(1, Math.ceil(Number(seconds) || 0));
    const until = Date.now() + secs * 1000;
    // Không rút ngắn một cooldown đang dài hơn: tín hiệu xấu hơn luôn thắng.
    if (until > this.cooldownUntil) {
      this.cooldownUntil = until;
      this.cooldownReason = reason;
    }
    return secs;
  }

  markHealthy() {
    this.cooldownUntil = 0;
    this.cooldownReason = null;
    this.lastFailureStatus = 0;
    this.lastError = null;
    this.enabled = true;
  }

  /**
   * Ghi nhận một lượt thành công.
   *
   * KHÔNG đụng tới `lastUsedAt`: dấu LRU do pool đóng và phải đơn điệu tăng. Gán lại
   * `Date.now()` ở đây sẽ ghi đè dấu đó bằng một mốc thô — hai lượt rơi vào cùng mili-giây
   * là khóa LRU hòa nhau, thứ tự tụt về thứ tự khai báo, và pool kẹt vào đúng một tài
   * khoản trong khi log vẫn trông bình thường.
   */
  markSuccess() {
    this.lastError = null;
    this.lastFailureStatus = 0;
    this.successCount++;
  }

  markFailure(error) {
    this.lastError = error?.message || String(error || '');
    this.failureCount++;
  }

  trackRequest(now = Date.now()) {
    this._rollRequestWindow(now);
    this.requestCount++;
  }

  /** Trạng thái để hiện ra ngoài. Không bao giờ chứa key thật. */
  getStatus(now = Date.now()) {
    this._rollRequestWindow(now);
    return {
      id: this.id,
      label: this.label,
      key: this.maskedKey,
      fingerprint: this.fingerprint,
      status: this.statusName(now),
      model: this.model || null,
      requestCount: this.requestCount,
      maxRPM: this.maxRPM,
      cooldownUntil: this.cooldownUntil || null,
      cooldownRemaining: this.cooldownRemaining(now),
      cooldownReason: this.cooldownReason,
      lastFailureStatus: this.lastFailureStatus || null,
      lastError: this.lastError,
      successCount: this.successCount,
      failureCount: this.failureCount
    };
  }
}

// ---------- tìm key ----------

/** Nhãn hợp lệ trong cú pháp `nhãn=key`: đủ chặt để không nuốt nhầm một key có dấu `=`. */
const LABEL_PATTERN = /^[\w.\-#@ ]{1,32}$/;

/**
 * Độ dài tối thiểu của phần sau dấu `=` để nó được coi là một key.
 *
 * Không có ràng buộc này thì `abc123def456==` (đuôi đệm base64) bị cắt thành nhãn
 * `abc123def456` và key `=`: một key hợp lệ bị băm nát mà không có lỗi nào, chỉ có một
 * chuỗi 401 khó hiểu sau đó. Mọi API key thật đều dài hơn ngưỡng này rất nhiều.
 */
const MIN_KEY_CHARS = 8;

/**
 * Tách một chuỗi nhiều key thành từng key.
 *
 * Chấp nhận dấu phẩy, chấm phẩy và xuống dòng làm dấu ngăn: ba thứ này phủ hết cách người
 * ta thực sự viết biến môi trường (một dòng dài trong `.env`, hay một secret nhiều dòng
 * của Docker/Kubernetes). Mỗi phần tử có thể mang nhãn ở dạng `cá-nhân=sk-...` để bảng
 * trạng thái gọi được tên tài khoản thay vì `openai#2`.
 */
function parseKeyList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => parseKeyList(item));
  if (typeof value !== 'string') return [];

  return value
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq > 0) {
        const label = part.slice(0, eq).trim();
        const key = part.slice(eq + 1).trim();
        // Chỉ coi là `nhãn=key` khi vế trái trông như một cái tên VÀ vế phải dài như một
        // key thật; ngược lại thì dấu `=` đó thuộc về chính key (đuôi đệm base64 chẳng hạn).
        if (key.length >= MIN_KEY_CHARS && LABEL_PATTERN.test(label)) return { label, key };
      }
      return { label: '', key: part };
    })
    .filter((entry) => entry.key);
}

/**
 * Gom mọi key của một nhà cung cấp, theo thứ tự ưu tiên ổn định.
 *
 * Ba dạng biến môi trường, vì ba cách triển khai khác nhau đều phổ biến và không cách nào
 * thay được cả hai cách kia:
 * - `GEMINI_API_KEY` — một key, giữ nguyên cho cấu hình cũ chạy tiếp không cần sửa gì.
 * - `GEMINI_API_KEYS` — danh sách, cách gọn nhất cho `.env` và cho một secret duy nhất.
 * - `GEMINI_API_KEY_2`, `_3`… — mỗi key một biến, cách duy nhất tiện khi secret được
 *   gắn rời từng cái (Docker secrets, Kubernetes env, CI variables).
 *
 * Key trùng nhau bị loại theo dấu vân tay: dán nhầm cùng một key vào hai biến là chuyện
 * thường, và nếu không loại thì pool tưởng có hai tài khoản, chia đôi lưu lượng vào cùng
 * một hạn mức rồi ăn 429 sớm gấp đôi.
 */
function discoverKeys(providerName, { env = process.env, apiKeys = {} } = {}) {
  const prefix = providerName.toUpperCase();
  const entries = [];

  // Key gửi kèm request (web UI) đi trước: người dùng vừa gõ nó, ý định rõ ràng hơn `.env`.
  entries.push(...parseKeyList(apiKeys?.[providerName]));

  entries.push(...parseKeyList(env[`${prefix}_API_KEY`]));
  entries.push(...parseKeyList(env[`${prefix}_API_KEYS`]));

  // Tài khoản subscription (Claude Pro/Max) đăng nhập sẵn qua Claude Code CLI: đọc thẳng
  // token OAuth mà CLI đã lưu, khỏi bắt người dùng dán tay `sk-ant-oat...`.
  if (providerName === 'claude') {
    const cli = discoverClaudeCliCredential(env);
    if (cli) entries.push(cli);
  }

  // `..._API_KEY_10` phải đứng sau `..._API_KEY_9`: so chuỗi sẽ xếp "10" trước "9".
  const numbered = Object.keys(env)
    .map((name) => {
      const match = name.match(new RegExp(`^${prefix}_API_KEY_(\\d+)$`));
      return match ? { name, index: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);

  for (const { name } of numbered) entries.push(...parseKeyList(env[name]));

  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const fp = fingerprint(entry.key);
    if (seen.has(fp)) continue;
    seen.add(fp);
    unique.push({ label: entry.label || `${providerName}#${unique.length + 1}`, key: entry.key });
  }
  return unique;
}

/**
 * Đọc token OAuth mà Claude Code CLI đã lưu khi người dùng `claude login` bằng tài khoản
 * subscription (Pro/Max), ở `~/.claude/.credentials.json` (hoặc `$CLAUDE_CONFIG_DIR`).
 *
 * Đây là "thông qua CLI": không yêu cầu người vận hành tự tay copy token ra biến môi
 * trường — CLI vốn đã đăng nhập sẵn trên máy, gateway chỉ mượn lại phiên đó. Token hết hạn
 * thì bỏ qua thay vì gửi lên upstream để ăn 401 — CLI tự làm mới token của nó, không phải
 * việc của gateway.
 */
function discoverClaudeCliCredential(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const file = path.join(dir, '.credentials.json');

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // Chưa `claude login`, hoặc chạy trên máy/CI không có CLI — im lặng bỏ qua.
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // File hỏng/đang ghi dở: coi như không có, đừng làm sập cả pool vì nó.
  }

  const oauth = parsed?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (!token) return null;

  if (oauth.expiresAt && Number(oauth.expiresAt) <= Date.now()) return null;

  return { label: 'claude-cli', key: token };
}

module.exports = {
  Account,
  fingerprint,
  maskKey,
  parseKeyList,
  discoverKeys,
  discoverClaudeCliCredential,
  RPM_WINDOW_MS,
  FINGERPRINT_CHARS,
  MIN_KEY_CHARS
};
