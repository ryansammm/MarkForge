import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * Service worker suite.
 *
 * `public/sw.js` runs in a worker, so it is exercised here the only way it can be
 * exercised from Node: the file is evaluated in a `vm` context with a stubbed
 * `self`, `caches` and `fetch`, and its `fetch` listener is called with hand-built
 * events.
 *
 * The property under test is what happens when the network is gone. An offline
 * navigation should get the app shell; an offline request for anything else must
 * get a network error. Handing the HTML shell to a request for `_next/static/
 * chunks/*.js` makes the browser parse `<!DOCTYPE` as JavaScript and report
 * `Uncaught SyntaxError: Unexpected token '<'` once per chunk — a white screen
 * plus an error that points at the wrong thing.
 */

const ORIGIN = 'https://markforge.test'

type FetchEventInit = {
  url: string
  method?: string
  mode?: RequestMode
  destination?: string
}

type Harness = {
  /** Dispatch a fetch event; resolves to the response the worker answered with, or null if it declined. */
  request: (init: FetchEventInit) => Promise<Response | null>
  install: () => Promise<void>
  activate: () => Promise<void>
  /** What `fetch` inside the worker does. Default: reject, as an offline browser does. */
  setNetwork: (fn: (url: string) => Promise<Response>) => void
  cacheNames: () => string[]
  cachedUrls: () => string[]
  /** Plant an entry in a named cache, as a previous version of the worker would have left behind. */
  seed: (cacheName: string, url: string, response: Response) => Promise<void>
  evict: (url: string) => Promise<void>
}

const absolute = (target: string) => new URL(target, ORIGIN).toString()
const keyOf = (target: string | { url: string }) => absolute(typeof target === 'string' ? target : target.url)

function offline(): Promise<Response> {
  return Promise.reject(new TypeError('Failed to fetch'))
}

function loadWorker(): Harness {
  const source = readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8')
  const listeners = new Map<string, (event: unknown) => void>()
  const caches = new Map<string, Map<string, Response>>()
  let network: (url: string) => Promise<Response> = offline

  const cacheFor = (name: string) => {
    const existing = caches.get(name)
    if (existing) return existing
    const created = new Map<string, Response>()
    caches.set(name, created)
    return created
  }

  const open = async (name: string) => {
    const entries = cacheFor(name)
    return {
      put: async (request: string | { url: string }, response: Response) => {
        entries.set(keyOf(request), response)
      },
      match: async (request: string | { url: string }) => entries.get(keyOf(request)),
      addAll: async (urls: string[]) => {
        // Real `addAll` fetches each entry and rejects as a unit if any fails.
        const fetched = await Promise.all(urls.map((url) => network(absolute(url))))
        urls.forEach((url, i) => entries.set(keyOf(url), fetched[i]))
      },
    }
  }

  const cachesStub = {
    open,
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
    match: async (request: string | { url: string }) => {
      for (const entries of caches.values()) {
        const hit = entries.get(keyOf(request))
        if (hit) return hit
      }
      return undefined
    },
  }

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    skipWaiting: () => {},
    clients: { claim: () => {} },
  }

  vm.runInNewContext(source, {
    self,
    caches: cachesStub,
    fetch: (request: { url: string }) => network(keyOf(request)),
    Response,
    URL,
    Promise,
    console,
  })

  // The worker caches without awaiting — `caches.open(...).then(put)` is deliberately
  // fire-and-forget so the response is not held up. Let those settle before asserting.
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

  const lifecycle = async (type: 'install' | 'activate') => {
    const pending: Promise<unknown>[] = []
    listeners.get(type)?.({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) })
    await Promise.all(pending)
  }

  return {
    request: async ({ url, method = 'GET', mode = 'no-cors', destination = '' }) => {
      let answered: Promise<Response> | null = null
      listeners.get('fetch')?.({
        request: { url: absolute(url), method, mode, destination },
        respondWith: (promise: Promise<Response>) => {
          answered = promise
        },
        waitUntil: () => {},
      })
      if (answered === null) return null
      const response = await answered
      await settle()
      return response
    },
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    setNetwork: (fn) => {
      network = fn
    },
    cacheNames: () => [...caches.keys()],
    cachedUrls: () => [...caches.values()].flatMap((entries) => [...entries.keys()]),
    seed: async (cacheName, url, response) => {
      const cache = await open(cacheName)
      await cache.put(url, response)
    },
    evict: async (url) => {
      for (const entries of caches.values()) entries.delete(absolute(url))
    },
  }
}

const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
const script = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/javascript' } })
const navigation = { mode: 'navigate' as RequestMode, destination: 'document' }
const chunk = { mode: 'no-cors' as RequestMode, destination: 'script' }

