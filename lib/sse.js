/**
 * Đọc Server-Sent Events từ body của một `fetch` Response.
 *
 * Cả bốn định dạng stream mà gateway phải nói chuyện (OpenAI, Gemini, Claude, Cohere) đều
 * là SSE; chỉ khác nhau ở JSON bên trong. Tách phần khung ra đây để bốn provider không ai
 * phải tự cắt chuỗi — cắt SSE bằng tay là chỗ rất dễ sai: một sự kiện có thể bị chia đôi
 * giữa hai chunk TCP, và nếu cứ `split('\n\n')` trên từng chunk thì sự kiện bị xé đó mất
 * hẳn hoặc thành JSON hỏng, chỉ lộ ra khi phản hồi đủ dài.
 */

/**
 * Duyệt từng sự kiện SSE. Trả về `{ event, data }` với `data` là chuỗi thô (chưa parse JSON).
 * Sự kiện `data: [DONE]` được nuốt và kết thúc vòng lặp.
 */
async function* parseSSE(response) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    // Chỉ cắt ở ranh giới sự kiện HOÀN CHỈNH; phần đuôi dở dang ở lại buffer chờ chunk sau.
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const parsed = parseEvent(raw);
      if (!parsed) continue;
      if (parsed.data === '[DONE]') return;
      yield parsed;
    }
  }

  // Một số upstream đóng kết nối mà không có `\n\n` cuối; đừng bỏ mất sự kiện cuối cùng.
  const tail = parseEvent(buffer);
  if (tail && tail.data !== '[DONE]') yield tail;
}

function parseEvent(raw) {
  const text = raw.replace(/\r/g, '').trim();
  if (!text || text.startsWith(':')) return null; // dòng `:` là comment/keep-alive

  let event = null;
  const dataLines = [];

  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // Theo spec chỉ bỏ đúng MỘT khoảng trắng sau dấu hai chấm — `trim()` sẽ ăn mất
      // khoảng trắng đầu của delta và làm câu trả lời dính chữ vào nhau.
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }

  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

/** Như `parseSSE` nhưng bỏ qua sự kiện có JSON hỏng thay vì làm vỡ cả stream. */
async function* parseSSEJson(response) {
  for await (const { event, data } of parseSSE(response)) {
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    yield { event, payload };
  }
}

module.exports = { parseSSE, parseSSEJson };
