// AIS Branch & Asset Operations Service Worker
const CACHE_NAME = 'ais-ops-cache-v1'
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
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    })
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  // Only cache GET requests for same origin static assets
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
          }
          return response
        })
        .catch(async () => {
          const cached = await caches.match(event.request)
          if (cached) return cached
          if (event.request.headers.get('accept')?.includes('text/html')) {
            return caches.match('/index.html')
          }
          return new Response('Network error occurred in offline mode', { status: 503 })
        })
    )
  }
})
