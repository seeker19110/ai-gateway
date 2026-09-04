const GeminiProvider = require('../providers/gemini');
const GroqProvider = require('../providers/groq');
const OpenAIProvider = require('../providers/openai');
const ClaudeProvider = require('../providers/claude');
const OpenRouterProvider = require('../providers/openrouter');
const MistralProvider = require('../providers/mistral');
const CerebrasProvider = require('../providers/cerebras');
const CohereProvider = require('../providers/cohere');
const DeepSeekProvider = require('../providers/deepseek');
const TogetherProvider = require('../providers/together');

/** Pool mới, mỗi lần gọi là một bộ provider độc lập (test dựng pool riêng, không dùng chung state). */
function createProviders() {
  return {
    gemini: new GeminiProvider(),
    groq: new GroqProvider(),
    openai: new OpenAIProvider(),
    claude: new ClaudeProvider(),
    openrouter: new OpenRouterProvider(),
    mistral: new MistralProvider(),
    cerebras: new CerebrasProvider(),
    cohere: new CohereProvider(),
    deepseek: new DeepSeekProvider(),
    together: new TogetherProvider()
  };
}

module.exports = { createProviders };
