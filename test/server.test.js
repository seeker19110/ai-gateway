const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../lib/app');
const { fakePool, acct, silentLogger } = require('./helpers');

/** Thư mục trạng thái riêng cho mỗi lần gọi: không đụng tới `~/.ai-gateway` thật khi test. */
function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-state-'));
}

/**
 * Dựng app trên pool giả và mở cổng ngẫu nhiên; trả về `fetch` đã gắn base URL.
 *
 * Pool và app phải dùng CHUNG một `env` (cùng `GATEWAY_STATE_DIR`): đăng nhập subscription
 * ghi token xuống đĩa theo `env` của app, còn `pool.configure()` đọc lại token đó theo
 * `env` mà chính pool được dựng bằng — hai object khác nhau (dù cùng giá trị) là pool sẽ
 * không bao giờ thấy token vừa đăng nhập.
 */
async function withServer(spec, fn, { env = { GATEWAY_STATE_DIR: tmpStateDir() } } = {}) {
  const { providers, pool } = fakePool(spec, { env });
  const app = createApp({ providers, pool, logger: silentLogger(), store: null, env });

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

/** POST thô tới `/mcp`, giữ nguyên header phản hồi (test session/SSE cần đọc `Mcp-Session-Id`). */
async function mcpPost(base, body, { sessionId, accept = 'application/json' } = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: accept,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
    },
    body: JSON.stringify(body)
  });
  const sessionHeader = res.headers.get('mcp-session-id');
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  return { status: res.status, sessionHeader, contentType, text };
}

async function mcpInit(base) {
  const res = await mcpPost(base, { jsonrpc: '2.0', id: 1, method: 'initialize' });
  return res.sessionHeader;
}

test('POST /mcp: initialize cấp session, tools/list không kèm session bị từ chối', async () => {
  await withServer({ a: [{ ok: 'xin chào' }] }, async (_c, _s, base) => {
    const init = await mcpPost(base, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(init.status, 200);
    assert.ok(init.sessionHeader, 'phải cấp Mcp-Session-Id');
    assert.equal(JSON.parse(init.text).result.protocolVersion, '2024-11-05');

    const noSession = await mcpPost(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(noSession.status, 400, 'thiếu Mcp-Session-Id phải bị từ chối theo spec');

    const unknownSession = await mcpPost(base, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { sessionId: 'khong-ton-tai' });
    assert.equal(unknownSession.status, 404, 'session lạ phải trả 404 để client tự init lại');

    const list = await mcpPost(base, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { sessionId: init.sessionHeader });
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.text).result.tools[0].name, 'chat');
  });
});

test('POST /mcp: client chỉ nhận SSE thì phản hồi bằng một sự kiện text/event-stream', async () => {
  await withServer({ a: [{ ok: 'xin chào' }] }, async (_c, _s, base) => {
    const sessionId = await mcpInit(base);
    const res = await mcpPost(
      base,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { sessionId, accept: 'text/event-stream' }
    );
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/event-stream/);
    assert.match(res.text, /^data: /);
    const payload = JSON.parse(res.text.replace(/^data: /, '').trim());
    assert.equal(payload.result.tools[0].name, 'chat');
  });
});

test('POST /mcp: tools/call "chat" đi qua đúng router, xoay vòng như /api/chat', async () => {
  await withServer({ a: [{ ok: 'xin chào' }], b: [] }, async (_c, _s, base) => {
    const sessionId = await mcpInit(base);
    const res = await mcpPost(
      base,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chat', arguments: { message: 'chào' } } },
      { sessionId }
    );
    const body = JSON.parse(res.text);
    assert.equal(res.status, 200);
    assert.equal(body.result.content[0].text, 'xin chào');
    assert.equal(body.result.isError, undefined);
  });
});

test('POST /mcp: tool lạ hoặc pool kiệt trả isError, không vỡ JSON-RPC', async () => {
  await withServer({ a: [] }, async (_c, { pool }, base) => {
    acct(pool, 'a').markUnavailable(429);
    const sessionId = await mcpInit(base);

    const exhausted = await mcpPost(
      base,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'chat', arguments: { message: 'chào' } } },
      { sessionId }
    );
    assert.equal(JSON.parse(exhausted.text).result.isError, true);

    const unknown = await mcpPost(
      base,
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'khong-ton-tai', arguments: {} } },
      { sessionId }
    );
    assert.equal(JSON.parse(unknown.text).result.isError, true);
  });
});

