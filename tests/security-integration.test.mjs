import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createHmacVerifier } from '../src/lib/aggregators.ts';
import { getRateLimitClientIp, isRateLimited, RateLimitUnavailableError } from '../src/lib/rate-limit.ts';
import { readJsonObject, RequestInputError } from '../src/lib/http.ts';
import { accessTokenSigningKey } from '../src/lib/jwt-secret.ts';
import { passwordFitsBcrypt, passwordMeetsRegistrationPolicy } from '../src/lib/password-policy.ts';
import { isSameOriginRequest } from '../src/lib/csrf.ts';

test('aggregator HMAC verifier accepts authentic requests and rejects tampering', () => {
  const previous = process.env.KORA_TEST_WEBHOOK_SECRET;
  process.env.KORA_TEST_WEBHOOK_SECRET = 'local-test-secret';
  const raw = '{"order":"KORA-1"}';
  const signature = createHmac('sha256', 'local-test-secret').update(raw).digest('hex');
  const verify = createHmacVerifier('KORA_TEST_WEBHOOK_SECRET');
  assert.equal(verify(raw, signature), true);
  assert.equal(verify(`${raw} `, signature), false);
  assert.equal(verify(raw, 'not-a-signature'), false);
  if (previous === undefined) delete process.env.KORA_TEST_WEBHOOK_SECRET;
  else process.env.KORA_TEST_WEBHOOK_SECRET = previous;
});

test('API rate limiter caps repeated authentication attempts by IP', async () => {
  const request = () => new Request('http://localhost/api/auth/login', { headers: { 'x-forwarded-for': '192.0.2.88' } });
  assert.equal((await isRateLimited(request(), 'security-test', 2, 60)).limited, false);
  assert.equal((await isRateLimited(request(), 'security-test', 2, 60)).limited, false);
  assert.equal((await isRateLimited(request(), 'security-test', 2, 60)).limited, true);
});

test('request parser rejects malformed, non-object and oversized JSON with a controlled input error', async () => {
  await assert.rejects(readJsonObject(new Request('http://localhost', { method: 'POST', body: '{' })), RequestInputError);
  await assert.rejects(readJsonObject(new Request('http://localhost', { method: 'POST', body: '[]' })), /JSON object/);
  await assert.rejects(readJsonObject(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ ok: true }) }), 4), /too large/i);
  assert.deepEqual(await readJsonObject(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ ok: true }) })), { ok: true });
});


