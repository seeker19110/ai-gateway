const { UpstreamError } = require('./errors');

/**
 * Tham số sinh văn bản: nhận theo tên của OpenAI, dịch sang phương ngữ của từng nhà cung cấp.
 *
 * Bản trước bỏ rơi toàn bộ nhóm này: `temperature`, `max_tokens`, `stop`… gửi lên gateway
 * đều bị nuốt, nên cùng một request cho ra kết quả khác hẳn khi gọi thẳng nhà cung cấp.
 * Với một gateway tự nhận là "chuẩn OpenAI" thì đó không phải thiếu tính năng mà là nói sai
 * chuẩn: client tưởng đã đặt `temperature: 0` và tin vào một sự ổn định không hề có.
 */

const CANONICAL = [
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'stop',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'response_format',
  'user'
];

/** Khoảng giá trị chung (theo OpenAI); nhà cung cấp hẹp hơn thì siết thêm ở bảng dưới. */
const RANGES = {
  temperature: [0, 2],
  top_p: [0, 1],
  top_k: [1, 500],
  presence_penalty: [-2, 2],
  frequency_penalty: [-2, 2]
};

/**
 * Đọc tham số từ body request và kiểm tra kiểu.
 *
 * Sai kiểu thì trả 400 ngay tại gateway, không đẩy xuống upstream: nếu để nó đi tiếp,
 * upstream trả 400 và bộ phân loại coi đó là "lỗi phía client, không xoay vòng" — đúng kết
 * luận, nhưng phải tốn một lượt gọi thật và một dòng log đổ tội cho nhà cung cấp.
 */
function normalizeParams(body = {}) {
  const params = {};

  if (body.tools !== undefined) params.tools = normalizeTools(body.tools);
  if (body.tool_choice !== undefined) params.tool_choice = normalizeToolChoice(body.tool_choice, params.tools);

  for (const name of CANONICAL) {
    const value = body[name];
    if (value === undefined || value === null) continue;

    if (name === 'stop') {
      const list = Array.isArray(value) ? value : [value];
      const stop = list.filter((s) => typeof s === 'string' && s.length);
      if (stop.length !== list.length) throw badParam('stop', 'chuỗi hoặc mảng chuỗi');
      if (stop.length) params.stop = stop.slice(0, 4); // OpenAI: tối đa 4 chuỗi dừng
      continue;
    }

    if (name === 'response_format') {
      if (typeof value !== 'object' || typeof value.type !== 'string') {
        throw badParam('response_format', 'object có trường `type`');
      }
      params.response_format = value;
      continue;
    }

    if (name === 'user') {
      if (typeof value !== 'string') throw badParam('user', 'chuỗi');
      params.user = value;
      continue;
    }

    const num = Number(value);
    if (!Number.isFinite(num)) throw badParam(name, 'số');
    if (name === 'max_tokens' || name === 'seed' || name === 'top_k') {
      if (!Number.isInteger(num)) throw badParam(name, 'số nguyên');
      if (name === 'max_tokens' && num <= 0) throw badParam('max_tokens', 'số nguyên dương');
    }
    params[name] = num;
  }

  return params;
}

function badParam(name, expected) {
  return new UpstreamError(`Tham số \`${name}\` phải là ${expected}`, 400);
}

/**
 * Kiểm tra `tools`: mảng khai báo hàm chuẩn OpenAI
 * (`{type:'function', function:{name, description?, parameters?}}`).
 *
 * Sai kiểu bị chặn ngay tại gateway thay vì đẩy xuống upstream, vì đây là tham số cấu trúc
 * (không phải một con số) — để lọt một `name` thiếu hay một `parameters` không phải object
 * thì tất cả mười nhà cung cấp đều trả 400, mỗi nhà một câu chữ khác nhau.
 */
function normalizeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) {
    throw badParam('tools', 'mảng không rỗng các khai báo hàm');
  }
  return tools.map((tool, i) => {
    if (!tool || typeof tool !== 'object' || tool.type !== 'function') {
      throw new UpstreamError(`tools[${i}].type phải là "function"`, 400);
    }
    const fn = tool.function;
    if (!fn || typeof fn.name !== 'string' || !fn.name) {
      throw new UpstreamError(`tools[${i}].function.name là bắt buộc`, 400);
    }
    if (fn.description !== undefined && typeof fn.description !== 'string') {
      throw new UpstreamError(`tools[${i}].function.description phải là chuỗi`, 400);
    }
    if (fn.parameters !== undefined && (typeof fn.parameters !== 'object' || fn.parameters === null)) {
      throw new UpstreamError(`tools[${i}].function.parameters phải là object (JSON Schema)`, 400);
    }
    return {
      type: 'function',
      function: {
        name: fn.name,
        ...(fn.description !== undefined ? { description: fn.description } : {}),
        ...(fn.parameters !== undefined ? { parameters: fn.parameters } : { parameters: { type: 'object', properties: {} } })
      }
    };
  });
}

