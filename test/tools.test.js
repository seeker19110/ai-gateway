const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { normalizeMessages } = require('../lib/messages');
const { normalizeParams } = require('../lib/params');
const { UpstreamError } = require('../lib/errors');
const { createProviders } = require('../lib/providers');
const { AccountPool } = require('../lib/pool');
const { createApp } = require('../lib/app');
const { stubFetch, jsonResponse, fakePool, silentLogger } = require('./helpers');
const SmartRouter = require('../lib/router');
const ClaudeProvider = require('../providers/claude');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Lấy thời tiết',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
    }
  }
];

// ---------- messages.js ----------

test('normalizeMessages chấp nhận assistant có tool_calls, content rỗng', () => {
  const out = normalizeMessages([
    { role: 'user', content: 'thời tiết Hà Nội?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hà Nội"}' } }]
    },
    { role: 'tool', tool_call_id: 'call_1', content: '20°C' }
  ]);
  assert.equal(out[1].content, '');
  assert.equal(out[1].tool_calls[0].function.name, 'get_weather');
  assert.equal(out[2].tool_call_id, 'call_1');
});

test('normalizeMessages từ chối message role="tool" thiếu tool_call_id', () => {
  assert.throws(
    () => normalizeMessages([{ role: 'user', content: 'x' }, { role: 'tool', content: 'y' }]),
    UpstreamError
  );
});

test('normalizeMessages từ chối tool_calls thiếu function.name', () => {
  assert.throws(
    () =>
      normalizeMessages([
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: {} }] }
      ]),
    UpstreamError
  );
});

// ---------- params.js ----------

test('normalizeParams đọc và kiểm tra tools/tool_choice', () => {
  const params = normalizeParams({ tools: TOOLS, tool_choice: 'auto' });
  assert.equal(params.tools[0].function.name, 'get_weather');
  assert.equal(params.tool_choice, 'auto');
});

test('normalizeParams từ chối tools rỗng hoặc sai hình dạng', () => {
  assert.throws(() => normalizeParams({ tools: [] }), UpstreamError);
  assert.throws(() => normalizeParams({ tools: [{ type: 'function', function: {} }] }), UpstreamError);
});

test('normalizeParams từ chối tool_choice ghim hàm không có trong tools', () => {
  assert.throws(
    () => normalizeParams({ tools: TOOLS, tool_choice: { type: 'function', function: { name: 'khong_ton_tai' } } }),
    UpstreamError
  );
});

test('normalizeParams chấp nhận tool_choice ghim đúng hàm trong tools', () => {
  const params = normalizeParams({ tools: TOOLS, tool_choice: { type: 'function', function: { name: 'get_weather' } } });
  assert.deepEqual(params.tool_choice, { type: 'function', function: { name: 'get_weather' } });
});

// ---------- providers/base.js (dialect OpenAI) ----------

test('provider OpenAI-compatible gửi tools/tool_choice và đọc tool_calls trong phản hồi', async () => {
  const { groq } = createProviders({});
  const stub = stubFetch(async () =>
    jsonResponse(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"HN"}' } }]
          }
        }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    })
  );
  try {
    const result = await groq.chat([{ role: 'user', content: 'thời tiết?' }], 'key', {
      params: { tools: TOOLS, tool_choice: 'auto' }
    });
    assert.equal(result.text, '');
    assert.equal(result.toolCalls[0].function.name, 'get_weather');

    const body = JSON.parse(stub.calls[0].init.body);
    assert.deepEqual(body.tools, TOOLS);
    assert.equal(body.tool_choice, 'auto');
  } finally {
    stub.restore();
  }
});

test('provider không khai supportsTools thì không gửi tools xuống upstream', async () => {
  const GroqProvider = require('../providers/groq');
  const groqNoTools = new GroqProvider({ supportsTools: false });
  const stub = stubFetch(async () =>
    jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
  );
  try {
    await groqNoTools.chat([{ role: 'user', content: 'x' }], 'key', { params: { tools: TOOLS } });
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.tools, undefined);
  } finally {
    stub.restore();
  }
});

