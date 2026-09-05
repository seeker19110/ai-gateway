const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const path = require('path');

const SmartRouter = require('./router');
const { createProviders } = require('./providers');
const { AccountPool } = require('./pool');
const { UpstreamError } = require('./errors');
const { CooldownStore } = require('./store');
const { normalizeParams } = require('./params');
const { normalizeMessages } = require('./messages');
const { parseKeyList, maskKey } = require('./accounts');
const { createMcpRouter } = require('./mcp');
const claudeOAuth = require('./claudeOAuth');
const { createMetrics } = require('./metrics');

/** Log có mốc thời gian; test tiêm logger im lặng để output không lẫn. */
const defaultLogger = {
  info: (msg) => console.log(`[${new Date().toISOString()}] INFO  ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] WARN  ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ERROR ${msg}`)
};

function createApp({
  providers = createProviders(),
  logger = defaultLogger,
  store,
  pool,
  env = process.env,
  backgroundRefresh = false,
  loginTtlMs = 10 * 60_000,
  refreshIntervalMs = 5 * 60_000
} = {}) {
  // `store: null` để tắt hẳn (test dùng), bỏ trống thì dùng file mặc định.
  const cooldownStore = store === undefined ? new CooldownStore() : store;
  const accountPool = pool || new AccountPool(providers, { env });
  const router = new SmartRouter(accountPool, { logger, store: cooldownStore });

  if (cooldownStore) {
    const restored = cooldownStore.restore(accountPool);
    if (restored) logger.info(`Khôi phục cooldown cho ${restored} tài khoản`);
  }
  const app = express();
  const metrics = createMetrics();

  // Một dòng log + một điểm dữ liệu `/metrics` cho MỌI request, kể cả request chết yểu
  // trước khi chạm route nào (JSON hỏng, 404). Đây là chỗ duy nhất trả lời được "gateway có
  // đang được gọi không, chậm cỡ nào, lỗi ở đâu" mà không phải tin vào cảm giác — thiếu nó,
  // cách duy nhất để biết pool có đang phục vụ thật hay không là hỏi người dùng đầu cuối.
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    // Chụp `req.path` NGAY BÂY GIỜ, trước khi Express mount bất kỳ middleware con nào:
    // `app.use('/api/chat', mw)` viết đè tạm `req.url` thành phần đuôi sau tiền tố lúc đi
    // vào `mw`, và chỉ phục hồi lại khi `mw` gọi `next()` để đi tiếp — một middleware chặn
    // request tại đó (401 của `requireClientKey`/`requireAdminToken` chẳng hạn) không bao
    // giờ gọi `next()`, nên `req.path` đọc lại lúc `finish` sẽ chỉ còn thấy `"/"`.
    const pathHint = req.path;
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // `req.route.path` chỉ có SAU khi Express khớp được route, và gọn hơn `pathHint` cho
      // route có tham số động; request chết trước đó (lỗi JSON, 401, 404) thì rơi về
      // `pathHint` đã chụp ở trên.
      const route = req.route?.path || pathHint;
      metrics.increment(req.method, route, res.statusCode, durationMs);
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
    });
    next();
  });

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  // JSON hỏng cú pháp thì body-parser ném lỗi ngay trong middleware này — không bắt ở đây
  // thì Express rơi vào error handler mặc định, trả một trang HTML kèm stack trace thay vì
  // JSON `{ error }` như mọi lỗi khác của gateway, và rò cả đường dẫn file trên đĩa ra ngoài.
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
      return res.status(400).json({ error: { message: 'JSON gửi lên không hợp lệ', status: 400 } });
    }
    return next(error);
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.locals.router = router;
  app.locals.pool = accountPool;

  // `/api/chat`, `/v1/chat/completions` và `/mcp` là mặt hàng chính — nơi thật sự tiêu quota
  // của các nhà cung cấp phía sau. Xác thực chỉ BẬT khi có `GATEWAY_API_KEY`/`_KEYS`: mặc
  // định giữ nguyên hành vi cũ (không cần cấu hình gì để chạy `npm start` lần đầu). Nhận
  // nhiều key cùng lúc (dấu phẩy/chấm phẩy/xuống dòng, cú pháp `nhãn=key`) để mỗi client gọi
  // gateway có thể mang một key riêng, thu hồi được từng cái mà không ảnh hưởng client khác.
  const clientKeys = [...parseKeyList(env.GATEWAY_API_KEY), ...parseKeyList(env.GATEWAY_API_KEYS)].map((e) => e.key);
  if (!clientKeys.length) {
    logger.warn('GATEWAY_API_KEY(S) chưa đặt: /api/chat, /v1/chat/completions và /mcp đang mở cho bất kỳ ai gọi tới cổng');
  }
  app.use(['/api/chat', '/v1/chat/completions', '/mcp'], requireClientKey(clientKeys));

  // MCP (Model Context Protocol) trên cùng một cổng: client MCP (Claude Desktop, Claude
  // Code…) trỏ tới `<base_url>/mcp` là dùng được, xoay vòng tài khoản y hệt `/api/chat`.
  app.use('/mcp', createMcpRouter(router, { logger }));

  // `/api/providers/*`, `/api/claude/oauth/*` và `/metrics` không nên mở cho bất kỳ ai gọi
  // tới cổng: nhóm đầu đọc/xóa cooldown, thử API key, mở/đóng phiên đăng nhập subscription;
  // `/metrics` lộ nhịp gọi thật (bao nhiêu request, từ route nào, lỗi bao nhiêu) mà một
  // client bên ngoài không cần biết. Xác thực chỉ BẬT khi có `GATEWAY_ADMIN_TOKEN`.
  if (!env.GATEWAY_ADMIN_TOKEN) {
    logger.warn('GATEWAY_ADMIN_TOKEN chưa đặt: /api/providers/*, /api/claude/oauth/* và /metrics đang mở cho bất kỳ ai gọi tới cổng');
  }
  app.use(['/api/providers', '/api/claude/oauth', '/metrics'], requireAdminToken(env));

  app.get('/metrics', (req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.renderPrometheus());
  });

  /** Lỗi nào cũng ra JSON có `error.message` + `error.status`, không rò stack trace. */
  const fail = (res, error) => {
    const status = error instanceof UpstreamError ? error.statusCode : 500;
    const message = error instanceof UpstreamError ? error.message : 'Lỗi máy chủ nội bộ';
    if (!(error instanceof UpstreamError)) logger.error(`${error.stack || error.message}`);
    return res.status(status).json({ error: { message, status } });
  };

  // ---------- API riêng (web UI) ----------

  app.post('/api/chat', async (req, res) => {
    const { message, history = [], providers: apiKeys = {}, preferredProvider = null } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: { message: 'Nội dung tin nhắn không được trống', status: 400 } });
    }

    try {
      const messages = normalizeMessages([...history, { role: 'user', content: message }]);
      const result = await router.chat(messages, {
        apiKeys,
        preferred: preferredProvider,
        params: normalizeParams(req.body || {})
      });
      return res.json({
        provider: result.provider,
        account: result.account,
        response: result.text,
        tool_calls: result.toolCalls || null,
        usage: result.usage,
        attempts: result.attempts,
        status: router.getAllStatuses()
      });
    } catch (error) {
      if (error instanceof UpstreamError) {
        return res.status(error.statusCode).json({
          error: { message: error.message, status: error.statusCode },
          statuses: router.getAllStatuses()
        });
      }
      return fail(res, error);
    }
  });

  // ---------- Chuẩn OpenAI ----------
  //
  // Có hai endpoint này thì mọi client nói chuẩn OpenAI (SDK openai, LangChain, Cursor,
  // Continue…) cắm thẳng `base_url` vào gateway là chạy, không cần biết bên dưới đang
  // xoay vòng nhiều nhà cung cấp và nhiều tài khoản. Đây là thứ biến gateway từ một web
  // app thành hạ tầng.

  app.post('/v1/chat/completions', async (req, res) => {
    const { messages, model = 'auto', stream = false } = req.body || {};

    let normalized;
    let params;
    let target;
    try {
      normalized = normalizeMessages(messages);
      params = normalizeParams(req.body || {});
      target = resolveModel(model, providers);
    } catch (error) {
      return fail(res, error);
    }

    if (stream) {
      return streamCompletion(req, res, { router, messages: normalized, target, params, logger });
    }

    try {
      const result = await router.chat(normalized, {
        preferred: target.provider,
        model: target.model,
        params
      });
      return res.json({
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.provider,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.toolCalls ? null : result.text,
              ...(result.toolCalls ? { tool_calls: result.toolCalls } : {})
            },
            finish_reason: result.toolCalls ? 'tool_calls' : 'stop'
          }
        ],
        usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    } catch (error) {
      return fail(res, error);
    }
  });

  app.get('/v1/models', (req, res) => {
    const created = Math.floor(Date.now() / 1000);
    res.json({
      object: 'list',
      data: [
        { id: 'auto', object: 'model', created, owned_by: 'ai-gateway' },
        ...Object.values(providers).map((p) => ({
          id: p.name,
          object: 'model',
          created,
          owned_by: p.displayName,
          upstream_model: p.model
        }))
      ]
    });
  });

  // ---------- vận hành ----------

  app.get('/health', (req, res) => {
    const statuses = router.getAllStatuses();
    const providerList = Object.values(statuses);
    const ready = providerList.filter((s) => s.status === 'active').length;
    // Không nhà cung cấp nào sẵn sàng nghĩa là gateway KHÔNG phục vụ được request nào —
    // 200 trong trường hợp đó sẽ khiến bộ cân bằng tải/orchestrator tin gateway đang khỏe
    // trong khi mọi request sẽ ăn lỗi. Chỉ cần còn một nhà dùng được vẫn coi là khỏe: đúng
    // tinh thần xoay vòng của gateway.
    res.status(ready > 0 ? 200 : 503).json({
      service: 'ai-gateway',
      ready,
      total: providerList.length,
      accounts: providerList.reduce((sum, s) => sum + s.accountCount, 0),
      accountsReady: providerList.reduce((sum, s) => sum + s.readyCount, 0)
    });
  });

  app.get('/api/providers/status', (req, res) => {
    let apiKeys = {};
    if (req.query.providers) {
      try {
        apiKeys = JSON.parse(req.query.providers);
      } catch {
        logger.warn('Không đọc được tham số `providers` trên query string');
      }
    }
    router.configureProviders(apiKeys);
    res.json(router.getAllStatuses());
  });

  app.post('/api/providers/test', async (req, res) => {
    const { provider, apiKey } = req.body || {};
    if (!provider || !apiKey) {
      return res.status(400).json({ success: false, message: 'Thiếu tên provider hoặc API key' });
    }
    const p = providers[provider];
    if (!p) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy provider' });
    }
    // Thử được nhiều key một lượt: người dùng dán bốn key vào một ô thì họ muốn biết cả
    // bốn cái, và biết cái NÀO hỏng — chứ không phải một chữ "thất bại" cho cả nhóm.
    const keys = parseKeyList(apiKey);
    if (!keys.length) {
      return res.status(400).json({ success: false, message: 'Không đọc được API key nào' });
    }

    const results = [];
    for (const [i, entry] of keys.entries()) {
      const outcome = await p.testConnection(entry.key);
      results.push({
        label: entry.label || `${provider}#${i + 1}`,
        key: maskKey(entry.key),
        success: outcome.ok,
        message: outcome.message
      });
    }

    const okCount = results.filter((r) => r.success).length;
    return res.json({
      success: okCount > 0,
      okCount,
      total: results.length,
      message: results.length === 1
        ? results[0].message
        : `${okCount}/${results.length} key kết nối được`,
      results
    });
  });

  /** Xóa cooldown thủ công — nhận tên nhà cung cấp hoặc id một tài khoản. */
  app.post('/api/providers/reset', (req, res) => {
    const { provider, account } = req.body || {};
    const target = account || provider || null;
    const reset = router.reset(target);
    if (reset === null) {
      return res.status(404).json({ error: { message: 'Không tìm thấy provider hoặc tài khoản', status: 404 } });
    }
    return res.json({ reset });
  });

  // ---------- đăng nhập tài khoản subscription Claude (máy không có CLI) ----------

  // state -> { verifier, createdAt }. Chỉ sống trong RAM: một lượt đăng nhập kéo dài vài
  // phút, không đáng ghi xuống đĩa, và mất nó khi restart chỉ nghĩa là làm lại từ đầu.
  const pendingLogins = new Map();

  app.post('/api/claude/oauth/start', (req, res) => {
    for (const [state, entry] of pendingLogins) {
      if (Date.now() - entry.createdAt > loginTtlMs) pendingLogins.delete(state);
    }
    const { verifier, challenge, state } = claudeOAuth.createPkce();
    pendingLogins.set(state, { verifier, createdAt: Date.now() });
    res.json({ url: claudeOAuth.buildAuthorizeUrl({ challenge, state }), state });
  });

  app.post('/api/claude/oauth/callback', async (req, res) => {
    const { code, state } = req.body || {};
    const pending = state ? pendingLogins.get(state) : null;
    if (!pending) {
      return res.status(400).json({ error: { message: 'Phiên đăng nhập không tồn tại hoặc đã hết hạn, hãy bắt đầu lại', status: 400 } });
    }

    try {
      const credential = await claudeOAuth.exchangeCode({ rawCode: code, verifier: pending.verifier, expectedState: state });
      claudeOAuth.saveCredential(credential, env);
      pendingLogins.delete(state);
      accountPool.configure();
      logger.info('Đăng nhập tài khoản subscription Claude thành công qua gateway');
      return res.json({ ok: true, expiresAt: credential.expiresAt });
    } catch (error) {
      return fail(res, error);
    }
  });

  app.get('/api/claude/oauth/status', (req, res) => {
    const credential = claudeOAuth.loadCredential(env);
    if (!credential) return res.json({ loggedIn: false });
    return res.json({ loggedIn: !claudeOAuth.isExpired(credential), expiresAt: credential.expiresAt || null });
  });

  app.delete('/api/claude/oauth', (req, res) => {
    claudeOAuth.clearCredential(env);
    accountPool.configure();
    res.json({ ok: true });
  });

  // Làm mới token trước khi hết hạn, chạy nền: `discoverKeys` (đường đồng bộ, chạy lại mỗi
  // request) không thể tự `await` một lượt refresh network, nên phải có ai đó làm việc này
  // ngoài đường request. `unref()` để timer không giữ tiến trình sống khi mọi việc khác đã
  // xong — nó chỉ là bảo trì, không phải việc chính.
  if (backgroundRefresh) {
    const timer = setInterval(() => {
      claudeOAuth.refreshIfNeeded(env).then((refreshed) => {
        if (refreshed) {
          accountPool.configure();
          logger.info('Đã làm mới token subscription Claude (gateway)');
        }
      }).catch((error) => logger.warn(`Làm mới token subscription Claude thất bại: ${error.message}`));
    }, refreshIntervalMs);
    timer.unref();
  }

  return app;
}

