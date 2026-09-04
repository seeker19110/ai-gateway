require('dotenv').config();

const { createApp } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

createApp().listen(PORT, HOST, () => {
  console.log(`AI Gateway đang chạy tại http://${HOST}:${PORT}`);
  console.log(`  API riêng:     POST /api/chat`);
  console.log(`  Chuẩn OpenAI:  POST /v1/chat/completions   GET /v1/models`);
});
