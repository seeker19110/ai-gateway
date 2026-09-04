const BaseProvider = require('./base');

class OpenAIProvider extends BaseProvider {
  constructor(options = {}) {
    super('openai', 'OpenAI', {
      model: 'gpt-4o-mini',
      maxRPM: 3,
      ...options
    });
  }

  async chat(messages, apiKey, options = {}) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.openai.com/v1/chat/completions',
      ...options
    });
  }

  async *stream(messages, apiKey, options = {}) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.openai.com/v1/chat/completions',
      ...options
    });
  }
}

module.exports = OpenAIProvider;