let passed = 0
const failures: string[] = []

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures.push(`${name}\n      ${(err as Error).message}`)
    console.error(`  FAIL ${name}`)
    console.error(`       ${(err as Error).message}`)
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}\n      expected: ${expected}\n      actual:   ${actual}`)
}

/** Boot a worker that has installed against a live network, then cut the network. */
async function installed() {
  const worker = loadWorker()
  worker.setNetwork(async (url) => (url.endsWith('.svg') || url.endsWith('.webmanifest') ? script('asset') : html('<!DOCTYPE html><title>shell</title>')))
  await worker.install()
  await worker.activate()
  worker.setNetwork(offline)
  return worker
}

async function run() {
  console.log('\nservice worker\n')

  await check('installs the app shell', async () => {
    const worker = await installed()
    const cached = worker.cachedUrls()
    for (const url of ['/', '/manifest.webmanifest', '/icon.svg']) {
      assert(cached.includes(absolute(url)), `${url} was not cached at install`)
    }
  })

  await check('activate drops the cache left by an older version of the worker', async () => {
    const worker = loadWorker()
    // Stale chunks from an earlier deploy live in the cache until the cache name
    // changes, which is the whole reason the name carries a version.
    await worker.seed('markforge-shell-v1', '/_next/static/chunks/stale-000.js', script('/* last deploy */'))
    worker.setNetwork(async () => html('<!DOCTYPE html><title>shell</title>'))
    await worker.install()
    await worker.activate()

    equal(worker.cacheNames().length, 1, 'the old cache survived activation')
    assert(!worker.cachedUrls().some((url) => url.includes('stale-000')), 'a stale chunk survived activation')
  })

  await check('an offline navigation gets the app shell', async () => {
    const worker = await installed()
    const response = await worker.request({ url: '/', ...navigation })
    assert(response, 'the worker declined to handle a navigation')
    equal(response!.type, 'default', 'the navigation got a network error instead of the shell')
    assert((await response!.text()).includes('<!DOCTYPE html>'), 'the shell was not returned')
  })

  await check('an offline navigation to a route with no cached entry still gets the shell', async () => {
    const worker = await installed()
    const response = await worker.request({ url: '/some/deep/route', ...navigation })
    assert((await response!.text()).includes('<!DOCTYPE html>'), 'a deep route did not fall back to the shell')
  })

  await check('an offline, uncached chunk gets a network error — never the HTML shell', async () => {
    const worker = await installed()
    const response = await worker.request({ url: '/_next/static/chunks/main-abc123.js', ...chunk })
    assert(response, 'the worker declined to handle a script request')
    equal(response!.type, 'error', 'a script request was answered with something other than a network error')
    // The regression this suite exists for: HTML handed to a <script> tag.
    const body = await response!.clone().text().catch(() => '')
    assert(!body.includes('<!DOCTYPE'), 'the HTML shell was served in place of a JavaScript chunk')
  })

  await check('an offline stylesheet and image also get a network error', async () => {
    const worker = await installed()
    for (const destination of ['style', 'image', 'font']) {
      const response = await worker.request({ url: `/_next/static/media/x.${destination}`, destination, mode: 'no-cors' })
      equal(response!.type, 'error', `a ${destination} request fell back to the shell`)
    }
  })

  await check('an offline chunk that is cached is served from the cache', async () => {
    const worker = loadWorker()
    worker.setNetwork(async (url) => (url.includes('/chunks/') ? script('console.log(1)') : html('<!DOCTYPE html><title>shell</title>')))
    await worker.install()

    const url = '/_next/static/chunks/main-abc123.js'
    const online = await worker.request({ url, ...chunk })
    equal(await online!.text(), 'console.log(1)', 'the live response was not passed through')

    worker.setNetwork(offline)
    const cached = await worker.request({ url, ...chunk })
    equal(await cached!.text(), 'console.log(1)', 'a cached chunk was not served offline')
  })

  await check('a navigation with no shell in the cache gets a network error, not undefined', async () => {
    const worker = await installed()
    await worker.evict('/')
    const response = await worker.request({ url: '/', ...navigation })
    assert(response instanceof Response, 'respondWith was handed a non-response')
    equal(response!.type, 'error', 'expected a network error when the shell is missing')
  })

  await check('a successful navigation refreshes the cached shell', async () => {
    const worker = await installed()
    worker.setNetwork(async () => html('<!DOCTYPE html><title>shell v2</title>'))
    await worker.request({ url: '/', ...navigation })

    worker.setNetwork(offline)
    const offlineShell = await worker.request({ url: '/', ...navigation })
    assert((await offlineShell!.text()).includes('shell v2'), 'the offline shell is still the one from install')
  })

  await check('a redirect to the login page does not become the cached shell', async () => {
    const worker = await installed()
    worker.setNetwork(async () => {
      const login = html('<!DOCTYPE html><title>login</title>')
      Object.defineProperty(login, 'redirected', { value: true })
      return login
    })
    await worker.request({ url: '/', ...navigation })

    worker.setNetwork(offline)
    const offlineShell = await worker.request({ url: '/', ...navigation })
    assert(!(await offlineShell!.text()).includes('login'), 'the login page was cached as the app shell')
  })

  await check('a non-root navigation does not overwrite the shell', async () => {
    const worker = await installed()
    worker.setNetwork(async () => html('<!DOCTYPE html><title>a shared note</title>'))
    await worker.request({ url: '/share/abc', ...navigation })

    worker.setNetwork(offline)
    const offlineShell = await worker.request({ url: '/', ...navigation })
    assert(!(await offlineShell!.text()).includes('shared note'), 'a /share page was cached as the app shell')
  })

  await check('API responses are never handled or cached', async () => {
    const worker = await installed()
    equal(await worker.request({ url: '/api/documents' }), null, 'the worker handled an API request')
    assert(!worker.cachedUrls().some((url) => url.includes('/api/')), 'an API response reached the cache')
  })

  await check('non-GET and cross-origin requests are left alone', async () => {
    const worker = await installed()
    equal(await worker.request({ url: '/', method: 'POST', ...navigation }), null, 'the worker handled a POST')
    equal(await worker.request({ url: 'https://elsewhere.test/x.js', ...chunk }), null, 'the worker handled a cross-origin request')
  })

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures.`)
    return true
  }
  console.error(`FAIL — ${failures.length} failure(s) of ${passed + failures.length} checks:\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  return false
}

if (require.main === module) {
  run().then((ok) => process.exit(ok ? 0 : 1))
}

export { run as runServiceWorkerTests }
