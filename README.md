# ai-gateway — xoay vòng nhiều nhà cung cấp AI

Gateway nhận request, chọn một trong 10 nhà cung cấp AI và tự xoay sang nhà khác khi nhà
đang dùng hết quota, hỏng, hoặc không trả lời. Có sẵn web UI, và nói **chuẩn OpenAI Chat
Completions** nên mọi client OpenAI cắm thẳng `base_url` vào là chạy.

Nhà cung cấp: Gemini, Groq, OpenAI, Claude, OpenRouter, Mistral, Cerebras, Cohere, DeepSeek, Together.

## Cơ chế xoay vòng

| Tình huống upstream | Gateway làm gì |
|---|---|
| 401 / 402 / 403 / 429, hoặc body có `quota`, `rate limit`, `RESOURCE_EXHAUSTED`… | Ghi cooldown cho nhà đó (tôn trọng `Retry-After`) → nhà kế |
| 5xx | Sang nhà kế, **không** cooldown (lỗi phía họ, thường qua nhanh) |
| Lỗi mạng (timeout, DNS, socket đứt) | Bỏ qua nhà đó **lượt này**, **không** cooldown |
| 4xx khác (payload hỏng, model sai tên) | Trả lỗi ngay, **không** xoay |
| Mọi nhà đều cooldown | Trả **429** kèm "thử lại sau khoảng Ns" để lớp trên biết nghỉ bao lâu |
| Chưa cấu hình API key nào | Trả **503** nói rõ là thiếu key, không lẫn với hết quota |

Cooldown mặc định (`lib/failover.js`): 401 → 300s; 402/403/429 → 3600s; mã khác → 60s.
`Retry-After` của upstream luôn ghi đè — upstream biết rõ hơn ta khi nào nó sẵn sàng trở lại.

Ba phân biệt ở trên là toàn bộ giá trị của bảng này:

- **Lỗi mạng ≠ upstream từ chối.** Một nhịp mạng chập chờn không được làm nguội cả pool.
- **5xx ≠ hết quota.** Lỗi phía họ thường qua trong vài giây; cho nghỉ 1 giờ là tự cắt tay mình.
- **4xx của người gọi ≠ lỗi nhà cung cấp.** Payload hỏng thì nhà nào cũng từ chối y hệt;
  xoay vòng chỉ đốt quota và làm chậm câu trả lời cho một lỗi mà người gọi phải tự sửa.

### Thứ tự chọn nhà cung cấp

Pool sắp lại theo **LRU** trước mỗi lượt: nhà lâu chưa dùng nhất đi trước. `preferredProvider`
(hoặc `model` ở endpoint OpenAI) được đẩy lên đầu; nếu nhà đó đang cooldown thì rơi về pool
chứ không lỗi.

LRU thay cho con trỏ round-robin: con trỏ đó nhích ngay cả khi nhà cung cấp bị bỏ qua, nên
thứ tự trôi theo *số lần gọi* chứ không theo *ai vừa phục vụ*.

### Lượt nào đi nhà nào

Mỗi lượt thành công ghi một dòng log kèm vị trí trong danh sách ứng viên của lượt đó:

```
WARN  gemini trả 429, cho nghỉ 3600s và xoay sang nhà kế
WARN  groq lỗi mạng (bỏ qua lượt này, không cooldown): ECONNRESET
INFO  mistral phục vụ thành công (lần thử 3/10)
```

Đây là chỗ duy nhất **kiểm chứng** được việc xoay vòng thay vì phải tin: thiếu nó thì mọi
lượt thành công trông giống hệt nhau, kể cả khi pool đã kẹt vào đúng một nhà cung cấp.

`lần thử i/n` là vị trí trong danh sách ứng viên **của lượt đó**, không phải số thứ tự cố
định của nhà cung cấp: pool sắp lại theo LRU trước mỗi lượt, nên lượt trơn tru luôn là `1/n`,
còn `2/n` trở lên nghĩa là đã phải bỏ qua ai đó.

Phản hồi của `/api/chat` cũng kèm mảng `attempts` mô tả đúng đường đi đó cho từng lượt gọi.

## Dùng nhanh

```bash
npm install
cp .env.example .env     # điền API key nào có; nhà không có key thì tự động nằm ngoài pool
npm start                # http://localhost:3000
npm test                 # không gọi mạng: fetch được stub
```

Không cần điền đủ 10 key. Nhà cung cấp nào không có key thì ở trạng thái `inactive` và
không bao giờ được chọn.

