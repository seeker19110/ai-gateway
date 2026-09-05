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

### Dạng proxy MCP

Gateway lộ thêm một endpoint MCP (Model Context Protocol) tại `/mcp` — JSON-RPC 2.0 chuẩn
(`initialize`, `tools/list`, `tools/call`), không cần SDK riêng. Client MCP (Claude Desktop,
Claude Code…) trỏ tới `<base_url>/mcp` là gọi được tool `chat`, đi xuyên qua đúng
`router.chat()` mà `/api/chat` dùng: failover, xoay vòng tài khoản, cooldown và tài khoản
subscription CLI ở trên đều áp dụng y hệt.

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
| GET | `/health` | `{service, ready, total, accounts, accountsReady}` |

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
key trong `.env`. Vì vậy **đừng mở gateway ra internet**: ai gọi được cũng tiêu quota của bạn.

Tham số được chuyển tiếp: `temperature`, `top_p`, `top_k`, `max_tokens`, `stop`, `seed`,
`presence_penalty`, `frequency_penalty`, `response_format`, `user` — mỗi cái được dịch sang
phương ngữ của nhà cung cấp đang phục vụ, và bị lọc bỏ ở nhà nào không có nó.

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
- **Chỉ chuyển văn bản.** Ảnh, audio, tool/function call chưa đi qua được gateway — và bị từ
  chối rõ ràng bằng 400 thay vì bị lặng lẽ bỏ đi.
- **Nhiều tiến trình dùng chung file cooldown là "cố gắng hết sức", không phải khóa.** File
  được ghi nguyên tử nên không bao giờ đọc phải JSON cụt, nhưng hai tiến trình cùng ghi thì
  bên ghi sau thắng, và cooldown chỉ được đọc lại lúc khởi động — nên trong một phiên chạy,
  tiến trình này vẫn không thấy tài khoản mà tiến trình kia vừa cho nghỉ. Chạy nặng nhiều
  tiến trình thì nên chia mỗi tiến trình một tập key riêng.
