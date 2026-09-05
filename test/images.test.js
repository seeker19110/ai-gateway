const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeMessages, hasImages } = require('../lib/messages');
const { UpstreamError } = require('../lib/errors');
const { createProviders } = require('../lib/providers');
const { AccountPool } = require('../lib/pool');
const { stubFetch, jsonResponse, fakePool, silentLogger } = require('./helpers');
const SmartRouter = require('../lib/router');
const GeminiProvider = require('../providers/gemini');
const ClaudeProvider = require('../providers/claude');

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const IMAGE_MESSAGE = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Ảnh này vẽ gì?' },
      { type: 'image_url', image_url: { url: PNG_DATA_URI } }
    ]
  }
];

// ---------- messages.js ----------

test('normalizeMessages giữ content dạng mảng khối khi có image_url', () => {
  const out = normalizeMessages(IMAGE_MESSAGE);
  assert.ok(Array.isArray(out[0].content));
  assert.equal(out[0].content[1].image_url.url, PNG_DATA_URI);
  assert.ok(hasImages(out));
});

test('normalizeMessages vẫn dẹp content toàn text về chuỗi (không đổi hành vi cũ)', () => {
  const out = normalizeMessages([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
  assert.equal(out[0].content, 'a\nb');
  assert.equal(hasImages(out), false);
});

test('normalizeMessages từ chối khối image_url thiếu url', () => {
  assert.throws(
    () => normalizeMessages([{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }]),
    UpstreamError
  );
});

test('normalizeMessages từ chối khối video (chưa hỗ trợ)', () => {
  assert.throws(
    () => normalizeMessages([{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://x/y.mp4' } }] }]),
    UpstreamError
  );
});

// ---------- providers/base.js (OpenAI-dialect: passthrough nguyên khối) ----------

test('provider OpenAI-compatible chuyển thẳng content dạng mảng khối (không dịch)', async () => {
  const { groq } = createProviders({});
  const stub = stubFetch(async () => jsonResponse(200, { choices: [{ message: { content: 'đây là mèo' } }] }));
  try {
    const messages = normalizeMessages(IMAGE_MESSAGE);
    await groq.chat(messages, 'key');
    const body = JSON.parse(stub.calls[0].init.body);
    assert.deepEqual(body.messages[0].content, messages[0].content);
  } finally {
    stub.restore();
  }
});

// ---------- providers/gemini.js ----------

test('Gemini dịch ảnh base64 sang inlineData', async () => {
  const gemini = new GeminiProvider();
  const stub = stubFetch(async () =>
    jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'con mèo' }] } }] })
  );
  try {
    const messages = normalizeMessages(IMAGE_MESSAGE);
    await gemini.chat(messages, 'key');
    const body = JSON.parse(stub.calls[0].init.body);
    const imgPart = body.contents[0].parts.find((p) => p.inlineData);
    assert.equal(imgPart.inlineData.mimeType, 'image/png');
    assert.ok(imgPart.inlineData.data.length > 0);
  } finally {
    stub.restore();
  }
});

test('Gemini từ chối ảnh dạng URL công khai (chỉ nhận base64)', async () => {
  const gemini = new GeminiProvider();
  const messages = normalizeMessages([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }] }
  ]);
  await assert.rejects(() => gemini.chat(messages, 'key'), (err) => {
    assert.ok(err instanceof UpstreamError);
    assert.equal(err.statusCode, 400);
    return true;
  });
});

// ---------- providers/claude.js ----------

test('Claude dịch ảnh base64 và URL sang khối image', async () => {
  const claude = new ClaudeProvider();
  const stub = stubFetch(async () => jsonResponse(200, { content: [{ type: 'text', text: 'con mèo' }], usage: {} }));
  try {
    const messages = normalizeMessages([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: PNG_DATA_URI } },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }
        ]
      }
    ]);
    await claude.chat(messages, 'sk-ant-api-x');
    const body = JSON.parse(stub.calls[0].init.body);
    const blocks = body.messages[0].content;
    assert.equal(blocks[0].source.type, 'base64');
    assert.equal(blocks[1].source.type, 'url');
    assert.equal(blocks[1].source.url, 'https://example.com/cat.png');
  } finally {
    stub.restore();
  }
});

// ---------- router: lọc pool theo ảnh ----------

test('router loại nhà cung cấp không hỗ trợ ảnh, xoay sang nhà còn lại', async () => {
  const { pool, providers } = fakePool({ a: ['ok từ a'], b: ['ok từ b'] });
  providers.a.supportsImages = false;
  providers.b.supportsImages = true;
  const router = new SmartRouter(pool, { logger: { info() {}, warn() {}, error() {} } });

  const result = await router.chat(normalizeMessages(IMAGE_MESSAGE));
  assert.equal(result.provider, 'b');
});

test('router trả 400 khi không còn nhà nào hỗ trợ ảnh', async () => {
  const { pool, providers } = fakePool({ a: ['ok'] });
  providers.a.supportsImages = false;
  const router = new SmartRouter(pool, { logger: { info() {}, warn() {}, error() {} } });

  await assert.rejects(
    () => router.chat(normalizeMessages(IMAGE_MESSAGE)),
    (err) => {
      assert.ok(err instanceof UpstreamError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

// ---------- end-to-end ----------

test('POST /v1/chat/completions chuyển ảnh tới provider và trả lời bình thường', async () => {
  const { createApp } = require('../lib/app');
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
    return jsonResponse(200, { choices: [{ message: { content: 'đây là một con mèo' } }] });
  });

  try {
    const res = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'groq', messages: IMAGE_MESSAGE })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.choices[0].message.content, 'đây là một con mèo');
  } finally {
    stub.restore();
    await new Promise((resolve) => server.close(resolve));
  }
});
