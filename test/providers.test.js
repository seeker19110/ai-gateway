const test = require('node:test');
const assert = require('node:assert/strict');

const { createProviders } = require('../lib/providers');
const { UpstreamError } = require('../lib/errors');
const { stubFetch, jsonResponse } = require('./helpers');

const MSG = [
  { role: 'system', content: 'Bạn là trợ lý.' },
  { role: 'user', content: 'chào' }
];

/** Gọi một provider với `fetch` đã bị thay; trả về các lần gọi để soi body. */
async function withFetch(handler, fn) {
  const stub = stubFetch(handler);
  try {
    return await fn(stub);
  } finally {
    stub.restore();
  }
}

const okOpenAI = () =>
  jsonResponse(200, {
    choices: [{ message: { content: 'xin chào' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  });

test('mọi provider đều khai đủ name/displayName/model', () => {
  for (const [key, p] of Object.entries(createProviders({}))) {
    assert.equal(p.name, key);
    assert.ok(p.displayName, `${key} thiếu displayName`);
    assert.ok(p.model, `${key} thiếu model`);
    assert.ok(p.maxRPM > 0);
    assert.ok(Array.isArray(p.paramSupport) && p.paramSupport.length, `${key} thiếu paramSupport`);
  }
});

test('provider chuẩn OpenAI đọc được phản hồi và usage', async () => {
  const { groq } = createProviders({});
  await withFetch(okOpenAI, async (stub) => {
    const result = await groq.chat(MSG, 'key-abc');
    assert.equal(result.text, 'xin chào');
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.model, groq.model);
    assert.deepEqual(body.messages, MSG);
    assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer key-abc');
  });
});

test('lỗi HTTP thành UpstreamError mang đúng mã và Retry-After', async () => {
  const { groq } = createProviders({});
  await withFetch(
    async () => jsonResponse(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '42' }),
    async () => {
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
    }
  );
});

test('lỗi mạng được đánh dấu isNetworkError', async () => {
  const { groq } = createProviders({});
  await withFetch(
    async () => { throw new Error('ECONNRESET'); },
    async () => {
      await assert.rejects(
        () => groq.chat(MSG, 'key'),
        (err) => err instanceof UpstreamError && err.isNetworkError === true
      );
    }
  );
});

test('thiếu API key thì báo 401, không gọi mạng', async () => {
  const { groq } = createProviders({});
  await withFetch(
    async () => { throw new Error('không được gọi tới đây'); },
    async (stub) => {
      await assert.rejects(() => groq.chat(MSG, ''), (err) => err.statusCode === 401);
      assert.equal(stub.calls.length, 0);
    }
  );
});

test('Gemini gửi key ở header, không ở query string', async () => {
  const { gemini } = createProviders({});
  await withFetch(
    async () =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'chào bạn' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
      }),
    async (stub) => {
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
    }
  );
});

test('Gemini chặn nội dung bằng HTTP 200 thì nói rõ lý do', async () => {
  const { gemini } = createProviders({});
  await withFetch(
    async () => jsonResponse(200, { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }),
    async () => {
      await assert.rejects(() => gemini.chat(MSG, 'key'), (err) => /SAFETY/.test(err.message));
    }
  );
});

test('Gemini đọc retryDelay trong thân lỗi — họ không gửi Retry-After', async () => {
  const { gemini } = createProviders({});
  const body = {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '27s' }]
    }
  };

  await withFetch(
    async () => jsonResponse(429, body),
    async () => {
      await assert.rejects(
        () => gemini.chat(MSG, 'key'),
        (err) => {
          // Không đọc trường này thì bảng mặc định cho 429 nghỉ nguyên một tiếng, cho một
          // nhịp nghẽn 27 giây của hạn mức phút.
          assert.equal(err.retryAfter, 27);
          return true;
        }
      );
    }
  );
});

test('Claude tách system message và đọc usage', async () => {
  const { claude } = createProviders({});
  await withFetch(
    async () =>
      jsonResponse(200, {
        content: [{ type: 'text', text: 'chào' }],
        usage: { input_tokens: 7, output_tokens: 3 }
      }),
    async (stub) => {
      const result = await claude.chat(MSG, 'sk-ant');
      assert.equal(result.text, 'chào');
      assert.equal(result.usage.total_tokens, 10);

      const body = JSON.parse(stub.calls[0].init.body);
      assert.equal(body.system, 'Bạn là trợ lý.');
      assert.equal(body.messages.length, 1, 'system không được lẫn vào messages');
      assert.equal(body.max_tokens, 4096, 'max_tokens là trường bắt buộc của API này');
      assert.equal(stub.calls[0].init.headers['x-api-key'], 'sk-ant');
    }
  );
});

