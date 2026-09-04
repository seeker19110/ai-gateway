const BaseProvider = require('./base');

class OpenRouterProvider extends BaseProvider {
  constructor() {
    super('openrouter', 'OpenRouter', {
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      maxRPM: 20
    });
  }

  async chat(messages, apiKey) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { 'HTTP-Referer': 'https://github.com/seeker19110/ai-gateway', 'X-Title': 'AI Gateway' }
    });
  }

  async *stream(messages, apiKey) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { 'HTTP-Referer': 'https://github.com/seeker19110/ai-gateway', 'X-Title': 'AI Gateway' }
    });
  }
}

module.exports = OpenRouterProvider;
