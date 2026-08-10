const BaseProvider = require('./base');

class ClaudeProvider extends BaseProvider {
  constructor() {
    super('claude', 'Anthropic Claude', {
      model: 'claude-3-haiku-20240307',
      maxRPM: 5
    });
  }

  async chat(messages, apiKey) {
    if (!apiKey) throw new Error('Cần có API key');

    const url = 'https://api.anthropic.com/v1/messages';
    
    const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const userAndAssistantMessages = messages.filter(m => m.role !== 'system');
    
    const body = {
      model: this.model,
      max_tokens: 4096,
      messages: userAndAssistantMessages
    };

    if (systemMessages) {
      body.system = systemMessages;
    }
    
    try {
      this.trackRequest();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 429) {
          this.setCooldown(60);
          throw new Error('Đã vượt quá giới hạn request (Rate limited)');
        }
        throw new Error(errorData.error?.message || `Lỗi HTTP: ${response.status}`);
      }

      const data = await response.json();
      if (!data.content || !data.content[0]?.text) {
        throw new Error('Định dạng phản hồi không hợp lệ');
      }

      return data.content[0].text;
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }
}

module.exports = ClaudeProvider;
