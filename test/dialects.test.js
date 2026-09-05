const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeParams, toOpenAI, toGemini, toAnthropic, toCohere } = require('../lib/params');
const { normalizeMessages, flattenContent, toAlternating, mergeConsecutive } = require('../lib/messages');
const { readRateLimit, parseReset, parseDuration, retryDelayFromGoogleError } = require('../lib/ratelimit');

// ---------- tham số ----------

test('chỉ đọc tham số biết mặt, bỏ qua phần còn lại của body', () => {
  const params = normalizeParams({
    messages: [],
    model: 'auto',
    stream: true,
    temperature: 0.4,
    max_tokens: 100
  });
  assert.deepEqual(params, { temperature: 0.4, max_tokens: 100 });
});

test('tham số sai kiểu bị chặn ngay tại gateway', () => {
  // Để nó đi tiếp thì upstream trả 400, bị xếp vào "lỗi phía client, không xoay vòng" —
  // đúng kết luận, nhưng tốn một lượt gọi thật và một dòng log đổ tội cho nhà cung cấp.
  assert.throws(() => normalizeParams({ temperature: 'nóng' }), (err) => err.statusCode === 400);
  assert.throws(() => normalizeParams({ max_tokens: -5 }), (err) => err.statusCode === 400);
  assert.throws(() => normalizeParams({ max_tokens: 1.5 }), (err) => err.statusCode === 400);
  assert.throws(() => normalizeParams({ stop: [1, 2] }), (err) => err.statusCode === 400);
});

test('`user` phải là chuỗi, kiểu khác bị chặn ngay tại gateway', () => {
  assert.equal(normalizeParams({ user: 'khach-1' }).user, 'khach-1');
  assert.throws(() => normalizeParams({ user: 123 }), (err) => err.statusCode === 400);
});

test('`stop` nhận cả chuỗi lẫn mảng, tối đa 4 như chuẩn OpenAI', () => {
  assert.deepEqual(normalizeParams({ stop: 'X' }).stop, ['X']);
  assert.deepEqual(normalizeParams({ stop: ['a', 'b', 'c', 'd', 'e'] }).stop, ['a', 'b', 'c', 'd']);
});

test('tham số nhà cung cấp không nhận thì bị lọc, không gửi bừa', () => {
  const params = normalizeParams({ temperature: 0.5, seed: 3, max_tokens: 20 });
  // Cerebras trả 400 cho trường lạ thay vì bỏ qua, nên "gửi thừa cho chắc" là hỏng request.
  const body = toOpenAI(params, { allow: ['temperature', 'max_tokens'] });
  assert.deepEqual(body, { temperature: 0.5, max_tokens: 20 });
});

test('tên khác cho cùng một ý được đổi đúng', () => {
  const body = toOpenAI(normalizeParams({ seed: 7 }), {
    allow: ['seed'],
    rename: { seed: 'random_seed' }
  });
  assert.deepEqual(body, { random_seed: 7 });
});

test('Gemini gói mọi thứ vào generationConfig', () => {
  const body = toGemini(normalizeParams({ temperature: 0.5, top_p: 0.9, max_tokens: 32, stop: 'END' }));
  assert.deepEqual(body, {
    generationConfig: { temperature: 0.5, topP: 0.9, maxOutputTokens: 32, stopSequences: ['END'] }
  });
});

test('Gemini dịch response_format json sang responseMimeType', () => {
  const body = toGemini(normalizeParams({ response_format: { type: 'json_object' } }));
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
});

test('Anthropic luôn có max_tokens vì đó là trường bắt buộc', () => {
  assert.equal(toAnthropic({}, { defaultMaxTokens: 4096 }).max_tokens, 4096);
  assert.equal(toAnthropic(normalizeParams({ max_tokens: 10 })).max_tokens, 10);
});

test('Cohere v2 đổi top_p thành p và top_k thành k', () => {
  const body = toCohere(normalizeParams({ top_p: 0.5, top_k: 10 }));
  assert.equal(body.p, 0.5);
  assert.equal(body.k, 10);
});

test('không có tham số nào thì body không mọc thêm trường', () => {
  assert.deepEqual(toGemini({}), {});
  assert.deepEqual(toOpenAI({}), {});
});

// ---------- messages ----------

