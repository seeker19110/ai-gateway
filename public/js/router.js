class ProviderRouter {
  constructor() {
    this.modeSelect = document.getElementById('rotation-mode');
    this.cardsContainer = document.getElementById('provider-cards');
    
    this.mode = 'roundrobin';
    this.selectedProvider = null;
    
    this.providers = [
      { id: 'gemini', name: 'Google Gemini', model: 'gemini-2.0-flash', status: 'inactive', count: 0 },
      { id: 'groq', name: 'Groq', model: 'llama-3.3-70b', status: 'inactive', count: 0 },
      { id: 'openai', name: 'OpenAI', model: 'gpt-4o-mini', status: 'inactive', count: 0 },
      { id: 'claude', name: 'Claude', model: 'claude-3-haiku', status: 'inactive', count: 0 },
      { id: 'openrouter', name: 'OpenRouter', model: 'llama-3.3-70b:free', status: 'inactive', count: 0 },
      { id: 'mistral', name: 'Mistral AI', model: 'mistral-small-latest', status: 'inactive', count: 0 },
      { id: 'cerebras', name: 'Cerebras', model: 'llama-3.3-70b', status: 'inactive', count: 0 },
      { id: 'cohere', name: 'Cohere', model: 'command-r7b', status: 'inactive', count: 0 }
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
        'error': 'Lỗi'
      };
      const statusText = statusMap[p.status] || p.status;
      
      // Map status cho CSS class
      const cssStatusMap = {
        'inactive': 'inactive',
        'active': 'active',
        'rate_limited': 'warning',
        'error': 'error'
      };
      const cssStatus = cssStatusMap[p.status] || p.status;
      
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
            <span>Yêu cầu: ${p.count}</span>
        </div>
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
      if (keys[p.id]) {
        p.status = 'active';
      } else {
        p.status = 'inactive';
      }
    });
    this.renderCards();
  }
}
