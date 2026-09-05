const { UpstreamError } = require('./errors');

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Chuẩn hóa và kiểm tra `messages` đầu vào một lần, ở biên của gateway.
 *
 * Client chuẩn OpenAI được phép gửi `content` là mảng khối (`[{type:'text',text:'…'}]`),
 * còn phần lớn upstream ở đây chỉ nhận chuỗi. Nếu không dẹp phẳng ở một chỗ thì mỗi
 * provider tự đoán một kiểu, và thứ đi tới nhà cung cấp thứ hai trong lượt failover lại
 * khác thứ đã đi tới nhà thứ nhất — cùng một câu hỏi cho ra hai request khác nhau.
 *
 * `assistant` mang thêm `tool_calls` (lời gọi hàm) và `tool` là kết quả gắn với đúng một
 * `tool_call_id` — đây là hai mắt xích bắt buộc phải giữ ràng buộc đúng thứ tự, khác hẳn
 * `content` tự do của user/assistant thường.
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new UpstreamError('`messages` phải là mảng không rỗng', 400);
  }

  const out = [];
  for (const [i, message] of messages.entries()) {
    if (!message || typeof message !== 'object') {
      throw new UpstreamError(`messages[${i}] phải là một object`, 400);
    }
    const role = message.role;
    if (!ROLES.has(role)) {
      throw new UpstreamError(
        `messages[${i}].role = "${role}" không được hỗ trợ (chỉ có system, user, assistant, tool)`,
        400
      );
    }

    if (role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) {
        throw new UpstreamError(`messages[${i}].tool_call_id là bắt buộc với role "tool"`, 400);
      }
      const content = flattenContent(message.content);
      if (content === null) {
        throw new UpstreamError(`messages[${i}].content phải là chuỗi hoặc mảng khối text`, 400);
      }
      out.push({ role, content, tool_call_id: message.tool_call_id });
      continue;
    }

    const toolCalls = normalizeToolCallsField(message.tool_calls, i);
    // Assistant gọi hàm được phép có `content` rỗng: lời gọi NẰM trong `tool_calls`, không
    // trong content, và một số nhà cung cấp trả về `content: null` cho đúng lượt này.
    const content = toolCalls ? flattenContent(message.content ?? '') : flattenContent(message.content);
    if (content === null) {
      throw new UpstreamError(`messages[${i}].content phải là chuỗi hoặc mảng khối text`, 400);
    }
    out.push({ role, content, ...(toolCalls ? { tool_calls: toolCalls } : {}) });
  }
  return out;
}

/** Kiểm tra `tool_calls` của một message assistant: mảng {id, type:'function', function:{name, arguments}}. */
function normalizeToolCallsField(toolCalls, i) {
  if (toolCalls === undefined || toolCalls === null) return null;
  if (!Array.isArray(toolCalls) || !toolCalls.length) {
    throw new UpstreamError(`messages[${i}].tool_calls phải là mảng không rỗng`, 400);
  }
  return toolCalls.map((call, j) => {
    if (!call || typeof call !== 'object' || typeof call.id !== 'string' || !call.id) {
      throw new UpstreamError(`messages[${i}].tool_calls[${j}].id là bắt buộc`, 400);
    }
    const fn = call.function;
    if (!fn || typeof fn.name !== 'string' || !fn.name) {
      throw new UpstreamError(`messages[${i}].tool_calls[${j}].function.name là bắt buộc`, 400);
    }
    const args = fn.arguments;
    if (args !== undefined && typeof args !== 'string') {
      throw new UpstreamError(`messages[${i}].tool_calls[${j}].function.arguments phải là chuỗi JSON`, 400);
    }
    return { id: call.id, type: 'function', function: { name: fn.name, arguments: args || '{}' } };
  });
}

/** `content` → chuỗi. Trả `null` nếu không đọc được (để nơi gọi báo 400). */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) return null;

  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block && typeof block === 'object' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    // Khối không phải text (ảnh, audio): gateway này chỉ chuyển văn bản, và giả vờ đã gửi
    // ảnh đi là cách hỏng tệ nhất — người dùng nhận về một câu trả lời tự tin về thứ mà
    // model chưa từng nhìn thấy.
    return null;
  }
  return parts.join('\n');
}

/** Tách system message ra khỏi hội thoại — Gemini và Anthropic đều để nó ở một trường riêng. */
function splitSystem(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n');
  return { system, chat: messages.filter((m) => m.role !== 'system') };
}

/**
 * Gộp các lượt liên tiếp cùng vai.
 *
 * Anthropic và Gemini đòi hội thoại phải luân phiên user/assistant. Hai tin nhắn user
 * liền nhau là chuyện rất thường (người dùng gõ tiếp khi câu trước lỗi, hoặc lịch sử đã
 * bị cắt bớt ở giữa) và nếu chuyển thẳng thì upstream trả 400 — mà 400 lại bị phân loại
 * là "lỗi phía client, không xoay vòng", nên cả pool đứng im vì một thứ gateway tự sửa được.
 */
function mergeConsecutive(chat) {
  const out = [];
  for (const message of chat) {
    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      last.content = [last.content, message.content].filter(Boolean).join('\n\n');
    } else {
      out.push({ ...message });
    }
  }
  return out;
}

/**
 * Bỏ các lượt assistant ở đầu: cả Anthropic lẫn Gemini đều đòi lượt đầu tiên là của user.
 * Một câu trả lời của trợ lý mà không có câu hỏi đứng trước thì cũng không mang thêm ngữ
 * cảnh nào đáng giữ.
 */
function dropLeadingAssistant(chat) {
  let i = 0;
  while (i < chat.length && chat[i].role === 'assistant') i++;
  return chat.slice(i);
}

/** Bộ chuẩn bị dùng chung cho Anthropic/Gemini: tách system, gộp lượt, đảm bảo mở đầu bằng user. */
function toAlternating(messages) {
  const { system, chat } = splitSystem(messages);
  const turns = mergeConsecutive(dropLeadingAssistant(mergeConsecutive(chat)));
  if (!turns.length) {
    throw new UpstreamError('Hội thoại phải có ít nhất một lượt của user', 400);
  }
  return { system, turns };
}

module.exports = {
  normalizeMessages,
  flattenContent,
  splitSystem,
  mergeConsecutive,
  dropLeadingAssistant,
  toAlternating
};
