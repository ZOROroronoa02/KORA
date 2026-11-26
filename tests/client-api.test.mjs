import test from 'node:test';
import assert from 'node:assert/strict';
import { getAccessToken, hasPendingLogout, restoreSession, setAccessToken, signIn, signOut } from '../src/lib/client-api.ts';

function installBrowserStorage(values = new Map()) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return {
    values,
    restore() {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete globalThis.localStorage;
    },
  };
}

test('offline session restore fails closed while a logout is pending', async () => {
  const browser = installBrowserStorage(new Map([['kora-cloud-logout-pending', '1']]));
  const originalFetch = globalThis.fetch;
  try {
    let logoutCalls = 0;
    globalThis.fetch = async () => { logoutCalls++; throw new TypeError('network offline'); };
    setAccessToken('stale-access-token');
    assert.equal(hasPendingLogout(), true);
    assert.equal(await restoreSession(), null);
    assert.equal(getAccessToken(), null);
    assert.equal(logoutCalls, 1, 'restore attempts only the pending logout, never a refresh');
  } finally {
    setAccessToken(null);
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('sign-out persists a local latch before an offline request fails', async () => {
  const browser = installBrowserStorage();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('network offline'); };
    setAccessToken('active-access-token');
    await assert.doesNotReject(signOut());
    assert.equal(browser.values.get('kora-cloud-logout-pending'), '1');
    assert.equal(getAccessToken(), null);
  } finally {
    setAccessToken(null);
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('new sign-in flushes a previous logout before creating another session', async () => {
  const browser = installBrowserStorage(new Map([['kora-cloud-logout-pending', '1']]));
  const originalFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const path = typeof input === 'string' ? input : input.url;
      calls.push(path);
      if (path === '/api/auth/logout') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'fresh-access-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/api/auth/me') {
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fresh-access-token');
        return new Response(JSON.stringify({ user: { id: 'user-1', name: 'Owner', email: 'owner@example.test' }, outlets: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const session = await signIn({ tenantSlug: 'restaurant', email: 'owner@example.test', password: 'correct-password' });
    assert.equal(session.user.id, 'user-1');
    assert.deepEqual(calls, ['/api/auth/logout', '/api/auth/login', '/api/auth/me']);
    assert.equal(browser.values.has('kora-cloud-logout-pending'), false);
  } finally {
    setAccessToken(null);
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('inaccessible browser storage is treated as a pending logout', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); } });
  try { assert.equal(hasPendingLogout(), true); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});
