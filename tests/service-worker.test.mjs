import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const serviceWorkerSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://kora.example';

function createHarness(initialCacheNames = []) {
  const listeners = new Map();
  const stores = new Map(initialCacheNames.map((name) => [name, new Map()]));
  const deleted = [];
  let networkFetch = async () => new Response('network response', { status: 200 });

  const keyFor = (request) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(paths) {
          for (const path of paths) entries.set(keyFor(path), new Response('cached root shell'));
        },
        async put(request, response) { entries.set(keyFor(request), response); },
        async match(request) { return entries.get(keyFor(request)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
    async match(request) {
      for (const entries of stores.values()) {
        const response = entries.get(keyFor(request));
        if (response) return response;
      }
      return undefined;
    },
  };
  const self = {
    location: { origin },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  runInNewContext(serviceWorkerSource, {
    self,
    caches,
    fetch: (...args) => networkFetch(...args),
    URL,
    Response,
    Promise,
  });

  return {
    caches,
    deleted,
    stores,
    setFetch(handler) { networkFetch = handler; },
    async dispatch(name, properties = {}) {
      const event = {
        waits: [],
        waitUntil(promise) { this.waits.push(promise); },
        respondWith(promise) { this.response = promise; },
        ...properties,
      };
      listeners.get(name)(event);
      if (event.response) event.result = await event.response;
      await Promise.all(event.waits);
      return event;
    },
  };
}

test('service worker upgrades only KORA caches and keeps unrelated origin caches', async () => {
  const harness = createHarness(['kora-shell-v1', 'other-app-cache', 'kora-shell-v2']);
  await harness.dispatch('activate');

  assert.deepEqual(harness.deleted, ['kora-shell-v1']);
  assert.equal(harness.stores.has('other-app-cache'), true);
  assert.equal(harness.stores.has('kora-shell-v2'), true);
});

test('service worker caches the public shell and versioned assets, not private document responses', async () => {
  const harness = createHarness();
  await harness.dispatch('install');

  const privatePage = `${origin}/orders`;
  await harness.dispatch('fetch', {
    request: { method: 'GET', url: privatePage, mode: 'navigate', destination: 'document' },
  });
  assert.equal(await harness.caches.match(privatePage), undefined, 'server-rendered private documents must not be cached');

  const assetUrl = `${origin}/_next/static/chunks/app/dashboard-a91f0b.js`;
  await harness.dispatch('fetch', {
    request: { method: 'GET', url: assetUrl, mode: 'cors', destination: 'script' },
  });
  assert.equal(await (await harness.caches.match(assetUrl)).text(), 'network response');

  const api = await harness.dispatch('fetch', {
    request: { method: 'GET', url: `${origin}/api/orders`, mode: 'cors', destination: '' },
  });
  assert.equal(api.response, undefined, 'API requests must bypass the worker');
  assert.equal(await harness.caches.match(`${origin}/api/orders`), undefined, 'API responses must not be cached as app data');

  const manifest = await harness.dispatch('fetch', {
    request: { method: 'GET', url: `${origin}/manifest.webmanifest`, mode: 'cors', destination: 'manifest' },
  });
  assert.equal(manifest.response, undefined, 'the web manifest must bypass the worker cache strategy');

  harness.setFetch(async () => { throw new TypeError('offline'); });
  const navigation = await harness.dispatch('fetch', {
    request: { method: 'GET', url: `${origin}/orders`, mode: 'navigate', destination: 'document' },
  });
  assert.equal(await navigation.result.text(), 'cached root shell');
});

test('service worker registers cache writes before the event lifetime closes', async () => {
  const harness = createHarness();
  const event = await harness.dispatch('fetch', {
    request: { method: 'GET', url: `${origin}/`, mode: 'navigate', destination: 'document' },
  });
  assert.equal(event.waits.length, 1);
  assert.equal(await (await harness.caches.match(`${origin}/`)).text(), 'network response');
});

test('service worker leaves POST mutations outside its cache handler', async () => {
  const harness = createHarness();
  let networkCalls = 0;
  harness.setFetch(async () => { networkCalls++; return new Response('posted'); });
  const event = await harness.dispatch('fetch', {
    request: { method: 'POST', url: `${origin}/api/orders`, mode: 'cors', destination: '' },
  });

  assert.equal(event.response, undefined);
  assert.equal(networkCalls, 0, 'the browser owns POST requests and their retry/idempotency contract');
});
