const BaseProvider = require('./base');

class CohereProvider extends BaseProvider {
  constructor() {
    super('cohere', 'Cohere', {
      model: 'command-r7b-12-2024',
      maxRPM: 10
    });
  }

  async chat(messages, apiKey) {
    if (!apiKey) throw new Error('Cần có API key');

    const url = 'https://api.cohere.com/v2/chat';

    const systemMessages = messages
      .filter(m => m.role === 'system')
      .map(m => ({ role: 'system', content: m.content }));
    const chatMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    try {
      this.trackRequest();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [...systemMessages, ...chatMessages]
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 429) {
          this.setCooldown(60);
          throw new Error('Đã vượt quá giới hạn request (Rate limited)');
        }
        throw new Error(errorData.message || `Lỗi HTTP: ${response.status}`);
      }

      const data = await response.json();
      const text = data.message?.content?.map(c => c.text).join('') || '';
      if (!text) {
        throw new Error('Định dạng phản hồi không hợp lệ');
      }

      return text;
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }
}

module.exports = CohereProvider;
