const BaseProvider = require('./base');

class TogetherProvider extends BaseProvider {
  constructor(options = {}) {
    super('together', 'Together AI', {
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
      maxRPM: 15,
      ...options
    });
  }

  async chat(messages, apiKey, options = {}) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.together.xyz/v1/chat/completions',
      ...options
    });
  }

  async *stream(messages, apiKey, options = {}) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.together.xyz/v1/chat/completions',
      ...options
    });
  }
}

module.exports = TogetherProvider;
