# ai-gateway — xoay vòng nhiều nhà cung cấp AI, nhiều tài khoản

Gateway nhận request, chọn một trong các **tài khoản** (API key) đang có và tự xoay sang
tài khoản khác khi cái đang dùng hết quota, hỏng, hoặc không trả lời. Có sẵn web UI, và nói
**chuẩn OpenAI Chat Completions** nên mọi client OpenAI cắm thẳng `base_url` vào là chạy.

Nhà cung cấp: Gemini, Groq, OpenAI, Claude, OpenRouter, Mistral, Cerebras, Cohere, DeepSeek, Together.

## Đơn vị xoay vòng là tài khoản, không phải nhà cung cấp

Hạn mức được cấp cho từng **API key**, không cho cả hãng. Nên sức khỏe cũng phải đo trên
từng key: một key Gemini hết hạn mức phút không nói gì về key Gemini thứ hai của một dự án
khác. Gộp chung nghĩa là một key hết quota làm chết cả nhà cung cấp — đúng thứ mà nhiều tài
khoản sinh ra để tránh.

Cooldown, cửa sổ RPM, dấu LRU, số lượt thành công/thất bại đều nằm ở tài khoản. Nhà cung
cấp chỉ còn là bộ chuyển ngữ: biết nói chuyện với upstream nào, theo phương ngữ nào.

### Tài khoản subscription (Claude Pro/Max)

`CLAUDE_API_KEY(S)` nhận cả API key Console (`sk-ant-api...`) lẫn token OAuth của tài khoản
subscription (`sk-ant-oat...`, lấy từ đăng nhập Claude Code/claude.ai). Gateway tự nhận diện
theo tiền tố: token subscription được gửi bằng `Authorization: Bearer` kèm header
`anthropic-beta: oauth-2025-04-20` và system prompt tự xưng "Claude Code" — đúng thứ
Anthropic đòi hỏi ở loại token này — thay vì `x-api-key` như API key thường. Không cần khai
báo gì thêm, cứ dán token vào chung danh sách key là dùng được.

Tiện hơn nữa: nếu máy chạy gateway đã `claude login` (Claude Code CLI) bằng tài khoản
subscription, gateway tự đọc token từ `~/.claude/.credentials.json` (hay
`$CLAUDE_CONFIG_DIR/.credentials.json`) và thêm nó vào pool dưới nhãn `claude-cli` — không
cần copy tay, không cần biến môi trường nào. Token hết hạn thì gateway lặng lẽ bỏ qua, y như
chưa đăng nhập.

**Máy không có Claude Code CLI?** Gateway tự đăng nhập được, đi đúng luồng OAuth (PKCE) mà
bản thân CLI dùng — không cần cài thêm gì:

1. Mở web UI → **Cài đặt API** → mục Anthropic Claude → **Đăng nhập bằng tài khoản Claude**.
   Gateway mở một tab tới trang đăng nhập của Anthropic.
2. Đăng nhập xong, Anthropic hiện một mã trên trang (dạng `code#state`) — copy và dán lại
   vào ô mà gateway hỏi. (Anthropic chỉ khai báo sẵn `console.anthropic.com` làm nơi nhận
   redirect, gateway không tự host được URL riêng, nên đây là bước thủ công duy nhất.)
3. Token được lưu ở `~/.ai-gateway/claude-subscription.json` (0600, cùng thư mục với
   cooldown), gateway tự làm mới token này mỗi 5 phút trước khi nó hết hạn — miễn là còn
   `refresh_token`, không cần đăng nhập lại.

Ba nguồn tài khoản subscription cho Claude — API key thường, token CLI đã đăng nhập sẵn,
token gateway tự đăng nhập — chỉ lấy ĐÚNG MỘT nguồn subscription mỗi lượt cấu hình (CLI có
trước thì ưu tiên CLI) để không đếm trùng cùng một tài khoản.

Endpoint tương ứng: `POST /api/claude/oauth/start`, `POST /api/claude/oauth/callback`,
`GET /api/claude/oauth/status`, `DELETE /api/claude/oauth` (đăng xuất).

### Dạng proxy MCP

Gateway lộ thêm một endpoint MCP (Model Context Protocol) tại `/mcp`, nói đúng transport
"Streamable HTTP" của spec — không chỉ JSON-RPC trần:

