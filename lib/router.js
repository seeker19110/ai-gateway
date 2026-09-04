const { UpstreamError } = require('./errors');
const { shouldFailOver, isClientFault } = require('./failover');

/**
 * Pool nhà cung cấp có xoay vòng LRU + failover phân loại theo mã lỗi.
 *
 * Cơ chế (đối chiếu bảng trong README):
 * - 401/402/403/429 hoặc body báo hết quota → cho nhà cung cấp nghỉ (tôn trọng `Retry-After`) → nhà kế.
 * - 5xx → nhà kế, KHÔNG cooldown (lỗi phía họ, thường qua nhanh, không đáng loại khỏi pool).
 * - Lỗi mạng → bỏ qua lượt này, KHÔNG cooldown (một nhịp mạng chập chờn không được làm nguội cả pool).
 * - 4xx khác (payload hỏng) → trả lỗi ngay, KHÔNG xoay (nhà nào cũng sẽ từ chối y hệt).
 * - Hết ứng viên → 429 kèm "thử lại sau khoảng Ns" để lớp trên biết nghỉ bao lâu.
 */
class SmartRouter {
  constructor(providers, { logger = console, store = null } = {}) {
    this.providers = providers;
    this.providerKeys = Object.keys(providers);
    this.logger = logger;
    this.store = store;
  }

  /**
   * Ghi cooldown xuống đĩa.
   *
   * Không ghi được là mất một tiện ích (cooldown không sống qua restart), không phải lý do
   * để hỏng một request đang phục vụ được — nên chỉ ghi log rồi đi tiếp.
   */
  _persist() {
    if (!this.store) return;
    try {
      this.store.persist(this.providers);
    } catch (error) {
      this.logger.warn(`Không lưu được cooldown: ${error.message}`);
    }
  }

  /** Bật/tắt nhà cung cấp theo việc có API key hay không. */
  configureProviders(apiKeys = {}) {
    for (const [key, provider] of Object.entries(this.providers)) {
      const hasKey = Boolean(this.resolveApiKey(key, apiKeys));
      if (hasKey) {
        if (provider.status === 'inactive') provider.status = 'active';
      } else {
        provider.status = 'inactive';
      }
    }
  }

  resolveApiKey(name, apiKeys = {}) {
    return apiKeys[name] || process.env[`${name.toUpperCase()}_API_KEY`] || '';
  }

  /**
   * Danh sách nhà cung cấp dùng được cho lượt này, theo đúng thứ tự sẽ thử.
   *
   * `preferred` được đẩy lên đầu; phần còn lại xoay vòng LRU (lâu chưa dùng nhất đi trước).
   * LRU thay cho con trỏ round-robin cũ: con trỏ đó nhích ngay cả khi nhà cung cấp bị bỏ
   * qua, nên thứ tự trôi theo số lần gọi chứ không theo việc ai vừa phục vụ.
   */
  candidates(preferred = null, now = Date.now()) {
    const usable = this.providerKeys
      .map((key) => this.providers[key])
      .filter((provider) => provider.isAvailable(now));

    usable.sort((a, b) => {
      const aPreferred = preferred && a.name === preferred ? 0 : 1;
      const bPreferred = preferred && b.name === preferred ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      return a.lastUsedAt - b.lastUsedAt;
    });

    return usable;
  }

  /** Bao lâu nữa thì có nhà cung cấp đầu tiên tỉnh dậy — để báo cho client nghỉ đúng số giây. */
  soonestRetrySeconds(now = Date.now()) {
    const waking = this.providerKeys
      .map((key) => this.providers[key])
      .filter((p) => p.status !== 'inactive' && p.isCoolingDown(now))
      .map((p) => p.cooldownUntil);
    if (!waking.length) return 0;
    return Math.max(0, Math.ceil((Math.min(...waking) - now) / 1000));
  }

