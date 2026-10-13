# Gợi ý nâng cấp — rà soát 2026-10-13

> Lấy từ đợt rà soát chéo 19 repo của chủ sở hữu (ma trận vệ sinh ở [seeker19110/stored, mục 23 §8.1](https://github.com/seeker19110/stored/blob/main/23-own-repos-lessons/README.md); gợi ý tích hợp ở §7b của cùng file). Số liệu đo bằng lệnh trên HEAD (đếm `uses:` ghim SHA 40 ký tự, khối `permissions:`, `dependabot.yml`, `.claude/settings.json`), không suy ra từ văn xuôi. Đây là **đề xuất**, chưa sửa code. Mỗi mục kèm bằng chứng để kiểm lại trước khi làm; mục nào đã xử lý thì đánh dấu hoặc xoá.

## Hiện trạng đo được

| HEAD đọc | Action ghim SHA | Workflow thiếu `permissions:` cấp đầu | Dependabot | LICENSE · SECURITY | File test |
|---|---|---|---|---|---|
| `36edbef` (2026-09-05) | 0/6 | `ci.yml` | **không có** | có · không | 14 |

## Đề xuất (🔴 cao · 🟠 trung bình · 🟢 nhẹ)

| # | Mức | Đề xuất | Bằng chứng | Kiểm xong khi |
|---|---|---|---|---|
| 1 | 🔴 | **Đổi sang fail-closed**: mặc định `HOST=127.0.0.1`; khi bind ra ngoài loopback mà thiếu `GATEWAY_API_KEY(S)` hoặc `GATEWAY_ADMIN_TOKEN` thì **từ chối khởi động**, thay vì chỉ `logger.warn` | `server.js:6` mặc định `0.0.0.0`; `lib/app.js:94` và `:118` chỉ cảnh báo, nên `/v1/chat/completions`, `/api/chat`, `/mcp`, `/api/providers/*`, `/api/claude/oauth/*` và `/metrics` mở cho bất kỳ ai gọi tới cổng. Gateway giữ API key và token OAuth subscription, nên mở ra là lộ quota và token | Test: khởi động với `HOST=0.0.0.0` mà không có token thì process thoát mã ≠ 0; với `HOST=127.0.0.1` thì vẫn chạy được như cũ |
| 2 | 🟠 | Nâng `engines.node` từ `>=18` lên `>=22` cho khớp Dockerfile | `package.json` ghi `"node": ">=18"` (Node 18 hết hỗ trợ từ 4/2025), còn `Dockerfile` dùng `node:22-alpine` | `npm ci` trên Node 22 xanh |
| 3 | 🟠 | Ghim 6 action theo SHA, thêm `permissions: contents: read` cho `ci.yml`, thêm `.github/dependabot.yml` (npm, github-actions, docker) và `SECURITY.md` | Ghim 0/6; `ci.yml` không có `permissions:`; repo không có Dependabot và không có SECURITY.md | Grep `uses:` không ghim trả về 0 |
| 4 | 🟢 | Ghi rõ rủi ro điều khoản dịch vụ khi dùng token subscription (`sk-ant-oat…`) qua gateway, giống cách Plugin-4-Hermes ghi "vùng xám ToS" | README mục "Tài khoản subscription" mô tả cách gửi token subscription kèm system prompt tự xưng "Claude Code" | README có cảnh báo rõ ràng |

## Giữ nguyên (điểm mạnh)

- Đơn vị xoay vòng là tài khoản chứ không phải nhà cung cấp; bảng lỗi → cooldown; so token bằng `timingSafeEqual`; rate limit cho client.

## Gợi ý tích hợp từ catalog `stored`

- Đối chiếu với LiteLLM (fallback tier, bảng lỗi) (stored mục 10 §6); thêm OWASP LLM Top 10 và guardrails ở biên (mục 12 §1–§2); benchmark định tuyến bằng promptfoo (mục 07).
- Mẫu lớp biên mạng tốt ngay trong hệ của bạn: `donghanhcungban/hermes-agents/bridge/http_security.py` (kiểm loopback, Host, `hmac.compare_digest`, giới hạn body và số request đồng thời).

## Ghi chú chung

- Ghim action theo SHA bằng [pinact](https://github.com/suzuki-shunsuke/pinact) hoặc [ratchet](https://github.com/sethvargo/ratchet), giữ comment tag (`# v7.0.1`), rồi để Dependabot `github-actions` tự nâng SHA. Đây là cách projects-template, xboss và Sales-Hunter đang làm.
- Chuẩn tham chiếu là `seeker19110/projects-template`: 25/25 action ghim SHA, mọi workflow có `permissions:` cấp đầu, Dependabot cho npm, github-actions và pip.