test('content dạng mảng khối text được dẹp phẳng', () => {
  // Client chuẩn OpenAI được phép gửi mảng khối; phần lớn upstream ở đây chỉ nhận chuỗi.
  assert.equal(flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(flattenContent('thẳng'), 'thẳng');
  assert.equal(flattenContent(null), '');
});

test('content dạng mảng chứa chuỗi thô (không phải khối {type,text}) vẫn được dẹp phẳng', () => {
  assert.equal(flattenContent(['a', 'b']), 'a\nb');
});

test('phần tử messages không phải object (null, chuỗi...) bị từ chối rõ ràng', () => {
  assert.throws(
    () => normalizeMessages([null]),
    (err) => err.statusCode === 400 && /object/.test(err.message)
  );
  assert.throws(
    () => normalizeMessages(['chỉ là chuỗi']),
    (err) => err.statusCode === 400
  );
});

test('khối không phải text bị từ chối chứ không bị bỏ qua', () => {
  // Giả vờ đã gửi ảnh đi là cách hỏng tệ nhất: người dùng nhận về một câu trả lời tự tin
  // về thứ mà model chưa từng nhìn thấy.
  assert.throws(
    () => normalizeMessages([{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }]),
    (err) => err.statusCode === 400
  );
});

test('role lạ bị từ chối rõ ràng, không bị nuốt', () => {
  assert.throws(
    () => normalizeMessages([{ role: 'tool', content: 'kết quả' }]),
    (err) => err.statusCode === 400 && /tool/.test(err.message)
  );
});

test('lượt liên tiếp cùng vai được gộp cho API đòi luân phiên', () => {
  const merged = mergeConsecutive([
    { role: 'user', content: 'một' },
    { role: 'user', content: 'hai' },
    { role: 'assistant', content: 'ba' }
  ]);
  assert.deepEqual(merged, [
    { role: 'user', content: 'một\n\nhai' },
    { role: 'assistant', content: 'ba' }
  ]);
});

test('hội thoại mở đầu bằng assistant được cắt về lượt user đầu tiên', () => {
  const { turns } = toAlternating([
    { role: 'assistant', content: 'mồ côi' },
    { role: 'user', content: 'hỏi' }
  ]);
  assert.deepEqual(turns, [{ role: 'user', content: 'hỏi' }]);
});

test('system message tách khỏi hội thoại và gộp lại thành một', () => {
  const { system, turns } = toAlternating([
    { role: 'system', content: 'A' },
    { role: 'user', content: 'hỏi' },
    { role: 'system', content: 'B' }
  ]);
  assert.equal(system, 'A\nB');
  assert.equal(turns.length, 1);
});

test('hội thoại chỉ có system thì báo lỗi thay vì gửi mảng rỗng', () => {
  assert.throws(
    () => toAlternating([{ role: 'system', content: 'A' }]),
    (err) => err.statusCode === 400
  );
});

// ---------- tín hiệu hạn mức ----------

const headers = (obj) => ({ get: (k) => obj[k.toLowerCase()] ?? null });

test('đọc được cả ba họ header hạn mức', () => {
  assert.deepEqual(
    readRateLimit(headers({ 'x-ratelimit-remaining-requests': '4', 'x-ratelimit-reset-requests': '30s' })),
    { remaining: 4, resetSeconds: 30 }
  );
  assert.deepEqual(
    readRateLimit(headers({ 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': '60' })),
    { remaining: 0, resetSeconds: 60 }
  );
  assert.deepEqual(
    readRateLimit(headers({ 'ratelimit-remaining': '7', 'ratelimit-reset': '15' })),
    { remaining: 7, resetSeconds: 15 }
  );
});

test('lấy hạn mức CĂNG NHẤT khi có nhiều loại cùng lúc', () => {
  // Còn dư 5000 token mà hết lượt request thì vẫn là hết.
  const rl = readRateLimit(headers({
    'x-ratelimit-remaining-requests': '0',
    'x-ratelimit-reset-requests': '20s',
    'x-ratelimit-remaining-tokens': '5000',
    'x-ratelimit-reset-tokens': '1s'
  }));
  assert.equal(rl.remaining, 0);
  assert.equal(rl.resetSeconds, 20);
});

test('upstream không nói gì thì không đoán bừa', () => {
  assert.equal(readRateLimit(headers({})), null);
  assert.equal(readRateLimit(null), null);
});

test('mốc reset đọc được cả ba định dạng ngoài đời', () => {
  assert.equal(parseReset('60'), 60);
  assert.equal(parseDuration('2m59.56s'), 180);
  assert.equal(parseDuration('1h2m3s'), 3723);
  assert.equal(parseDuration('88ms'), 1);

  const iso = new Date(Date.now() + 45_000).toISOString();
  const seconds = parseReset(iso);
  assert.ok(seconds > 40 && seconds <= 45, `mốc RFC-3339 ra ${seconds}s`);
});

test('chuỗi không phải khoảng thời gian thì trả null, không đoán', () => {
  assert.equal(parseDuration('2026-09-04T12:00:00Z'), null);
  assert.equal(parseReset('không rõ'), null);
});

test('retryDelay của Google đọc được từ thân lỗi 429', () => {
  const body = JSON.stringify({
    error: { code: 429, details: [{ '@type': '…RetryInfo', retryDelay: '27s' }] }
  });
  assert.equal(retryDelayFromGoogleError(body), 27);
  assert.equal(retryDelayFromGoogleError('{}'), null);
  assert.equal(retryDelayFromGoogleError('không phải json'), null);
  assert.equal(retryDelayFromGoogleError(null), null);

  // `details` có mặt nhưng không phần tử nào mang `retryDelay` hợp lệ: phải trả null chứ
  // không ném lỗi hay đoán bừa một con số.
  const noValidDelay = JSON.stringify({ error: { details: [{ '@type': 'khác', foo: 'bar' }] } });
  assert.equal(retryDelayFromGoogleError(noValidDelay), null);
});
