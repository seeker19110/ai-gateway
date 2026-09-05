const crypto = require('crypto');

const express = require('express');

const { UpstreamError } = require('./errors');
const { normalizeParams } = require('./params');
const { normalizeMessages } = require('./messages');

const PROTOCOL_VERSION = '2024-11-05';
const SESSION_HEADER = 'mcp-session-id';

/**
 * Gateway nói được cả MCP (Model Context Protocol) qua transport chuẩn "Streamable HTTP",
 * không chỉ HTTP thường chuẩn OpenAI.
 *
 * Ba việc mà transport này đòi hỏi, ngoài JSON-RPC 2.0 (`initialize`, `tools/list`,
 * `tools/call`) mà bản trước đã có:
 *
 * 1. **Phiên (session)** — `initialize` cấp một `Mcp-Session-Id`; mọi request sau đó của
 *    cùng client phải mang lại đúng header đó. Thiếu nó thì không phân biệt được hai client
 *    đang gọi xen kẽ cùng một tiến trình server, dù ở gateway này chưa có state nào thật sự
 *    gắn theo phiên (tool `chat` không giữ ngữ cảnh) — vẫn phải cấp và kiểm để client
 *    nghiêm theo spec (Claude Desktop, SDK chính chủ) không bị từ chối kết nối.
 * 2. **SSE khi client đòi** — client gửi `Accept: text/event-stream` (không có
 *    `application/json`) nghĩa là nó chỉ chấp nhận stream, không chấp nhận JSON thường.
 *    Vì gateway không có sự kiện đẩy từ server (không resources/prompts), một phiên SSE chỉ
 *    cần mang đúng MỘT sự kiện — kết quả JSON-RPC — rồi đóng, không phải giữ kết nối sống.
 * 3. **GET/DELETE trên cùng endpoint** — GET là kênh server-initiated message mà gateway
 *    không có gì để đẩy nên trả 405 (spec cho phép); DELETE là client chủ động đóng phiên.
 */
