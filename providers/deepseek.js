const BaseProvider = require('./base');

class DeepSeekProvider extends BaseProvider {
  constructor(options = {}) {
    super('deepseek', 'DeepSeek', {
      model: 'deepseek-chat',
      maxRPM: 15,
      // DeepSeek theo sát OpenAI nhưng không có `seed` và `user`.
      paramSupport: [
        'temperature',
        'top_p',
        'max_tokens',
        'stop',
        'presence_penalty',
        'frequency_penalty',
        'response_format'
      ],
      ...options
    });
  }

  async chat(messages, apiKey, options = {}) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.deepseek.com/chat/completions',
      ...options
    });
  }

  async *stream(messages, apiKey, options = {}) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.deepseek.com/chat/completions',
      ...options
    });
  }
}

module.exports = DeepSeekProvider;