test('GET/DELETE /mcp: không hỗ trợ server-push (405), đóng phiên chủ động', async () => {
  await withServer({ a: [] }, async (_c, _s, base) => {
    const sessionId = await mcpInit(base);

    const get = await fetch(`${base}/mcp`);
    assert.equal(get.status, 405);

    const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } });
    assert.equal(del.status, 200);

    const afterDelete = await mcpPost(base, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, { sessionId });
    assert.equal(afterDelete.status, 404, 'phiên đã bị xoá thì request sau phải bị từ chối');

    const delAgain = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } });
    assert.equal(delAgain.status, 404);
  });
});

test('POST /api/claude/oauth/start rồi callback: đăng nhập xong thì pool có tài khoản claude-subscription', async () => {
  const { stubFetch, jsonResponse } = require('./helpers');
  await withServer({ claude: [] }, async (call) => {
    const { status: startStatus, body: start } = await call('/api/claude/oauth/start', { method: 'POST' });
    assert.equal(startStatus, 200);
    assert.ok(start.state, 'phải trả state để đối chiếu ở bước callback');
    assert.match(start.url, /^https:\/\/claude\.ai\/oauth\/authorize\?/);

    // `stubFetch` thay `global.fetch` cho CẢ TIẾN TRÌNH — kể cả lệnh gọi HTTP của chính test
    // này tới server cục bộ (`call()` bên dưới cũng đi qua `fetch`). Chỉ chặn đúng URL của
    // Anthropic, mọi request khác forward về `fetch` gốc.
    const originalFetch = global.fetch;
    const stub = stubFetch(async (url, init) => {
      if (!url.startsWith('https://console.anthropic.com/')) return originalFetch(url, init);
      return jsonResponse(200, { access_token: 'sk-ant-oat-xxx', refresh_token: 'rt', expires_in: 3600 });
    });
    let cb;
    try {
      cb = await call('/api/claude/oauth/callback', json({ code: `real-code#${start.state}`, state: start.state }));
    } finally {
      stub.restore();
    }
    assert.equal(cb.status, 200);
    assert.equal(cb.body.ok, true);

    const status = await call('/api/claude/oauth/status', { method: 'GET' });
    assert.equal(status.body.loggedIn, true);

    const providerStatus = await call('/api/providers/status', { method: 'GET' });
    const labels = providerStatus.body.claude.accounts.map((a) => a.label);
    assert.ok(labels.includes('claude-subscription'), `phải thấy tài khoản claude-subscription trong: ${labels}`);
  });
});

test('POST /api/claude/oauth/callback: state sai hoặc không tồn tại thì bị từ chối, không lộ verifier', async () => {
  await withServer({ claude: [] }, async (call) => {
    const missing = await call('/api/claude/oauth/callback', json({ code: 'abc#xyz', state: 'khong-ton-tai' }));
    assert.equal(missing.status, 400);

    const { body: start } = await call('/api/claude/oauth/start', { method: 'POST' });
    const wrongState = await call('/api/claude/oauth/callback', json({ code: 'abc#khac', state: start.state }));
    // exchangeCode nhận state khác `expectedState` (đọc từ chính mã) → lỗi 400 từ claudeOAuth,
    // đi qua nhánh `fail()` chung chứ không phải nhánh "phiên không tồn tại".
    assert.equal(wrongState.status, 400);
  });
});

test('DELETE /api/claude/oauth: đăng xuất thì status báo loggedIn=false', async () => {
  await withServer({ claude: [] }, async (call) => {
    const before = await call('/api/claude/oauth/status', { method: 'GET' });
    assert.equal(before.body.loggedIn, false);

    const del = await call('/api/claude/oauth', { method: 'DELETE' });
    assert.equal(del.status, 200);

    const after = await call('/api/claude/oauth/status', { method: 'GET' });
    assert.equal(after.body.loggedIn, false);
  });
});
