// MarkForge live HTTP end-to-end checks against a running offline server.
// Verifies the multi-root grimoire fixes at the HTTP layer (not just page boot):
//   - grimoire CRUD + isolation (doc in grimoire not visible from root)
//   - external grimoire backed by a real folder (written in place)
//   - search scoped to the active grimoire (X-Grimoire-Id header)
//   - asset delivery via ?grimoireId= query param (the <img> fallback)
//   - rename + trash restore on a grimoire doc
// Usage: node scripts/markforge-e2e.cjs
// Requires the server up on 127.0.0.1:3457. Reads APP_PIN from .env to log in.
const fs = require('fs')
const os = require('os')
const path = require('path')

const BASE = process.env.MF_URL || 'http://127.0.0.1:3457'
const ts = Date.now()
const GRIMOIRE = `e2e-test-${ts}`
const EXT_FOLDER = fs.mkdtempSync(path.join(os.tmpdir(), 'markforge-e2e-'))

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
  let h = { ...headers }
  const u = new URL(url, BASE)
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
  if (cookie) h['Cookie'] = cookie
  if (json !== undefined) h['Content-Type'] = 'application/json'
  const res = await fetch(u.toString(), { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined })
  const set = res.headers.get('set-cookie')
  if (set) {
    const m = set.match(/morrow_session=([^;]+)/)
    if (m) cookie = `morrow_session=${m[1]}`
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

  // --- grimoire CRUD --------------------------------------------------------
  const created = await api('POST', '/api/grimoires', { json: { name: GRIMOIRE } })
  check('create grimoire', created.status === 201 && created.body && created.body.id, `status=${created.status}`)
  const grimoireId = created.body?.id
  const g = grimoireId ? { 'X-Grimoire-Id': grimoireId } : {}

  const extCreated = await api('POST', '/api/grimoires', { json: { name: GRIMOIRE + '-ext', path: EXT_FOLDER } })
  check('create external grimoire', extCreated.status === 201 && !!extCreated.body?.id, `status=${extCreated.status}`)
  const extId = extCreated.body?.id
  const eh = extId ? { 'X-Grimoire-Id': extId } : {}

  // --- document write + isolation -----------------------------------------
  const docBody = `# Hello ${ts}\n\nThis is a scoped doc.\n`
  const w = await api('PUT', `/api/files`, { json: { content: docBody }, query: { path: 'note.md' }, headers: g })
  check('write doc in grimoire', w.status === 200, `status=${w.status}`)

  const rooted = await api('GET', `/api/files`, { query: { path: 'note.md' }, headers: g })
  check('read doc from grimoire', rooted.status === 200 && rooted.text.includes('scoped doc'), `status=${rooted.status}`)

  const rootRead = await api('GET', `/api/files`, { query: { path: 'note.md' } })
  check('doc isolated from root', rootRead.status === 404, `root status=${rootRead.status}`)

  // --- external grimoire: written in place ---------------------------------
  const extBody = `# External ${ts}\n\nEdited in place.\n`
  const extWrite = await api('PUT', `/api/files`, { json: { content: extBody }, query: { path: 'extnote.md' }, headers: eh })
  check('write doc in external grimoire', extWrite.status === 200, `status=${extWrite.status}`)
  const onDisk = fs.existsSync(path.join(EXT_FOLDER, 'extnote.md'))
    ? fs.readFileSync(path.join(EXT_FOLDER, 'extnote.md'), 'utf8').includes('Edited in place')
    : null
  check('external grimoire file on disk (in place)', onDisk === true, `onDisk=${String(onDisk)}`)

  // --- search scoping ------------------------------------------------------
  await api('PUT', `/api/files`, { json: { content: '# ZooMarks\n\nquokka polarbear nested\n' }, query: { path: 'searchable.md' }, headers: g })
  const sG = await api('GET', '/api/search', { query: { q: 'quokka' }, headers: g })
  const sRoot = await api('GET', '/api/search', { query: { q: 'quokka' } })
  const gHit = sG.body?.hits?.some((h) => h.path === 'searchable.md')
  const rootHit = sRoot.body?.hits?.some((h) => h.path === 'searchable.md')
  check('search scoped to grimoire', sG.status === 200 && gHit === true, `grimoireHit=${String(gHit)}`)
  check('search not leaking to root', sRoot.status === 200 && rootHit === false, `rootHit=${String(rootHit)}`)

  // --- asset delivery via ?grimoireId= (the <img> fallback) ----------------
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea73fbe2f0000000049454e44ae426082', 'hex')
  const fd = new FormData()
  fd.append('file', new Blob([png], { type: 'image/png' }), 'img.png')
  const up = await fetch(`${BASE}/api/assets`, { method: 'POST', headers: { Cookie: cookie, ...g }, body: fd })
  const upJson = await up.json()
  const assetPath = upJson?.path
  check('upload asset to grimoire', up.status === 201 && !!assetPath, `status=${up.status}, path=${assetPath}`)

  if (assetPath) {
    // header-only fetch
    const viaHeader = await fetch(`${BASE}/api/assets?path=${encodeURIComponent(assetPath)}`, { headers: { Cookie: cookie, ...g } })
    // query-param fetch (what an <img> can actually do — no header)
    const viaQuery = await fetch(`${BASE}/api/assets?path=${encodeURIComponent(assetPath)}&grimoireId=${encodeURIComponent(grimoireId)}`, { headers: { Cookie: cookie } })
    check('asset via header', viaHeader.status === 200 && viaHeader.headers.get('content-type') === 'image/png', `status=${viaHeader.status}`)
    check('asset via ?grimoireId query param', viaQuery.status === 200 && viaQuery.headers.get('content-type') === 'image/png', `status=${viaQuery.status}`)
  }

  // --- rename + trash restore ----------------------------------------------
  const rn = await api('POST', '/api/rename', { json: { from: 'note.md', to: 'renamed.md' }, headers: g })
  check('rename doc in grimoire', rn.status === 200, `status=${rn.status}`)
  const renamed = await api('GET', `/api/files`, { query: { path: 'renamed.md' }, headers: g })
  check('renamed doc readable', renamed.status === 200, `status=${renamed.status}`)

  const del = await api('DELETE', `/api/files`, { query: { path: 'renamed.md' }, headers: g })
  check('delete doc', del.status === 200 && !!del.body?.trashId, `status=${del.status}`)
  const trashId = del.body?.trashId
  if (trashId) {
    const tr = await api('POST', '/api/trash', { json: { id: trashId, action: 'restore' }, headers: g })
    check('trash restore', tr.status === 200, `status=${tr.status}`)
  }

  // --- cleanup ---------------------------------------------------------------
  if (extId) await api('DELETE', `/api/grimoires/${extId}`)
  if (grimoireId) await api('DELETE', `/api/grimoires/${grimoireId}`)
  try { fs.rmSync(EXT_FOLDER, { recursive: true, force: true }) } catch {}
  await api('DELETE', '/api/auth')

  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('E2E FAILED:', e)
  try { fs.rmSync(EXT_FOLDER, { recursive: true, force: true }) } catch {}
  process.exit(1)
})