/**
 * `model` của client → nhà cung cấp cần ghim và model upstream cần dùng.
 *
 * Ba dạng, vì client OpenAI chỉ có đúng một ô để nói cả hai ý:
 * - `auto` (hoặc tên lạ) → để pool tự xoay.
 * - `groq` → ghim nhà cung cấp, dùng model mặc định của nhà đó.
 * - `groq/llama-3.1-8b-instant` → ghim cả nhà cung cấp lẫn model.
 *
 * Dạng thứ ba là thứ duy nhất cho phép client chọn model thật mà không phải sửa `.env` và
 * khởi động lại gateway — và cũng là cách thoát khi một model bị hãng cho nghỉ hưu.
 */
function resolveModel(model, providers) {
  const raw = String(model || 'auto').trim();
  if (!raw || raw === 'auto') return { provider: null, model: null };

  const slash = raw.indexOf('/');
  if (slash > 0) {
    const name = raw.slice(0, slash);
    if (providers[name]) return { provider: name, model: raw.slice(slash + 1) };
  }
  if (providers[raw]) return { provider: raw, model: null };

  // Tên lạ: để pool tự xoay thay vì trả 404. Nhiều client gửi thẳng tên model của OpenAI
  // ("gpt-4o-mini") vào mọi base_url, và với một gateway xoay vòng thì "chọn giúp tôi" là
  // câu trả lời hữu ích hơn một lỗi.
  return { provider: null, model: null };
}

