const BaseProvider = require('./base');

class TogetherProvider extends BaseProvider {
  constructor() {
    super('together', 'Together AI', {
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
      maxRPM: 15
    });
  }

  async chat(messages, apiKey) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.together.xyz/v1/chat/completions'
    });
  }

  async *stream(messages, apiKey) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.together.xyz/v1/chat/completions'
    });
  }
}

module.exports = TogetherProvider;
