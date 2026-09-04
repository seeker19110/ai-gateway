const BaseProvider = require('./base');

// OpenRouter dùng hai header này để xếp hạng và ghi công ứng dụng gọi tới.
const ATTRIBUTION = {
  'HTTP-Referer': 'https://github.com/seeker19110/ai-gateway',
  'X-Title': 'AI Gateway'
};

class OpenRouterProvider extends BaseProvider {
  constructor(options = {}) {
    super('openrouter', 'OpenRouter', {
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      maxRPM: 20,
      ...options
    });
  }

  async chat(messages, apiKey, options = {}) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      ...options,
      headers: { ...ATTRIBUTION, ...options.headers }
    });
  }

  async *stream(messages, apiKey, options = {}) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      ...options,
      headers: { ...ATTRIBUTION, ...options.headers }
    });
  }
}

module.exports = OpenRouterProvider;