  /**
   * Đóng dấu LRU cho nhà cung cấp vừa được chọn đầu tiên.
   *
   * Luôn nhảy hơn hẳn mốc lớn nhất đang có, thay vì gán thẳng `Date.now()`: hai lượt liên
   * tiếp có thể rơi vào cùng một mili-giây, khi đó khóa sắp xếp LRU hòa nhau và thứ tự tụt
   * về thứ tự khai báo — pool kẹt vào đúng một nhà cung cấp mà nhìn log vẫn thấy "bình thường".
   */
  _stampUsed(provider, now = Date.now()) {
    const newest = Math.max(...this.providerKeys.map((k) => this.providers[k].lastUsedAt), 0);
    provider.lastUsedAt = Math.max(now, newest + 1);
  }

  /**
   * Chạy một lượt chat qua pool.
   * Trả về `{ text, provider, usage, attempts }`, hoặc ném `UpstreamError`.
   */
  async chat(messages, { apiKeys = {}, preferred = null } = {}) {
    this.configureProviders(apiKeys);

    const now = Date.now();
    const candidates = this.candidates(preferred, now);
    if (!candidates.length) throw this._exhausted(now);

    this._stampUsed(candidates[0], now);

    const attempts = [];
    let lastError = null;

    for (const [i, provider] of candidates.entries()) {
      const position = `lần thử ${i + 1}/${candidates.length}`;
      const apiKey = this.resolveApiKey(provider.name, apiKeys);

      try {
        const { text, usage } = await provider.chat(messages, apiKey);
        provider.markSuccess();
        attempts.push({ provider: provider.name, outcome: 'ok' });

        // Lượt nào đi nhà cung cấp nào — thứ duy nhất cho phép người vận hành KIỂM CHỨNG
        // việc xoay vòng thay vì phải tin. Thiếu dòng này thì mọi lượt thành công trông
        // giống hệt nhau, kể cả khi pool đã kẹt vào đúng một nhà cung cấp.
        // `i+1/n` là vị trí trong danh sách ứng viên CỦA LƯỢT NÀY, không phải số thứ tự cố
        // định: pool sắp lại theo LRU trước mỗi lượt, nên lượt trơn tru luôn là 1/n, còn
        // 2/n trở lên nghĩa là đã phải bỏ qua ai đó.
        this.logger.info(`${provider.name} phục vụ thành công (${position})`);
        return { text, provider: provider.name, usage, attempts };
      } catch (error) {
        lastError = error;
        provider.lastError = error.message;

        const { outcome, status, cooldown, message } = this._classify(provider, error);
        this.logger.warn(`${provider.name} ${message} (${position})`);
        attempts.push({ provider: provider.name, outcome, status, ...(cooldown ? { cooldown } : {}) });

        if (outcome === 'client_fault') throw error;
      }
    }

    throw this._giveUp(candidates.length, lastError);
  }

  /**
   * Như `chat`, nhưng phát ra từng mẩu: `{ text }` nhiều lần, rồi `{ usage }`.
   *
   * Chỉ xoay vòng TRƯỚC mẩu đầu tiên. Khi mẩu đầu đã ra khỏi đây thì client đã bắt đầu
   * hiển thị câu trả lời; đổi nhà cung cấp giữa chừng sẽ nối phần đầu của nhà này với phần
   * giữa của nhà kia thành một câu trả lời không ai từng viết — hỏng theo kiểu không báo lỗi
   * và không nhìn ra được. Lỗi sau mẩu đầu vì vậy được ném thẳng lên trên.
   */
  async *streamChat(messages, { apiKeys = {}, preferred = null } = {}) {
    this.configureProviders(apiKeys);

    const now = Date.now();
    const candidates = this.candidates(preferred, now);
    if (!candidates.length) throw this._exhausted(now);

    this._stampUsed(candidates[0], now);

    let lastError = null;

    for (const [i, provider] of candidates.entries()) {
      const position = `lần thử ${i + 1}/${candidates.length}`;
      const apiKey = this.resolveApiKey(provider.name, apiKeys);
      let started = false;

      try {
        for await (const piece of provider.stream(messages, apiKey)) {
          if (!started) {
            started = true;
            provider.markSuccess();
            this.logger.info(`${provider.name} bắt đầu stream (${position})`);
            yield { provider: provider.name };
          }
          yield piece;
        }
        return;
      } catch (error) {
        if (started) {
          // Quá muộn để cứu: client đã nhận một phần câu trả lời của nhà này.
          this.logger.error(`${provider.name} đứt giữa stream, không thể xoay vòng: ${error.message}`);
          throw error;
        }

        lastError = error;
        provider.lastError = error.message;
        const { outcome, message } = this._classify(provider, error);
        this.logger.warn(`${provider.name} ${message} (stream, ${position})`);
        if (outcome === 'client_fault') throw error;
      }
    }

    throw this._giveUp(candidates.length, lastError);
  }

