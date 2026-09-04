const BaseProvider = require('./base');

class MistralProvider extends BaseProvider {
  constructor() {
    super('mistral', 'Mistral AI', {
      model: 'mistral-small-latest',
      maxRPM: 15
    });
  }

  async chat(messages, apiKey) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.mistral.ai/v1/chat/completions'
    });
  }

  async *stream(messages, apiKey) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.mistral.ai/v1/chat/completions'
    });
  }
}

module.exports = MistralProvider;