/**
 * Trả lời `/v1/chat/completions` dạng SSE theo đúng khuôn OpenAI.
 *
 * Có một ranh giới quan trọng ở đây: một khi mẩu đầu tiên đã gửi đi thì header HTTP đã ra
 * khỏi máy, không còn đổi được status code nữa. Lỗi trước mốc đó trả JSON kèm status thật;
 * lỗi sau mốc đó chỉ còn cách báo trong thân stream rồi đóng — im lặng đóng kết nối sẽ
 * hiện ra ở client như một câu trả lời bị cắt cụt mà không có lý do nào.
 */
async function streamCompletion(req, res, { router, messages, target, params, logger }) {
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  let headersSent = false;
  let providerName = null;
  let sawToolCalls = false;

  // Client đóng tab giữa chừng thì ngừng kéo từ upstream — nếu không, gateway vẫn đọc hết
  // câu trả lời và vẫn tiêu quota cho một câu không ai còn đọc.
  //
  // Phải nghe trên `res`, không phải `req`: `express.json()` đã đọc cạn thân request, nên
  // `req` phát 'close' ngay khi body vào hết — dùng nó thì mọi stream đều bị coi là đã ngắt
  // trước cả mẩu đầu tiên và client nhận về một phản hồi rỗng. Trên `res`, 'close' chỉ là
  // ngắt thật khi phản hồi chưa kịp kết thúc.
  const aborted = { value: false };
  res.on('close', () => {
    if (!res.writableEnded) aborted.value = true;
  });

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const chunk = (delta, finishReason = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: providerName || 'auto',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  });

  try {
    const pieces = router.streamChat(messages, {
      preferred: target.provider,
      model: target.model,
      params
    });
    for await (const piece of pieces) {
      if (aborted.value) break;

      if (piece.provider) {
        providerName = piece.provider;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          // Nginx mặc định gom buffer phản hồi proxy, biến stream thành một cục ở cuối.
          'X-Accel-Buffering': 'no'
        });
        headersSent = true;
        send(chunk({ role: 'assistant', content: '' }));
        continue;
      }

      if (piece.text) send(chunk({ content: piece.text }));
      if (piece.toolCalls) {
        send(chunk({ tool_calls: piece.toolCalls.map((tc, index) => ({ index, ...tc })) }));
        sawToolCalls = true;
      }
      if (piece.usage) {
        send({ ...chunk({}), usage: piece.usage });
      }
    }

    if (aborted.value) return res.end();

    send(chunk({}, sawToolCalls ? 'tool_calls' : 'stop'));
    res.write('data: [DONE]\n\n');
    return res.end();
  } catch (error) {
    const status = error instanceof UpstreamError ? error.statusCode : 500;
    const message = error instanceof UpstreamError ? error.message : 'Lỗi máy chủ nội bộ';
    if (!(error instanceof UpstreamError)) logger.error(error.stack || error.message);

    if (!headersSent) {
      return res.status(status).json({ error: { message, status } });
    }
    // Header đã gửi: chỉ còn báo được trong thân stream.
    send({ error: { message, status } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
}

/**
 * Chặn `/api/providers/*` và `/api/claude/oauth/*` sau một token cấu hình qua
 * `GATEWAY_ADMIN_TOKEN`. Không đặt biến này thì middleware là no-op — giữ đúng hành vi
 * trước đây cho ai chưa cần khóa các endpoint này lại.
 *
 * Nhận token qua `Authorization: Bearer <token>` (chuẩn HTTP) hoặc header `X-Admin-Token`
 * (dễ gõ tay hơn khi test bằng curl). So bằng `timingSafeEqual` — so `===` thẳng một chuỗi
 * bí mật để lộ thời gian so sánh tỉ lệ với số ký tự khớp từ đầu, đủ để dò ra token qua đủ
 * nhiều lần thử.
 */
/** So hai chuỗi bằng thời gian không phụ thuộc nội dung — tránh dò bí mật qua độ trễ. */
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function requireAdminToken(env) {
  const token = env.GATEWAY_ADMIN_TOKEN ? String(env.GATEWAY_ADMIN_TOKEN) : '';
  return (req, res, next) => {
    if (!token) return next();

    const header = req.get('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const provided = bearer || req.get('x-admin-token') || '';

    if (!timingSafeStringEqual(provided, token)) {
      return res.status(401).json({
        error: { message: 'Thiếu hoặc sai admin token (GATEWAY_ADMIN_TOKEN)', status: 401 }
      });
    }
    return next();
  };
}

/**
 * Chặn `/api/chat`, `/v1/chat/completions` và `/mcp` sau một trong các key cấu hình qua
 * `GATEWAY_API_KEY`/`GATEWAY_API_KEYS`. Không đặt biến nào thì `validKeys` rỗng và
 * middleware là no-op — giữ đúng hành vi mở như trước cho ai chưa cần khóa lại.
 *
 * Nhiều key hợp lệ (không phải một chuỗi bí mật duy nhất) nên không thể so bằng
 * `timingSafeEqual` một lần với TOÀN BỘ danh sách; so tuần tự từng key vẫn an toàn hơn
 * `===` vì mỗi phép so sánh riêng lẻ không rò thời gian theo nội dung của chính key đó.
 */
function requireClientKey(validKeys) {
  return (req, res, next) => {
    if (!validKeys.length) return next();

    const header = req.get('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const provided = bearer || req.get('x-api-key') || '';

    const match = provided && validKeys.some((key) => timingSafeStringEqual(provided, key));
    if (!match) {
      return res.status(401).json({
        error: { message: 'Thiếu hoặc sai API key của gateway (GATEWAY_API_KEY)', status: 401 }
      });
    }
    return next();
  };
}

module.exports = { createApp, defaultLogger, resolveModel };