test('stream OpenAI-compatible gom tool_calls rải theo nhiều mẩu delta', async () => {
  const { groq } = createProviders({});
  const sseBody =
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"HN"}' } }] } }] })}\n\n` +
    'data: [DONE]\n\n';

  const stub = stubFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: Readable.from([Buffer.from(sseBody, 'utf8')])
  }));

  try {
    const pieces = [];
    for await (const piece of groq.stream([{ role: 'user', content: 'x' }], 'key', { params: { tools: TOOLS } })) {
      pieces.push(piece);
    }
    const withToolCalls = pieces.find((p) => p.toolCalls);
    assert.ok(withToolCalls, 'phải phát ra một mẩu toolCalls sau khi stream kết thúc');
    assert.equal(withToolCalls.toolCalls[0].id, 'call_1');
    assert.equal(withToolCalls.toolCalls[0].function.arguments, '{"city":"HN"}');
  } finally {
    stub.restore();
  }
});

// ---------- providers/claude.js ----------

test('Claude dịch tools sang input_schema và đọc tool_use trong phản hồi', async () => {
  const claude = new ClaudeProvider();
  const stub = stubFetch(async () =>
    jsonResponse(200, {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'HN' } }],
      usage: { input_tokens: 3, output_tokens: 4 }
    })
  );
  try {
    const result = await claude.chat([{ role: 'user', content: 'thời tiết HN?' }], 'sk-ant-api-x', {
      params: { tools: TOOLS, tool_choice: 'required' }
    });
    assert.equal(result.toolCalls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { city: 'HN' });

    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.tools[0].name, 'get_weather');
    assert.deepEqual(body.tools[0].input_schema, TOOLS[0].function.parameters);
    assert.deepEqual(body.tool_choice, { type: 'any' });
  } finally {
    stub.restore();
  }
});

test('Claude chuyển tool_call/tool_result thành khối tool_use/tool_result đúng cặp id', async () => {
  const claude = new ClaudeProvider();
  const stub = stubFetch(async () => jsonResponse(200, { content: [{ type: 'text', text: 'trời nắng' }], usage: {} }));
  try {
    await claude.chat(
      [
        { role: 'user', content: 'thời tiết HN?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"HN"}' } }]
        },
        { role: 'tool', tool_call_id: 'call_1', content: '30°C, nắng' }
      ],
      'sk-ant-api-x',
      { params: { tools: TOOLS } }
    );
    const body = JSON.parse(stub.calls[0].init.body);
    const assistantTurn = body.messages.find((m) => m.role === 'assistant');
    const toolUse = assistantTurn.content.find((b) => b.type === 'tool_use');
    assert.equal(toolUse.id, 'call_1');

    const userTurns = body.messages.filter((m) => m.role === 'user');
    const toolResult = userTurns.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    assert.equal(toolResult.tool_use_id, 'call_1');
    assert.equal(toolResult.content, '30°C, nắng');
  } finally {
    stub.restore();
  }
});

// ---------- router: lọc pool theo tools ----------

test('router loại nhà cung cấp không hỗ trợ tools khi request có tools, không lỗi nếu còn ứng viên khác', async () => {
  const { pool, providers } = fakePool({ a: ['ok từ a'], b: ['ok từ b'] });
  providers.a.supportsTools = false;
  providers.b.supportsTools = true;
  const router = new SmartRouter(pool, { logger: { info() {}, warn() {}, error() {} } });

  const result = await router.chat([{ role: 'user', content: 'x' }], { params: { tools: TOOLS } });
  assert.equal(result.provider, 'b');
});

// ---------- end-to-end: /v1/chat/completions ----------

test('POST /v1/chat/completions trả tool_calls khi upstream chọn gọi hàm', async () => {
  const env = { GROQ_API_KEY: 'test-key' };
  const providers = createProviders(env);
  const pool = new AccountPool(providers, { env });
  const app = createApp({ providers, pool, logger: silentLogger(), store: null, env });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = global.fetch;

  const stub = stubFetch(async (url, init) => {
    if (String(url).startsWith(base)) return realFetch(url, init);
    return jsonResponse(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"HN"}' } }]
          }
        }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    });
  });

  try {
    const res = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'groq',
        messages: [{ role: 'user', content: 'thời tiết Hà Nội?' }],
        tools: TOOLS,
        tool_choice: 'auto'
      })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.equal(body.choices[0].message.content, null);
  } finally {
    stub.restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('router trả 400 khi mọi nhà cung cấp còn dùng được đều không hỗ trợ tools', async () => {
  const { pool, providers } = fakePool({ a: ['ok'] });
  providers.a.supportsTools = false;
  const router = new SmartRouter(pool, { logger: { info() {}, warn() {}, error() {} } });

  await assert.rejects(
    () => router.chat([{ role: 'user', content: 'x' }], { params: { tools: TOOLS } }),
    (err) => {
      assert.ok(err instanceof UpstreamError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});
