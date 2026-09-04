const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_VERSION = 2;

/**
 * Lưu cooldown xuống đĩa để nó sống qua restart.
 *
 * Không có phần này thì restart là xóa sạch cooldown: gateway lại bắn thẳng vào tài khoản
 * vừa hết quota, ăn 429 ngay lượt đầu — và một tiến trình hay crash-restart sẽ không bao
 * giờ học được gì. File dùng chung cũng cho nhiều tiến trình thấy cooldown của nhau, thứ
 * mà quota vốn đã dùng chung nhưng trạng thái trong RAM thì không.
 *
 * Khóa là **dấu vân tay của API key**, không phải tên nhà cung cấp: có nhiều tài khoản thì
 * "gemini đang nghỉ" là một câu vô nghĩa — nghỉ là key nào? Vân tay cũng ổn định qua việc
 * đổi thứ tự key trong `.env`, nên cooldown nạp lại đúng key đã bị khóa chứ không phải
 * "key thứ hai" của lần chạy trước.
 *
 * Chỉ lưu cooldown, KHÔNG lưu API key: file này không phải chỗ chứa bí mật, và vân tay là
 * hàm một chiều nên đọc file không dựng lại được key.
 */
class CooldownStore {
  constructor(filePath = defaultStorePath()) {
    this.filePath = filePath;
  }

  /**
   * Đọc `{ [id tài khoản]: { cooldownUntil, lastFailureStatus } }`; file hỏng hoặc thiếu
   * thì coi như rỗng.
   *
   * File phiên bản 1 khóa theo tên nhà cung cấp. Nó vẫn được đọc và được hiểu là "cả nhà
   * cung cấp này đang nghỉ": bản cũ chỉ biết tới một key mỗi nhà, nên đó đúng là điều nó
   * muốn nói. Bỏ qua file cũ thì lần nâng cấp đầu tiên sẽ bắn thẳng vào những tài khoản
   * vừa hết quota — đúng thứ mà việc lưu xuống đĩa sinh ra để tránh.
   */
  read() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      // Thiếu file là chuyện bình thường (lần chạy đầu); file hỏng thì bắt đầu lại từ rỗng
      // còn hơn là không khởi động được vì một file cache.
      return { accounts: {}, providers: {} };
    }
    if (!data || typeof data !== 'object') return { accounts: {}, providers: {} };

    return {
      accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
      providers: data.providers && typeof data.providers === 'object' ? data.providers : {}
    };
  }

  /**
   * Ghi nguyên tử: viết ra file tạm rồi `rename` đè vào chỗ.
   *
   * `rename` trong cùng một thư mục là thao tác nguyên tử của hệ thống tệp, nên không có
   * thời điểm nào file chính ở trạng thái viết dở. Ghi thẳng vào file chính thì một lần
   * tắt máy đúng lúc sẽ để lại JSON cụt, và mọi lần khởi động sau đó đều mất cooldown.
   */
  write(accounts) {
    const payload = { version: STORE_VERSION, savedAt: Date.now(), accounts };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* file tạm có thể chưa kịp tạo */ }
      // Không ghi được cooldown là mất một tiện ích, không phải lý do để hỏng cả request.
      throw Object.assign(new Error(`Không ghi được ${this.filePath}: ${error.message}`), {
        code: 'STORE_WRITE_FAILED'
      });
    }
  }

  /** Nạp cooldown còn hiệu lực vào pool. Cooldown đã hết hạn thì bỏ qua. */
  restore(pool, now = Date.now()) {
    const saved = this.read();
    let restored = 0;

    for (const account of pool.list()) {
      const state = saved.accounts[account.id] || saved.providers[account.provider];
      if (!state) continue;

      const until = Number(state.cooldownUntil) || 0;
      if (until <= now) continue; // đã hết hạn trong lúc gateway tắt

      account.cooldownUntil = until;
      account.lastFailureStatus = Number(state.lastFailureStatus) || 0;
      account.cooldownReason = state.reason || 'error';
      restored++;
    }
    return restored;
  }

  /** Ghi lại cooldown còn hiệu lực của cả pool. */
  persist(pool, now = Date.now()) {
    const state = {};
    for (const account of pool.list()) {
      if (account.cooldownUntil > now) {
        state[account.id] = {
          provider: account.provider,
          cooldownUntil: account.cooldownUntil,
          lastFailureStatus: account.lastFailureStatus || 0,
          reason: account.cooldownReason || 'error'
        };
      }
    }
    this.write(state);
    return state;
  }
}

function defaultStorePath() {
  return process.env.GATEWAY_STATE_FILE || path.join(os.homedir(), '.ai-gateway', 'cooldowns.json');
}

module.exports = { CooldownStore, defaultStorePath, STORE_VERSION };