test('production auth throttling ignores spoofed X-Forwarded-For and requires a signed proxy IP', async () => {
  const keys = ['NODE_ENV', 'REDIS_URL', 'KORA_PROXY_SHARED_SECRET'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'production';
  delete process.env.REDIS_URL;
  process.env.KORA_PROXY_SHARED_SECRET = 'test-only-proxy-secret-long-enough-32-bytes';
  const makeRequest = (ip, forwarded) => {
    const signature = createHmac('sha256', process.env.KORA_PROXY_SHARED_SECRET).update(ip).digest('hex');
    return new Request('https://kora.example/api/auth/login', { headers: {
      'x-kora-client-ip': ip,
      'x-kora-client-ip-signature': signature,
      'x-forwarded-for': forwarded,
    } });
  };
  try {
    assert.equal(getRateLimitClientIp(makeRequest('198.51.100.8', '203.0.113.1')), '198.51.100.8');
    assert.equal(getRateLimitClientIp(makeRequest('198.51.100.8', '203.0.113.99')), '198.51.100.8');
    const invalid = new Request('https://kora.example', { headers: { 'x-kora-client-ip': '198.51.100.8', 'x-kora-client-ip-signature': '0'.repeat(64), 'x-forwarded-for': '192.0.2.1' } });
    assert.throws(() => getRateLimitClientIp(invalid), RateLimitUnavailableError);
    await assert.rejects(isRateLimited(makeRequest('198.51.100.8', '203.0.113.1'), 'missing-redis-regression', 2, 60), RateLimitUnavailableError);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('account throttling caps one account across different client IPs', async () => {
  const keys = ['NODE_ENV', 'REDIS_URL'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'development';
  delete process.env.REDIS_URL;
  try {
    const limited = [];
    for (const ip of ['198.51.100.11', '198.51.100.12', '198.51.100.13']) {
      const request = new Request('http://localhost/api/auth/login', { headers: { 'x-forwarded-for': ip } });
      limited.push((await isRateLimited(request, 'account-throttle-regression', 2, 60, 'restaurant:owner@example.test')).limited);
    }
    assert.deepEqual(limited, [false, false, true]);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
test('JSON body limit rejects declared and streamed oversize bodies before buffering them fully', async () => {
  const declared = new Request('http://localhost/api', { method: 'POST', headers: { 'content-length': '1000000' }, body: '{}' });
  await assert.rejects(readJsonObject(declared, 16), (error) => error instanceof RequestInputError && error.statusCode === 413);
  const streamed = new Request('http://localhost/api', {
    method: 'POST',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(17)); controller.close(); } }),
    duplex: 'half',
  });
  await assert.rejects(readJsonObject(streamed, 16), (error) => error instanceof RequestInputError && error.statusCode === 413);
  await assert.rejects(readJsonObject(new Request('http://localhost/api', { method: 'POST', body: new Uint8Array([0xff]) })), /UTF-8/);
});

test('JWT signing key rejects the documented placeholder and accepts a canonical 256-bit secret', () => {
  const secret = randomBytes(32).toString('base64url');
  assert.equal(accessTokenSigningKey(secret).byteLength, 32);
  assert.throws(() => accessTokenSigningKey('replace-with-a-long-random-secret'), /32 bytes/);
  assert.throws(() => accessTokenSigningKey('A'.repeat(42)), /32 bytes/);
});

test('bcrypt password policy measures UTF-8 bytes and blocks silent 72-byte truncation', () => {
  assert.equal(passwordFitsBcrypt('a'.repeat(72)), true);
  assert.equal(passwordFitsBcrypt('a'.repeat(73)), false);
  assert.equal(passwordFitsBcrypt('é'.repeat(36)), true);
  assert.equal(passwordFitsBcrypt('é'.repeat(37)), false);
  assert.equal(passwordMeetsRegistrationPolicy('a'.repeat(12)), true);
  assert.equal(passwordMeetsRegistrationPolicy('😀'.repeat(6)), false);
  assert.equal(passwordMeetsRegistrationPolicy('😀'.repeat(12)), true);
});

test('refresh-cookie endpoints can reject cross-origin browser requests', () => {
  assert.equal(isSameOriginRequest(new Request('https://kora.example/api/auth/refresh', { method: 'POST', headers: { origin: 'https://kora.example', 'sec-fetch-site': 'same-origin' } })), true);
  assert.equal(isSameOriginRequest(new Request('https://kora.example/api/auth/refresh', { method: 'POST', headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' } })), false);
  assert.equal(isSameOriginRequest(new Request('https://kora.example/api/auth/refresh', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })), false);
  const previousEnv = process.env.NODE_ENV;
  const previousOrigin = process.env.KORA_APP_ORIGIN;
  process.env.NODE_ENV = 'production';
  delete process.env.KORA_APP_ORIGIN;
  assert.equal(isSameOriginRequest(new Request('https://kora.example/api/auth/refresh', { method: 'POST', headers: { origin: 'https://kora.example' } })), false);
  process.env.KORA_APP_ORIGIN = 'https://kora.example';
  assert.equal(isSameOriginRequest(new Request('https://kora.example/api/auth/refresh', { method: 'POST', headers: { origin: 'https://kora.example' } })), true);
  if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  if (previousOrigin === undefined) delete process.env.KORA_APP_ORIGIN; else process.env.KORA_APP_ORIGIN = previousOrigin;
});
