// Application shell only: account/API responses belong to the owner-scoped IDB layer.
const CACHE = "archery-shell-v4-20260930";
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];
const isAsset = (url) => url.origin === self.location.origin
  && !url.search && (/^\/assets\/[\w.-]+\.(js|css|woff2?|png|svg|webp)$/.test(url.pathname)
    || ["/manifest.webmanifest", "/icon.svg"].includes(url.pathname));
self.addEventListener("install", (event) => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(APP_SHELL);
  const html = await (await cache.match("/index.html")).text();
  const assets = [...new Set([...html.matchAll(/(?:src|href)=["'](\/assets\/[^"'?]+)["']/g)].map(match => match[1]))];
  await cache.addAll(assets.filter(asset => isAsset(new URL(asset, self.location.origin))));
  await self.skipWaiting();
})()));
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  // Shell-only caches may be replaced safely; owner-scoped IDB records are untouched.
  await Promise.all(["archery-shell-v1", "archery-shell-v2-20260907", "archery-shell-v3-20260909"].map((key) => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener("fetch", (event) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin
    || request.headers.has("Authorization") || url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/auth/") || request.cache === "no-store") return;
  if (request.mode === "navigate") {
    // The root PWA owns only its own shell. /next/ and /get-app/ must keep their own HTML.
    if (url.pathname !== "/" && url.pathname !== "/index.html") return;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.headers.get("Content-Type")?.includes("text/html")) {
          await cache.put("/index.html", response.clone());
        }
        return response;
      } catch {
        return (await cache.match("/index.html")) || Response.error();
      }
    })());
  } else if (isAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE), cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type !== "opaque") await cache.put(request, response.clone());
      return response;
    })());
  }
});
