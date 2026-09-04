const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../lib/app');
const { fakePool, silentLogger } = require('./helpers');

/** Dựng app trên pool giả và mở cổng ngẫu nhiên; trả về `fetch` đã gắn base URL. */
async function withServer(spec, fn) {
  const providers = fakePool(spec);
  const app = createApp({ providers, logger: silentLogger(), store: null });
  app.locals.router.resolveApiKey = () => 'test-key';

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn(async (path, init) => {
      const res = await fetch(base + path, init);
      return { status: res.status, body: await res.json() };
    }, providers, base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

test('POST /api/chat trả lời và nói rõ nhà nào đã phục vụ', async () => {
  await withServer({ a: [{ ok: 'xin chào' }], b: [] }, async (call) => {
    const { status, body } = await call('/api/chat', json({ message: 'chào' }));
    assert.equal(status, 200);
    assert.equal(body.response, 'xin chào');
    assert.equal(body.provider, 'a');
    assert.ok(body.status.a, 'kèm trạng thái pool cho web UI');
  });
});

test('POST /api/chat thiếu message thì 400', async () => {
  await withServer({ a: [] }, async (call) => {
    const { status } = await call('/api/chat', json({}));
    assert.equal(status, 400);
  });
});

test('POST /api/chat khi pool kiệt thì trả 429 kèm trạng thái', async () => {
  await withServer({ a: [{ status: 429 }] }, async (call) => {
    const { status, body } = await call('/api/chat', json({ message: 'chào' }));
    assert.equal(status, 429);
    assert.ok(body.statuses.a.cooldownRemaining > 0);
  });
});

test('POST /v1/chat/completions trả đúng hình dạng OpenAI', async () => {
  await withServer({ a: [{ ok: 'chào bạn' }] }, async (call) => {
    const { status, body } = await call(
      '/v1/chat/completions',
      json({ model: 'auto', messages: [{ role: 'user', content: 'chào' }] })
    );

    assert.equal(status, 200);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].message.content, 'chào bạn');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.ok(body.usage.total_tokens >= 0);
    assert.ok(body.id.startsWith('chatcmpl-'));
  });
});

test('/v1/chat/completions dùng `model` làm gợi ý ghim nhà cung cấp', async () => {
  await withServer({ a: [{ ok: 'từ a' }], b: [{ ok: 'từ b' }] }, async (call) => {
    const { body } = await call(
      '/v1/chat/completions',
      json({ model: 'b', messages: [{ role: 'user', content: 'chào' }] })
    );
    assert.equal(body.choices[0].message.content, 'từ b');
  });
});



test('/v1/chat/completions kiểm tra messages', async () => {
  await withServer({ a: [] }, async (call) => {
    assert.equal((await call('/v1/chat/completions', json({ messages: [] }))).status, 400);
    assert.equal((await call('/v1/chat/completions', json({}))).status, 400);
  });
});

test('/v1/chat/completions giữ nguyên mã lỗi 4xx của upstream', async () => {
  await withServer({ a: [{ status: 400, body: '{"error":{"message":"payload hỏng"}}' }] }, async (call) => {
    const { status, body } = await call(
      '/v1/chat/completions',
      json({ messages: [{ role: 'user', content: 'chào' }] })
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /payload hỏng/);
  });
});

test('GET /v1/models liệt kê auto + mọi nhà cung cấp', async () => {
  await withServer({ a: [], b: [] }, async (call) => {
    const { status, body } = await call('/v1/models');
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data.map((m) => m.id), ['auto', 'a', 'b']);
  });
});

test('GET /health cho biết bao nhiêu nhà đang sẵn sàng', async () => {
  await withServer({ a: [], b: [] }, async (call, providers) => {
    providers.b.markUnavailable(429);
    const { body } = await call('/health');
    assert.equal(body.service, 'ai-gateway');
    assert.equal(body.total, 2);
    assert.equal(body.ready, 1);
  });
});

test('POST /api/providers/reset xóa cooldown', async () => {
  await withServer({ a: [], b: [] }, async (call, providers) => {
    providers.a.markUnavailable(429);
    providers.b.markUnavailable(429);

    const one = await call('/api/providers/reset', json({ provider: 'a' }));
    assert.deepEqual(one.body.reset, ['a']);
    assert.equal(providers.a.isCoolingDown(), false);
    assert.equal(providers.b.isCoolingDown(), true);

    await call('/api/providers/reset', json({}));
    assert.equal(providers.b.isCoolingDown(), false);
  });
});

test('POST /api/providers/reset với tên lạ thì 404', async () => {
  await withServer({ a: [] }, async (call) => {
    assert.equal((await call('/api/providers/reset', json({ provider: 'x' }))).status, 404);
  });
});

