import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * API contract suite for /api/files.
 *
 * Exercises the route handlers directly — no server, no browser. The contract
 * tested here is exactly what the save hook in lib/use-document-save.ts reads:
 * the ETag header, the 409 body shape carrying `actualEtag`, and the WriteResult
 * carrying the rebuilt document. If any of those drift, the editor's save-state
 * indicator starts lying, which is the one thing it must never do.
 *
 * NOTE: the store resolves its roots from env at construction, so NOTES_DIR,
 * META_DIR and INDEX_PATH are set before the route module is imported.
 */

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-api-'))
const notesDir = path.join(workspace, 'notes')
fs.mkdirSync(notesDir, { recursive: true })

process.env.NOTES_DIR = notesDir
process.env.INDEX_PATH = path.join(workspace, 'index.json')
// Without META_DIR the trash defaults to process.cwd(), so deleting a document in a
// test writes .trash/ into the repository being tested.
process.env.META_DIR = workspace

let passed = 0
const failures: string[] = []

async function check(name: string, fn: () => Promise<void>) {
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
  }
}

const BASE = 'http://localhost/api/files'

function request(url: string, init?: RequestInit) {
  // The route handlers take a NextRequest; a Request with nextUrl attached is
  // enough for the surface they actually use.
  const req = new Request(url, init) as Request & { nextUrl: URL }
  Object.defineProperty(req, 'nextUrl', { value: new URL(url), writable: false })
  return req
}