## Endpoint

| Method | Path | |
|---|---|---|
| POST | `/v1/chat/completions` | Chuẩn OpenAI, có `stream: true`. `model` là tên nhà cung cấp để ghim, hoặc `auto` để pool tự xoay |
| GET | `/v1/models` | `auto` + danh sách nhà cung cấp |
| POST | `/api/chat` | API riêng của web UI; trả kèm `provider`, `usage`, `attempts`, `status` |
| GET | `/api/providers/status` | Trạng thái pool: cooldown còn lại, số request trong cửa sổ, lỗi cuối |
| POST | `/api/providers/test` | Thử một API key |
| POST | `/api/providers/reset` | Xóa cooldown (`{"provider":"groq"}`, hoặc body rỗng để xóa tất cả) |
| GET | `/health` | `{service, ready, total}` |

Cắm client OpenAI vào:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3000/v1", api_key="không-dùng-tới")
client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "chào"}])
```

`api_key` phía client không được dùng tới — gateway tự xác thực với các nhà cung cấp bằng
key trong `.env`. Vì vậy **đừng mở gateway ra internet**: ai gọi được cũng tiêu quota của bạn.

### Stream

`stream: true` trả SSE đúng khuôn OpenAI (`chat.completion.chunk`, kết bằng `data: [DONE]`).

Xoay vòng chỉ diễn ra **trước mẩu đầu tiên**. Sau mốc đó, đổi nhà cung cấp sẽ nối phần đầu
của nhà này với phần giữa của nhà kia thành một câu trả lời không ai từng viết — hỏng theo
kiểu không báo lỗi và không nhìn ra được. Nên lỗi giữa stream được báo trong thân stream rồi
đóng, chứ không âm thầm chuyển nhà.

Cùng ranh giới đó quyết định cách báo lỗi: trước mẩu đầu, header chưa gửi nên vẫn trả được
status HTTP thật (400, 429…); sau mẩu đầu thì chỉ còn báo được bằng một mẩu `{"error":…}`
trong thân.

## Cấu trúc

```
lib/failover.js    phân loại lỗi → xoay hay không, cooldown bao lâu
lib/errors.js      UpstreamError mang mã HTTP thật + cắt gọn thông điệp lỗi
lib/router.js      pool, LRU, vòng failover (chat + streamChat)
lib/sse.js         đọc Server-Sent Events, dùng chung cho cả 4 định dạng stream
lib/store.js       lưu cooldown xuống đĩa để sống qua restart
lib/providers.js   dựng 10 nhà cung cấp
lib/app.js         express app (test dựng app riêng, không đụng cổng thật)
providers/base.js  gọi HTTP, chuẩn hóa lỗi, thân chung cho nhà cung cấp chuẩn OpenAI
server.js          chỉ mở cổng
```

Provider chỉ làm hai việc: gọi upstream, và ném `UpstreamError` mang mã HTTP thật. Provider
**không** tự quyết định cooldown — đó là việc của router, nơi duy nhất nhìn thấy cả pool.

### Lưu cooldown

Cooldown được ghi xuống `~/.ai-gateway/cooldowns.json` (đổi bằng `GATEWAY_STATE_FILE`) và nạp
lại lúc khởi động — chỉ những cooldown còn hiệu lực. Không có phần này thì restart là xóa
sạch cooldown và gateway lại bắn thẳng vào nhà vừa hết quota, ăn 429 ngay lượt đầu.

Ghi nguyên tử (file tạm rồi `rename`), quyền `600`, và **chỉ chứa cooldown — không chứa API
key**. Không ghi được đĩa chỉ là mất một tiện ích, không làm hỏng request đang phục vụ được.

## Giới hạn đã biết

- **Cửa sổ RPM là bộ đếm 60 giây**, xấp xỉ chứ không phải rate limit thật của nhà cung cấp;
  nó chỉ giảm bớt số lần ăn 429, không thay thế được cooldown.
- **Nhiều tiến trình dùng chung file cooldown là "cố gắng hết sức", không phải khóa.** File
  được ghi nguyên tử nên không bao giờ đọc phải JSON cụt, nhưng hai tiến trình cùng ghi thì
  bên ghi sau thắng, và cooldown chỉ được đọc lại lúc khởi động — nên trong một phiên chạy,
  tiến trình này vẫn không thấy nhà cung cấp mà tiến trình kia vừa cho nghỉ. Chạy nặng nhiều
  tiến trình thì nên chia mỗi tiến trình một tập key riêng.
