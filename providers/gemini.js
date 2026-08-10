const BaseProvider = require('./base');

class GeminiProvider extends BaseProvider {
  constructor() {
    super('gemini', 'Google Gemini', {
      model: 'gemini-2.0-flash',
      maxRPM: 15
    });
  }

  async chat(messages, apiKey) {
    if (!apiKey) throw new Error('Cần có API key');
    
    const contents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`;
    
    try {
      this.trackRequest();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents })
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
      if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
        throw new Error('Định dạng phản hồi không hợp lệ');
      }

      return data.candidates[0].content.parts[0].text;
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }
}

module.exports = GeminiProvider;
