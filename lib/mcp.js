const express = require('express');

const { UpstreamError } = require('./errors');
const { normalizeParams } = require('./params');
const { normalizeMessages } = require('./messages');

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Gateway nói được cả MCP (Model Context Protocol), không chỉ HTTP chuẩn OpenAI.
 *
 * MCP client (Claude Desktop, Claude Code, …) nói chuyện qua JSON-RPC 2.0 trên một endpoint
 * HTTP duy nhất — không cần SDK riêng, bản thân giao thức chỉ là vài phương thức cố định:
 * `initialize`, `tools/list`, `tools/call`. Gateway lộ đúng MỘT tool, `chat`, và tool đó đi
 * qua cùng một `router.chat()` mà `/api/chat` dùng — nghĩa là failover, xoay vòng tài khoản,
 * cooldown áp dụng y hệt cho cả hai đường vào, kể cả tài khoản subscription CLI.
 */
function createMcpRouter(router, { logger } = {}) {
  const app = express.Router();
  app.use(express.json({ limit: '10mb' }));

  app.post('/', async (req, res) => {
    const { id = null, method, params = {} } = req.body || {};

    const reply = (result) => res.json({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'ai-gateway', version: '1.0.0' }
          });

        // Client MCP gửi cái này sau `initialize`, không cần trả gì — im lặng là hợp lệ với
        // một notification (không có `id`), nhưng vài client vẫn chờ HTTP 200 trống.
        case 'notifications/initialized':
          return res.status(202).end();

        case 'tools/list':
          return reply({ tools: [CHAT_TOOL] });

        case 'tools/call':
          return reply(await callTool(router, params));

        default:
          return fail(-32601, `Không hỗ trợ phương thức: ${method}`);
      }
    } catch (error) {
      if (error instanceof UpstreamError) {
        // Lỗi upstream (hết quota, key hỏng...) là kết quả tool bình thường theo MCP —
        // trả `isError: true` trong result, KHÔNG phải lỗi JSON-RPC tầng giao thức.
        return reply({ content: [{ type: 'text', text: error.message }], isError: true });
      }
      logger?.error?.(error.stack || error.message);
      return fail(-32603, 'Lỗi máy chủ nội bộ');
    }
  });

  return app;
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
