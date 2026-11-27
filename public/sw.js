const CACHE = "kora-shell-v2";
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/"]).catch(() => undefined)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("kora-shell-") && key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  const path = new URL(request.url).pathname;
  const appNavigation = request.mode === "navigate" && path !== "/api" && !path.startsWith("/api/");
  const appShellNavigation = appNavigation && path === "/";
  const versionedNextAsset = path.startsWith("/_next/static/") && /\.(?:js|css)$/.test(path);
  if (!appNavigation && !versionedNextAsset) return;
  const networkResponse = fetch(request);
  const cacheWrite = networkResponse.then((response) => {
    if (!response.ok || (!appShellNavigation && !versionedNextAsset)) return;
    return caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
  }).catch(() => undefined);
  // Register the lifetime extension synchronously while the fetch event is active.
  event.waitUntil(cacheWrite);
  event.respondWith(networkResponse.catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (appNavigation) return (await caches.match("/")) ?? Response.error();
    return Response.error();
  }));
});
