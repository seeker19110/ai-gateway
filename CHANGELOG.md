# Changelog

Ghi lại thay đổi có ý nghĩa với người dùng gateway (không phải lịch sử commit đầy đủ — xem
`git log` cho việc đó). Theo tinh thần [Keep a Changelog](https://keepachangelog.com/), phiên
bản theo [SemVer](https://semver.org/).

## [1.2.0]

### Added
- `GATEWAY_RATE_LIMIT_RPM`: giới hạn số request/phút mà **client** được gọi vào
  `/api/chat`, `/v1/chat/completions`, `/mcp` (tách biệt với cửa sổ RPM đã có sẵn cho
  từng tài khoản upstream). Đếm theo API key (`GATEWAY_API_KEY`) nếu có, hoặc theo IP
  nếu client auth chưa bật. Không đặt biến thì không giới hạn — giữ hành vi cũ.
- CHANGELOG.md (file này).
- ESLint + job `lint` trong CI.
- `HEALTHCHECK` trong Dockerfile, dùng `GET /health`.

## [1.1.0]

### Added
- LICENSE (MIT).
- `GATEWAY_API_KEY`/`GATEWAY_API_KEYS`: khóa `/api/chat`, `/v1/chat/completions`, `/mcp`
  sau một hoặc nhiều key của chính gateway (khác với key của các nhà cung cấp AI).
- `GATEWAY_ADMIN_TOKEN`: khóa `/api/providers/*`, `/api/claude/oauth/*`.
- `GET /metrics`: số request + thời gian xử lý theo method/route/status, khuôn
  Prometheus text.
- Access log: một dòng mỗi request, kể cả request chết yểu trước khi khớp route.
- `Dockerfile` + `.dockerignore`: build multi-stage, chạy bằng user `node`.
- Job `audit` (`npm audit --audit-level=moderate`) chạy trên mỗi PR.

### Changed
- Nâng `express` lên v5, `dotenv` lên v17, `cors` lên v2.8.6 — dọn 3 lỗ hổng moderate
  (`qs`/`body-parser`) mà bản cũ mang theo.
- `GET /health` trả **503** khi không còn nhà cung cấp nào sẵn sàng (trước đây luôn 200).
- JSON gửi lên hỏng cú pháp trả về `{"error"}` JSON gọn, không còn trang lỗi HTML kèm
  stack trace của Express.
- `server.js`: log rõ ràng trước khi thoát khi có `uncaughtException`/`unhandledRejection`;
  đóng listener êm ái khi nhận `SIGTERM`/`SIGINT` thay vì cắt ngang request đang xử lý dở.

## [1.0.0] và trước đó

Giai đoạn trước khi có file này. Các mốc chính, theo thứ tự:

- Gateway xoay vòng nhiều nhà cung cấp AI miễn phí, nói chuẩn OpenAI Chat Completions.
- Thêm OpenRouter, Mistral, Cerebras, Cohere (tổng 8 nhà cung cấp lúc đó).
- Thay lõi failover: phân loại lỗi theo mã HTTP, thêm streaming, lưu cooldown xuống đĩa
  để sống qua restart.
- Đơn vị xoay vòng chuyển từ **nhà cung cấp** sang **tài khoản** (một API key): một key
  hết hạn mức không còn kéo theo cả nhà cung cấp. Đúng chuẩn tham số riêng của từng nhà.
- Hỗ trợ tài khoản subscription Claude Pro/Max (API key thường, token CLI đã đăng nhập,
  hoặc gateway tự đăng nhập qua OAuth PKCE) và một endpoint MCP (`/mcp`) theo đúng
  transport "Streamable HTTP" của spec.
- Tool/function calling cho 8/10 nhà cung cấp.
- Hỗ trợ ảnh (`image_url`) cho 9/10 nhà cung cấp.
