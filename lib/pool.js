const { Account, discoverKeys, fingerprint } = require('./accounts');

/**
 * Pool: các nhà cung cấp và **tài khoản** của từng nhà.
 *
 * Đơn vị xoay vòng là tài khoản, không phải nhà cung cấp. Đó là toàn bộ điểm của việc hỗ
 * trợ nhiều tài khoản: hạn mức được cấp cho từng key, nên sức khỏe cũng phải đo trên từng
 * key. Nhà cung cấp chỉ còn là bộ chuyển ngữ (biết nói chuyện với upstream nào, theo
 * phương ngữ nào) — nó không giữ trạng thái nào của lượt gọi.
 */
class AccountPool {
  constructor(providers, { env = process.env, strategy = defaultStrategy(env) } = {}) {
    this.providers = providers;
    this.providerNames = Object.keys(providers);
    this.env = env;
    this.strategy = strategy === 'provider' ? 'provider' : 'account';

    // Tài khoản sống lâu hơn một lần `configure`: `/api/chat` cấu hình lại pool ở MỖI
    // request, nên dựng lại object mỗi lần là xóa sạch cooldown và cửa sổ RPM sau đúng
    // một lượt — pool sẽ không bao giờ nhớ được nhà nào vừa hết quota.
    this.registry = new Map(); // id tài khoản -> Account
    this.active = new Map(); // tên nhà cung cấp -> Account[]
    this.providerUsedAt = new Map(); // tên nhà cung cấp -> dấu LRU cấp nhà cung cấp

    this.configure();
  }

  /**
   * Dựng lại danh sách tài khoản đang dùng được từ `.env` + key gửi kèm request.
   *
   * Giữ nguyên object cũ cho key đã biết (theo dấu vân tay) để không mất cooldown; key
   * biến mất khỏi cấu hình thì rời khỏi danh sách nhưng vẫn nằm trong registry, nên dán
   * lại nó vào UI không xóa mất khoảng nghỉ mà nó đang phải chịu.
   */
  configure(apiKeys = {}) {
    for (const name of this.providerNames) {
      const provider = this.providers[name];
      const found = discoverKeys(name, { env: this.env, apiKeys });

      const accounts = found.map(({ label, key }) => {
        const id = `${name}:${fingerprint(key)}`;
        let account = this.registry.get(id);
        if (!account) {
          // Không gán `model` ở đây: `account.model` là chỗ dành cho một model RIÊNG của
          // tài khoản này. Chép model mặc định của nhà cung cấp vào đó sẽ làm bảng trạng
          // thái báo "có ghi đè" cho mọi tài khoản, kể cả những tài khoản không ghi đè gì.
          account = new Account(name, key, { label, maxRPM: provider.maxRPM });
          this.registry.set(id, account);
        }
        // Nhãn và hạn mức có thể đổi giữa hai lần cấu hình; sức khỏe thì không được đụng.
        account.label = label;
        account.maxRPM = provider.maxRPM;
        account.enabled = true;
        return account;
      });

      this.active.set(name, accounts);
    }
    return this;
  }

  accountsOf(name) {
    return this.active.get(name) || [];
  }

  /** Mọi tài khoản đang được cấu hình, theo thứ tự khai báo nhà cung cấp. */
  list() {
    return this.providerNames.flatMap((name) => this.accountsOf(name));
  }

  providerOf(account) {
    return this.providers[account.provider];
  }

  hasAnyAccount() {
    return this.list().length > 0;
  }

  /**
   * Danh sách tài khoản dùng được cho lượt này, theo đúng thứ tự sẽ thử.
   *
   * Hai bước, giải hai bài toán khác nhau:
   *
   * 1. **Sắp theo LRU** — quyết định ai đi ĐẦU, tức là lưu lượng chia thế nào. Ở chế độ
   *    `account` (mặc định), tài khoản lâu chưa dùng nhất đi trước, nên nhà có 5 key nhận
   *    khoảng 5 phần còn nhà có 1 key nhận 1 phần: đúng bằng tỉ lệ hạn mức thật sự có.
   *    Ở chế độ `provider`, các nhà cung cấp được chia đều trước, rồi mới tới key bên trong.
   *
   * 2. **Xen kẽ theo nhà cung cấp** — quyết định thứ tự PHẦN CÒN LẠI, tức là đường thoát
   *    khi ứng viên đầu hỏng. Nếu cứ theo LRU thuần thì 5 key Gemini nằm liền nhau, và một
   *    sự cố ở phía Gemini (mất mạng tới họ, quota tính theo dự án chứ theo key, model bị
   *    gỡ) sẽ đốt cả 5 lần thử trước khi chạm tới nhà thứ hai. Xen kẽ làm ứng viên kế tiếp
   *    luôn là một nhà cung cấp khác — mà vẫn giữ nguyên ứng viên đầu, nên bước 1 không bị
   *    ảnh hưởng.
   *
   * Nhà cung cấp được GHIM là ngoại lệ của bước 2: mọi tài khoản của nhà đó đứng liền nhau
   * ở đầu. Người gọi đã nói rõ họ muốn nhà nào, nên key thứ hai của chính nhà đó bám sát ý
   * định ấy hơn hẳn một nhà khác — chỉ khi nhà được ghim hết sạch key dùng được thì mới
   * đáng rơi về phần còn lại của pool.
   */
  candidates(preferred = null, now = Date.now()) {
    const usable = this.list().filter((account) => account.isAvailable(now));

    const providerKey = (account) =>
      this.strategy === 'provider' ? this.providerUsedAt.get(account.provider) || 0 : 0;

    const byAge = (a, b) => {
      const byProvider = providerKey(a) - providerKey(b);
      if (byProvider !== 0) return byProvider;
      return a.lastUsedAt - b.lastUsedAt;
    };

    const pinned = preferred ? usable.filter((a) => a.provider === preferred).sort(byAge) : [];
    const rest = usable.filter((a) => !preferred || a.provider !== preferred).sort(byAge);

    return [...pinned, ...interleaveByProvider(rest)];
  }

