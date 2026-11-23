import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHmacVerifier } from '../src/lib/aggregators.ts';
import { isRateLimited } from '../src/lib/rate-limit.ts';
import { readJsonObject, RequestInputError } from '../src/lib/http.ts';

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
