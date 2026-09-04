const BaseProvider = require('./base');

class GroqProvider extends BaseProvider {
  constructor() {
    super('groq', 'Groq', {
      model: 'llama-3.3-70b-versatile',
      maxRPM: 30
    });
  }

  async chat(messages, apiKey) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.groq.com/openai/v1/chat/completions'
    });
  }

  async *stream(messages, apiKey) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.groq.com/openai/v1/chat/completions'
    });
  }
}

module.exports = GroqProvider;
