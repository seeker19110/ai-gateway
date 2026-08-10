class SettingsManager {
  constructor() {
    this.providers = ['gemini', 'groq', 'openai', 'claude', 'openrouter', 'mistral', 'cerebras', 'cohere'];
    this.providerLabels = {
      gemini: 'Google Gemini',
      groq: 'Groq',
      openai: 'OpenAI',
      claude: 'Anthropic Claude',
      openrouter: 'OpenRouter',
      mistral: 'Mistral AI',
      cerebras: 'Cerebras',
      cohere: 'Cohere'
    };
    this.providerLinks = {
      gemini: 'https://aistudio.google.com/apikey',
      groq: 'https://console.groq.com/keys',
      openai: 'https://platform.openai.com/api-keys',
      claude: 'https://console.anthropic.com/settings/keys',
      openrouter: 'https://openrouter.ai/keys',
      mistral: 'https://console.mistral.ai/api-keys',
      cerebras: 'https://cloud.cerebras.ai/platform',
      cohere: 'https://dashboard.cohere.com/api-keys'
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
      
      item.innerHTML = `
        <div class="api-key-header">
            <label>${this.providerLabels[provider]}</label>
            <a href="${this.providerLinks[provider]}" target="_blank" class="api-link">Nhận khóa API</a>
        </div>
        <div class="input-with-icon">
            <input type="password" id="key-${provider}" placeholder="Nhập khóa API cho ${this.providerLabels[provider]}">
            <button type="button" class="toggle-password" data-target="key-${provider}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
        </div>
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
    
    // Toggle password visibility
    document.querySelectorAll('.toggle-password').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetId = e.currentTarget.getAttribute('data-target');
        const input = document.getElementById(targetId);
        if (input.type === 'password') {
          input.type = 'text';
          // Simple eye-off icon for text mode
          e.currentTarget.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22"/></svg>';
        } else {
          input.type = 'password';
          e.currentTarget.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        }
      });
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
  
  getApiKeys() {
    const keys = {};
    this.providers.forEach(p => {
      const val = document.getElementById(`key-${p}`).value.trim();
      if (val) keys[p] = val;
    });
    return keys;
  }
  
  saveKeys() {
    const keys = this.getApiKeys();
    // Basic obfuscation using btoa
    localStorage.setItem('aigateway_keys', btoa(JSON.stringify(keys)));
  }
  
  loadKeys() {
    const stored = localStorage.getItem('aigateway_keys');
    if (stored) {
      try {
        const keys = JSON.parse(atob(stored));
        this.providers.forEach(p => {
          if (keys[p]) {
            document.getElementById(`key-${p}`).value = keys[p];
          }
        });
      } catch (e) {
        console.error('Lỗi khi tải khóa API:', e);
      }
    }
  }
  
  async testConnection(provider) {
    const val = document.getElementById(`key-${provider}`).value.trim();
    const statusEl = document.getElementById(`status-${provider}`);
    
    if (!val) {
      statusEl.textContent = 'Vui lòng nhập khóa API trước';
      statusEl.style.color = 'var(--warning)';
      return;
    }
    
    statusEl.textContent = 'Đang kiểm tra...';
    statusEl.style.color = 'var(--text-secondary)';
    
    try {
      const response = await fetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: val })
      });
      
      const data = await response.json();
      
      if (data.success) {
        statusEl.textContent = '✅ ' + data.message;
        statusEl.style.color = 'var(--success)';
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
