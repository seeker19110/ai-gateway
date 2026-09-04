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
      `;
      
      this.container.appendChild(item);
    });
  }
  
  bindEvents() {
    this.btnOpen.addEventListener('click', () => this.openModal());
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
      const response = await fetch('/api/providers/test', {
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
