const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../lib/app');
const { fakePool, acct, silentLogger } = require('./helpers');

/** Dựng app trên pool giả và mở cổng ngẫu nhiên; trả về `fetch` đã gắn base URL. */
async function withServer(spec, fn) {
  const { providers, pool } = fakePool(spec);
  const app = createApp({ providers, pool, logger: silentLogger(), store: null });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn(async (path, init) => {
      const res = await fetch(base + path, init);
      return { status: res.status, body: await res.json() };
    }, { providers, pool }, base);
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
    assert.ok(body.statuses.a.accounts[0].cooldownRemaining > 0, 'trạng thái phải chỉ ra KEY nào đang nghỉ');
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

test('GET /health cho biết bao nhiêu nhà và bao nhiêu tài khoản đang sẵn sàng', async () => {
  await withServer({ a: { k1: [], k2: [] }, b: [] }, async (call, { pool }) => {
    acct(pool, 'b').markUnavailable(429);
    acct(pool, 'a', 0).markUnavailable(429);

    const { body } = await call('/health');
    assert.equal(body.service, 'ai-gateway');
    assert.equal(body.total, 2);
    assert.equal(body.ready, 1, 'a vẫn còn một key dùng được');
    assert.equal(body.accounts, 3);
    assert.equal(body.accountsReady, 1);
  });
});

test('POST /api/providers/reset xóa cooldown', async () => {
  await withServer({ a: [], b: [] }, async (call, { pool }) => {
    acct(pool, 'a').markUnavailable(429);
    acct(pool, 'b').markUnavailable(429);

    const one = await call('/api/providers/reset', json({ provider: 'a' }));
    assert.deepEqual(one.body.reset, [acct(pool, 'a').id]);
    assert.equal(acct(pool, 'a').isCoolingDown(), false);
    assert.equal(acct(pool, 'b').isCoolingDown(), true);

    await call('/api/providers/reset', json({}));
    assert.equal(acct(pool, 'b').isCoolingDown(), false);
  });
});

test('POST /api/providers/reset xóa được đúng MỘT tài khoản', async () => {
  await withServer({ a: { k1: [], k2: [] } }, async (call, { pool }) => {
    acct(pool, 'a', 0).markUnavailable(429);
    acct(pool, 'a', 1).markUnavailable(429);

    const { body } = await call('/api/providers/reset', json({ account: acct(pool, 'a', 1).id }));
    assert.deepEqual(body.reset, [acct(pool, 'a', 1).id]);
    assert.equal(acct(pool, 'a', 0).isCoolingDown(), true, 'key kia không được đụng tới');
    assert.equal(acct(pool, 'a', 1).isCoolingDown(), false);
  });
});

test('POST /api/providers/reset với tên lạ thì 404', async () => {
  await withServer({ a: [] }, async (call) => {
    assert.equal((await call('/api/providers/reset', json({ provider: 'x' }))).status, 404);
  });
});

test('GET /api/providers/status liệt kê từng tài khoản, key đã che', async () => {
  await withServer({ a: { 'sk-key-mot-that-dai': [], 'sk-key-hai-that-dai': [] } }, async (call) => {
    const { body } = await call('/api/providers/status');
    assert.equal(body.a.accountCount, 2);
    assert.deepEqual(body.a.accounts.map((x) => x.label), ['a#1', 'a#2']);
    assert.doesNotMatch(JSON.stringify(body), /that-dai/, 'không được dội key thật ra ngoài');
  });
});

test('/v1/chat/completions chuyển tham số sinh văn bản xuống nhà cung cấp', async () => {
  await withServer({ a: [{ ok: 'xong' }] }, async (call, { providers }) => {
    await call(
      '/v1/chat/completions',
      json({ messages: [{ role: 'user', content: 'chào' }], temperature: 0.2, max_tokens: 40 })
    );
    assert.deepEqual(providers.a.seenParams[0], { temperature: 0.2, max_tokens: 40 });
  });
});

test('/v1/chat/completions từ chối tham số sai kiểu bằng 400', async () => {
  await withServer({ a: [] }, async (call, { providers }) => {
    const { status } = await call(
      '/v1/chat/completions',
      json({ messages: [{ role: 'user', content: 'chào' }], temperature: 'nóng' })
    );
    assert.equal(status, 400);
    assert.equal(providers.a.calls, 0, 'không được tốn một lượt gọi thật cho một lỗi đọc được ngay');
  });
});

test('`model` dạng `nhà/model` ghim cả nhà cung cấp lẫn model upstream', async () => {
  await withServer({ a: [{ ok: 'từ a' }], b: [{ ok: 'từ b' }] }, async (call, { providers }) => {
    const { body } = await call(
      '/v1/chat/completions',
      json({ model: 'b/model-cu-the', messages: [{ role: 'user', content: 'chào' }] })
    );
    assert.equal(body.choices[0].message.content, 'từ b');
    assert.equal(providers.b.seenModels[0], 'model-cu-the');
  });
});

test('`model` lạ thì để pool tự xoay thay vì trả 404', async () => {
  // Nhiều client gửi thẳng tên model của OpenAI vào mọi base_url; với một gateway xoay
  // vòng thì "chọn giúp tôi" là câu trả lời hữu ích hơn một lỗi.
  await withServer({ a: [{ ok: 'xong' }] }, async (call) => {
    const { status } = await call(
      '/v1/chat/completions',
      json({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'chào' }] })
    );
    assert.equal(status, 200);
  });
});

test('/v1/chat/completions từ chối role không hỗ trợ bằng 400', async () => {
  await withServer({ a: [] }, async (call) => {
    const { status, body } = await call(
      '/v1/chat/completions',
      json({ messages: [{ role: 'tool', content: 'kết quả' }] })
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /tool/);
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
  await withServer(spec, async (_call, { providers, pool }, base) => {
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
    await fn({ res, events, providers, pool, body: res.bodyUsed ? null : await res.json().catch(() => null) });
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
    ({ res, events, pool }) => {
      assert.equal(res.status, 200);
      const text = events
        .filter((e) => e !== '[DONE]')
        .map((e) => e.choices?.[0]?.delta?.content || '')
        .join('');
      assert.equal(text, 'từ b');
      assert.equal(acct(pool, 'a').isCoolingDown(), true);
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
  await withServer({ a: [] }, async (_c, { pool }, base) => {
    acct(pool, 'a').markUnavailable(429);
    const res = await fetch(`${base}/v1/chat/completions`, json({
      messages: [{ role: 'user', content: 'chào' }],
      stream: true
    }));
    assert.equal(res.status, 429);
  });
});
