const BaseProvider = require('./base');

class MistralProvider extends BaseProvider {
  constructor(options = {}) {
    super('mistral', 'Mistral AI', {
      model: 'mistral-small-latest',
      maxRPM: 15,
      paramSupport: [
        'temperature',
        'top_p',
        'max_tokens',
        'stop',
        'seed',
        'presence_penalty',
        'frequency_penalty',
        'response_format'
      ],
      // Mistral gọi `seed` là `random_seed`. Gửi đúng tên OpenAI thì tham số bị bỏ qua
      // lặng lẽ — không lỗi, chỉ là kết quả không lặp lại được như client tưởng.
      paramRename: { seed: 'random_seed' },
      // Không có `stream_options`; usage đã nằm sẵn ở mẩu cuối.
      streamUsage: false,
      ...options
    });
  }

  async chat(messages, apiKey, options = {}) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.mistral.ai/v1/chat/completions',
      ...options
    });
  }

  async *stream(messages, apiKey, options = {}) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.mistral.ai/v1/chat/completions',
      ...options
    });
  }
}

module.exports = MistralProvider;
