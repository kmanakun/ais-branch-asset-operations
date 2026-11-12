// AIS Branch & Asset Operations Service Worker
const CACHE_PREFIX = 'ais-ops-cache-'
const CACHE_NAME = `${CACHE_PREFIX}v2`
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS).catch(() => {})
    })
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    })
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)

  // Strictly handle only same-origin static assets and HTML navigation
  if (url.origin !== self.location.origin) return

  // Never intercept or cache API or auth endpoints
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return

  const isStaticAsset = url.pathname.startsWith('/assets/') ||
    ['script', 'style', 'image', 'font'].includes(event.request.destination) ||
    url.pathname === '/manifest.json' ||
    url.pathname === '/favicon.ico'
  const isNavigation = event.request.mode === 'navigate'

  if (!isStaticAsset && !isNavigation) return

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        fetch(event.request)
          .then(networkResponse => {
            if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
              const clone = networkResponse.clone()
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
            }
          })
          .catch(() => {})
        return cachedResponse
      }

      return fetch(event.request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const clone = networkResponse.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
          }
          return networkResponse
        })
        .catch(async () => {
          if (isNavigation) {
            const fallback = await caches.match('/index.html')
            if (fallback) return fallback
          }
          return new Response('Network error occurred in offline mode', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          })
        })
    })
  )
})