- `initialize` cấp một phiên qua header `Mcp-Session-Id`; mọi request sau đó phải mang lại
  đúng header này (thiếu → 400, sai/hết hạn → 404 để client tự `initialize` lại).
- Phản hồi theo `Accept` của client: `application/json` thì trả JSON thường, còn nếu client
  chỉ nhận `text/event-stream` thì gateway trả một sự kiện SSE rồi đóng — không giữ kết nối
  sống vì không có gì để đẩy thêm.
- `GET /mcp` trả 405 (không có server-initiated message nào để mở kênh), `DELETE /mcp` đóng
  phiên chủ động.

Client MCP (Claude Desktop, Claude Code…) trỏ tới `<base_url>/mcp` là gọi được tool `chat`,
đi xuyên qua đúng `router.chat()` mà `/api/chat` dùng: failover, xoay vòng tài khoản, cooldown
và tài khoản subscription CLI ở trên đều áp dụng y hệt.

### Khai báo nhiều key

Ba cách, dùng cách nào cũng được và trộn lẫn cũng được:

```bash
GEMINI_API_KEY=AIza...                    # một key (cấu hình cũ chạy tiếp, không cần sửa gì)
GEMINI_API_KEYS=AIza...,AIza...           # danh sách: phẩy, chấm phẩy hoặc xuống dòng
GEMINI_API_KEY_2=AIza...                  # mỗi key một biến (Docker/K8s secret gắn rời từng cái)
GEMINI_API_KEYS=ca-nhan=AIza...,cong-ty=AIza...   # đặt tên cho tài khoản
```

Ba dạng cùng tồn tại vì ba cách triển khai đều phổ biến và không cách nào thay được cả hai
cách kia. Key trùng nhau bị loại theo dấu vân tay: dán nhầm cùng một key vào hai biến là
chuyện thường, và nếu không loại thì pool tưởng có hai tài khoản, chia đôi lưu lượng vào
cùng một hạn mức rồi ăn 429 sớm gấp đôi.

Web UI cũng nhận nhiều key: mỗi khóa một dòng trong ô của nhà cung cấp đó.

### Thứ tự chọn

Hai bước, giải hai bài toán khác nhau:

1. **LRU** quyết định ai đi **đầu**, tức là lưu lượng chia thế nào. Mặc định
   (`GATEWAY_ROTATION=account`) tài khoản lâu chưa dùng nhất đi trước, nên nhà có 5 key nhận
   khoảng 5 phần còn nhà có 1 key nhận 1 phần — đúng bằng tỉ lệ hạn mức thật sự có.
   Đặt `GATEWAY_ROTATION=provider` để chia đều theo nhà cung cấp, bất kể mỗi nhà mấy key.
2. **Xen kẽ theo nhà cung cấp** quyết định thứ tự **phần còn lại**, tức là đường thoát khi
   ứng viên đầu hỏng. Theo LRU thuần thì 5 key Gemini nằm liền nhau, và một sự cố ở phía
   Gemini (mất mạng tới họ, quota tính theo dự án chứ không theo key, model bị gỡ) sẽ đốt cả
   5 lần thử trước khi chạm tới nhà thứ hai. Xen kẽ làm ứng viên kế tiếp luôn là một nhà
   cung cấp khác, mà vẫn giữ nguyên ứng viên đầu.

`preferredProvider` (hoặc `model` ở endpoint OpenAI) được đẩy lên đầu; nếu mọi key của nhà
đó đang cooldown thì rơi về pool chứ không lỗi.

`GATEWAY_MAX_ATTEMPTS` (mặc định: không giới hạn) đặt trần số lần thử cho một request. Với
mười nhà cung cấp và vài key mỗi nhà, một lượt xui có thể đi qua ba chục upstream trước khi
bỏ cuộc — và người gọi đã bỏ đi từ lâu trước đó.

## Cơ chế xoay vòng

