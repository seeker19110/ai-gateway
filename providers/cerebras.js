const BaseProvider = require('./base');

class CerebrasProvider extends BaseProvider {
  constructor() {
    super('cerebras', 'Cerebras', {
      model: 'llama-3.3-70b',
      maxRPM: 30
    });
  }

  async chat(messages, apiKey) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.cerebras.ai/v1/chat/completions'
    });
  }

  async *stream(messages, apiKey) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.cerebras.ai/v1/chat/completions'
    });
  }
}

module.exports = CerebrasProvider;