  /**
   * Xử lý một lỗi của provider: ghi cooldown nếu cần, trả về quyết định đã phân loại.
   *
   * Trả về `{ outcome, message }` chứ không phải một câu chữ: `chat` và `streamChat` đều
   * rẽ nhánh trên `outcome`, và rẽ nhánh bằng cách so chuỗi prose của chính mình là kiểu
   * hỏng lặng lẽ — sửa một chữ trong log là đổi luôn hành vi failover.
   */
  _classify(provider, error) {
    const status = error.statusCode || 500;
    const body = error.body || error.message || '';

    if (error.isNetworkError) {
      return { outcome: 'network', status, message: `lỗi mạng (bỏ qua lượt này, không cooldown): ${error.message}` };
    }
    if (isClientFault(status, body)) {
      provider.status = 'active';
      return { outcome: 'client_fault', status, message: `trả ${status} (lỗi phía client, không xoay vòng)` };
    }
    if (status >= 500) {
      return { outcome: 'server_error', status, message: `trả ${status}, sang nhà kế (không cooldown)` };
    }
    if (shouldFailOver(status, body)) {
      const cooldown = provider.markUnavailable(status, error.retryAfter);
      this._persist();
      return {
        outcome: 'cooldown',
        status,
        cooldown,
        message: `trả ${status}, cho nghỉ ${cooldown}s và xoay sang nhà kế`
      };
    }
    return { outcome: 'unknown', status, message: `lỗi không phân loại được (${status}), sang nhà kế` };
  }

  _exhausted(now) {
    const wait = this.soonestRetrySeconds(now);
    const anyConfigured = this.providerKeys.some((k) => this.providers[k].status !== 'inactive');
    if (!anyConfigured) {
      return new UpstreamError(
        'Chưa cấu hình nhà cung cấp nào. Thêm API key trong giao diện hoặc file .env.',
        503
      );
    }
    return new UpstreamError(
      `Mọi nhà cung cấp đều đang cooldown.${wait ? ` Thử lại sau khoảng ${wait}s.` : ''}`,
      429
    );
  }

  _giveUp(tried, lastError) {
    const wait = this.soonestRetrySeconds();
    return new UpstreamError(
      `Đã thử ${tried} nhà cung cấp, không nhà nào phục vụ được.` +
        (wait ? ` Thử lại sau khoảng ${wait}s.` : '') +
        (lastError ? ` Lỗi cuối: ${lastError.message}` : ''),
      lastError?.statusCode >= 500 ? 502 : 429
    );
  }

  resetProvider(name) {
    const provider = this.providers[name];
    if (!provider) return false;
    provider.markHealthy();
    this._persist();
    return true;
  }

  resetAll() {
    for (const key of this.providerKeys) this.providers[key].markHealthy();
    this._persist();
  }

  getAllStatuses(now = Date.now()) {
    const statuses = {};
    for (const [key, provider] of Object.entries(this.providers)) {
      statuses[key] = provider.getStatus(now);
    }
    return statuses;
  }
}

module.exports = SmartRouter;
