/* Service worker for /mobile: keeps the app shell and the versioned map available offline.
   It never caches live guidance (/api/stream, participant actions): an old route must not look current.
   It does not track position or keep a connection while the app is closed. */
// Registered with scope "/mobile": it controls only the mobile pages, never the 3D dashboard.
const SHELL = "skr-evac-shell-v1";
const MAP = "skr-evac-map-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(["/mobile", "/mobile.webmanifest", "/assets/skr-school-emblem.png"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL && key !== MAP).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname === "/api/map") {
    // Network first; the cached copy is the static plan only (carries its mapVersion).
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) { const copy = response.clone(); caches.open(MAP).then((cache) => cache.put("/api/map", copy)); }
      return response;
    }).catch(() => caches.match("/api/map").then((cached) => cached || new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "content-type": "application/json" } }))));
    return;
  }
  if (url.pathname.startsWith("/api/")) return; // live data: network only
  const isShell = url.pathname === "/mobile" || url.pathname === "/mobile.html" || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/") || url.pathname === "/mobile.webmanifest";
  if (!isShell) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) { const copy = response.clone(); caches.open(SHELL).then((cache) => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || caches.match("/mobile"))));
});
