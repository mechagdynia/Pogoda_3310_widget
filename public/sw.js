const VERSION = 'pogoda3310-v4';
const SHELL_CACHE = VERSION + '-shell';
const API_CACHE = VERSION + '-api';

const API_HOSTS = [
  'api.open-meteo.com',
  'geocoding-api.open-meteo.com',
  'api.met.no',
  'api.weatherapi.com',
  'api.bigdatacloud.net',
];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (API_HOSTS.includes(url.hostname)) {
    const isForecast =
      url.hostname === 'api.open-meteo.com' ||
      url.hostname === 'api.met.no' ||
      url.hostname === 'api.weatherapi.com';
    event.respondWith(isForecast ? networkFirst(req, API_CACHE) : staleWhileRevalidate(req));
  } else if (url.origin === self.location.origin) {
    event.respondWith(req.mode === 'navigate' ? networkFirst(req, SHELL_CACHE) : cacheFirst(req));
  }
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    return cached || Response.error();
  }
}
