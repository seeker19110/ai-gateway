const BaseProvider = require('./base');

class DeepSeekProvider extends BaseProvider {
  constructor() {
    super('deepseek', 'DeepSeek', {
      model: 'deepseek-chat',
      maxRPM: 15
    });
  }

  async chat(messages, apiKey) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.deepseek.com/chat/completions'
    });
  }

  async *stream(messages, apiKey) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.deepseek.com/chat/completions'
    });
  }
}

module.exports = DeepSeekProvider;
