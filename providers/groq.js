const BaseProvider = require('./base');

class GroqProvider extends BaseProvider {
  constructor() {
    super('groq', 'Groq', {
      model: 'llama-3.3-70b-versatile',
      maxRPM: 30
    });
  }

  async chat(messages, apiKey) {
    if (!apiKey) throw new Error('Cần có API key');

    const url = 'https://api.groq.com/openai/v1/chat/completions';
    
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
          messages: messages
        })
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
      if (!data.choices || !data.choices[0]?.message?.content) {
        throw new Error('Định dạng phản hồi không hợp lệ');
      }

      return data.choices[0].message.content;
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }
}

module.exports = GroqProvider;