| Tình huống upstream | Gateway làm gì |
|---|---|
| 401 / 402 / 403 / 429, hoặc body có `quota`, `rate limit`, `RESOURCE_EXHAUSTED`… | Ghi cooldown cho **tài khoản đó** (tôn trọng `Retry-After`) → ứng viên kế |
| 5xx | Sang ứng viên kế, **không** cooldown (lỗi phía họ, thường qua nhanh) |
| Lỗi mạng (timeout, DNS, socket đứt) | Bỏ qua tài khoản đó **lượt này**, **không** cooldown |
| 4xx khác (payload hỏng, model sai tên) | Trả lỗi ngay, **không** xoay |
| Header hạn mức báo hết lượt (`remaining: 0`) | Cho tài khoản đó nghỉ tới mốc reset — **kể cả khi lượt vừa rồi thành công** |
| Mọi tài khoản đều cooldown | Trả **429** kèm "thử lại sau khoảng Ns" để lớp trên biết nghỉ bao lâu |
| Chưa cấu hình API key nào | Trả **503** nói rõ là thiếu key, không lẫn với hết quota |

Cooldown mặc định (`lib/failover.js`): 401 → 300s; 402/403/429 → 3600s; mã khác → 60s.
`Retry-After` của upstream luôn ghi đè — upstream biết rõ hơn ta khi nào nó sẵn sàng trở lại.

Bốn phân biệt ở trên là toàn bộ giá trị của bảng này:

- **Lỗi mạng ≠ upstream từ chối.** Một nhịp mạng chập chờn không được làm nguội cả pool.
- **5xx ≠ hết quota.** Lỗi phía họ thường qua trong vài giây; cho nghỉ 1 giờ là tự cắt tay mình.
- **4xx của người gọi ≠ lỗi nhà cung cấp.** Payload hỏng thì nhà nào cũng từ chối y hệt;
  xoay vòng chỉ đốt quota và làm chậm câu trả lời cho một lỗi mà người gọi phải tự sửa.
- **Một key hết quota ≠ cả hãng hết quota.** Đây là phân biệt mà toàn bộ phần nhiều tài
  khoản dựa vào.

### Nghỉ trước khi ăn 429

Nhà cung cấp gửi kèm hạn mức còn lại trong header của mọi phản hồi. Gateway đọc nó và cho
tài khoản nghỉ ngay khi `remaining` về 0, chứ không chờ tới lượt sau để ăn một cái 429.

Với một tài khoản, đâm vào giới hạn rồi mới nghỉ chỉ tốn một lượt. Với mười tài khoản thì đó
là mười lượt 429 mỗi vòng — và vài nhà cung cấp tính cả request bị từ chối vào hạn mức, nên
cách đó tự kéo dài đúng cái nó đang cố tránh.

Ba họ header được đọc, vì không nhà nào chịu giống nhà nào: `x-ratelimit-remaining-requests`
(OpenAI, Groq, Together, DeepSeek), `anthropic-ratelimit-requests-remaining` (Anthropic,
mốc reset là RFC-3339), và `ratelimit-remaining` (bản nháp IETF). Mốc reset đọc được cả ba
định dạng ngoài đời: số giây, khoảng thời gian kiểu Go (`2m59.56s`, `88ms`), và mốc RFC-3339.

### Lượt nào đi tài khoản nào

Mỗi lượt thành công ghi một dòng log kèm vị trí trong danh sách ứng viên của lượt đó:

```
WARN  gemini#1 trả 429, cho nghỉ 27s và xoay sang ứng viên kế
WARN  groq#2 lỗi mạng (bỏ qua lượt này, không cooldown): ECONNRESET
INFO  gemini#2 phục vụ thành công (lần thử 3/12)
```

Đây là chỗ duy nhất **kiểm chứng** được việc xoay vòng thay vì phải tin: thiếu nó thì mọi
lượt thành công trông giống hệt nhau, kể cả khi pool đã kẹt vào đúng một key.

`lần thử i/n` là vị trí trong danh sách ứng viên **của lượt đó**, không phải số thứ tự cố
định: pool sắp lại theo LRU trước mỗi lượt, nên lượt trơn tru luôn là `1/n`, còn `2/n` trở
lên nghĩa là đã phải bỏ qua ai đó.

Phản hồi của `/api/chat` cũng kèm mảng `attempts` mô tả đúng đường đi đó, có cả tên tài khoản.

## Đúng chuẩn cho từng nhà cung cấp

Mười nhà cung cấp không nói cùng một thứ tiếng, kể cả bảy nhà tự nhận là "tương thích
OpenAI". Mỗi khác biệt dưới đây từng là một lỗi thật:

