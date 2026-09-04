const BaseProvider = require('./base');

class GroqProvider extends BaseProvider {
  constructor(options = {}) {
    super('groq', 'Groq', {
      model: 'llama-3.3-70b-versatile',
      maxRPM: 30,
      ...options
    });
  }

  async chat(messages, apiKey, options = {}) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      ...options
    });
  }

  async *stream(messages, apiKey, options = {}) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      ...options
    });
  }
}

module.exports = GroqProvider;
