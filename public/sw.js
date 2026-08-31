const CACHE_NAME = 'markforge-shell-v2'
const APP_SHELL = ['/', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)

  // Never cache API responses or user data in the browser's Cache Storage.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && ['script', 'style', 'image', 'font'].includes(event.request.destination)) {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))
        }

        // Keep the offline shell tracking the deployed build. `install` only re-runs
        // when this file's own bytes change, so without this refresh the shell stays
        // whatever was live the first time the worker installed — and an old shell
        // asks for chunk URLs that a newer deploy no longer serves. A redirect means
        // the middleware sent us to /login; that page is not the shell.
        if (response.ok && !response.redirected && event.request.mode === 'navigate' && url.pathname === '/') {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put('/', copy))
        }

        return response
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached

          // Only a navigation may fall back to the app shell. Answering a request for
          // a script with HTML makes the browser parse `<!DOCTYPE` as JavaScript and
          // report `Unexpected token '<'` once per chunk, which buries the actual
          // failure — the network is gone. A network error says exactly that.
          if (event.request.mode === 'navigate') {
            return caches.match('/').then((shell) => shell || Response.error())
          }

          return Response.error()
        }),
      ),
  )
})