test('GET /api/providers/status không vỡ khi query string hỏng', async () => {
  await withServer({ a: [] }, async (call) => {
    const { status } = await call('/api/providers/status?providers=khong-phai-json');
    assert.equal(status, 200);
  });
});

// ---------- stream ----------

/** Dựng server rồi đọc trọn một phản hồi SSE thành danh sách payload. */
async function readStream(spec, body, fn) {
  await withServer(spec, async (_call, providers, base) => {
    const res = await fetch(`${base}/v1/chat/completions`, json(body));
    const events = [];
    if (res.headers.get('content-type')?.includes('event-stream')) {
      const text = await res.text();
      for (const block of text.split('\n\n')) {
        const line = block.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { events.push('[DONE]'); continue; }
        events.push(JSON.parse(data));
      }
    }
    await fn({ res, events, providers, body: res.bodyUsed ? null : await res.json().catch(() => null) });
  });
}

test('stream trả SSE đúng khuôn OpenAI và kết bằng [DONE]', async () => {
  await readStream(
    { a: [{ chunks: ['Xin ', 'chào'] }] },
    { messages: [{ role: 'user', content: 'chào' }], stream: true },
    ({ res, events }) => {
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      assert.equal(res.headers.get('x-accel-buffering'), 'no');

      assert.equal(events.at(-1), '[DONE]');
      assert.equal(events[0].choices[0].delta.role, 'assistant');

      const text = events
        .filter((e) => e !== '[DONE]')
        .map((e) => e.choices?.[0]?.delta?.content || '')
        .join('');
      assert.equal(text, 'Xin chào');

      const last = events.at(-2);
      assert.equal(last.choices[0].finish_reason, 'stop');
      assert.ok(events.some((e) => e !== '[DONE]' && e.usage), 'phải có mẩu mang usage');
      assert.ok(events.every((e) => e === '[DONE]' || e.object === 'chat.completion.chunk'));
    }
  );
});

test('stream xoay vòng được TRƯỚC mẩu đầu tiên', async () => {
  await readStream(
    { a: [{ status: 429 }], b: [{ chunks: ['từ ', 'b'] }] },
    { messages: [{ role: 'user', content: 'chào' }], stream: true },
    ({ res, events, providers }) => {
      assert.equal(res.status, 200);
      const text = events
        .filter((e) => e !== '[DONE]')
        .map((e) => e.choices?.[0]?.delta?.content || '')
        .join('');
      assert.equal(text, 'từ b');
      assert.equal(providers.a.isCoolingDown(), true);
    }
  );
});

test('stream lỗi trước mẩu đầu vẫn trả được status HTTP thật', async () => {
  await withServer({ a: [{ status: 400, body: '{"error":{"message":"payload hỏng"}}' }] }, async (_c, _p, base) => {
    const res = await fetch(`${base}/v1/chat/completions`, json({
      messages: [{ role: 'user', content: 'chào' }],
      stream: true
    }));
    assert.equal(res.status, 400, 'header chưa gửi thì vẫn đặt được status');
    assert.match((await res.json()).error.message, /payload hỏng/);
  });
});

test('stream đứt GIỮA chừng thì báo lỗi trong thân stream, không xoay vòng', async () => {
  await readStream(
    { a: [{ chunks: ['một nửa'], thenFail: 500 }], b: [{ chunks: ['nửa kia'] }] },
    { messages: [{ role: 'user', content: 'chào' }], stream: true },
    ({ res, events, providers }) => {
      // Header đã gửi nên status vẫn là 200 — lỗi chỉ báo được trong thân.
      assert.equal(res.status, 200);
      assert.ok(events.some((e) => e !== '[DONE]' && e.error), 'phải có mẩu mang lỗi');
      assert.equal(events.at(-1), '[DONE]', 'vẫn đóng đúng cách');

      const text = events
        .filter((e) => e !== '[DONE]')
        .map((e) => e.choices?.[0]?.delta?.content || '')
        .join('');
      assert.equal(text, 'một nửa');
      assert.doesNotMatch(text, /nửa kia/, 'không được ghép câu trả lời của hai nhà cung cấp');
      assert.equal(providers.b.calls, 0, 'quá muộn để xoay vòng');
    }
  );
});

test('stream khi pool kiệt thì trả 429, không mở SSE', async () => {
  await withServer({ a: [] }, async (_c, providers, base) => {
    providers.a.markUnavailable(429);
    const res = await fetch(`${base}/v1/chat/completions`, json({
      messages: [{ role: 'user', content: 'chào' }],
      stream: true
    }));
    assert.equal(res.status, 429);
  });
});
