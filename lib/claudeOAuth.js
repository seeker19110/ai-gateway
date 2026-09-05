const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UpstreamError } = require('./errors');

/**
 * Đăng nhập tài khoản subscription (Claude Pro/Max) NGAY TỪ GATEWAY, cho máy không có sẵn
 * Claude Code CLI (`claude login`).
 *
 * Đây là đúng luồng OAuth mà bản thân Claude Code CLI dùng (PKCE, `client_id` công khai của
 * nó) — gateway chỉ đóng vai trò client thay vì CLI. `client_id` này không phải bí mật: nó
 * nằm sẵn trong mã nguồn/traffic của CLI chính chủ, PKCE mới là thứ bảo vệ luồng (verifier
 * không rời máy người dùng cho tới bước đổi code).
 *
 * Anthropic KHÔNG cho gateway tự host redirect URI riêng (ứng dụng OAuth chỉ khai báo sẵn
 * `console.anthropic.com` làm nơi nhận), nên luồng là "authorization code thủ công": người
 * dùng mở URL, đăng nhập, Anthropic hiện một mã trên trang — người dùng dán mã đó lại vào
 * gateway để đổi lấy token. Không có bước redirect nào chạm tới gateway.
 */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

/** `code_verifier`/`code_challenge` của PKCE (RFC 7636), cộng thêm `state` chống CSRF. */
function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  return { verifier, challenge, state };
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildAuthorizeUrl({ challenge, state }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Trang Anthropic hiện mã dạng `code#state`: người dùng copy nguyên cụm đó. Tách state ra
 * để so với state đã phát, phòng người dùng dán nhầm mã của một lượt đăng nhập khác.
 */
function splitCode(raw) {
  const value = String(raw || '').trim();
  const hashAt = value.indexOf('#');
  if (hashAt === -1) return { code: value, state: null };
  return { code: value.slice(0, hashAt), state: value.slice(hashAt + 1) };
}

async function postToken(body) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new UpstreamError(`Lỗi mạng khi đổi token với Anthropic: ${error.message}`, 503, { isNetworkError: true });
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new UpstreamError(`Anthropic từ chối đăng nhập (${response.status}): ${raw.slice(0, 300)}`, response.status);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new UpstreamError('Anthropic trả về phản hồi không phải JSON hợp lệ', 502);
  }
  if (!data.access_token) throw new UpstreamError('Phản hồi thiếu access_token', 502);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + (Number(data.expires_in) || 0) * 1000
  };
}

/** Đổi `code` (từ trang Anthropic) lấy access/refresh token, xác thực đúng `state` đã phát. */
async function exchangeCode({ rawCode, verifier, expectedState }) {
  const { code, state } = splitCode(rawCode);
  if (!code) throw new UpstreamError('Thiếu mã xác thực', 400);
  if (expectedState && state && state !== expectedState) {
    throw new UpstreamError('State không khớp — có thể đây là mã của một lượt đăng nhập khác', 400);
  }

  return postToken({
    grant_type: 'authorization_code',
    code,
    state: state || expectedState,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });
}

async function refreshToken(refreshTokenValue) {
  return postToken({ grant_type: 'refresh_token', refresh_token: refreshTokenValue, client_id: CLIENT_ID });
}

// ---------- lưu trữ token đã đăng nhập qua gateway ----------

/**
 * Cùng thư mục trạng thái với `CooldownStore` (`~/.ai-gateway`), KHÔNG phải
 * `~/.claude/.credentials.json` của CLI thật — ghi đè file của CLI là làm hỏng phiên đăng
 * nhập của một công cụ khác mà gateway không có quyền động vào.
 */
function credentialPath(env = process.env) {
  const dir = env.GATEWAY_STATE_DIR || path.join(os.homedir(), '.ai-gateway');
  return path.join(dir, 'claude-subscription.json');
}

// Cache ngắn hạn theo ĐƯỜNG DẪN FILE (không phải một biến toàn cục duy nhất — nhiều `env`
// khác nhau, ví dụ nhiều test hay nhiều `GATEWAY_STATE_DIR`, phải không dẫm lên nhau).
// `loadCredential` được `discoverGatewayClaudeCredential` (accounts.js) gọi lại ở MỖI request
// chat, nên đọc đĩa mỗi lần là chặn event loop không cần thiết — TTL vài giây đủ ngắn để một
// lượt đăng nhập mới hiện ra gần như ngay lập tức, đủ dài để không dội `readFileSync` liên
// tục. `save`/`clear` xoá đúng entry của mình ngay, không đợi hết TTL.
const LOAD_CACHE_TTL_MS = 3000;
const loadCache = new Map(); // filePath -> { expiresAt, value }

function loadCredential(env = process.env) {
  const file = credentialPath(env);
  const now = Date.now();
  const cached = loadCache.get(file);
  if (cached && cached.expiresAt > now) return cached.value;

  let value;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    value = parsed?.accessToken ? parsed : null;
  } catch {
    value = null;
  }
  loadCache.set(file, { expiresAt: now + LOAD_CACHE_TTL_MS, value });
  return value;
}

/** Ghi nguyên tử (tạm rồi rename), quyền 0600: đây là bí mật, không phải cache. */
function saveCredential(credential, env = process.env) {
  const file = credentialPath(env);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(credential, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  loadCache.delete(file);
}

function clearCredential(env = process.env) {
  try {
    fs.unlinkSync(credentialPath(env));
  } catch {
    /* không có gì để xoá */
  }
  loadCache.delete(credentialPath(env));
}

/**
 * Token còn hạn hay đã hết? Không tự làm mới ở đây — hàm này được gọi từ đường đồng bộ
 * (`discoverKeys`, chạy lại ở MỖI request) nên không thể `await` một lượt refresh network.
 * Làm mới thật sự nằm ở `refreshIfNeeded`, chạy nền theo chu kỳ (xem `lib/app.js`).
 */
function isExpired(credential, now = Date.now()) {
  return !credential?.expiresAt || Number(credential.expiresAt) <= now;
}

/** Làm mới token nếu sắp hết hạn và có `refreshToken`; im lặng bỏ qua nếu không cần hoặc không thể. */
async function refreshIfNeeded(env = process.env, { marginMs = 5 * 60_000 } = {}) {
  const credential = loadCredential(env);
  if (!credential?.refreshToken) return null;
  if (Number(credential.expiresAt) - Date.now() > marginMs) return null; // còn lâu mới hết hạn

  const refreshed = await refreshToken(credential.refreshToken);
  const merged = { ...refreshed, refreshToken: refreshed.refreshToken || credential.refreshToken };
  saveCredential(merged, env);
  return merged;
}

module.exports = {
  CLIENT_ID,
  AUTHORIZE_URL,
  createPkce,
  buildAuthorizeUrl,
  exchangeCode,
  refreshToken,
  credentialPath,
  loadCredential,
  saveCredential,
  clearCredential,
  isExpired,
  refreshIfNeeded
};
