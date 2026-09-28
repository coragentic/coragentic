import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SlidingWindowRateLimiter,
  createRateLimiter,
  isOriginAllowed,
  getCorsHeaders,
  getSecurityHeaders,
  formatPublicError,
} from './security.mjs';

test('rate limiter tracks IP and wallet windows and returns Retry-After metadata', () => {
  let now = 1_000;
  const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 10_000, maxKeys: 10, now: () => now });
  assert.deepEqual(limiter.check({ ip: '203.0.113.10', wallet: '0xabc' }), {
    allowed: true, limit: 2, remaining: 1, retryAfter: 0, retryAfterSeconds: 0,
  });
  assert.equal(limiter.check({ ip: '203.0.113.10', wallet: '0xabc' }).allowed, true);
  const blocked = limiter.check({ ip: '203.0.113.10', wallet: '0xabc' });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfter, 10_000);
  assert.equal(blocked.retryAfterSeconds, 10);
  now += 10_001;
  assert.equal(limiter.check({ ip: '203.0.113.10', wallet: '0xabc' }).allowed, true);
});

test('rate limiter bounds key memory and supports factory API', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2, now: () => 100 });
  limiter.check({ ip: '1.1.1.1' });
  limiter.check({ ip: '2.2.2.2' });
  limiter.check({ ip: '3.3.3.3' });
  assert.ok(limiter.size <= 2);
});

test('CORS uses exact origins from the environment allowlist', () => {
  const env = { CORS_ORIGINS: 'https://app.example, https://admin.example' };
  assert.equal(isOriginAllowed('https://app.example', env), true);
  assert.equal(isOriginAllowed('https://admin.example', env), true);
  assert.equal(isOriginAllowed('https://evil.example', env), false);
  assert.equal(isOriginAllowed('https://app.example.evil', env), false);
  assert.deepEqual(getCorsHeaders('https://app.example', env), {
    'access-control-allow-origin': 'https://app.example',
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  });
  assert.deepEqual(getCorsHeaders('https://evil.example', env), { vary: 'Origin' });
});

test('security headers include safe defaults and production HSTS', () => {
  const headers = getSecurityHeaders({ production: true });
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.match(headers['content-security-policy'], /default-src 'none'/);
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(headers['strict-transport-security'], /max-age=31536000/);
  assert.equal(getSecurityHeaders({ production: false })['strict-transport-security'], undefined);
});

test('public error formatter redacts internal details and carries correlation id', () => {
  const response = formatPublicError(new Error('secret database password'), { correlationId: 'req-123' });
  assert.deepEqual(response, { ok: false, error: 'internal_error', correlationId: 'req-123' });
  assert.doesNotMatch(JSON.stringify(response), /secret|password|database/);
  assert.match(formatPublicError(new Error('x')).correlationId, /^[0-9a-f-]{36}$/);
});
