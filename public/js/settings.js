/**
 * `fetch` tự gắn một token từ `localStorage` vào header cho trước, và hỏi lại qua hộp thoại
 * khi gặp `401` (token thiếu/sai) rồi thử lại đúng một lần. Không đụng gì khi gateway chưa
 * bật xác thực tương ứng — request đi qua bình thường vì server bỏ qua header không cần đến.
 *
 * Hỏi SAU khi gặp 401, không hỏi trước: đa số gateway chạy nội bộ không bật token nào, và
 * hỏi trước ở MỌI lượt sẽ làm phiền đúng những người không cần nó.
 */
function makeTokenFetch({ storageKey, header, promptText }) {
  return async function tokenFetch(url, options = {}) {
    const token = localStorage.getItem(storageKey);
    const withToken = (t) => ({ ...options, headers: { ...(options.headers || {}), ...(t ? { [header]: t } : {}) } });

    let res = await fetch(url, withToken(token));
    if (res.status === 401) {
      const entered = window.prompt(promptText);
      if (!entered) return res;
      localStorage.setItem(storageKey, entered);
      res = await fetch(url, withToken(entered));
    }
    return res;
  };
}

/** Cho `/api/providers/*` và `/api/claude/oauth/*` — xem GATEWAY_ADMIN_TOKEN trong README. */
const adminFetch = makeTokenFetch({
  storageKey: 'aigateway_admin_token',
  header: 'X-Admin-Token',
  promptText: 'Endpoint quản trị này yêu cầu admin token (GATEWAY_ADMIN_TOKEN của gateway). Dán token vào đây:'
});

/** Cho `/api/chat` — xem GATEWAY_API_KEY/GATEWAY_API_KEYS trong README. */
const clientFetch = makeTokenFetch({
  storageKey: 'aigateway_client_key',
  header: 'X-Api-Key',
  promptText: 'Gateway này yêu cầu một API key riêng (GATEWAY_API_KEY của gateway, khác với key của các nhà cung cấp AI). Dán vào đây:'
});

class SettingsManager {
  constructor() {
    this.providers = ['gemini', 'groq', 'openai', 'claude', 'openrouter', 'mistral', 'cerebras', 'cohere', 'deepseek', 'together'];
    this.providerLabels = {
      gemini: 'Google Gemini',
      groq: 'Groq',
      openai: 'OpenAI',
      claude: 'Anthropic Claude',
      openrouter: 'OpenRouter',
      mistral: 'Mistral AI',
      cerebras: 'Cerebras',
      cohere: 'Cohere',
      deepseek: 'DeepSeek',
      together: 'Together AI'
    };
    this.providerLinks = {
      gemini: 'https://aistudio.google.com/apikey',
      groq: 'https://console.groq.com/keys',
      openai: 'https://platform.openai.com/api-keys',
      claude: 'https://console.anthropic.com/settings/keys',
      openrouter: 'https://openrouter.ai/keys',
      mistral: 'https://console.mistral.ai/api-keys',
      cerebras: 'https://cloud.cerebras.ai/platform',
      cohere: 'https://dashboard.cohere.com/api-keys',
      deepseek: 'https://platform.deepseek.com/api_keys',
      together: 'https://api.together.ai/settings/api-keys'
    };
    
    this.modal = document.getElementById('settings-modal');
    this.container = document.getElementById('api-keys-container');
    this.btnOpen = document.getElementById('btn-open-settings');
    this.btnClose = document.getElementById('btn-close-settings');
    this.btnSave = document.getElementById('btn-save-settings');
  }
  
  init() {
    this.renderForm();
    this.loadKeys();
    this.bindEvents();
  }
  