test('Claude nhận token subscription (sk-ant-oat) và gửi Bearer thay vì x-api-key', async () => {
  const { claude } = createProviders({});
  await withFetch(
    async () =>
      jsonResponse(200, {
        content: [{ type: 'text', text: 'chào' }],
        usage: { input_tokens: 7, output_tokens: 3 }
      }),
    async (stub) => {
      const result = await claude.chat(MSG, 'sk-ant-oat01-abc123');
      assert.equal(result.text, 'chào');

      const headers = stub.calls[0].init.headers;
      assert.equal(headers.Authorization, 'Bearer sk-ant-oat01-abc123');
      assert.equal(headers['x-api-key'], undefined);
      assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');

      const body = JSON.parse(stub.calls[0].init.body);
      assert.ok(Array.isArray(body.system), 'system phải là mảng khi dùng token subscription');
      assert.match(body.system[0].text, /Claude Code/);
      assert.equal(body.system[1].text, 'Bạn là trợ lý.');
    }
  );
});

test('Claude bỏ qua block không phải text', async () => {
  const { claude } = createProviders({});
  await withFetch(
    async () =>
      jsonResponse(200, {
        content: [{ type: 'thinking', thinking: 'nghĩ' }, { type: 'text', text: 'trả lời' }]
      }),
    async () => {
      assert.equal((await claude.chat(MSG, 'k')).text, 'trả lời');
    }
  );
});

test('Cohere ghép nhiều block text', async () => {
  const { cohere } = createProviders({});
  await withFetch(
    async () =>
      jsonResponse(200, {
        message: { content: [{ text: 'xin ' }, { text: 'chào' }] },
        usage: { tokens: { input_tokens: 4, output_tokens: 2 } }
      }),
    async () => {
      const result = await cohere.chat(MSG, 'key');
      assert.equal(result.text, 'xin chào');
      assert.equal(result.usage.total_tokens, 6);
    }
  );
});

test('phản hồi rỗng bị coi là lỗi 502, không trả chuỗi rỗng cho người dùng', async () => {
  const { groq } = createProviders({});
  await withFetch(
    async () => jsonResponse(200, { choices: [{ message: { content: '' } }] }),
    async () => {
      await assert.rejects(() => groq.chat(MSG, 'key'), (err) => err.statusCode === 502);
    }
  );
});

test('JSON hỏng thành 502 chứ không phải crash', async () => {
  const { groq } = createProviders({});
  await withFetch(
    async () => jsonResponse(200, 'không phải json'),
    async () => {
      await assert.rejects(
        () => groq.chat(MSG, 'key'),
        (err) => err.statusCode === 502 && /JSON/.test(err.message)
      );
    }
  );
});

test('dựng pool không để lại timer treo process', () => {
  createProviders({});
  // Bản cũ tạo setInterval 60s cho mỗi provider và không bao giờ dọn: process không thoát
  // được và test treo. Giờ không provider nào giữ handle nào.
  const handles = process._getActiveHandles().filter((h) => h.constructor.name === 'Timeout');
  assert.equal(handles.length, 0, 'còn timer sống sau khi dựng pool');
});

// ---------- đúng chuẩn từng nhà cung cấp ----------

test('tham số được dịch sang phương ngữ của từng nhà cung cấp', async () => {
  const params = { temperature: 0.3, top_p: 0.9, max_tokens: 64, stop: ['STOP'], seed: 7 };
  const providers = createProviders({});

  const bodies = {};
  for (const name of ['groq', 'mistral', 'cerebras', 'gemini', 'claude', 'cohere']) {
    const response = {
      groq: okOpenAI,
      mistral: okOpenAI,
      cerebras: okOpenAI,
      gemini: () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'x' }] } }] }),
      claude: () => jsonResponse(200, { content: [{ type: 'text', text: 'x' }] }),
      cohere: () => jsonResponse(200, { message: { content: [{ text: 'x' }] } })
    }[name];

    await withFetch(response, async (stub) => {
      await providers[name].chat(MSG, 'key', { params });
      bodies[name] = JSON.parse(stub.calls[0].init.body);
    });
  }

  // Groq: y như OpenAI.
  assert.equal(bodies.groq.temperature, 0.3);
  assert.equal(bodies.groq.seed, 7);

  // Mistral gọi `seed` là `random_seed`; gửi đúng tên OpenAI thì bị bỏ qua lặng lẽ.
  assert.equal(bodies.mistral.random_seed, 7);
  assert.equal(bodies.mistral.seed, undefined);

  // Cerebras trả 400 cho trường lạ, nên `seed` phải bị lọc ra hẳn.
  assert.equal(bodies.cerebras.seed, undefined, 'Cerebras không có seed — gửi kèm là hỏng cả request');
  assert.equal(bodies.cerebras.max_tokens, 64);

  // Gemini: mọi thứ nằm trong generationConfig, camelCase.
  assert.deepEqual(bodies.gemini.generationConfig, {
    temperature: 0.3,
    topP: 0.9,
    maxOutputTokens: 64,
    stopSequences: ['STOP'],
    seed: 7
  });

  // Anthropic: `stop_sequences`, không có seed.
  assert.deepEqual(bodies.claude.stop_sequences, ['STOP']);
  assert.equal(bodies.claude.seed, undefined);

  // Cohere v2: `top_p` là `p`.
  assert.equal(bodies.cohere.p, 0.9);
  assert.equal(bodies.cohere.top_p, undefined);
});

