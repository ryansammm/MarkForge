// MarkForge live HTTP end-to-end checks against a running dev server.
// After grimoire removal: single workspace, no scoping headers, no registry.
//   - document write/read/delete/restore
//   - search across the workspace
//   - asset upload + read
//   - rename + trash restore
//   - notion-parity §16 e2e extension: + new page, page menu Copy, standalone URL
// Usage: node scripts/markforge-e2e.cjs
// Requires the server up on 127.0.0.1:3457. Reads APP_PIN from .env to log in.
const fs = require('fs')
const path = require('path')

const BASE = process.env.MF_URL || 'http://127.0.0.1:3457'
const ts = Date.now()

let cookie = ''
let results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function loadEnvPin() {
  if (process.env.MF_PIN) return process.env.MF_PIN
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8')
    const m = raw.match(/^APP_PIN\s*=\s*(.+)$/m)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  } catch {}
  return null
}

async function api(method, url, { json, query, headers = {} } = {}) {
  const h = { ...headers }
  const u = new URL(url, BASE)
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
  if (cookie) h['Cookie'] = cookie
  if (json !== undefined) h['Content-Type'] = 'application/json'
  const res = await fetch(u.toString(), { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined })
  const set = res.headers.get('set-cookie')
  if (set) {
    const m = set.match(/markforge_session=([^;]+)/)
    if (m) cookie = `markforge_session=${m[1]}`
  }
  let body = null
  const text = await res.text()
  try { body = JSON.parse(text) } catch {}
  return { status: res.status, body, text, headers: res.headers }
}

async function main() {
  // --- auth ---------------------------------------------------------------
  const pin = loadEnvPin()
  if (!pin) {
    console.log('SKIP  live HTTP checks: no APP_PIN in .env (gate likely off)')
    return
  }
  const login = await api('POST', '/api/auth', { json: { pin } })
  check('login sets session', login.status === 200 && !!cookie, `status=${login.status}, cookie=${!!cookie}`)
  if (!cookie) return

  // --- document write + read ---------------------------------------------
  const docBody = `# Hello ${ts}\n\nThis is a workspace doc.\n`
  const w = await api('PUT', `/api/files`, { json: { content: docBody }, query: { path: 'note.md' } })
  check('write doc', w.status === 200, `status=${w.status}`)

  const rooted = await api('GET', `/api/files`, { query: { path: 'note.md' } })
  check('read doc', rooted.status === 200 && rooted.text.includes('workspace doc'), `status=${rooted.status}`)

  // --- search -------------------------------------------------------------
  await api('PUT', `/api/files`, { json: { content: '# ZooMarks\n\nquokka polarbear nested\n' }, query: { path: 'searchable.md' } })
  const sR = await api('GET', '/api/search', { query: { q: 'quokka' } })
  const rHit = sR.body?.hits?.some((h) => h.path === 'searchable.md')
  check('search finds the workspace doc', sR.status === 200 && rHit === true, `hit=${String(rHit)}`)

  // --- asset upload + read ------------------------------------------------
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea73fbe2f0000000049454e44ae426082', 'hex')
  const fd = new FormData()
  fd.append('file', new Blob([png], { type: 'image/png' }), 'img.png')
  const up = await fetch(`${BASE}/api/assets`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
  const upJson = await up.json()
  const assetPath = upJson?.path
  check('upload asset', up.status === 201 && !!assetPath, `status=${up.status}, path=${assetPath}`)

  if (assetPath) {
    const viaHeader = await fetch(`${BASE}/api/assets?path=${encodeURIComponent(assetPath)}`, { headers: { Cookie: cookie } })
    check('asset read via header', viaHeader.status === 200 && viaHeader.headers.get('content-type') === 'image/png', `status=${viaHeader.status}`)
  }

  // --- rename + trash restore --------------------------------------------
  const rn = await api('POST', '/api/rename', { json: { from: 'note.md', to: 'renamed.md' } })
  check('rename doc', rn.status === 200, `status=${rn.status}`)
  const renamed = await api('GET', `/api/files`, { query: { path: 'renamed.md' } })
  check('renamed doc readable', renamed.status === 200, `status=${renamed.status}`)

  const del = await api('DELETE', `/api/files`, { query: { path: 'renamed.md' } })
  check('delete doc', del.status === 200 && !!del.body?.trashId, `status=${del.status}`)
  const trashId = del.body?.trashId
  if (trashId) {
    const tr = await api('POST', '/api/trash', { json: { id: trashId, action: 'restore' } })
    check('trash restore', tr.status === 200, `status=${tr.status}`)
  }

  // --- notion-parity §16 e2e extension ------------------------------------
  // `+ New page` in the sidebar popover: PUT creates a document, the UI
  // then dispatches it as the active tab.
  const newPath = `e2e-newpage-${ts}.md`
  const newBody = `# Created via + popover\n\n${ts}\n`
  const np = await api('PUT', `/api/files`, { json: { content: newBody }, query: { path: newPath } })
  check('+ new page: PUT creates a fresh document', np.status === 200, `status=${np.status}`)
  const npRead = await api('GET', `/api/files`, { query: { path: newPath } })
  check('+ new page: round-trip reads the body back', npRead.status === 200 && npRead.text.includes(String(ts)), `status=${npRead.status}`)

  // Page menu "Copy": GET the source, PUT to a new path.
  const copyPath = `e2e-copy-${ts}.md`
  const copyResp = await api('PUT', `/api/files`, { json: { content: npRead.body.raw }, query: { path: copyPath } })
  check('page menu Copy: GET+PUT duplicates the document', copyResp.status === 200, `status=${copyResp.status}`)
  const copyRead = await api('GET', `/api/files`, { query: { path: copyPath } })
  check('page menu Copy: duplicate has the same body', copyRead.body?.raw === npRead.body.raw, 'body mismatch')

  // Standalone URL — what `electron/main.cjs` opens for `Open in new window`.
  const standalone = await fetch(`${BASE}/?path=${encodeURIComponent(newPath)}&standalone=1`, { headers: { Cookie: cookie } })
  check('desktop tab bar: standalone URL loads the workspace', standalone.status === 200, `status=${standalone.status}`)

  // --- cleanup -------------------------------------------------------------
  if (newPath) await api('DELETE', `/api/files`, { query: { path: newPath } })
  if (copyPath) await api('DELETE', `/api/files`, { query: { path: copyPath } })
  await api('DELETE', '/api/auth')

  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('E2E FAILED:', e)
  process.exit(1)
})
