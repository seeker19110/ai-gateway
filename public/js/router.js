class ProviderRouter {
  constructor() {
    this.modeSelect = document.getElementById('rotation-mode');
    this.cardsContainer = document.getElementById('provider-cards');
    
    this.mode = 'roundrobin';
    this.selectedProvider = null;
    
    this.providers = [
      { id: 'gemini', name: 'Google Gemini', model: 'gemini-2.0-flash', status: 'inactive', count: 0, accounts: [] },
      { id: 'groq', name: 'Groq', model: 'llama-3.3-70b', status: 'inactive', count: 0, accounts: [] },
      { id: 'openai', name: 'OpenAI', model: 'gpt-4o-mini', status: 'inactive', count: 0, accounts: [] },
      { id: 'claude', name: 'Claude', model: 'claude-3-haiku', status: 'inactive', count: 0, accounts: [] },
      { id: 'openrouter', name: 'OpenRouter', model: 'llama-3.3-70b:free', status: 'inactive', count: 0, accounts: [] },
      { id: 'mistral', name: 'Mistral AI', model: 'mistral-small-latest', status: 'inactive', count: 0, accounts: [] },
      { id: 'cerebras', name: 'Cerebras', model: 'llama-3.3-70b', status: 'inactive', count: 0, accounts: [] },
      { id: 'cohere', name: 'Cohere', model: 'command-r7b', status: 'inactive', count: 0, accounts: [] },
      { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', status: 'inactive', count: 0, accounts: [] },
      { id: 'together', name: 'Together AI', model: 'llama-3.3-70b-turbo-free', status: 'inactive', count: 0, accounts: [] }
    ];
  }
  
  init() {
    this.renderCards();
    
    this.modeSelect.addEventListener('change', (e) => {
      this.mode = e.target.value;
      localStorage.setItem('aigateway_mode', this.mode);
      this.renderCards();
    });
    
    const savedMode = localStorage.getItem('aigateway_mode');
    if (savedMode) {
      this.mode = savedMode;
      this.modeSelect.value = savedMode;
    }
  }
  
  renderCards() {
    this.cardsContainer.innerHTML = '';
    
    this.providers.forEach(p => {
      const card = document.createElement('div');
      card.className = 'provider-card';
      card.id = `card-${p.id}`;
      
      // Cho phép click chọn provider trong chế độ Manual
      if (this.mode === 'manual') {
        card.style.cursor = 'pointer';
        if (this.selectedProvider === p.id) {
          card.classList.add('selected');
        }
        card.addEventListener('click', () => {
          this.selectedProvider = p.id;
          this.renderCards();
        });
      }
      
      // Dịch status sang tiếng Việt
      const statusMap = {
        'inactive': 'Không hoạt động',
        'active': 'Hoạt động',
        'rate_limited': 'Quá tải',
        'throttled': 'Chạm trần RPM',
        'disabled': 'Đã tắt',
        'error': 'Lỗi'
      };
      const statusText = statusMap[p.status] || p.status;
      
      // Map status cho CSS class
      const cssStatusMap = {
        'inactive': 'inactive',
        'active': 'active',
        'rate_limited': 'warning',
        'throttled': 'warning',
        'disabled': 'inactive',
        'error': 'error'
      };
      const cssStatus = cssStatusMap[p.status] || p.status;
      
      // Với nhiều tài khoản, con số gộp một mình là vô dụng: "Quá tải" không cho biết một
      // trong bốn key hỏng hay cả bốn — mà đó là câu hỏi duy nhất cần trả lời trước khi đi
      // mua thêm key. Nên liệt kê từng key khi nhà đó có hơn một.
      const accountRows = p.accounts.length > 1
        ? `<div class="provider-accounts">${p.accounts.map(a => `
            <div class="account-row">
                <span class="status-dot ${cssStatusMap[a.status] || 'inactive'}"></span>
                <span class="account-label">${a.label}</span>
                <span class="account-key">${a.key}</span>
                <span class="account-note">${a.cooldownRemaining ? `nghỉ ${a.cooldownRemaining}s` : `${a.requestCount}/${a.maxRPM}`}</span>
            </div>`).join('')}</div>`
        : '';

      card.innerHTML = `
        <div class="provider-header">
            <span class="provider-name">${p.name}</span>
            <div class="provider-status">
                <span class="status-dot ${cssStatus}"></span>
                <span class="status-text">${statusText}</span>
            </div>
        </div>
        <div class="provider-stats">
            <span>Mô hình: ${p.model}</span>
            <span>${p.accounts.length > 1 ? `${p.readyCount}/${p.accounts.length} khóa · ` : ''}Yêu cầu: ${p.count}</span>
        </div>
        ${accountRows}
      `;
      
      this.cardsContainer.appendChild(card);
    });
  }
  
  // Cập nhật trạng thái từ response của server
  updateStatuses(statuses) {
    for (const [id, status] of Object.entries(statuses)) {
      const provider = this.providers.find(p => p.id === id);
      if (provider) {
        provider.status = status.status;
        provider.count = status.requestCount || provider.count;
        provider.accounts = status.accounts || [];
        provider.readyCount = status.readyCount || 0;
        if (status.model) provider.model = status.model;
      }
    }
    this.renderCards();
  }
  
  updateProviderState(id, status, incrementCount = false) {
    const provider = this.providers.find(p => p.id === id);
    if (provider) {
      if (status) provider.status = status;
      if (incrementCount) provider.count += 1;
      this.renderCards();
    }
  }

  // Khởi tạo trạng thái dựa trên API keys đã cung cấp
  syncWithKeys(keys) {
    this.providers.forEach(p => {
      const list = keys[p.id] ? [].concat(keys[p.id]) : [];
      p.status = list.length ? 'active' : 'inactive';
      // Trạng thái thật của từng key chỉ có ở server; ở đây chỉ đủ để vẽ ra số lượng trước
      // lượt gọi đầu tiên.
      p.accounts = list.map((_, i) => ({
        label: `${p.id}#${i + 1}`,
        key: '••••',
        status: 'active',
        requestCount: 0,
        maxRPM: 0,
        cooldownRemaining: 0
      }));
      p.readyCount = list.length;
    });
    this.renderCards();
  }
}