| Nhà cung cấp | Khác biệt | Không xử lý thì sao |
|---|---|---|
| **Cerebras** | Không có `seed`, `stream_options`, penalty; trả **400** cho trường lạ | Hỏng đúng những request có đặt tham số, còn request trần vẫn chạy ngon — nên rất dễ lọt qua mọi lần thử tay |
| **Mistral** | Gọi `seed` là `random_seed`; không có `stream_options` | Tham số bị bỏ qua lặng lẽ: không lỗi, chỉ là kết quả không lặp lại được như client tưởng |
| **Gemini** | Tham số nằm trong `generationConfig` (camelCase); 429 giấu `retryDelay` trong `error.details` chứ **không** gửi `Retry-After` | Nghỉ nguyên một tiếng cho một nhịp nghẽn 27 giây của hạn mức phút |
| **Anthropic** | `max_tokens` là trường **bắt buộc**; `temperature` chỉ tới 1; không có `seed`/penalty; hội thoại phải luân phiên và mở đầu bằng `user` | 400 — bị xếp vào "lỗi phía client, không xoay vòng", nên làm đứng cả pool |
| **Cohere v2** | `top_p` là `p`, `top_k` là `k`; usage có hai bộ đếm (`tokens` vs `billed_units`) | Tham số bị bỏ qua; usage báo số tiền chứ không phải số token |
| **DeepSeek** | Không có `seed`, `user` | Như Cerebras nếu họ siết kiểm tra |

Ba thứ được chuẩn hóa một lần ở biên gateway, thay vì để mỗi provider tự đoán:

- **`content` dạng mảng khối** (`[{type:'text',text:'…'}]`) được dẹp phẳng thành chuỗi. Khối
  không phải text (ảnh, audio) bị **từ chối** chứ không bị bỏ qua: giả vờ đã gửi ảnh đi là
  cách hỏng tệ nhất — người dùng nhận về một câu trả lời tự tin về thứ mà model chưa từng thấy.
- **Lượt liên tiếp cùng vai** được gộp, và lượt `assistant` mở đầu bị cắt. Hai tin nhắn user
  liền nhau là chuyện rất thường (gõ tiếp khi câu trước lỗi, hoặc lịch sử đã bị cắt bớt), và
  Anthropic/Gemini đều trả 400 cho nó — một lỗi gateway tự sửa được.
- **`temperature` ngoài khoảng** được ép về trần của nhà cung cấp. `temperature: 1.5` là hợp
  lệ với chuẩn mà gateway đang nói; chuyển thẳng xuống Anthropic sẽ thành 400 và làm đứng cả
  pool cho một request mà 9 nhà còn lại phục vụ được.

Tham số sai kiểu (`temperature: "nóng"`) bị chặn ngay tại gateway bằng 400. Để nó đi tiếp thì
upstream cũng trả 400 — đúng kết luận, nhưng tốn một lượt gọi thật và một dòng log đổ tội cho
nhà cung cấp.

## Dùng nhanh

```bash
npm install
cp .env.example .env     # điền API key nào có; nhà không có key thì tự động nằm ngoài pool
npm start                # http://localhost:3000
npm test                 # không gọi mạng: fetch được stub
```

Không cần điền đủ. Nhà cung cấp nào không có key thì ở trạng thái `inactive` và không bao
giờ được chọn.

## Endpoint

| Method | Path | |
|---|---|---|
| POST | `/v1/chat/completions` | Chuẩn OpenAI, có `stream: true` và tham số sinh văn bản |
| GET | `/v1/models` | `auto` + danh sách nhà cung cấp |
| POST | `/api/chat` | API riêng của web UI; trả kèm `provider`, `account`, `usage`, `attempts`, `status` |
| GET | `/api/providers/status` | Trạng thái pool, **có từng tài khoản**: cooldown còn lại, số request trong cửa sổ, lỗi cuối |
| POST | `/api/providers/test` | Thử API key (nhận nhiều key một lượt, trả kết quả từng key) |
| POST | `/api/providers/reset` | Xóa cooldown (`{"provider":"groq"}`, `{"account":"groq:a1b2…"}`, hoặc body rỗng để xóa tất cả) |
| GET | `/health` | `{service, ready, total, accounts, accountsReady}` — **503** khi `ready` bằng 0 (không nhà nào phục vụ được), **200** nếu còn ít nhất một |

