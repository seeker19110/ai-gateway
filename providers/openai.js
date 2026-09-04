const BaseProvider = require('./base');

class OpenAIProvider extends BaseProvider {
  constructor() {
    super('openai', 'OpenAI', {
      model: 'gpt-4o-mini',
      maxRPM: 3
    });
  }

  async chat(messages, apiKey) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.openai.com/v1/chat/completions'
    });
  }

  async *stream(messages, apiKey) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.openai.com/v1/chat/completions'
    });
  }
}

module.exports = OpenAIProvider;