test('temperature ngoài khoảng được ép về trần của nhà cung cấp, không để họ trả 400', async () => {
  const { claude } = createProviders({});
  await withFetch(
    async () => jsonResponse(200, { content: [{ type: 'text', text: 'x' }] }),
    async (stub) => {
      // Hợp lệ với chuẩn OpenAI (tới 2), quá trần của Anthropic (tới 1). Chuyển thẳng thì
      // thành 400 — bị xếp vào "lỗi phía client" và làm đứng cả pool.
      await claude.chat(MSG, 'key', { params: { temperature: 1.8 } });
      assert.equal(JSON.parse(stub.calls[0].init.body).temperature, 1);
    }
  );
});

test('stream_options chỉ gửi cho nhà cung cấp thật sự có tham số đó', async () => {
  const providers = createProviders({});
  const sse = () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: (async function* () { yield Buffer.from('data: [DONE]\n\n'); })()
  });

  for (const [name, expected] of [['groq', true], ['cerebras', false], ['mistral', false]]) {
    await withFetch(sse, async (stub) => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of providers[name].stream(MSG, 'key')) { /* chỉ cần mở kết nối */ }
      const body = JSON.parse(stub.calls[0].init.body);
      assert.equal(
        Boolean(body.stream_options),
        expected,
        `${name}: stream_options ${expected ? 'phải' : 'không được'} có mặt`
      );
    });
  }
});

test('lượt user liên tiếp được gộp lại cho các API đòi luân phiên', async () => {
  const { claude } = createProviders({});
  const history = [
    { role: 'assistant', content: 'mồ côi' },
    { role: 'user', content: 'một' },
    { role: 'user', content: 'hai' }
  ];

  await withFetch(
    async () => jsonResponse(200, { content: [{ type: 'text', text: 'x' }] }),
    async (stub) => {
      await claude.chat(history, 'key');
      const body = JSON.parse(stub.calls[0].init.body);
      // Anthropic đòi hội thoại luân phiên và mở đầu bằng user; hai thứ này gateway tự sửa
      // được, còn để upstream trả 400 thì cả pool đứng im vì một lỗi không phải của họ.
      assert.deepEqual(body.messages, [{ role: 'user', content: 'một\n\nhai' }]);
    }
  );
});

test('model theo request ghi đè model mặc định', async () => {
  const { groq } = createProviders({});
  await withFetch(okOpenAI, async (stub) => {
    await groq.chat(MSG, 'key', { model: 'llama-3.1-8b-instant' });
    assert.equal(JSON.parse(stub.calls[0].init.body).model, 'llama-3.1-8b-instant');
  });
});

test('model và hạn mức đọc được từ biến môi trường', () => {
  const providers = createProviders({ GEMINI_MODEL: 'gemini-2.5-flash', GROQ_MAX_RPM: '60' });
  // Tên model trong code là ảnh chụp của một thời điểm; hãng cho model nghỉ hưu theo lịch
  // của họ, và khi đó mọi lượt đi qua nhà đó trả 404 — một lỗi "phía client" nên không xoay
  // vòng. Sửa được bằng biến môi trường là chuyện một phút, còn không thì phải chờ phát hành.
  assert.equal(providers.gemini.model, 'gemini-2.5-flash');
  assert.equal(providers.groq.maxRPM, 60);
  assert.equal(providers.openai.model, 'gpt-4o-mini', 'nhà không được ghi đè thì giữ mặc định');
});

test('testConnection không ghi trạng thái lên provider dùng chung', async () => {
  const { groq } = createProviders({});
  await withFetch(
    async () => jsonResponse(401, { error: { message: 'key hỏng' } }),
    async () => {
      const outcome = await groq.testConnection('key-hong');
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /key hỏng/);
      // Một provider phục vụ nhiều tài khoản: ghi kết quả của một key lên object dùng chung
      // sẽ dán nhãn "hỏng" cho những key chưa từng được thử.
      assert.equal(groq.lastError, undefined);
      assert.equal(groq.status, undefined);
    }
  );
});
