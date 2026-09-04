const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { parseSSE, parseSSEJson } = require('../lib/sse');

/** Response giả có body là stream các chunk byte đúng như đã chia. */
function responseOf(chunks) {
  return { body: Readable.from(chunks.map((c) => Buffer.from(c, 'utf8'))) };
}

async function collect(iter) {
  const out = [];
  for await (const item of iter) out.push(item);
  return out;
}

test('đọc được các sự kiện cơ bản', async () => {
  const events = await collect(parseSSE(responseOf(['data: một\n\ndata: hai\n\n'])));
  assert.deepEqual(events.map((e) => e.data), ['một', 'hai']);
});

test('sự kiện bị chia đôi giữa hai chunk vẫn ghép lại đúng', async () => {
  // Đây là ca mà cắt SSE bằng tay hay làm hỏng: `split('\n\n')` trên từng chunk sẽ
  // đánh rơi hoặc làm vỡ JSON của sự kiện bị xé.
  const events = await collect(
    parseSSEJson(responseOf(['data: {"a":', '1,"b":2}\n\ndata: {"a":3}\n\n']))
  );
  assert.deepEqual(events.map((e) => e.payload), [{ a: 1, b: 2 }, { a: 3 }]);
});

test('một sự kiện chia thành nhiều chunk rất nhỏ', async () => {
  const raw = 'data: {"x":"xin chào"}\n\n';
  const events = await collect(parseSSEJson(responseOf(raw.split(''))));
  assert.deepEqual(events.map((e) => e.payload), [{ x: 'xin chào' }]);
});

test('[DONE] kết thúc vòng lặp và không được phát ra', async () => {
  const events = await collect(parseSSE(responseOf(['data: một\n\ndata: [DONE]\n\ndata: sau\n\n'])));
  assert.deepEqual(events.map((e) => e.data), ['một'], 'không đọc tiếp sau [DONE]');
});

test('giữ nguyên khoảng trắng đầu của delta', async () => {
  // Chỉ được bỏ ĐÚNG MỘT khoảng trắng sau `data:`; `trim()` sẽ làm các chữ dính vào nhau.
  const events = await collect(parseSSE(responseOf(['data:  hai dấu cách\n\n'])));
  assert.equal(events[0].data, ' hai dấu cách');
});

test('bỏ qua dòng comment / keep-alive', async () => {
  const events = await collect(parseSSE(responseOf([': keep-alive\n\ndata: thật\n\n'])));
  assert.deepEqual(events.map((e) => e.data), ['thật']);
});

test('đọc được tên sự kiện', async () => {
  const events = await collect(parseSSE(responseOf(['event: message_start\ndata: {}\n\n'])));
  assert.equal(events[0].event, 'message_start');
});

test('gộp nhiều dòng data của cùng một sự kiện', async () => {
  const events = await collect(parseSSE(responseOf(['data: dòng 1\ndata: dòng 2\n\n'])));
  assert.equal(events[0].data, 'dòng 1\ndòng 2');
});

test('sự kiện cuối không có \\n\\n vẫn không bị mất', async () => {
  const events = await collect(parseSSE(responseOf(['data: cuối cùng'])));
  assert.deepEqual(events.map((e) => e.data), ['cuối cùng']);
});

test('chịu được CRLF', async () => {
  const events = await collect(parseSSE(responseOf(['data: có CR\r\n\r\n'])));
  assert.equal(events[0].data, 'có CR');
});

test('JSON hỏng bị bỏ qua thay vì làm vỡ cả stream', async () => {
  const events = await collect(
    parseSSEJson(responseOf(['data: {hỏng\n\ndata: {"ok":true}\n\n']))
  );
  assert.deepEqual(events.map((e) => e.payload), [{ ok: true }]);
});

test('ký tự nhiều byte bị cắt giữa hai chunk vẫn ghép đúng', async () => {
  // "chào" trong UTF-8: 'à' là 2 byte. Cắt giữa hai byte đó mà decode không có
  // `{ stream: true }` sẽ ra ký tự thay thế.
  const raw = Buffer.from('data: {"t":"chào"}\n\n', 'utf8');
  const cut = 14; // rơi vào giữa chuỗi byte của 'à'
  const events = await collect(
    parseSSEJson({ body: Readable.from([raw.subarray(0, cut), raw.subarray(cut)]) })
  );
  assert.deepEqual(events.map((e) => e.payload), [{ t: 'chào' }]);
});
