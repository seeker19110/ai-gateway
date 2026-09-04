const { UpstreamError } = require('./errors');
const { shouldFailOver, isClientFault } = require('./failover');

/**
 * Pool nhiều nhà cung cấp, nhiều tài khoản, có xoay vòng LRU + failover phân loại theo mã lỗi.
 *
 * Đơn vị xoay vòng là **tài khoản** (một API key), không phải nhà cung cấp: hạn mức được
 * cấp cho từng key, nên một key Gemini hết hạn mức phút không nói gì về key Gemini thứ hai.
 *
 * Cơ chế (đối chiếu bảng trong README):
 * - 401/402/403/429 hoặc body báo hết quota → cho TÀI KHOẢN đó nghỉ (tôn trọng `Retry-After`) → ứng viên kế.
 * - 5xx → ứng viên kế, KHÔNG cooldown (lỗi phía họ, thường qua nhanh, không đáng loại khỏi pool).
 * - Lỗi mạng → bỏ qua lượt này, KHÔNG cooldown (một nhịp mạng chập chờn không được làm nguội cả pool).
 * - 4xx khác (payload hỏng) → trả lỗi ngay, KHÔNG xoay (nhà nào cũng sẽ từ chối y hệt).
 * - Header hạn mức báo hết lượt → cho nghỉ tới mốc reset, kể cả khi lượt vừa rồi THÀNH CÔNG.
 * - Hết ứng viên → 429 kèm "thử lại sau khoảng Ns" để lớp trên biết nghỉ bao lâu.
 */
