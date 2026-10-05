// Vaneskald Engine — Service Worker
// Strategy:
//   • App shell (HTML, JS, CSS, fonts, icons, manifest): Cache-first with
//     network fallback. Stale assets are refreshed in the background.
//   • API calls (/api/*): Network-first with no caching (auth-sensitive).
//   • Offline fallback: Serves the cached index.html for navigation requests
//     when the network is unavailable, enabling a degraded offline state.

const CACHE_NAME = 'lce-shell-v1';

// Resources to pre-cache on install (app shell).
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon.svg',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
];

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────
// Clean up stale caches from previous versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) return;

  // API calls: network-first, no caching (may carry auth tokens).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Navigation requests: serve app shell (index.html) from cache when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache the fresh HTML response for offline use.
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          // Offline fallback: serve the cached root page.
          caches.match('/').then(
            (cached) =>
              cached ||
              new Response('<h1>Offline</h1><p>Please reconnect to use the Vaneskald Engine.</p>', {
                headers: { 'Content-Type': 'text/html' },
              })
          )
        )
    );
    return;
  }

  // Static assets: cache-first, update in background (stale-while-revalidate).
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
      return cached || fetchPromise;
    })
  );
});

// ─── Web Push (LCE-108, deep links LCE-257) ───────────────────────────────────
// The engine taps the user on the shoulder: posted-live, render failed, paused.
// Payload shape (JSON): { title, body, url, tag, data? } — see lib/pushLinks.js.
// `url` is the pre-resolved deep link (e.g. /dashboard?content=<id>&brand=<id>);
// `data` carries the same context structurally ({ type, contentId, brandId }) so
// the tap lands on the exact screen (the app reads the query params to activate
// the brand and open the detail modal).
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Vaneskald Engine', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Vaneskald Engine';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'lce',
      // Persist the deep-link url plus the structured context onto the
      // notification so notificationclick can route the tap (LCE-257).
      data: { url: data.url || '/dashboard', ...(data.data || {}) },
    })
  );
});

// Tapping the notification focuses an open app window (and navigates it) or
// opens a fresh one at the notification's deep link (LCE-257). An unknown or
// missing payload falls back to the app root exactly as before.
// NOTE: WindowClient.navigate() is a FULL document navigation (the SPA
// remounts), so mount-time deep-link consumption always runs — but the app
// also re-reads params on router navigations, so a future switch to soft
// routing (postMessage + client-side navigate) won't break deep links.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/dashboard';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if ('focus' in win) {
          win.focus();
          if ('navigate' in win) win.navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
