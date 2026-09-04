const BaseProvider = require('./base');

class CerebrasProvider extends BaseProvider {
  constructor(options = {}) {
    super('cerebras', 'Cerebras', {
      model: 'llama-3.3-70b',
      maxRPM: 30,
      // Cerebras KIỂM TRA CHẶT thân request: trường lạ bị trả 400 chứ không bị bỏ qua.
      // Nên danh sách này phải đúng bằng những gì họ nhận — thừa một tham số là hỏng
      // đúng những request có đặt tham số, trong khi request trần vẫn chạy ngon (nên
      // kiểu hỏng này rất dễ lọt qua mọi lần thử tay).
      paramSupport: ['temperature', 'top_p', 'max_tokens', 'stop', 'user', 'response_format'],
      streamUsage: false,
      ...options
    });
  }

  async chat(messages, apiKey, options = {}) {
    return this.openAICompatibleChat(messages, apiKey, {
      url: 'https://api.cerebras.ai/v1/chat/completions',
      ...options
    });
  }

  async *stream(messages, apiKey, options = {}) {
    yield* this.streamOpenAICompatible(messages, apiKey, {
      url: 'https://api.cerebras.ai/v1/chat/completions',
      ...options
    });
  }
}

module.exports = CerebrasProvider;
