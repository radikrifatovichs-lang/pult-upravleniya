"use strict";

// Increase VERSION with every publication so updated files replace the offline copy.
const VERSION = 11;
const CACHE_PREFIX = "pult-upravleniya-v";
const CACHE_NAME = CACHE_PREFIX + VERSION;
const scope = new URL(self.registration.scope);
const appUrl = new URL("index.html", scope);
const assets = [
  "index.html",
  "style.css",
  "app.js",
  "data.json",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
].map((file) => new URL(file, scope).href);
const assetUrls = new Set(assets);

function releaseUrl(address) {
  const url = new URL(address);
  url.searchParams.set("v", VERSION);
  return url.href;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(assets.map((url) => new Request(releaseUrl(url), { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const obsolete = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
    await Promise.all(obsolete.map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;

  const appNavigation = request.mode === "navigate"
    && (url.pathname === scope.pathname || url.pathname === appUrl.pathname);
  if (!appNavigation && !assetUrls.has(url.href)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(releaseUrl(appNavigation ? appUrl.href : url.href));
    return cached || fetch(request);
  })());
});
