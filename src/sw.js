// POH Community Portal — minimal service worker.
//
// Purpose: make the app an installable PWA (a registered SW with a fetch handler
// is required for a Trusted Web Activity / Play-Store wrapper). Deliberately
// minimal: network-first for navigations with an offline fallback, and NO
// caching of API/auth/Firestore responses (those must always be live). The app
// itself is served no-cache by Firebase Hosting, so online users always get the
// latest build.
const SHELL_CACHE = "poh-shell-v1";
const OFFLINE_URLS = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(OFFLINE_URLS)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle top-level navigations; everything else (Firestore, Auth,
  // Functions, Storage, CDNs) goes straight to the network, untouched.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
  }
});