async function run() {
  console.log('API contract suite (/api/files)\n')

  const route = await import('../app/api/files/route')
  type Handler = (req: never) => Promise<Response>
  const GET = route.GET as unknown as Handler
  const PUT = route.PUT as unknown as Handler
  const POST = route.POST as unknown as Handler
  const DELETE = route.DELETE as unknown as Handler

  const put = (p: string, content: string, headers: Record<string, string> = {}) =>
    PUT(
      request(`${BASE}?path=${encodeURIComponent(p)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ content }),
      }) as never
    )

  const get = (p: string) => GET(request(`${BASE}?path=${encodeURIComponent(p)}`) as never)
  const readRaw = (p: string) => fs.readFileSync(path.join(notesDir, p), 'utf-8')

  let firstEtag = ''

  await check('PUT creates a document and returns its etag', async () => {
    const res = await put('Note.md', '# Note\n\nLinks to [[Other]].\n')
    equal(res.status, 200, 'unexpected status')

    const body = (await res.json()) as { etag: string; document: { title: string; outboundLinks: string[] } }
    assert(body.etag, 'no etag in body')
    equal(res.headers.get('ETag'), `"${body.etag}"`, 'ETag header does not match body')
    equal(body.document.title, 'Note', 'title not derived')
    equal(body.document.outboundLinks, ['Other'], 'links not extracted')
    firstEtag = body.etag
  })

  await check('GET returns the raw file text, frontmatter included', async () => {
    await put('WithMeta.md', '---\ntitle: Meta\n---\n\n# Body\n')
    const res = await get('WithMeta.md')
    equal(res.status, 200, 'unexpected status')

    const body = (await res.json()) as { raw: string; document: { content: string; title: string } }
    assert(body.raw.startsWith('---\n'), 'raw is missing the frontmatter block')
    assert(!body.document.content.includes('title: Meta'), 'index content should have frontmatter stripped')
    equal(body.document.title, 'Meta', 'frontmatter title not used')
  })

  await check('PUT with a matching If-Match succeeds and rotates the etag', async () => {
    const res = await put('Note.md', '# Note\n\nEdited.\n', { 'If-Match': `"${firstEtag}"` })
    equal(res.status, 200, 'unexpected status')
    const body = (await res.json()) as { etag: string }
    assert(body.etag !== firstEtag, 'etag did not change after an edit')
    firstEtag = body.etag
  })

  await check('PUT with a stale If-Match returns 409 with the current etag', async () => {
    const res = await put('Note.md', 'clobber\n', { 'If-Match': '"stale-etag"' })
    equal(res.status, 409, 'should be 409 Conflict')

    const body = (await res.json()) as { code: string; actualEtag: string; expectedEtag: string }
    equal(body.code, 'CONFLICT', 'wrong error code')
    equal(body.expectedEtag, 'stale-etag', 'expectedEtag not echoed')
    equal(body.actualEtag, firstEtag, 'actualEtag is not the live etag')

    const onDisk = fs.readFileSync(path.join(notesDir, 'Note.md'), 'utf-8')
    assert(!onDisk.includes('clobber'), 'refused write still modified the file')
  })

  await check('unquoted If-Match is accepted too', async () => {
    const res = await put('Note.md', '# Note\n\nAgain.\n', { 'If-Match': firstEtag })
    equal(res.status, 200, 'bare etag should be accepted')
    firstEtag = ((await res.json()) as { etag: string }).etag
  })

  await check('GET of a missing document is 404', async () => {
    equal((await get('Nope.md')).status, 404, 'should be 404')
  })

  await check('a path escaping the workspace is 400', async () => {
    equal((await put('../escape.md', 'x')).status, 400, 'should be 400')
  })

  await check('a non-string body is 400', async () => {
    const res = await PUT(
      request(`${BASE}?path=Note.md`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 42 }),
      }) as never
    )
    equal(res.status, 400, 'should be 400')
  })

  await check('POST moves a document', async () => {
    await put('Move/From.md', '# From\n')
    const res = await POST(
      request(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Move/From.md', to: 'Move/To.md' }),
      }) as never
    )
    equal(res.status, 200, 'unexpected status')
    equal(((await res.json()) as { path: string }).path, 'Move/To.md', 'wrong resulting path')
    assert(fs.existsSync(path.join(notesDir, 'Move', 'To.md')), 'file not moved on disk')
  })

  await check('DELETE removes a document', async () => {
    await put('Trash.md', 'bye\n')
    const res = await DELETE(request(`${BASE}?path=Trash.md`, { method: 'DELETE' }) as never)
    equal(res.status, 200, 'unexpected status')
    assert(!fs.existsSync(path.join(notesDir, 'Trash.md')), 'file still on disk')
  })

  await check('DELETE with a stale If-Match is refused', async () => {
    await put('Keep.md', 'keep\n')
    const res = await DELETE(
      request(`${BASE}?path=Keep.md`, { method: 'DELETE', headers: { 'If-Match': '"wrong"' } }) as never
    )
    equal(res.status, 409, 'should be 409')
    assert(fs.existsSync(path.join(notesDir, 'Keep.md')), 'file deleted despite conflict')
  })

  await check('a refused save reports where the rejected content went', async () => {
    // The client renders `conflictPath` as a link. If it stops coming back, the
    // conflict copy still exists but nothing tells the user it does.
    const created = await put('Contested.md', '# One\n')
    const etag = ((await created.json()) as { etag: string }).etag
    await put('Contested.md', '# Two\n')

    const res = await put('Contested.md', '# Three\n', { 'If-Match': `"${etag}"` })
    equal(res.status, 409, 'should be 409')

    const body = (await res.json()) as { conflictPath?: string; actualEtag?: string }
    equal(body.conflictPath, 'Contested.conflict.md', 'the conflict path is missing from the 409 body')
    assert(body.actualEtag, 'the current etag is missing from the 409 body')
    assert(readRaw('Contested.conflict.md').includes('Three'), 'the conflict copy is not on disk')
  })

  await check('a document over the size cap is refused with 413', async () => {
    // Being authenticated is not a limit. Without a cap, one client — or one runaway
    // loop in a browser tab — can fill a bucket that bills by what is in it.
    const oversized = 'x'.repeat(1024 * 1024 + 1024)
    const res = await put('Huge.md', oversized)

    equal(res.status, 413, 'an oversized document was not refused')
    equal(((await res.json()) as { code: string }).code, 'PAYLOAD_TOO_LARGE', 'wrong error code')
    assert(!fs.existsSync(path.join(notesDir, 'Huge.md')), 'the oversized document was written anyway')
  })

  await check('a body that is not JSON is a 400, not a 500', async () => {
    const res = await PUT(
      request(`${BASE}?path=Broken.md`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all',
      }) as never
    )
    equal(res.status, 400, 'malformed JSON should be a client error')
  })

  // --- trash ----------------------------------------------------------------

  const trash = await import('../app/api/trash/route')
  const trashGET = ((req: never) => trash.GET(req as never)) as unknown as (req: Request) => Promise<Response>
  const trashPOST = trash.POST as unknown as Handler

  await check('DELETE reports a trash id, and the entry is listed', async () => {
    await put('Recoverable.md', '# Recoverable\n\nwork\n')
    const res = await DELETE(request(`${BASE}?path=Recoverable.md`, { method: 'DELETE' }) as never)

    const body = (await res.json()) as { ok: boolean; trashId: string | null }
    assert(body.trashId, 'no trash id — the delete cannot be undone')

    const listed = (await (await trashGET(request('http://localhost/api/trash') as never)).json()) as { entries: Array<{ id: string; label: string }> }
    assert(
      listed.entries.some((entry) => entry.id === body.trashId && entry.label === 'Recoverable.md'),
      'the deleted document is not in the trash listing'
    )
  })

  await check('POST /api/trash restores the document to disk', async () => {
    await put('Restorable.md', '# Restorable\n\nvaluable\n')
    const deleted = (await (
      await DELETE(request(`${BASE}?path=Restorable.md`, { method: 'DELETE' }) as never)
    ).json()) as { trashId: string }

    const res = await trashPOST(
      request('http://localhost/api/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleted.trashId }),
      }) as never
    )
    equal(res.status, 200, 'unexpected status')

    const body = (await res.json()) as { restored: string[]; skipped: string[] }
    equal(body.restored, ['Restorable.md'], 'wrong files restored')
    assert(readRaw('Restorable.md').includes('valuable'), 'the file is not back on disk')
  })

  await check('restoring an unknown entry is a 404, not a 500', async () => {
    const res = await trashPOST(
      request('http://localhost/api/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'no-such-entry' }),
      }) as never
    )
    equal(res.status, 404, 'unexpected status')
  })

  // --- folders --------------------------------------------------------------

  const folders = await import('../app/api/folders/route')
  const folderPUT = folders.PUT as unknown as Handler
  const folderPOST = folders.POST as unknown as Handler
  const folderDELETE = folders.DELETE as unknown as Handler

  const FOLDERS = 'http://localhost/api/folders'

  await check('PUT creates a nested folder', async () => {
    const res = await folderPUT(
      request(`${FOLDERS}?path=${encodeURIComponent('Projects/Active')}`, { method: 'PUT' }) as never
    )
    equal(res.status, 200, 'unexpected status')
    equal(((await res.json()) as { path: string }).path, 'Projects/Active', 'wrong path')
    assert(fs.existsSync(path.join(notesDir, 'Projects', 'Active')), 'folder not created')
  })

  await check('POST moves a folder and reports what moved', async () => {
    await put('Projects/Active/Task.md', '# Task\n')
    const res = await folderPOST(
      request(FOLDERS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Projects/Active', to: 'Projects/Done' }),
      }) as never
    )
    equal(res.status, 200, 'unexpected status')
    const body = (await res.json()) as { path: string; moved: string[] }
    equal(body.path, 'Projects/Done', 'wrong destination')
    equal(body.moved, ['Projects/Active/Task.md'], 'wrong documents reported')
    assert(fs.existsSync(path.join(notesDir, 'Projects', 'Done', 'Task.md')), 'not moved on disk')
  })

  await check('DELETE removes a folder and everything under it', async () => {
    const res = await folderDELETE(
      request(`${FOLDERS}?path=${encodeURIComponent('Projects')}`, { method: 'DELETE' }) as never
    )
    equal(res.status, 200, 'unexpected status')
    equal(((await res.json()) as { removed: string[] }).removed, ['Projects/Done/Task.md'], 'wrong contents')
    assert(!fs.existsSync(path.join(notesDir, 'Projects')), 'folder still on disk')
  })

  await check('a folder path escaping the workspace is 400', async () => {
    const res = await folderPUT(
      request(`${FOLDERS}?path=${encodeURIComponent('../escape')}`, { method: 'PUT' }) as never
    )
    equal(res.status, 400, 'should be 400')
  })

  // --- rename ---------------------------------------------------------------

  const rename = await import('../app/api/rename/route')
  const renamePOST = rename.POST as unknown as Handler
  const RENAME = 'http://localhost/api/rename'

  const renameRequest = (from: string, to: string, query = '') =>
    renamePOST(
      request(`${RENAME}${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      }) as never
    )

  await check('dry run returns the changeset without writing', async () => {
    await put('Subject.md', '# Subject\n')
    await put('linker-one.md', '# one\n\n[[Subject]]\n')
    await put('linker-two.md', '# two\n\n[[Subject]] twice [[Subject]]\n')

    const res = await renameRequest('Subject.md', 'Renamed.md', '?dryRun=1')
    equal(res.status, 200, 'unexpected status')

    const { plan } = (await res.json()) as { plan: { edits: { path: string; occurrences: number }[] } }
    equal(plan.edits.length, 2, 'wrong number of planned edits')
    equal(plan.edits.map((e) => e.path).sort(), ['linker-one.md', 'linker-two.md'], 'wrong files')
    equal(plan.edits.find((e) => e.path === 'linker-two.md')?.occurrences, 2, 'occurrence count wrong')

    assert(fs.existsSync(path.join(notesDir, 'Subject.md')), 'dry run renamed the file')
    assert(readRaw('linker-one.md').includes('[[Subject]]'), 'dry run rewrote a link')
  })

  await check('rename rewrites links and reports per file', async () => {
    const res = await renameRequest('Subject.md', 'Renamed.md')
    equal(res.status, 200, 'unexpected status')

    const { report, summary } = (await res.json()) as {
      report: { renamed: boolean; updatedCount: number; failedCount: number }
      summary: string
    }
    assert(report.renamed, 'document was not renamed')
    equal(report.failedCount, 0, 'unexpected failures')
    equal(report.updatedCount, 2, 'wrong update count')
    equal(
      summary,
      // The trailing sentence is the heading rewrite reporting itself: renaming the
      // file also renames the H1 the document is titled by, or the rename stays
      // invisible everywhere the app shows a title. See lib/server/rename.ts.
      'Renamed. 2 of 2 linking documents updated. The heading now reads the new name.',
      'unexpected summary'
    )

    assert(readRaw('linker-one.md').includes('[[Renamed]]'), 'link not rewritten')
    assert(fs.existsSync(path.join(notesDir, 'Renamed.md')), 'file not renamed on disk')
  })

  await check('renaming something that does not exist is 404', async () => {
    equal((await renameRequest('Ghost.md', 'Other.md')).status, 404, 'should be 404')
  })

  await check('a malformed rename body is 400', async () => {
    const res = await renamePOST(
      request(RENAME, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'only-one.md' }),
      }) as never
    )
    equal(res.status, 400, 'should be 400')
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

run()
  .then((ok) => {
    fs.rmSync(workspace, { recursive: true, force: true })
    process.exit(ok ? 0 : 1)
  })
  .catch((err) => {
    console.error(err)
    fs.rmSync(workspace, { recursive: true, force: true })
    process.exit(1)
  })
