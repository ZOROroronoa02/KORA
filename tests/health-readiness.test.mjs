import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { isServiceReady, probeRedis, redisDependencyState } from '../src/lib/health/readiness.ts';

test('readiness requires PostgreSQL and production Redis but allows the explicit development fallback', () => {
  assert.equal(redisDependencyState({ configured: false, healthy: false, production: true }), 'required');
  assert.equal(redisDependencyState({ configured: false, healthy: false, production: false }), 'not_configured');
  assert.equal(redisDependencyState({ configured: true, healthy: false, production: false }), 'unavailable');
  assert.equal(redisDependencyState({ configured: true, healthy: true, production: true }), 'ready');

  assert.equal(isServiceReady(false, 'ready'), false, 'Redis cannot compensate for a database outage');
  assert.equal(isServiceReady(true, 'required'), false, 'production requires Redis configuration');
  assert.equal(isServiceReady(true, 'unavailable'), false, 'configured but unhealthy Redis fails readiness');
  assert.equal(isServiceReady(true, 'not_configured'), true, 'development can use its documented in-memory fallback');
  assert.equal(isServiceReady(true, 'ready'), true);
});

test('readiness Redis client times out when a TCP endpoint accepts but never responds', async () => {
  let acceptedSocket;
  const server = createServer((socket) => { acceptedSocket = socket; });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const startedAt = Date.now();
  try {
    assert.equal(await probeRedis(`redis://127.0.0.1:${address.port}`, 500), false);
    assert.ok(Date.now() - startedAt < 3_000, 'socket inactivity must fail within the configured timeout');
  } finally {
    acceptedSocket?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

const productionBaseUrl = process.env.KORA_HEALTH_TEST_URL ?? process.env.KORA_CSP_TEST_URL;
test('live readiness reports dependency states without returning connection details', { skip: !productionBaseUrl }, async () => {
  const response = await fetch(`${productionBaseUrl.replace(/\/$/, '')}/api/health/ready`);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['database', 'name', 'redis', 'status']);
  assert.equal(body.name, 'KORA');
  assert.ok(['ready', 'unavailable'].includes(body.database));
  assert.ok(['ready', 'unavailable', 'required', 'not_configured'].includes(body.redis));
  const ready = body.database === 'ready' && (body.redis === 'ready' || body.redis === 'not_configured');
  assert.equal(response.status, ready ? 200 : 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