class SmartRouter {
  constructor(pool, { logger = console, store = null, maxAttempts = 0 } = {}) {
    this.pool = pool;
    this.providers = pool.providers;
    this.logger = logger;
    this.store = store;
    // Trần số lần thử cho MỘT request. Với mười nhà cung cấp và vài key mỗi nhà, một lượt
    // xui có thể đi qua ba chục upstream trước khi bỏ cuộc — và người gọi đã bỏ đi từ lâu
    // trước đó. `0` là không giới hạn.
    this.maxAttempts = Number(maxAttempts) || Number(process.env.GATEWAY_MAX_ATTEMPTS) || 0;
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
      this.store.persist(this.pool);
    } catch (error) {
      this.logger.warn(`Không lưu được cooldown: ${error.message}`);
    }
  }

  /** Nạp key từ `.env` + key gửi kèm request vào pool. */
  configureProviders(apiKeys = {}) {
    this.pool.configure(apiKeys);
  }

  candidates(preferred = null, now = Date.now()) {
    const all = this.pool.candidates(preferred, now);
    return this.maxAttempts > 0 ? all.slice(0, this.maxAttempts) : all;
  }

  /**
   * Chạy một lượt chat qua pool.
   * Trả về `{ text, provider, account, usage, attempts }`, hoặc ném `UpstreamError`.
   */
  async chat(messages, { apiKeys = {}, preferred = null, params = {}, model = null } = {}) {
    this.configureProviders(apiKeys);

    const now = Date.now();
    const candidates = this.candidates(preferred, now);
    if (!candidates.length) throw this._exhausted(now);

    this.pool.stampUsed(candidates[0], now);

    const attempts = [];
    let lastError = null;

    for (const [i, account] of candidates.entries()) {
      const provider = this.pool.providerOf(account);
      const position = `lần thử ${i + 1}/${candidates.length}`;

      try {
        account.trackRequest();
        const { text, usage, rateLimit } = await provider.chat(messages, account.apiKey, {
          model: this._modelFor(account, preferred, model),
          params
        });
        account.markSuccess();
        this._applyRateLimit(account, rateLimit);
        attempts.push({ provider: provider.name, account: account.label, outcome: 'ok' });

        // Lượt nào đi tài khoản nào — thứ duy nhất cho phép người vận hành KIỂM CHỨNG việc
        // xoay vòng thay vì phải tin. Thiếu dòng này thì mọi lượt thành công trông giống hệt
        // nhau, kể cả khi pool đã kẹt vào đúng một key.
        // `i+1/n` là vị trí trong danh sách ứng viên CỦA LƯỢT NÀY, không phải số thứ tự cố
        // định: pool sắp lại theo LRU trước mỗi lượt, nên lượt trơn tru luôn là 1/n, còn
        // 2/n trở lên nghĩa là đã phải bỏ qua ai đó.
        this.logger.info(`${account.label} phục vụ thành công (${position})`);
        return { text, provider: provider.name, account: account.label, usage, attempts };
      } catch (error) {
        lastError = error;
        account.markFailure(error);

        const { outcome, status, cooldown, message } = this._classify(account, error);
        this.logger.warn(`${account.label} ${message} (${position})`);
        attempts.push({
          provider: provider.name,
          account: account.label,
          outcome,
          status,
          ...(cooldown ? { cooldown } : {})
        });

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
  async *streamChat(messages, { apiKeys = {}, preferred = null, params = {}, model = null } = {}) {
    this.configureProviders(apiKeys);

    const now = Date.now();
    const candidates = this.candidates(preferred, now);
    if (!candidates.length) throw this._exhausted(now);

    this.pool.stampUsed(candidates[0], now);

    let lastError = null;

    for (const [i, account] of candidates.entries()) {
      const provider = this.pool.providerOf(account);
      const position = `lần thử ${i + 1}/${candidates.length}`;
      let started = false;

      try {
        account.trackRequest();
        const pieces = provider.stream(messages, account.apiKey, {
          model: this._modelFor(account, preferred, model),
          params
        });

        for await (const piece of pieces) {
          // Tín hiệu hạn mức đi kèm header, tới trước cả mẩu nội dung đầu tiên. Nó KHÔNG
          // được tính là "đã bắt đầu": nếu tính, một lỗi ngay sau header sẽ mất quyền xoay
          // vòng dù client chưa nhận được chữ nào.
          if (piece.rateLimit !== undefined) {
            this._applyRateLimit(account, piece.rateLimit);
            continue;
          }

          if (!started) {
            started = true;
            account.markSuccess();
            this.logger.info(`${account.label} bắt đầu stream (${position})`);
            yield { provider: provider.name, account: account.label };
          }
          yield piece;
        }
        return;
      } catch (error) {
        if (started) {
          // Quá muộn để cứu: client đã nhận một phần câu trả lời của nhà này.
          account.markFailure(error);
          this.logger.error(`${account.label} đứt giữa stream, không thể xoay vòng: ${error.message}`);
          throw error;
        }

        lastError = error;
        account.markFailure(error);
        const { outcome, message } = this._classify(account, error);
        this.logger.warn(`${account.label} ${message} (stream, ${position})`);
        if (outcome === 'client_fault') throw error;
      }
    }

    throw this._giveUp(candidates.length, lastError);
  }

  /**
   * Model dùng cho một ứng viên.
   *
   * Model do client chỉ định (`model: "groq/llama-3.1-8b-instant"`) CHỈ áp cho đúng nhà
   * cung cấp được ghim. Mang tên model của Groq sang Gemini trong lượt failover thì chắc
   * chắn 404 — mà 404 lại bị xếp vào "lỗi phía client, không xoay vòng", nên nó sẽ giết
   * luôn cả lượt gọi thay vì để nhà kế tiếp trả lời bằng model mặc định của họ.
   */
  _modelFor(account, preferred, requested) {
    if (requested && preferred && account.provider === preferred) return requested;
    return account.model || this.pool.providerOf(account).model;
  }

  /**
   * Nghỉ theo tín hiệu hạn mức của chính upstream, TRƯỚC khi ăn 429.
   *
   * Với một tài khoản, đâm vào giới hạn rồi mới nghỉ chỉ tốn một lượt. Với mười tài khoản
   * thì đó là mười lượt 429 mỗi vòng — và vài nhà cung cấp tính cả request bị từ chối vào
   * hạn mức, nên cách đó tự kéo dài đúng cái nó đang cố tránh.
   */
  _applyRateLimit(account, rateLimit) {
    if (!rateLimit || rateLimit.remaining > 0) return null;
    const seconds = rateLimit.resetSeconds;
    if (!Number.isFinite(seconds) || seconds <= 0) return null;

    account.cooldown(seconds, 'quota_header');
    this._persist();
    this.logger.info(`${account.label} hết lượt theo header hạn mức, nghỉ ${seconds}s`);
    return seconds;
  }

  /**
   * Xử lý một lỗi của tài khoản: ghi cooldown nếu cần, trả về quyết định đã phân loại.
   *
   * Trả về `{ outcome, message }` chứ không phải một câu chữ: `chat` và `streamChat` đều
   * rẽ nhánh trên `outcome`, và rẽ nhánh bằng cách so chuỗi prose của chính mình là kiểu
   * hỏng lặng lẽ — sửa một chữ trong log là đổi luôn hành vi failover.
   */
  _classify(account, error) {
    const status = error.statusCode || 500;
    const body = error.body || error.message || '';

    if (error.isNetworkError) {
      return { outcome: 'network', status, message: `lỗi mạng (bỏ qua lượt này, không cooldown): ${error.message}` };
    }
    if (isClientFault(status, body)) {
      return { outcome: 'client_fault', status, message: `trả ${status} (lỗi phía client, không xoay vòng)` };
    }
    if (status >= 500) {
      return { outcome: 'server_error', status, message: `trả ${status}, sang ứng viên kế (không cooldown)` };
    }
    if (shouldFailOver(status, body)) {
      // `Retry-After` trước, rồi mới tới mốc reset trong header hạn mức: cả hai đều là lời
      // của upstream, nhưng cái đầu nói riêng về lượt bị từ chối này.
      const retryAfter = error.retryAfter ?? error.rateLimit?.resetSeconds ?? null;
      const cooldown = account.markUnavailable(status, retryAfter);
      this._persist();
      return {
        outcome: 'cooldown',
        status,
        cooldown,
        message: `trả ${status}, cho nghỉ ${cooldown}s và xoay sang ứng viên kế`
      };
    }
    return { outcome: 'unknown', status, message: `lỗi không phân loại được (${status}), sang ứng viên kế` };
  }

  _exhausted(now) {
    if (!this.pool.hasAnyAccount()) {
      return new UpstreamError(
        'Chưa cấu hình nhà cung cấp nào. Thêm API key trong giao diện hoặc file .env.',
        503
      );
    }
    const wait = this.pool.soonestRetrySeconds(now);
    return new UpstreamError(
      `Mọi tài khoản đều đang cooldown.${wait ? ` Thử lại sau khoảng ${wait}s.` : ''}`,
      429
    );
  }

  _giveUp(tried, lastError) {
    const wait = this.pool.soonestRetrySeconds();
    return new UpstreamError(
      `Đã thử ${tried} tài khoản, không tài khoản nào phục vụ được.` +
        (wait ? ` Thử lại sau khoảng ${wait}s.` : '') +
        (lastError ? ` Lỗi cuối: ${lastError.message}` : ''),
      lastError?.statusCode >= 500 ? 502 : 429
    );
  }

  /** Xóa cooldown: một tài khoản (theo id), mọi tài khoản của một nhà, hoặc tất cả. */
  reset(target = null) {
    const reset = this.pool.reset(target);
    if (reset) this._persist();
    return reset;
  }

  getAllStatuses(now = Date.now()) {
    return this.pool.statuses(now);
  }
}

module.exports = SmartRouter;
