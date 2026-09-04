const express = require('express');
const cors = require('cors');
const path = require('path');

const SmartRouter = require('./router');
const { createProviders } = require('./providers');
const { UpstreamError } = require('./errors');
const { CooldownStore } = require('./store');

/** Log có mốc thời gian; test tiêm logger im lặng để output không lẫn. */
const defaultLogger = {
  info: (msg) => console.log(`[${new Date().toISOString()}] INFO  ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] WARN  ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ERROR ${msg}`)
};

function createApp({ providers = createProviders(), logger = defaultLogger, store } = {}) {
  // `store: null` để tắt hẳn (test dùng), bỏ trống thì dùng file mặc định.
  const cooldownStore = store === undefined ? new CooldownStore() : store;
  const router = new SmartRouter(providers, { logger, store: cooldownStore });

  if (cooldownStore) {
    const restored = cooldownStore.restore(providers);
    if (restored) logger.info(`Khôi phục cooldown cho ${restored} nhà cung cấp`);
  }
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.locals.router = router;

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
      const result = await router.chat([...history, { role: 'user', content: message }], {
        apiKeys,
        preferred: preferredProvider
      });
      return res.json({
        provider: result.provider,
        response: result.text,
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
  // xoay vòng 10 nhà cung cấp. Đây là thứ biến gateway từ một web app thành hạ tầng.

  app.post('/v1/chat/completions', async (req, res) => {
    const { messages, model = 'auto', stream = false } = req.body || {};

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: { message: '`messages` phải là mảng không rỗng', status: 400 } });
    }
    // `model` được dùng làm gợi ý chọn nhà cung cấp: tên nhà cung cấp thì ghim vào đó,
    // `auto` (hoặc tên lạ) thì để pool tự xoay.
    const preferred = Object.keys(providers).includes(model) ? model : null;

    if (stream) return streamCompletion(req, res, { router, messages, preferred, logger });

    try {
      const result = await router.chat(messages, { preferred });
      return res.json({
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.provider,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.text },
            finish_reason: 'stop'
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
    const ready = Object.values(statuses).filter((s) => s.status === 'active').length;
    res.json({ service: 'ai-gateway', ready, total: Object.keys(statuses).length });
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
    const ok = await p.testConnection(apiKey);
    return res.json({
      success: ok,
      message: ok ? 'Kết nối thành công!' : p.lastError || 'Kết nối thất bại'
    });
  });

  /** Xóa cooldown thủ công — tương đương `python -m gateway reset` của bản Python. */
  app.post('/api/providers/reset', (req, res) => {
    const { provider } = req.body || {};
    if (!provider) {
      router.resetAll();
      return res.json({ reset: Object.keys(providers) });
    }
    if (!router.resetProvider(provider)) {
      return res.status(404).json({ error: { message: 'Không tìm thấy provider', status: 404 } });
    }
    return res.json({ reset: [provider] });
  });

  return app;
}

/**
 * Trả lời `/v1/chat/completions` dạng SSE theo đúng khuôn OpenAI.
 *
 * Có một ranh giới quan trọng ở đây: một khi mẩu đầu tiên đã gửi đi thì header HTTP đã ra
 * khỏi máy, không còn đổi được status code nữa. Lỗi trước mốc đó trả JSON kèm status thật;
 * lỗi sau mốc đó chỉ còn cách báo trong thân stream rồi đóng — im lặng đóng kết nối sẽ
 * hiện ra ở client như một câu trả lời bị cắt cụt mà không có lý do nào.
 */
async function streamCompletion(req, res, { router, messages, preferred, logger }) {
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  let headersSent = false;
  let providerName = null;

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
    for await (const piece of router.streamChat(messages, { preferred })) {
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
      if (piece.usage) {
        send({ ...chunk({}), usage: piece.usage });
      }
    }

    if (aborted.value) return res.end();

    send(chunk({}, 'stop'));
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

module.exports = { createApp, defaultLogger };
