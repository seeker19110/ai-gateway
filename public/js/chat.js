class ChatManager {
  constructor() {
    this.messages = [];
    this.chatContainer = null;
    this.emptyState = null;
    this.loadingId = 'msg-loading';
  }
  
  init() {
    this.chatContainer = document.getElementById('chat-messages');
    this.emptyState = document.getElementById('empty-state');
    
    // Configure marked with highlight.js
    marked.setOptions({
      highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
      breaks: true
    });
  }
  
  addMessage(role, content, provider = null) {
    // Hide empty state
    if (this.emptyState) {
      this.emptyState.style.display = 'none';
    }

    this.messages.push({ role, content, provider });
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    
    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? 'U' : 'AI';
    
    // Content box
    const contentBox = document.createElement('div');
    contentBox.className = 'message-content';
    
    // Provider badge (for AI only)
    if (role === 'ai' && provider) {
      const badge = document.createElement('div');
      badge.className = `provider-badge ${provider.toLowerCase()}`;
      // Capitalize first letter
      badge.textContent = provider.charAt(0).toUpperCase() + provider.slice(1);
      contentBox.appendChild(badge);
    }
    
    // Content body (Markdown -> HTML)
    const body = document.createElement('div');
    if (role === 'ai') {
      const rawHtml = marked.parse(content);
      body.innerHTML = DOMPurify.sanitize(rawHtml);
    } else {
      // User message is plain text, escape it safely
      body.textContent = content;
      // Convert newlines to <br>
      body.innerHTML = body.innerHTML.replace(/\n/g, '<br>');
    }
    contentBox.appendChild(body);
    
    msgDiv.appendChild(avatar);
    msgDiv.appendChild(contentBox);
    
    this.chatContainer.appendChild(msgDiv);
    
    // Apply syntax highlighting manually to ensure it applies to dynamically added content
    msgDiv.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block);
    });

    this.scrollToBottom();
  }
  
  showLoading() {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ai';
    msgDiv.id = this.loadingId;
    
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = 'AI';
    
    const contentBox = document.createElement('div');
    contentBox.className = 'message-content';
    
    const loadingDots = document.createElement('div');
    loadingDots.className = 'loading-dots';
    loadingDots.innerHTML = '<div></div><div></div><div></div>';
    
    contentBox.appendChild(loadingDots);
    msgDiv.appendChild(avatar);
    msgDiv.appendChild(contentBox);
    
    this.chatContainer.appendChild(msgDiv);
    this.scrollToBottom();
  }
  
  hideLoading() {
    const loadingMsg = document.getElementById(this.loadingId);
    if (loadingMsg) {
      loadingMsg.remove();
    }
  }
  
  getHistory() {
    // Map 'ai' role to 'assistant' for API compatibility
    return this.messages.map(m => ({
      role: m.role === 'ai' ? 'assistant' : m.role,
      content: m.content
    }));
  }
  
  clearChat() {
    this.messages = [];
    this.chatContainer.innerHTML = '';
    if (this.emptyState) {
      this.chatContainer.appendChild(this.emptyState);
      this.emptyState.style.display = 'block';
    }
  }

  scrollToBottom() {
    this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
  }
}