  renderForm() {
    this.container.innerHTML = '';
    
    this.providers.forEach(provider => {
      const item = document.createElement('div');
      item.className = 'api-key-item';
      
      // Textarea chứ không phải một ô một dòng: nhiều tài khoản là chuyện bình thường ở
      // đây, và mỗi key một dòng là cách gõ tự nhiên nhất cho việc đó.
      // Claude có thêm lối vào thứ hai: đăng nhập subscription (Pro/Max) qua OAuth, không
      // cần dán tay API key — dành cho máy không có sẵn Claude Code CLI (`claude login`).
      const subscriptionRow = provider === 'claude'
        ? `
        <div class="claude-subscription-row" style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
            <span id="claude-sub-status" style="font-size:0.8rem;">Chưa đăng nhập subscription</span>
            <div>
              <button type="button" id="btn-claude-login" class="btn btn-secondary">Đăng nhập bằng tài khoản Claude</button>
              <button type="button" id="btn-claude-logout" class="btn btn-secondary" style="display:none;">Đăng xuất</button>
            </div>
        </div>`
        : '';

      item.innerHTML = `
        <div class="api-key-header">
            <label>${this.providerLabels[provider]}</label>
            <a href="${this.providerLinks[provider]}" target="_blank" class="api-link">Nhận khóa API</a>
        </div>
        <textarea id="key-${provider}" class="api-key-input" rows="1"
                  placeholder="Một hoặc nhiều khóa API, mỗi khóa một dòng (có thể đặt tên: ca-nhan=sk-...)"></textarea>
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <span id="status-${provider}" style="font-size: 0.8rem; margin-top: 10px;"></span>
            <button type="button" class="btn btn-secondary test-btn" data-provider="${provider}">Kiểm tra</button>
        </div>
        ${subscriptionRow}
      `;

      this.container.appendChild(item);
    });
  }

