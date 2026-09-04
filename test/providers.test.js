const test = require('node:test');
const assert = require('node:assert/strict');

const { createProviders } = require('../lib/providers');
const { UpstreamError } = require('../lib/errors');
const { stubFetch, jsonResponse } = require('./helpers');

const MSG = [
  { role: 'system', content: 'Bạn là trợ lý.' },
  { role: 'user', content: 'chào' }
];

test('mọi provider đều khai đủ name/displayName/model', () => {
  for (const [key, p] of Object.entries(createProviders())) {
    assert.equal(p.name, key);
    assert.ok(p.displayName, `${key} thiếu displayName`);
    assert.ok(p.model, `${key} thiếu model`);
    assert.ok(p.maxRPM > 0);
  }
});

test('provider chuẩn OpenAI đọc được phản hồi và usage', async () => {
  const { groq } = createProviders();
  const stub = stubFetch(async () =>
    jsonResponse(200, {
      choices: [{ message: { content: 'xin chào' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })
  );

  try {
    const result = await groq.chat(MSG, 'key-abc');
    assert.equal(result.text, 'xin chào');
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.model, groq.model);
    assert.deepEqual(body.messages, MSG);
    assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer key-abc');
  } finally {
    stub.restore();
  }
});

test('lỗi HTTP thành UpstreamError mang đúng mã và Retry-After', async () => {
  const { groq } = createProviders();
  const stub = stubFetch(async () =>
    jsonResponse(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '42' })
  );

  try {
    await assert.rejects(
      () => groq.chat(MSG, 'key'),
      (err) => {
        assert.ok(err instanceof UpstreamError);
        assert.equal(err.statusCode, 429);
        assert.equal(err.retryAfter, '42');
        assert.match(err.message, /Rate limit reached/);
        assert.equal(err.isNetworkError, false);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

test('lỗi mạng được đánh dấu isNetworkError', async () => {
  const { groq } = createProviders();
  const stub = stubFetch(async () => {
    throw new Error('ECONNRESET');
  });

  try {
    await assert.rejects(
      () => groq.chat(MSG, 'key'),
      (err) => err instanceof UpstreamError && err.isNetworkError === true
    );
  } finally {
    stub.restore();
  }
});

test('thiếu API key thì báo 401, không gọi mạng', async () => {
  const { groq } = createProviders();
  const stub = stubFetch(async () => {
    throw new Error('không được gọi tới đây');
  });

  try {
    await assert.rejects(
      () => groq.chat(MSG, ''),
      (err) => err.statusCode === 401
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('Gemini gửi key ở header, không ở query string', async () => {
  const { gemini } = createProviders();
  const stub = stubFetch(async () =>
    jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: 'chào bạn' }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
    })
  );

  try {
    const result = await gemini.chat(MSG, 'khoa-bi-mat');
    assert.equal(result.text, 'chào bạn');
    assert.equal(result.usage.prompt_tokens, 3);

    const { url, init } = stub.calls[0];
    assert.doesNotMatch(url, /khoa-bi-mat/, 'key không được nằm trên URL — URL bị ghi vào log');
    assert.equal(init.headers['x-goog-api-key'], 'khoa-bi-mat');

    // system message phải đi vào systemInstruction, không lẫn vào contents
    const body = JSON.parse(init.body);
    assert.equal(body.systemInstruction.parts[0].text, 'Bạn là trợ lý.');
    assert.equal(body.contents.length, 1);
  } finally {
    stub.restore();
  }
});

test('Gemini chặn nội dung bằng HTTP 200 thì nói rõ lý do', async () => {
  const { gemini } = createProviders();
  const stub = stubFetch(async () =>
    jsonResponse(200, { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] })
  );

  try {
    await assert.rejects(
      () => gemini.chat(MSG, 'key'),
      (err) => /SAFETY/.test(err.message)
    );
  } finally {
    stub.restore();
  }
});

test('Claude tách system message và đọc usage', async () => {
  const { claude } = createProviders();
  const stub = stubFetch(async () =>
    jsonResponse(200, {
      content: [{ type: 'text', text: 'chào' }],
      usage: { input_tokens: 7, output_tokens: 3 }
    })
  );

  try {
    const result = await claude.chat(MSG, 'sk-ant');
    assert.equal(result.text, 'chào');
    assert.equal(result.usage.total_tokens, 10);

    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.system, 'Bạn là trợ lý.');
    assert.equal(body.messages.length, 1, 'system không được lẫn vào messages');
    assert.equal(stub.calls[0].init.headers['x-api-key'], 'sk-ant');
  } finally {
    stub.restore();
  }
});

test('Claude bỏ qua block không phải text', async () => {
  const { claude } = createProviders();
  const stub = stubFetch(async () =>
    jsonResponse(200, {
      content: [{ type: 'thinking', thinking: 'nghĩ' }, { type: 'text', text: 'trả lời' }]
    })
  );

  try {
    assert.equal((await claude.chat(MSG, 'k')).text, 'trả lời');
  } finally {
    stub.restore();
  }
});

test('Cohere ghép nhiều block text', async () => {
  const { cohere } = createProviders();
  const stub = stubFetch(async () =>
    jsonResponse(200, {
      message: { content: [{ text: 'xin ' }, { text: 'chào' }] },
      usage: { billed_units: { input_tokens: 4, output_tokens: 2 } }
    })
  );

  try {
    const result = await cohere.chat(MSG, 'key');
    assert.equal(result.text, 'xin chào');
    assert.equal(result.usage.total_tokens, 6);
  } finally {
    stub.restore();
  }
});

test('phản hồi rỗng bị coi là lỗi 502, không trả chuỗi rỗng cho người dùng', async () => {
  const { groq } = createProviders();
  const stub = stubFetch(async () => jsonResponse(200, { choices: [{ message: { content: '' } }] }));

  try {
    await assert.rejects(
      () => groq.chat(MSG, 'key'),
      (err) => err.statusCode === 502
    );
  } finally {
    stub.restore();
  }
});

test('JSON hỏng thành 502 chứ không phải crash', async () => {
  const { groq } = createProviders();
  const stub = stubFetch(async () => jsonResponse(200, 'không phải json'));

  try {
    await assert.rejects(
      () => groq.chat(MSG, 'key'),
      (err) => err.statusCode === 502 && /JSON/.test(err.message)
    );
  } finally {
    stub.restore();
  }
});

test('cửa sổ RPM tự trượt, không cần setInterval', () => {
  const { groq } = createProviders();
  groq.status = 'active';
  groq.maxRPM = 2;
  const t0 = Date.now();

  groq.trackRequest(t0);
  groq.trackRequest(t0);
  assert.equal(groq.isAvailable(t0), false, 'đã chạm trần RPM');
  assert.equal(groq.isAvailable(t0 + 61_000), true, 'qua 60s là cửa sổ mới');
});

test('dựng pool không để lại timer treo process', () => {
  createProviders();
  // Bản cũ tạo setInterval 60s cho mỗi provider và không bao giờ dọn: process không thoát
  // được và test treo. Giờ không provider nào giữ handle nào.
  const handles = process._getActiveHandles().filter((h) => h.constructor.name === 'Timeout');
  assert.equal(handles.length, 0, 'còn timer sống sau khi dựng pool');
});
