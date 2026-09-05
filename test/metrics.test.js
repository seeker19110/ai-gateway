const test = require('node:test');
const assert = require('node:assert/strict');

const { createMetrics } = require('../lib/metrics');

test('createMetrics: cộng dồn theo method+route+status, phơi ra đúng khuôn Prometheus', () => {
  const metrics = createMetrics();
  metrics.increment('GET', '/health', 200, 5);
  metrics.increment('GET', '/health', 200, 3);
  metrics.increment('POST', '/api/chat', 500, 120);

  const text = metrics.renderPrometheus();
  assert.match(text, /ai_gateway_http_requests_total\{method="GET",route="\/health",status="200"\} 2/);
  assert.match(text, /ai_gateway_http_requests_total\{method="POST",route="\/api\/chat",status="500"\} 1/);
  assert.match(text, /ai_gateway_http_request_duration_ms_sum\{method="GET",route="\/health",status="200"\} 8\.000/);
});

test('createMetrics: escape ký tự đặc biệt trong label để không vỡ khuôn Prometheus', () => {
  const metrics = createMetrics();
  metrics.increment('GET', '/a"b\\c', 200, 1);

  const text = metrics.renderPrometheus();
  assert.match(text, /route="\/a\\"b\\\\c"/);
});