  bindEvents() {
    this.btnOpen.addEventListener('click', () => {
      this.openModal();
      this.refreshClaudeSubscriptionStatus();
    });
    this.btnClose.addEventListener('click', () => this.closeModal());
    this.btnSave.addEventListener('click', () => {
      this.saveKeys();
      this.closeModal();
    });

    // Close on clicking outside
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.closeModal();
    });

    // Ô nhập tự cao dần theo số dòng key.
    document.querySelectorAll('.api-key-input').forEach(input => {
      const grow = () => {
        input.style.height = 'auto';
        input.style.height = `${input.scrollHeight}px`;
      };
      input.addEventListener('input', grow);
    });

    // Test connections
    document.querySelectorAll('.test-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const provider = e.currentTarget.getAttribute('data-provider');
        await this.testConnection(provider);
      });
    });

    document.getElementById('btn-claude-login')?.addEventListener('click', () => this.startClaudeLogin());
    document.getElementById('btn-claude-logout')?.addEventListener('click', () => this.claudeLogout());
  }

  /**
   * Đăng nhập subscription: mở tab đăng nhập của Anthropic, rồi hỏi người dùng dán lại mã
   * mà trang đó hiện ra. Không có redirect nào chạm lại vào gateway — Anthropic chỉ khai
   * báo sẵn `console.anthropic.com` làm nơi nhận, gateway không tự host được URL redirect
   * riêng, nên bước "dán mã" là cách duy nhất khép kín vòng OAuth ở đây.
   */
  async startClaudeLogin() {
    const statusEl = document.getElementById('claude-sub-status');
    try {
      const res = await adminFetch('/api/claude/oauth/start', { method: 'POST' });
      const { url, state } = await res.json();
      window.open(url, '_blank', 'noopener');

      const pasted = window.prompt('Đăng nhập ở tab vừa mở, sau đó dán lại mã Anthropic hiện ra (dạng "code#state"):');
      if (!pasted) return;

      statusEl.textContent = 'Đang xác thực...';
      const cb = await adminFetch('/api/claude/oauth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pasted, state })
      });
      const data = await cb.json();
      if (!cb.ok) throw new Error(data?.error?.message || 'Đăng nhập thất bại');

      await this.refreshClaudeSubscriptionStatus();
    } catch (err) {
      statusEl.textContent = `❌ ${err.message}`;
      statusEl.style.color = 'var(--error)';
    }
  }

  async claudeLogout() {
    await adminFetch('/api/claude/oauth', { method: 'DELETE' });
    await this.refreshClaudeSubscriptionStatus();
  }

  async refreshClaudeSubscriptionStatus() {
    const statusEl = document.getElementById('claude-sub-status');
    const loginBtn = document.getElementById('btn-claude-login');
    const logoutBtn = document.getElementById('btn-claude-logout');
    if (!statusEl) return;

    try {
      const res = await adminFetch('/api/claude/oauth/status');
      const data = await res.json();
      if (data.loggedIn) {
        statusEl.textContent = '✅ Đã đăng nhập subscription qua gateway';
        statusEl.style.color = 'var(--success)';
        loginBtn.style.display = 'none';
        logoutBtn.style.display = '';
      } else {
        statusEl.textContent = 'Chưa đăng nhập subscription';
        statusEl.style.color = 'var(--text-secondary)';
        loginBtn.style.display = '';
        logoutBtn.style.display = 'none';
      }
    } catch {
      statusEl.textContent = 'Không kiểm tra được trạng thái đăng nhập';
    }
  }
  
  openModal() {
    this.modal.classList.remove('hidden');
  }
  
  closeModal() {
    this.modal.classList.add('hidden');
  }
  
  /**
   * `{ gemini: ['k1', 'k2'], ... }` — mỗi nhà cung cấp một MẢNG key.
   *
   * Server nhận cả chuỗi lẫn mảng, nhưng gửi mảng thì phía này không phải nghĩ về việc
   * ký tự nào đang làm dấu ngăn.
   */
  getApiKeys() {
    const keys = {};
    this.providers.forEach(p => {
      const list = this.readKeys(p);
      if (list.length) keys[p] = list;
    });
    return keys;
  }

  readKeys(provider) {
    return document.getElementById(`key-${provider}`).value
      .split(/[\n,;]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  
  saveKeys() {
    const keys = this.getApiKeys();
    // Basic obfuscation using btoa
    localStorage.setItem('aigateway_keys', btoa(JSON.stringify(keys)));
  }
  
  loadKeys() {
    const stored = localStorage.getItem('aigateway_keys');
    if (!stored) return;

    try {
      const keys = JSON.parse(atob(stored));
      this.providers.forEach(p => {
        if (!keys[p]) return;
        // Bản cũ lưu một chuỗi cho mỗi nhà cung cấp; đọc được cả hai dạng để lần nâng cấp
        // này không xóa mất key mà người dùng đã nhập từ trước.
        const list = Array.isArray(keys[p]) ? keys[p] : [keys[p]];
        const input = document.getElementById(`key-${p}`);
        input.value = list.join('\n');
        input.style.height = 'auto';
        input.style.height = `${input.scrollHeight}px`;
      });
    } catch (e) {
      console.error('Lỗi khi tải khóa API:', e);
    }
  }
  
  async testConnection(provider) {
    const keys = this.readKeys(provider);
    const statusEl = document.getElementById(`status-${provider}`);
    
    if (!keys.length) {
      statusEl.textContent = 'Vui lòng nhập khóa API trước';
      statusEl.style.color = 'var(--warning)';
      return;
    }
    
    statusEl.textContent = keys.length > 1 ? `Đang kiểm tra ${keys.length} khóa...` : 'Đang kiểm tra...';
    statusEl.style.color = 'var(--text-secondary)';
    
    try {
      const response = await adminFetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: keys.join('\n') })
      });
      
      const data = await response.json();
      
      // Với nhiều key thì "thất bại" một mình là vô dụng — phải nói rõ key NÀO hỏng, vì
      // đó là thứ duy nhất người dùng cần biết để đi sửa.
      const failed = (data.results || []).filter(r => !r.success);
      if (data.success && !failed.length) {
        statusEl.textContent = '✅ ' + data.message;
        statusEl.style.color = 'var(--success)';
      } else if (data.success) {
        statusEl.textContent = `⚠️ ${data.message} — hỏng: ${failed.map(r => r.key).join(', ')}`;
        statusEl.style.color = 'var(--warning)';
      } else {
        statusEl.textContent = '❌ ' + (data.message || 'Kết nối thất bại');
        statusEl.style.color = 'var(--error)';
      }
    } catch (err) {
      statusEl.textContent = '❌ Không thể kết nối đến máy chủ';
      statusEl.style.color = 'var(--error)';
    }
  }
}