  /**
   * Đóng dấu LRU cho tài khoản vừa được chọn đầu tiên.
   *
   * Luôn nhảy hơn hẳn mốc lớn nhất đang có, thay vì gán thẳng `Date.now()`: hai lượt liên
   * tiếp có thể rơi vào cùng một mili-giây, khi đó khóa sắp xếp LRU hòa nhau và thứ tự tụt
   * về thứ tự khai báo — pool kẹt vào đúng một tài khoản mà nhìn log vẫn thấy "bình thường".
   */
  stampUsed(account, now = Date.now()) {
    const newest = Math.max(0, ...this.list().map((a) => a.lastUsedAt), ...this.providerUsedAt.values());
    const stamp = Math.max(now, newest + 1);
    account.lastUsedAt = stamp;
    this.providerUsedAt.set(account.provider, stamp);
    return stamp;
  }

  /** Bao lâu nữa thì có tài khoản đầu tiên tỉnh dậy — để báo cho client nghỉ đúng số giây. */
  soonestRetrySeconds(now = Date.now()) {
    const waking = this.list()
      .filter((a) => a.enabled && a.isCoolingDown(now))
      .map((a) => a.cooldownUntil);
    if (!waking.length) return 0;
    return Math.max(0, Math.ceil((Math.min(...waking) - now) / 1000));
  }

  /** Xóa cooldown: một tài khoản (theo id), mọi tài khoản của một nhà, hoặc tất cả. */
  reset(target = null) {
    if (!target) {
      const all = this.list();
      all.forEach((a) => a.markHealthy());
      return all.map((a) => a.id);
    }
    if (this.active.has(target)) {
      const accounts = this.accountsOf(target);
      accounts.forEach((a) => a.markHealthy());
      return accounts.map((a) => a.id);
    }
    const account = this.registry.get(target) || this.list().find((a) => a.fingerprint === target);
    if (!account) return null;
    account.markHealthy();
    return [account.id];
  }

  /**
   * Trạng thái cả pool, gộp theo nhà cung cấp nhưng KHÔNG giấu từng tài khoản.
   *
   * Con số gộp một mình thì vô dụng khi có nhiều tài khoản: "gemini: rate_limited" không
   * cho biết một trong bốn key hỏng hay cả bốn, mà đó chính là câu hỏi duy nhất người vận
   * hành cần trả lời trước khi đi mua thêm key.
   */
  statuses(now = Date.now()) {
    const out = {};
    for (const name of this.providerNames) {
      const provider = this.providers[name];
      const accounts = this.accountsOf(name);
      const usable = accounts.filter((a) => a.isAvailable(now));

      out[name] = {
        name,
        displayName: provider.displayName,
        model: provider.model,
        status: providerStatus(accounts, usable, now),
        accountCount: accounts.length,
        readyCount: usable.length,
        requestCount: accounts.reduce((sum, a) => sum + a.requestCount, 0),
        maxRPM: provider.maxRPM * accounts.length,
        cooldownRemaining: accounts.length && !usable.length
          ? Math.min(...accounts.map((a) => a.cooldownRemaining(now)))
          : 0,
        lastFailureStatus: accounts.map((a) => a.lastFailureStatus).find(Boolean) || null,
        lastError: accounts.map((a) => a.lastError).find(Boolean) || null,
        accounts: accounts.map((a) => a.getStatus(now))
      };
    }
    return out;
  }
}

/**
 * `inactive` khi chưa có key nào — trạng thái đó nói "thiếu cấu hình", khác hẳn "hết quota",
 * và UI lẫn `/health` đều dựa vào phân biệt đó.
 */
function providerStatus(accounts, usable, now) {
  if (!accounts.length) return 'inactive';
  if (usable.length) return 'active';
  if (accounts.some((a) => a.isCoolingDown(now))) return 'rate_limited';
  return 'throttled';
}

/**
 * Xen kẽ một danh sách đã sắp xếp sao cho hai phần tử cùng nhà cung cấp không nằm cạnh
 * nhau, mà vẫn giữ nguyên phần tử đầu và thứ tự tương đối bên trong mỗi nhà.
 */
function interleaveByProvider(sorted) {
  const groups = new Map();
  for (const account of sorted) {
    if (!groups.has(account.provider)) groups.set(account.provider, []);
    groups.get(account.provider).push(account);
  }

  const queues = [...groups.values()];
  const out = [];
  let moved = true;
  while (moved) {
    moved = false;
    for (const queue of queues) {
      if (queue.length) {
        out.push(queue.shift());
        moved = true;
      }
    }
  }
  return out;
}

/** `GATEWAY_ROTATION=provider` để chia đều theo nhà cung cấp thay vì theo tài khoản. */
function defaultStrategy(env) {
  return String(env.GATEWAY_ROTATION || '').toLowerCase() === 'provider' ? 'provider' : 'account';
}

module.exports = { AccountPool, interleaveByProvider };
