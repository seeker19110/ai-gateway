const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stubFetch, jsonResponse } = require('./helpers');
const claudeOAuth = require('../lib/claudeOAuth');

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-oauth-'));
  return { GATEWAY_STATE_DIR: dir };
}

test('createPkce: verifier/challenge/state khác nhau mỗi lần, challenge đúng SHA-256 của verifier', () => {
  const crypto = require('crypto');
  const a = claudeOAuth.createPkce();
  const b = claudeOAuth.createPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);

  const expected = crypto.createHash('sha256').update(a.verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(a.challenge, expected);
});

test('buildAuthorizeUrl: mang đủ tham số PKCE + state, đúng client_id công khai của CLI', () => {
  const url = new URL(claudeOAuth.buildAuthorizeUrl({ challenge: 'chal123', state: 'state456' }));
  assert.equal(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), claudeOAuth.CLIENT_ID);
  assert.equal(url.searchParams.get('code_challenge'), 'chal123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state456');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('exchangeCode: tách "code#state", so khớp state đã phát, gửi đúng code_verifier', async () => {
  const stub = stubFetch(async (url, init) => {
    assert.equal(url, 'https://console.anthropic.com/v1/oauth/token');
    const body = JSON.parse(init.body);
    assert.equal(body.grant_type, 'authorization_code');
    assert.equal(body.code, 'abc123');
    assert.equal(body.state, 'xyz');
    assert.equal(body.code_verifier, 'verifier-value');
    return jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  });
  try {
    const before = Date.now();
    const cred = await claudeOAuth.exchangeCode({ rawCode: 'abc123#xyz', verifier: 'verifier-value', expectedState: 'xyz' });
    assert.equal(cred.accessToken, 'at');
    assert.equal(cred.refreshToken, 'rt');
    assert.ok(cred.expiresAt >= before + 3600_000);
  } finally {
    stub.restore();
  }
});

test('exchangeCode: state không khớp thì từ chối trước khi gọi mạng', async () => {
  const stub = stubFetch(async () => { throw new Error('không được gọi mạng'); });
  try {
    await assert.rejects(
      claudeOAuth.exchangeCode({ rawCode: 'abc#wrong-state', verifier: 'v', expectedState: 'xyz' }),
      /State không khớp/
    );
  } finally {
    stub.restore();
  }
});

test('exchangeCode: Anthropic từ chối thì ném UpstreamError mang đúng mã trạng thái', async () => {
  const stub = stubFetch(async () => jsonResponse(400, { error: 'invalid_grant' }));
  try {
    await assert.rejects(
      claudeOAuth.exchangeCode({ rawCode: 'abc#xyz', verifier: 'v', expectedState: 'xyz' }),
      (err) => err.statusCode === 400
    );
  } finally {
    stub.restore();
  }
});

test('save/load/clearCredential: ghi rồi đọc lại đúng, xoá thì loadCredential trả null', () => {
  const env = tmpEnv();
  assert.equal(claudeOAuth.loadCredential(env), null);

  claudeOAuth.saveCredential({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1000 }, env);
  const loaded = claudeOAuth.loadCredential(env);
  assert.equal(loaded.accessToken, 'at');

  claudeOAuth.clearCredential(env);
  assert.equal(claudeOAuth.loadCredential(env), null);
});

test('isExpired: hết hạn hoặc thiếu expiresAt thì coi là hết hạn', () => {
  assert.equal(claudeOAuth.isExpired(null), true);
  assert.equal(claudeOAuth.isExpired({ accessToken: 'x' }), true);
  assert.equal(claudeOAuth.isExpired({ accessToken: 'x', expiresAt: Date.now() - 1000 }), true);
  assert.equal(claudeOAuth.isExpired({ accessToken: 'x', expiresAt: Date.now() + 60_000 }), false);
});

test('refreshIfNeeded: bỏ qua khi còn hạn xa, hoặc khi không có refreshToken', async () => {
  const env = tmpEnv();
  const stub = stubFetch(async () => { throw new Error('không được gọi mạng khi chưa cần refresh'); });
  try {
    assert.equal(await claudeOAuth.refreshIfNeeded(env), null, 'chưa có credential nào');

    claudeOAuth.saveCredential({ accessToken: 'at', expiresAt: Date.now() + 60 * 60_000 }, env);
    assert.equal(await claudeOAuth.refreshIfNeeded(env), null, 'không có refreshToken thì không tự làm mới được');

    claudeOAuth.saveCredential({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60 * 60_000 }, env);
    assert.equal(await claudeOAuth.refreshIfNeeded(env), null, 'còn lâu mới hết hạn, chưa cần làm mới');
  } finally {
    stub.restore();
  }
});

test('refreshIfNeeded: sắp hết hạn và có refreshToken thì làm mới và ghi lại đĩa', async () => {
  const env = tmpEnv();
  claudeOAuth.saveCredential({ accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() + 1000 }, env);

  const stub = stubFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.refresh_token, 'rt');
    return jsonResponse(200, { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 });
  });
  try {
    const refreshed = await claudeOAuth.refreshIfNeeded(env);
    assert.equal(refreshed.accessToken, 'new');
    assert.equal(claudeOAuth.loadCredential(env).accessToken, 'new');
  } finally {
    stub.restore();
  }
});

test('exchangeCode: lỗi mạng khi đổi token thì ném UpstreamError 503 kèm isNetworkError', async () => {
  const stub = stubFetch(async () => { throw new Error('ECONNRESET'); });
  try {
    await assert.rejects(
      claudeOAuth.exchangeCode({ rawCode: 'abc#xyz', verifier: 'v', expectedState: 'xyz' }),
      (err) => err.statusCode === 503 && err.isNetworkError === true
    );
  } finally {
    stub.restore();
  }
});

test('exchangeCode: Anthropic trả 200 nhưng thân không phải JSON hợp lệ thì báo 502', async () => {
  const stub = stubFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => 'không phải json'
  }));
  try {
    await assert.rejects(
      claudeOAuth.exchangeCode({ rawCode: 'abc#xyz', verifier: 'v', expectedState: 'xyz' }),
      (err) => err.statusCode === 502 && /không phải JSON/.test(err.message)
    );
  } finally {
    stub.restore();
  }
});

test('loadCredential: cache TTL — sửa file trong vài giây đầu vẫn thấy giá trị cũ, save/clear xoá cache ngay', () => {
  const env = tmpEnv();
  claudeOAuth.saveCredential({ accessToken: 'v1' }, env);
  assert.equal(claudeOAuth.loadCredential(env).accessToken, 'v1');

  fs.writeFileSync(claudeOAuth.credentialPath(env), JSON.stringify({ accessToken: 'v2' }));
  assert.equal(claudeOAuth.loadCredential(env).accessToken, 'v1', 'còn trong cửa sổ cache');

  claudeOAuth.saveCredential({ accessToken: 'v3' }, env);
  assert.equal(claudeOAuth.loadCredential(env).accessToken, 'v3', 'save phải xoá cache ngay, không đợi hết TTL');
});