/** `tool_choice`: `"auto"|"none"|"required"` hoặc `{type:'function', function:{name}}` để ghim đúng một hàm. */
function normalizeToolChoice(choice, tools) {
  if (typeof choice === 'string') {
    if (!['auto', 'none', 'required'].includes(choice)) {
      throw badParam('tool_choice', '"auto", "none", "required", hoặc object chọn hàm');
    }
    return choice;
  }
  if (choice && typeof choice === 'object' && choice.type === 'function') {
    const name = choice.function?.name;
    if (typeof name !== 'string' || !name) {
      throw new UpstreamError('tool_choice.function.name là bắt buộc', 400);
    }
    if (tools && !tools.some((t) => t.function.name === name)) {
      throw new UpstreamError(`tool_choice chọn hàm "${name}" nhưng hàm đó không có trong \`tools\``, 400);
    }
    return { type: 'function', function: { name } };
  }
  throw badParam('tool_choice', '"auto", "none", "required", hoặc object chọn hàm');
}

/**
 * Ép giá trị vào khoảng nhà cung cấp chấp nhận, thay vì để họ trả 400.
 *
 * Anthropic chỉ nhận `temperature` tới 1 còn OpenAI tới 2. Một client đặt `temperature: 1.5`
 * là hợp lệ với chuẩn mà gateway đang nói; chuyển thẳng xuống Anthropic sẽ thành 400, bị xếp
 * vào "lỗi phía client" và làm ĐỨNG cả pool cho một request mà 9 nhà còn lại phục vụ được.
 * Ép về trần là chỗ duy nhất giữ được cả hai: request vẫn chạy, và ý định "nóng hết cỡ" vẫn
 * được tôn trọng ở mức nhà cung cấp đó cho phép.
 */
function clamp(name, value, ranges = RANGES) {
  const range = ranges[name];
  if (!range) return value;
  return Math.min(Math.max(value, range[0]), range[1]);
}

/** Lọc theo danh sách tham số nhà cung cấp thật sự nhận, rồi ép khoảng. */
function pick(params, allow, ranges) {
  const out = {};
  for (const name of allow) {
    if (params[name] === undefined) continue;
    out[name] = typeof params[name] === 'number' ? clamp(name, params[name], ranges) : params[name];
  }
  return out;
}

/**
 * Phương ngữ OpenAI. `rename` cho những nhà cung cấp dùng tên khác cho cùng một ý —
 * Mistral gọi `seed` là `random_seed`, và gửi sai tên thì tham số bị bỏ qua không một lời báo.
 */
function toOpenAI(params, { allow = CANONICAL, rename = {}, ranges } = {}) {
  const picked = pick(params, allow, ranges);
  const out = {};
  for (const [name, value] of Object.entries(picked)) {
    out[rename[name] || name] = value;
  }
  return out;
}

/** Phương ngữ Gemini: mọi thứ nằm trong `generationConfig` và đổi sang camelCase. */
function toGemini(params, { allow = CANONICAL, ranges } = {}) {
  const p = pick(params, allow, ranges);
  const config = {};

  if (p.temperature !== undefined) config.temperature = p.temperature;
  if (p.top_p !== undefined) config.topP = p.top_p;
  if (p.top_k !== undefined) config.topK = p.top_k;
  if (p.max_tokens !== undefined) config.maxOutputTokens = p.max_tokens;
  if (p.stop) config.stopSequences = p.stop;
  if (p.seed !== undefined) config.seed = p.seed;
  if (p.presence_penalty !== undefined) config.presencePenalty = p.presence_penalty;
  if (p.frequency_penalty !== undefined) config.frequencyPenalty = p.frequency_penalty;
  if (p.response_format?.type === 'json_object') config.responseMimeType = 'application/json';

  return Object.keys(config).length ? { generationConfig: config } : {};
}

/**
 * Phương ngữ Anthropic. `max_tokens` là BẮT BUỘC ở API này — thiếu nó là 400, nên phải có
 * một giá trị mặc định chứ không thể chỉ chuyển tiếp thứ client gửi.
 */
function toAnthropic(params, { allow = CANONICAL, ranges, defaultMaxTokens = 4096 } = {}) {
  const p = pick(params, allow, ranges);
  const out = { max_tokens: p.max_tokens ?? defaultMaxTokens };

  if (p.temperature !== undefined) out.temperature = p.temperature;
  if (p.top_p !== undefined) out.top_p = p.top_p;
  if (p.top_k !== undefined) out.top_k = p.top_k;
  if (p.stop) out.stop_sequences = p.stop;

  return out;
}

/** Phương ngữ Cohere v2: `top_p` là `p`, `top_k` là `k`. */
function toCohere(params, { allow = CANONICAL, ranges } = {}) {
  const p = pick(params, allow, ranges);
  const out = {};

  if (p.temperature !== undefined) out.temperature = p.temperature;
  if (p.top_p !== undefined) out.p = p.top_p;
  if (p.top_k !== undefined) out.k = p.top_k;
  if (p.max_tokens !== undefined) out.max_tokens = p.max_tokens;
  if (p.stop) out.stop_sequences = p.stop;
  if (p.seed !== undefined) out.seed = p.seed;
  if (p.presence_penalty !== undefined) out.presence_penalty = p.presence_penalty;
  if (p.frequency_penalty !== undefined) out.frequency_penalty = p.frequency_penalty;
  if (p.response_format) out.response_format = p.response_format;

  return out;
}

module.exports = {
  CANONICAL,
  RANGES,
  normalizeParams,
  normalizeTools,
  normalizeToolChoice,
  clamp,
  pick,
  toOpenAI,
  toGemini,
  toAnthropic,
  toCohere
};