`model` nhận ba dạng:

- `auto` (hoặc tên lạ) → để pool tự xoay.
- `groq` → ghim nhà cung cấp, dùng model mặc định của nhà đó.
- `groq/llama-3.1-8b-instant` → ghim cả nhà cung cấp lẫn model.

Dạng thứ ba là cách duy nhất chọn được model thật mà không phải sửa `.env` rồi khởi động lại,
và cũng là đường thoát khi một model bị hãng cho nghỉ hưu. Model được ghim chỉ áp cho đúng
nhà cung cấp đó: mang tên model của Groq sang Gemini trong lượt failover thì chắc chắn 404.

Cắm client OpenAI vào:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3000/v1", api_key="không-dùng-tới")
client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "chào"}],
    temperature=0.2,
    max_tokens=500,
)
```

`api_key` phía client không được dùng tới — gateway tự xác thực với các nhà cung cấp bằng
key trong `.env`. Vì vậy **đừng mở `/api/chat` và `/v1/chat/completions` ra internet** mà
không có lớp xác thực riêng ở trước (reverse proxy, VPN…): ai gọi được cũng tiêu quota của
bạn — `GATEWAY_ADMIN_TOKEN` (xem "Bảo vệ endpoint quản trị") không khóa hai endpoint này.

Tham số được chuyển tiếp: `temperature`, `top_p`, `top_k`, `max_tokens`, `stop`, `seed`,
`presence_penalty`, `frequency_penalty`, `response_format`, `user` — mỗi cái được dịch sang
phương ngữ của nhà cung cấp đang phục vụ, và bị lọc bỏ ở nhà nào không có nó.

### Bảo vệ endpoint quản trị

`/api/providers/status` (xem trạng thái từng tài khoản), `/api/providers/test` (thử API
key), `/api/providers/reset` (xóa cooldown) và toàn bộ `/api/claude/oauth/*` (đăng nhập/đăng
xuất subscription Claude) không có xác thực nào theo mặc định — giống `/api/chat`. Khác biệt
là ba nhóm đầu không phải mặt hàng chính của gateway: ai gọi được cũng đọc được cấu hình
pool, thử được key người khác, hoặc xóa cooldown đang bảo vệ một tài khoản.

Đặt `GATEWAY_ADMIN_TOKEN` để khóa lại đúng các endpoint này:

```bash
GATEWAY_ADMIN_TOKEN=một-chuỗi-bí-mật-dài
```

Gọi kèm `Authorization: Bearer một-chuỗi-bí-mật-dài` (hoặc header `X-Admin-Token`, dễ gõ tay
hơn khi test bằng curl):

```bash
curl -H "Authorization: Bearer một-chuỗi-bí-mật-dài" http://localhost:3000/api/providers/status
```

Không đặt biến này thì mọi thứ giữ nguyên như trước — không có gì bắt buộc phải cấu hình
thêm để chạy `npm start` lần đầu. Web UI (mục Cài đặt API) tự hỏi token qua một hộp thoại
ngay lần đầu gặp `401`, rồi nhớ lại trong `localStorage` cho những lần sau. `/api/chat` và
`/v1/chat/completions` không nằm trong phạm vi biến này — xem cảnh báo ở mục "Dùng nhanh".

### Ảnh

`content` của một message nhận thêm khối `image_url` (đúng khuôn OpenAI), trộn chung với
khối `text`:

```python
client.chat.completions.create(
    model="auto",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "Ảnh này vẽ gì?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KG..."}}
        ]
    }],
)
```

Nhận cả hai dạng `url`: **base64 nhúng thẳng** (`data:image/png;base64,...`) và **URL công
khai** (`https://...`) — nhưng không phải nhà nào cũng nhận cả hai:

| Nhà cung cấp | base64 | URL công khai |
|---|---|---|
| 7 nhà chuẩn OpenAI (OpenAI, Groq, OpenRouter, Mistral, Cerebras, DeepSeek, Together) | có | có (chuyển thẳng, không dịch) |
| Anthropic Claude | có | có (khối `image`, `source.type` khác nhau) |
| Google Gemini | có (`inlineData`) | **không** — trả 400 rõ ràng, không âm thầm bỏ ảnh |
| Cohere | **không** | **không** |

`model: "auto"` tự loại Cohere khỏi ứng viên khi request có ảnh (giống cách lọc `tools`).
Ghim thẳng Gemini (`model: "gemini"`) kèm ảnh dạng URL sẽ bị từ chối bằng 400 vì Gemini chỉ
đọc được ảnh nhúng base64 qua đường `generateContent` — muốn dùng URL công khai với Gemini
thì phải tự tải ảnh về và mã hóa base64 trước khi gửi.

Video và audio **chưa được hỗ trợ** ở bất kỳ nhà nào — một khối `video_url`/`input_audio`
bị từ chối rõ ràng bằng 400 ngay tại gateway thay vì bị lặng lẽ bỏ đi.

### Function calling

`tools` (khai báo hàm chuẩn OpenAI) và `tool_choice` được nhận ở cả `/v1/chat/completions`
lẫn `/api/chat`, cho cả stream lẫn không:

```python
client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hà Nội hôm nay thế nào?"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Lấy thời tiết hiện tại của một thành phố",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"]
            }
        }
    }],
    tool_choice="auto",
)
```

Phản hồi mang `choices[0].message.tool_calls` (và `finish_reason: "tool_calls"`) đúng khuôn
OpenAI dù model thật đang phục vụ là Groq hay Claude. Gửi kết quả hàm về bằng một message
`{"role": "tool", "tool_call_id": "...", "content": "..."}` nối tiếp theo message assistant
mang `tool_calls` — đúng vòng lặp chuẩn OpenAI.

Vì mỗi nhà cung cấp biểu diễn function calling một cách khác nhau, request có `tools` chỉ
xoay vào những nhà đã nói được nó (xem "Giới hạn đã biết") — kể cả khi `model` ghim thẳng
một nhà không hỗ trợ (`model: "gemini"` chẳng hạn), pool vẫn rơi về những nhà còn lại thay
vì gửi bừa cho Gemini rồi bị bỏ qua hàm âm thầm. Chỉ khi KHÔNG còn nhà nào hỗ trợ `tools`
trong số các tài khoản đang dùng được thì gateway mới trả 400 nói rõ lý do.

### Stream

`stream: true` trả SSE đúng khuôn OpenAI (`chat.completion.chunk`, kết bằng `data: [DONE]`).

Xoay vòng chỉ diễn ra **trước mẩu đầu tiên**. Sau mốc đó, đổi tài khoản sẽ nối phần đầu của
nhà này với phần giữa của nhà kia thành một câu trả lời không ai từng viết — hỏng theo kiểu
không báo lỗi và không nhìn ra được. Nên lỗi giữa stream được báo trong thân stream rồi đóng,
chứ không âm thầm chuyển nhà.

Cùng ranh giới đó quyết định cách báo lỗi: trước mẩu đầu, header chưa gửi nên vẫn trả được
status HTTP thật (400, 429…); sau mẩu đầu thì chỉ còn báo được bằng một mẩu `{"error":…}`
trong thân.

## Cấu trúc

```
lib/accounts.js    Account (một key + sức khỏe riêng của nó), dấu vân tay, tìm key trong .env
lib/pool.js        pool nhà cung cấp × tài khoản, chọn ứng viên (LRU + xen kẽ), trạng thái
lib/router.js      vòng failover (chat + streamChat), áp tín hiệu hạn mức
lib/failover.js    phân loại lỗi → xoay hay không, cooldown bao lâu
lib/ratelimit.js   đọc header hạn mức của cả ba họ + retryDelay của Google
lib/params.js      tham số chuẩn OpenAI → phương ngữ từng nhà cung cấp
lib/messages.js    dẹp phẳng content, tách system, gộp lượt liên tiếp
lib/errors.js      UpstreamError mang mã HTTP thật + cắt gọn thông điệp lỗi
lib/sse.js         đọc Server-Sent Events, dùng chung cho cả 4 định dạng stream
lib/store.js       lưu cooldown xuống đĩa để sống qua restart
lib/providers.js   dựng 10 nhà cung cấp, đọc model/RPM ghi đè từ .env
lib/app.js         express app (test dựng app riêng, không đụng cổng thật)
providers/base.js  gọi HTTP, chuẩn hóa lỗi, khai báo phương ngữ + tham số nhận được
server.js          chỉ mở cổng
```

Provider làm ba việc: gọi upstream, ném `UpstreamError` mang mã HTTP thật, và khai báo nó nói
được phương ngữ gì. Provider **không** giữ trạng thái nào của lượt gọi — đó là việc của tài
khoản (sức khỏe) và của router (chính sách), nơi duy nhất nhìn thấy cả pool.

### Lưu cooldown

Cooldown được ghi xuống `~/.ai-gateway/cooldowns.json` (đổi bằng `GATEWAY_STATE_FILE`) và nạp
lại lúc khởi động — chỉ những cooldown còn hiệu lực. Không có phần này thì restart là xóa
sạch cooldown và gateway lại bắn thẳng vào tài khoản vừa hết quota, ăn 429 ngay lượt đầu.

Khóa là **dấu vân tay SHA-256 của API key**, không phải tên nhà cung cấp: có nhiều tài khoản
thì "gemini đang nghỉ" là một câu vô nghĩa — nghỉ là key nào? Vân tay cũng ổn định qua việc
đổi thứ tự key trong `.env`, nên cooldown nạp lại đúng key đã bị khóa chứ không phải "key thứ
hai" của lần chạy trước.

Ghi nguyên tử (file tạm rồi `rename`), quyền `600`, và **chỉ chứa cooldown — không chứa API
key**. Vân tay là hàm một chiều nên đọc file không dựng lại được key. File phiên bản 1 (khóa
theo tên nhà cung cấp) vẫn đọc được, hiểu là "cả nhà cung cấp này đang nghỉ".

## Giới hạn đã biết

- **Cửa sổ RPM là bộ đếm 60 giây của từng tài khoản**, xấp xỉ chứ không phải rate limit thật
  của nhà cung cấp; nó chỉ giảm bớt số lần ăn 429, không thay thế được cooldown.
- **Quota tính theo dự án chứ không theo key.** Vài nhà cung cấp (và vài bậc tài khoản) tính
  hạn mức cho cả tổ chức, nên hai key cùng dự án sẽ hết quota cùng lúc và việc thêm key thứ
  hai không mua thêm được gì. Xen kẽ theo nhà cung cấp làm điều này chỉ tốn một lần thử thừa
  mỗi vòng, nhưng không sửa được gốc: muốn nhân hạn mức thì key phải thuộc dự án/tổ chức khác.
- **Ảnh đi qua được ở 9/10 nhà cung cấp** (`content` dạng khối `image_url`, xem "Ảnh" bên
  dưới) — chỉ Cohere chưa hỗ trợ. **Video và audio thì chưa nhà nào** — bị từ chối rõ ràng
  bằng 400 thay vì bị lặng lẽ bỏ đi.
- **Tool/function calling** đi qua được ở 8/10 nhà cung cấp: bảy nhà chuẩn OpenAI (OpenAI,
  Groq, OpenRouter, Mistral, Cerebras, DeepSeek, Together — passthrough nguyên `tools`/
  `tool_choice`) và Anthropic Claude (dịch sang `input_schema`/`tool_use`/`tool_result`).
  Gemini và Cohere chưa dịch được phương ngữ riêng của họ, nên khi request có `tools`, pool
  tự loại hai nhà này khỏi danh sách ứng viên thay vì gửi bừa rồi bị bỏ qua âm thầm; nếu
  không còn ai hỗ trợ, gateway trả 400 nói rõ lý do thay vì 404/lỗi mơ hồ từ upstream.
- **Nhiều tiến trình dùng chung file cooldown là "cố gắng hết sức", không phải khóa.** File
  được ghi nguyên tử nên không bao giờ đọc phải JSON cụt, nhưng hai tiến trình cùng ghi thì
  bên ghi sau thắng, và cooldown chỉ được đọc lại lúc khởi động — nên trong một phiên chạy,
  tiến trình này vẫn không thấy tài khoản mà tiến trình kia vừa cho nghỉ. Chạy nặng nhiều
  tiến trình thì nên chia mỗi tiến trình một tập key riêng.