function createMcpRouter(router, { logger, sessionTtlMs = 24 * 60 * 60_000 } = {}) {
  const app = express.Router();
  app.use(express.json({ limit: '10mb' }));

  // sessionId -> { lastSeenAt }. Sống theo tiến trình: một phiên không cần bền qua restart,
  // MCP client tự `initialize` lại khi nhận 404.
  //
  // PHẢI dọn định kỳ: phần lớn client MCP không bao giờ gọi DELETE khi đóng kết nối (tab bị
  // đóng, tiến trình bị kill, mất mạng...) — không dọn thì mỗi phiên bỏ lại là một entry sống
  // mãi, và một server chạy dài ngày phục vụ nhiều client sẽ rò rỉ bộ nhớ không giới hạn.
  const sessions = new Map();

  function pruneSessions(now = Date.now()) {
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeenAt > sessionTtlMs) sessions.delete(id);
    }
  }

  app.post('/', async (req, res) => {
    const body = req.body || {};
    const isInitialize = body.method === 'initialize';
    pruneSessions();

    if (!isInitialize) {
      const sessionId = req.get(SESSION_HEADER);
      // Chưa từng `initialize`: client sai thứ tự, đúng theo spec là 400 chứ không phải
      // âm thầm chấp nhận — nếu chấp nhận thì một client quên `initialize` sẽ ăn lỗi khó hiểu
      // ở tận `tools/call` thay vì ngay từ request đầu.
      if (!sessionId) return res.status(400).json(rpcError(body.id, -32000, 'Thiếu header Mcp-Session-Id: phải gọi "initialize" trước'));
      // Có header nhưng phiên không tồn tại (server restart, hết TTL, hoặc phiên đã bị đóng
      // bằng DELETE): 404 để client tự tạo phiên mới, đúng hành vi spec yêu cầu.
      const session = sessions.get(sessionId);
      if (!session) return res.status(404).json(rpcError(body.id, -32001, 'Phiên không tồn tại hoặc đã hết hạn'));
      session.lastSeenAt = Date.now();
    }

    const { id = null, method, params = {} } = body;
    const wantsJson = acceptsJson(req);

    const send = (payload) => {
      if (wantsJson) return res.json(payload);
      // Client chỉ chấp nhận SSE: một sự kiện duy nhất rồi đóng stream — không có gì để
      // đẩy thêm sau kết quả của một lệnh gọi đồng bộ.
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return res.end();
    };

    try {
      switch (method) {
        case 'initialize': {
          const sessionId = crypto.randomUUID();
          sessions.set(sessionId, { lastSeenAt: Date.now() });
          res.set(SESSION_HEADER, sessionId);
          return send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'ai-gateway', version: '1.0.0' }
            }
          });
        }

        // Client MCP gửi cái này sau `initialize`, không cần trả gì — im lặng là hợp lệ với
        // một notification (không có `id`), nhưng vài client vẫn chờ HTTP 200 trống.
        case 'notifications/initialized':
          return res.status(202).end();

        case 'tools/list':
          return send({ jsonrpc: '2.0', id, result: { tools: [CHAT_TOOL] } });

        case 'tools/call':
          return send({ jsonrpc: '2.0', id, result: await callTool(router, params) });

        default:
          return send(rpcError(id, -32601, `Không hỗ trợ phương thức: ${method}`));
      }
    } catch (error) {
      if (error instanceof UpstreamError) {
        // Lỗi upstream (hết quota, key hỏng...) là kết quả tool bình thường theo MCP —
        // trả `isError: true` trong result, KHÔNG phải lỗi JSON-RPC tầng giao thức.
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error.message }], isError: true } });
      }
      logger?.error?.(error.stack || error.message);
      return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Lỗi máy chủ nội bộ' } });
    }
  });

  // Không có sự kiện nào server tự đẩy (không resources/prompts subscription) nên không mở
  // kênh SSE dài hạn — 405 là phản hồi hợp lệ theo spec khi server không hỗ trợ chiều này.
  app.get('/', (req, res) => res.set('Allow', 'POST, DELETE').status(405).end());

  app.delete('/', (req, res) => {
    const sessionId = req.get(SESSION_HEADER);
    if (!sessionId || !sessions.has(sessionId)) return res.status(404).end();
    sessions.delete(sessionId);
    return res.status(200).end();
  });

  return app;
}

/** `Accept` không nhắc gì tới SSE, hoặc có luôn cả JSON: đi đường JSON thường, đơn giản nhất. */
function acceptsJson(req) {
  const accept = String(req.get('accept') || '');
  if (!accept) return true;
  return accept.includes('application/json') || !accept.includes('text/event-stream');
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const CHAT_TOOL = {
  name: 'chat',
  description:
    'Gửi một tin nhắn tới AI gateway; gateway tự chọn nhà cung cấp/tài khoản còn hạn mức và xoay vòng khi cần.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Nội dung tin nhắn của người dùng' },
      provider: { type: 'string', description: 'Ưu tiên một nhà cung cấp cụ thể (tuỳ chọn)' },
      history: {
        type: 'array',
        description: 'Lịch sử hội thoại trước đó (tuỳ chọn)',
        items: {
          type: 'object',
          properties: { role: { type: 'string' }, content: { type: 'string' } }
        }
      }
    },
    required: ['message']
  }
};

async function callTool(router, { name, arguments: args = {} } = {}) {
  if (name !== 'chat') {
    return { content: [{ type: 'text', text: `Không có tool tên "${name}"` }], isError: true };
  }

  const { message, history = [], provider = null } = args;
  if (!message || typeof message !== 'string') {
    return { content: [{ type: 'text', text: 'Thiếu "message" hoặc không phải chuỗi' }], isError: true };
  }

  const messages = normalizeMessages([...history, { role: 'user', content: message }]);
  const result = await router.chat(messages, {
    preferred: provider,
    params: normalizeParams({})
  });

  return { content: [{ type: 'text', text: result.text }] };
}

module.exports = { createMcpRouter, CHAT_TOOL };
