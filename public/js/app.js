class App {
  constructor() {
    this.chat = new ChatManager();
    this.settings = new SettingsManager();
    this.router = new ProviderRouter();
    
    this.input = document.getElementById('chat-input');
    this.btnSend = document.getElementById('btn-send');
    this.mobileMenuBtn = document.getElementById('mobile-menu');
    this.mobileCloseBtn = document.getElementById('mobile-close');
    this.sidebar = document.getElementById('sidebar');
  }
  
  init() {
    this.chat.init();
    this.settings.init();
    this.router.init();
    
    // Đồng bộ UI status với API keys hiện có
    this.router.syncWithKeys(this.settings.getApiKeys());
    
    this.bindEvents();
  }
  
  bindEvents() {
    // Tự động điều chỉnh chiều cao của textarea
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = (this.input.scrollHeight) + 'px';
    });
    
    // Xử lý phím Enter (Shift+Enter để xuống dòng)
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    
    this.btnSend.addEventListener('click', () => this.sendMessage());
    
    // Mobile Sidebar Toggle
    this.mobileMenuBtn.addEventListener('click', () => {
      this.sidebar.classList.add('open');
    });
    
    this.mobileCloseBtn.addEventListener('click', () => {
      this.sidebar.classList.remove('open');
    });
  }
  
  async sendMessage() {
    const text = this.input.value.trim();
    if (!text) return;
    
    const keys = this.settings.getApiKeys();
    if (Object.keys(keys).length === 0) {
      alert("Vui lòng cấu hình ít nhất một Khóa API trong phần Cài đặt!");
      this.settings.openModal();
      return;
    }
    
    // Reset input
    this.input.value = '';
    this.input.style.height = 'auto';
    
    // Thêm tin nhắn của người dùng
    this.chat.addMessage('user', text);
    this.chat.showLoading();
    this.btnSend.disabled = true;
    
    // Chọn nhà cung cấp ưu tiên (nếu manual mode)
    const preferredProvider = this.router.mode === 'manual' 
      ? this.router.selectedProvider 
      : undefined;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: this.chat.getHistory().slice(0, -1), // Không gửi tin nhắn vừa thêm (server tự thêm)
          providers: keys,
          preferredProvider: preferredProvider
        })
      });
      
      const data = await response.json();
      
      this.chat.hideLoading();
      this.btnSend.disabled = false;
      
      if (!response.ok) {
        this.chat.addMessage('ai', `❌ **Lỗi:** ${data.error || 'Không thể kết nối đến máy chủ'}`);
        if (data.statuses) {
          this.router.updateStatuses(data.statuses);
        }
        return;
      }
      
      // Hiển thị phản hồi từ AI với badge provider
      this.chat.addMessage('ai', data.response, data.provider);
      
      // Cập nhật trạng thái tất cả providers
      if (data.status) {
        this.router.updateStatuses(data.status);
      }
      
    } catch (error) {
      this.chat.hideLoading();
      this.btnSend.disabled = false;
      this.chat.addMessage('ai', `❌ **Lỗi kết nối:** ${error.message}\n\nHãy đảm bảo server đang chạy tại \`http://localhost:3000\``);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
