require('dotenv').config();

const { createApp } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Một lỗi không bắt được trong một request (promise quên `.catch`, TypeError ở đâu đó
// ngoài `try/catch` của app.js) mặc định làm Node thoát ngay lập tức không log gì rõ ràng
// — cả gateway sập vì một request, không ai biết vì sao. Ghi log trước khi thoát để lần
// khởi động lại sau còn có dấu vết mà tra; vẫn thoát vì tiến trình đã ở trạng thái không
// chắc chắn, và một process manager (systemd, Docker, pm2) sẽ khởi động lại nó.
process.on('uncaughtException', (error) => {
  console.error(`[${new Date().toISOString()}] ERROR Lỗi không bắt được, gateway sẽ thoát: ${error.stack || error}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] ERROR Promise bị từ chối không ai bắt: ${reason?.stack || reason}`);
  process.exit(1);
});

const server = createApp({ backgroundRefresh: true }).listen(PORT, HOST, () => {
  console.log(`AI Gateway đang chạy tại http://${HOST}:${PORT}`);
  console.log(`  API riêng:     POST /api/chat`);
  console.log(`  Chuẩn OpenAI:  POST /v1/chat/completions   GET /v1/models`);
});

// Đóng listener trước khi thoát khi orchestrator (Docker, k8s, systemd) gửi tín hiệu dừng —
// không làm vậy thì request đang xử lý dở bị cắt ngang giữa chừng thay vì được trả lời.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[${new Date().toISOString()}] INFO  Nhận ${signal}, đang đóng gateway...`);
    server.close(() => process.exit(0));
  });
}
