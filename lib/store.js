const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Lưu cooldown xuống đĩa để nó sống qua restart.
 *
 * Không có phần này thì restart là xóa sạch cooldown: gateway lại bắn thẳng vào nhà cung
 * cấp vừa hết quota, ăn 429 ngay lượt đầu — và một tiến trình hay crash-restart sẽ không
 * bao giờ học được gì. File dùng chung cũng cho nhiều tiến trình thấy cooldown của nhau,
 * thứ mà quota vốn đã dùng chung nhưng trạng thái trong RAM thì không.
 *
 * Chỉ lưu cooldown, KHÔNG lưu API key: file này không phải chỗ chứa bí mật.
 */
class CooldownStore {
  constructor(filePath = defaultStorePath()) {
    this.filePath = filePath;
  }

  /** Đọc `{ [tên]: { cooldownUntil, lastFailureStatus } }`; file hỏng hoặc thiếu thì coi như rỗng. */
  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return data && typeof data === 'object' && data.providers ? data.providers : {};
    } catch {
      // Thiếu file là chuyện bình thường (lần chạy đầu); file hỏng thì bắt đầu lại từ rỗng
      // còn hơn là không khởi động được vì một file cache.
      return {};
    }
  }

  /**
   * Ghi nguyên tử: viết ra file tạm rồi `rename` đè vào chỗ.
   *
   * `rename` trong cùng một thư mục là thao tác nguyên tử của hệ thống tệp, nên không có
   * thời điểm nào file chính ở trạng thái viết dở. Ghi thẳng vào file chính thì một lần
   * tắt máy đúng lúc sẽ để lại JSON cụt, và mọi lần khởi động sau đó đều mất cooldown.
   */
  write(providers) {
    const payload = { version: 1, savedAt: Date.now(), providers };
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
  restore(providers, now = Date.now()) {
    const saved = this.read();
    let restored = 0;

    for (const [name, state] of Object.entries(saved)) {
      const provider = providers[name];
      if (!provider) continue; // nhà cung cấp đã bị gỡ khỏi code
      const until = Number(state?.cooldownUntil) || 0;
      if (until <= now) continue; // đã hết hạn trong lúc gateway tắt
      provider.cooldownUntil = until;
      provider.lastFailureStatus = Number(state?.lastFailureStatus) || 0;
      restored++;
    }
    return restored;
  }

  /** Ghi lại cooldown còn hiệu lực của cả pool. */
  persist(providers, now = Date.now()) {
    const state = {};
    for (const [name, provider] of Object.entries(providers)) {
      if (provider.cooldownUntil > now) {
        state[name] = {
          cooldownUntil: provider.cooldownUntil,
          lastFailureStatus: provider.lastFailureStatus || 0
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

module.exports = { CooldownStore, defaultStorePath };
