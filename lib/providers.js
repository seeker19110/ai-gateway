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

const CLASSES = {
  gemini: GeminiProvider,
  groq: GroqProvider,
  openai: OpenAIProvider,
  claude: ClaudeProvider,
  openrouter: OpenRouterProvider,
  mistral: MistralProvider,
  cerebras: CerebrasProvider,
  cohere: CohereProvider,
  deepseek: DeepSeekProvider,
  together: TogetherProvider
};

/**
 * Pool mới, mỗi lần gọi là một bộ provider độc lập (test dựng pool riêng, không dùng chung state).
 *
 * Model và hạn mức đọc được từ `.env` (`GEMINI_MODEL`, `GEMINI_MAX_RPM`…). Tên model trong
 * code là ảnh chụp của một thời điểm: hãng cho model cũ nghỉ hưu theo lịch riêng của họ, và
 * khi đó gateway trả 404 cho mọi lượt đi qua nhà đó — một lỗi 4xx bị xếp vào "lỗi phía
 * client, không xoay vòng", nên nó làm đứng cả pool. Sửa được bằng một biến môi trường thì
 * đó là chuyện của một phút, còn không thì phải chờ một bản phát hành.
 *
 * `GROQ_MAX_RPM` cũng vậy: hạn mức phút phụ thuộc bậc tài khoản, và số cứng trong code chỉ
 * đúng cho bậc miễn phí.
 */
function createProviders(env = process.env) {
  const providers = {};
  for (const [name, Provider] of Object.entries(CLASSES)) {
    providers[name] = new Provider(overridesFor(name, env));
  }
  return providers;
}

function overridesFor(name, env) {
  const prefix = name.toUpperCase();
  const options = {};

  const model = String(env[`${prefix}_MODEL`] || '').trim();
  if (model) options.model = model;

  const maxRPM = Number(env[`${prefix}_MAX_RPM`]);
  if (Number.isFinite(maxRPM) && maxRPM > 0) options.maxRPM = Math.floor(maxRPM);

  return options;
}

module.exports = { createProviders, PROVIDER_CLASSES: CLASSES };
