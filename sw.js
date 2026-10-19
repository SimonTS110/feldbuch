// Feldbuch Service Worker: App offline, besuchte Kartenkacheln werden zwischengespeichert
const VERSION = "feldbuch-v2";
const TILES = "feldbuch-tiles-v1";
const MAX_TILES = 3000;
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "vendor/leaflet.js", "vendor/leaflet.css", "vendor/jszip.min.js", "vendor/shp.min.js", "vendor/togeojson.umd.js",
  "fonts/barlow-latin-400-normal.woff2", "fonts/barlow-latin-500-normal.woff2", "fonts/barlow-latin-600-normal.woff2", "fonts/barlow-condensed-latin-700-normal.woff2",
  "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const isTile = (u) => /geoservices\.bayern\.de|arcgisonline\.com|tile\.openstreetmap\.org/.test(u.hostname);
async function trimTiles() {
  const c = await caches.open(TILES); const ks = await c.keys();
  for (let i = 0; i < ks.length - MAX_TILES; i++) await c.delete(ks[i]);
}
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (isTile(u)) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const r = await fetch(e.request);
        if (r.ok || r.type === "opaque") { c.put(e.request, r.clone()); if (Math.random() < 0.05) trimTiles(); }
        return r;
      } catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  if (u.origin === location.origin) {
    // App-Dateien: erst Netz (damit Updates ankommen), sonst Cache
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cl = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cl)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
  }
});
