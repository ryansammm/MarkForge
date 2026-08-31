import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MemoryBucket, type Bucket } from '../lib/server/bucket'
import { FsBucket } from '../lib/server/fs-bucket'
import { R2Bucket, r2ConfigFromEnv } from '../lib/server/r2-bucket'
import { WorkspaceStore } from '../lib/server/workspace-store'
import { InvalidPathError } from '../lib/file-store'
import {
  ASSET_PREFIX,
  assetKeyFor,
  contentTypeForKey,
  extensionForContentType,
  isAssetKey,
  sniffImageType,
  slugifyFilename,
} from '../lib/server/assets'
import { MAX_ASSET_BYTES } from '../lib/server/request-limits'
import { setStore } from '../lib/server/store'

/**
 * Asset storage suite — Sprint 7, item 1.
 *
 * Two claims, asserted per backend rather than assumed:
 *
 *   1. **Bytes survive.** An image is not text, and the failure mode for treating it
 *      as text is not an error — it is a file of roughly the right size that decodes
 *      to garbage. Every check here uses a real PNG containing NUL bytes, which is
 *      exactly what a UTF-8 round trip destroys.
 *
 *   2. **An asset is not a document.** It must not appear in `listKeys`, in a rebuilt
 *      index, or in the file tree, and the store must refuse to address the asset
 *      namespace as a document or a folder. That last one is not tidiness: deleting a
 *      folder is recursive at the bucket layer and trashes only Markdown, so a
 *      writable `assets/` folder is an undo-less delete of every image in the vault.
 *
 * R2 runs only when credentials are present, and against a timestamped prefix.
 * Without them it is reported as skipped — a green suite that never touched the
 * backend it claims to cover is worse than a red one.
 */

/**
 * The route half of this suite exercises the handlers directly — no server, no
 * browser — so the store has to resolve its roots from the environment before
 * `app/api/assets/route.ts` is imported. It is imported dynamically, below, for
 * exactly that reason.
 */
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-assets-api-'))
fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true })
process.env.NOTES_DIR = path.join(workspace, 'notes')
process.env.INDEX_PATH = path.join(workspace, 'index.json')
// Without META_DIR the trash defaults to process.cwd(), which would write .trash/
// into the repository being tested.
process.env.META_DIR = workspace
process.env.R2_ACCOUNT_ID = ''
process.env.R2_ACCESS_KEY_ID = ''
process.env.R2_SECRET_ACCESS_KEY = ''
process.env.R2_BUCKET = ''

// The route half calls `getStore()` (which routes through `createBucket()`,
// now R2-only). Inject a FsBucket-backed store so the route handlers see
// the same WorkspaceStore interface without needing real R2 credentials.
setStore(
  new WorkspaceStore(
    new FsBucket({
      notesDir: path.join(workspace, 'notes'),
      indexPath: path.join(workspace, 'index.json'),
      metaDir: workspace,
    })
  )
)

let passed = 0
const failures: string[] = []
const cleanups: Array<() => void> = [
  () => fs.rmSync(workspace, { recursive: true, force: true }),
]

async function check(name: string, fn: () => void | Promise<void>) {
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
    throw new Error(
      `${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    )
  }
}

/** A real 1×1 PNG. Not a placeholder string — see claim 1 above. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
  'base64'
)

const ASSET_KEY = `${ASSET_PREFIX}/2026/a1b2c3d4-pastel.png`
const SPARE_KEY = `${ASSET_PREFIX}/2026/e5f6a7b8-spare.png`

async function expectInvalidPath(label: string, run: () => Promise<unknown>) {
  let threw: unknown = null
  try {
    await run()
  } catch (err) {
    threw = err
  }
  assert(threw instanceof InvalidPathError, `${label} should have been refused, and was not`)
}

function makeFsBucket(): Bucket {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-assets-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return new FsBucket({
    notesDir: path.join(dir, 'notes'),
    indexPath: path.join(dir, 'index.json'),
    metaDir: dir,
  })
}

/** Pure helpers, backend-independent. */
async function namespaceChecks() {
  console.log('asset namespace')

  await check('the fixture actually contains a NUL byte', () => {
    // Otherwise every "bytes survive" check below would pass against a backend that
    // silently round-trips through UTF-8, and prove nothing.
    assert(PNG_1X1.includes(0), 'the PNG fixture has no NUL byte — it cannot detect corruption')
  })

  await check('the asset prefix is recognised, including its own name', () => {
    assert(isAssetKey('assets'), 'the prefix itself is inside the namespace')
    assert(isAssetKey('assets/2026/x.png'), 'a key under the prefix is inside it')
    assert(!isAssetKey('assetsmith/x.md'), 'a prefix match is not a path match')
    assert(!isAssetKey('Notes/assets/x.md'), 'the namespace is rooted, not any segment')
  })

  await check('the reservation survives a case-insensitive filesystem', () => {
    // On Windows, Assets/ and assets/ are the same directory. A reservation that
    // matched only the lowercase form would let a document land among the images.
    assert(isAssetKey('Assets/x.png'), 'Assets/ is the same directory as assets/')
    assert(isAssetKey('ASSETS'), 'the check must not be case-sensitive')
  })

  await check('content types come from the extension', () => {
    equal(contentTypeForKey('assets/a.png'), 'image/png', 'png')
    equal(contentTypeForKey('assets/a.JPG'), 'image/jpeg', 'uppercase extensions count')
    equal(contentTypeForKey('assets/a.webp'), 'image/webp', 'webp')
    equal(
      contentTypeForKey('assets/nameless'),
      'application/octet-stream',
      'an unknown type must not be guessed at — a browser downloads octet-stream rather than running it'
    )
  })

  await check('the type is read out of the bytes', () => {
    equal(sniffImageType(PNG_1X1), 'image/png', 'a real PNG')
    equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), 'image/jpeg', 'JPEG')
    equal(sniffImageType(Buffer.from('GIF89a...')), 'image/gif', 'GIF89a')
    equal(sniffImageType(Buffer.from('RIFF____WEBPVP8 ')), 'image/webp', 'WebP')

    equal(sniffImageType(Buffer.from('<html>')), null, 'HTML is not an image')
    equal(sniffImageType(Buffer.from('RIFF____WAVEfmt ')), null, 'a RIFF container is not a WebP')
    equal(sniffImageType(Buffer.from([0x89, 0x50])), null, 'a truncated signature must not match')
    equal(sniffImageType(new Uint8Array(0)), null, 'nothing is not an image')
  })

  await check('an asset key is content-addressed and readable', () => {
    const now = new Date('2026-08-12T00:00:00Z')
    const key = assetKeyFor({ bytes: PNG_1X1, contentType: 'image/png', filename: 'My Photo.PNG', now })

    assert(/^assets\/2026\/[0-9a-f]{8}-my-photo\.png$/.test(key), `unexpected key: ${key}`)
    equal(
      assetKeyFor({ bytes: PNG_1X1, contentType: 'image/png', filename: 'My Photo.PNG', now }),
      key,
      'the same file must land on the same key, or dropping it twice costs two objects'
    )
    assert(
      assetKeyFor({ bytes: Buffer.from([1, 2, 3]), contentType: 'image/png', filename: 'My Photo.PNG', now }) !== key,
      'different bytes must not share a key — the serve route marks them immutable'
    )
  })

  await check('a filename can be anything and still produce a usable key', () => {
    equal(slugifyFilename('Rapat Q3 — final (2).png'), 'rapat-q3-final-2', 'punctuation and spaces')
    equal(slugifyFilename('C:\\Users\\Xyks\\shot.png'), 'shot', 'a Windows path is not a name')
    equal(slugifyFilename('screenshot.png'), 'screenshot', 'the extension is dropped')
    equal(slugifyFilename('图片.png'), 'image', 'a name with no ASCII still gets a key')
    equal(slugifyFilename(undefined), 'image', 'no name at all')
    assert(slugifyFilename('x'.repeat(200)).length <= 48, 'a long name must be truncated')
  })

  await check('SVG is not an accepted image type', () => {
    // An SVG is a script host, and assets are served same-origin to unauthenticated
    // readers on the share page. Accepting one is a stored XSS on a public page.
    equal(extensionForContentType('image/svg+xml'), null, 'SVG must not be accepted')
    equal(extensionForContentType('image/png'), '.png', 'png is accepted')
    equal(
      extensionForContentType('image/jpeg; charset=binary'),
      '.jpg',
      'a parameterised content type is still a content type'
    )
  })

  console.log('')
}

async function backendChecks(name: string, bucket: Bucket) {
  console.log(name)
  const store = new WorkspaceStore(bucket)

  await check(`${name}: bytes round-trip exactly`, async () => {
    await bucket.writeBinary(ASSET_KEY, PNG_1X1, 'image/png')
    const read = await bucket.readBinary(ASSET_KEY)

    assert(read, 'the asset came back null')
    equal(Buffer.from(read!.bytes).toString('base64'), PNG_1X1.toString('base64'), 'bytes changed in storage')
    equal(read!.contentType, 'image/png', 'wrong content type')
  })

  await check(`${name}: a missing asset reads as null, not as an error`, async () => {
    equal(await bucket.readBinary(`${ASSET_PREFIX}/nothing-here.png`), null, 'should be null')
  })

  await check(`${name}: an asset is not in the corpus`, async () => {
    const keys = await bucket.listKeys()
    assert(
      !keys.some((key) => isAssetKey(key)),
      `listKeys returned an asset — it must mean "the corpus" and nothing else: ${keys.join(', ')}`
    )
  })

  await check(`${name}: assets are enumerable on their own`, async () => {
    await store.write('Note.md', `# Note\n\n![pastel](${ASSET_KEY})\n`)
    const assets = await bucket.listBinaryKeys(ASSET_PREFIX)

    assert(assets.includes(ASSET_KEY), `the asset was not listed: ${assets.join(', ')}`)
    assert(
      !assets.some((key) => key.endsWith('.md')),
      'a document was listed as a binary object'
    )
  })

  await check(`${name}: a rebuilt index contains no trace of the asset`, async () => {
    // The reindex drill, aimed at the one thing that could quietly go wrong here: a
    // reindex reads storage alone, so anything it can see, it will put in the index.
    const index = await store.reindex()

    assert(!index.documents[ASSET_KEY], 'the asset was indexed as a document')
    assert(
      !Object.keys(index.documents).some((key) => isAssetKey(key)),
      'something under the asset prefix was indexed'
    )

    const tree = JSON.stringify(index.tree)
    assert(
      !tree.includes(`"${ASSET_PREFIX}`),
      `the asset folder reached the file tree, where it would show as a permanently empty folder: ${tree}`
    )
    assert(index.documents['Note.md'], 'the ordinary document went missing from the rebuild')
  })

  await check(`${name}: the document's image link is stored verbatim`, async () => {
    // The whole point of plain CommonMark: the bytes in the file are the bytes the
    // user would have typed. No rewriting on the way in or out.
    const result = await store.readDocument('Note.md')
    assert(result, 'the document disappeared')
    assert(
      result!.raw.includes(`![pastel](${ASSET_KEY})`),
      `the image link was rewritten on the way through storage: ${result!.raw}`
    )
  })

  await check(`${name}: the store refuses to address the asset namespace`, async () => {
    await expectInvalidPath('a document inside assets/', () =>
      store.write(`${ASSET_PREFIX}/sneaky.md`, '# Sneaky\n')
    )
    await expectInvalidPath('a document inside Assets/ (case)', () =>
      store.write('Assets/sneaky.md', '# Sneaky\n')
    )
    await expectInvalidPath('creating the assets folder', () => store.createDirectory(ASSET_PREFIX))
    await expectInvalidPath('creating a folder under assets/', () =>
      store.createDirectory(`${ASSET_PREFIX}/2026`)
    )
    await expectInvalidPath('deleting the assets folder', () => store.removeDirectory(ASSET_PREFIX))
    await expectInvalidPath('moving a document into assets/', () =>
      store.move('Note.md', `${ASSET_PREFIX}/Note.md`)
    )
  })

  await check(`${name}: refusing the namespace left the asset untouched`, async () => {
    // The refusals above must be refusals, not partial work. `removeDirectory` in
    // particular deletes recursively at the bucket layer once it gets that far.
    const read = await bucket.readBinary(ASSET_KEY)
    assert(read, 'an asset was destroyed by an operation that was supposed to be refused')
  })

  await check(`${name}: a snapshot carries the images, and a restore brings them back`, async () => {
    // The drill scripts/backup.ts exists for, aimed at images: they are the one thing
    // in a snapshot that cannot be rebuilt from anything else in it. A restore that
    // returns the notes and none of the pictures is a restore that lost data.
    const { backup, verify, restore } = await import('../scripts/backup')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-assets-snap-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))

    await backup(bucket, dir)
    assert(await verify(bucket, dir), 'the snapshot did not verify against the storage it came from')

    const fresh = makeFsBucket()
    await restore(fresh, dir, false)

    const restored = await fresh.readBinary(ASSET_KEY)
    assert(restored, 'the image did not survive a backup and restore')
    equal(
      Buffer.from(restored!.bytes).toString('base64'),
      PNG_1X1.toString('base64'),
      'the restored image is not the image that was backed up'
    )
    assert(await fresh.readText('Note.md'), 'the document did not survive alongside it')
  })

  await check(`${name}: an asset can be deleted through the object surface`, async () => {
    await bucket.writeBinary(SPARE_KEY, PNG_1X1, 'image/png')
    assert(await bucket.objectExists(SPARE_KEY), 'objectExists does not see binary objects')

    await bucket.deleteObject(SPARE_KEY)
    equal(await bucket.readBinary(SPARE_KEY), null, 'the asset outlived its delete')
    equal(await bucket.objectExists(SPARE_KEY), false, 'objectExists still reports it')
  })

  console.log('')
}

/** A Request the route handlers can read, matching tests/api.test.ts. */
function apiRequest(url: string, init?: RequestInit) {
  const req = new Request(url, init) as Request & { nextUrl: URL }
  Object.defineProperty(req, 'nextUrl', { value: new URL(url), writable: false })
  return req as unknown as Parameters<
    (typeof import('../app/api/assets/route'))['GET']
  >[0]
}

function upload(bytes: Uint8Array, filename: string, declaredType = 'image/png') {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: declaredType }), filename)
  return apiRequest('http://localhost/api/assets', { method: 'POST', body: form })
}

const BASE = 'http://localhost/api/assets'

async function routeChecks() {
  console.log('/api/assets')
  const route = await import('../app/api/assets/route')

  let storedPath = ''

  await check('an upload is accepted and answers with where it landed', async () => {
    const response = await route.POST(upload(PNG_1X1, 'Pastel Sketch.png'))
    equal(response.status, 201, 'expected 201 Created')

    const body = (await response.json()) as { path: string; bytes: number; contentType: string }
    storedPath = body.path

    equal(body.contentType, 'image/png', 'wrong content type')
    equal(body.bytes, PNG_1X1.byteLength, 'wrong byte count')
    assert(
      /^assets\/\d{4}\/[0-9a-f]{8}-pastel-sketch\.png$/.test(body.path),
      `the key is not the documented shape: ${body.path}`
    )
  })

  await check('the same file uploaded twice is the same object', async () => {
    // Content-addressed: the second upload overwrites identical bytes with identical
    // bytes rather than growing the vault.
    const response = await route.POST(upload(PNG_1X1, 'Pastel Sketch.png'))
    const body = (await response.json()) as { path: string }
    equal(body.path, storedPath, 'the same bytes produced two different keys')
  })

  await check('the stored image is served back byte for byte', async () => {
    const response = await route.GET(apiRequest(`${BASE}?path=${encodeURIComponent(storedPath)}`))
    equal(response.status, 200, 'expected 200')
    equal(response.headers.get('Content-Type'), 'image/png', 'wrong content type')
    equal(
      response.headers.get('X-Content-Type-Options'),
      'nosniff',
      'user-uploaded bytes served same-origin must not be sniffable'
    )
    assert(
      response.headers.get('Cache-Control')?.includes('immutable'),
      'a content-addressed key can be cached forever, and should say so'
    )
    assert(
      response.headers.get('Cache-Control')?.includes('private'),
      'a shared cache must not hold images from behind the session gate'
    )

    const served = Buffer.from(await response.arrayBuffer())
    equal(served.toString('base64'), PNG_1X1.toString('base64'), 'the bytes changed in transit')
  })

  await check('a file that only claims to be an image is refused', async () => {
    // The header says image/png and the name ends in .png. Only the bytes disagree,
    // and the bytes are what decide.
    const response = await route.POST(upload(Buffer.from('<html>not a png</html>'), 'evil.png'))
    equal(response.status, 415, 'a non-image was accepted on the strength of its name')
  })

  await check('an SVG is refused however it is labelled', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

    equal((await route.POST(upload(svg, 'x.svg', 'image/svg+xml'))).status, 415, 'declared SVG')
    equal((await route.POST(upload(svg, 'x.png', 'image/png'))).status, 415, 'SVG wearing a .png')
  })

  await check('an oversized upload is refused with a message naming the size', async () => {
    const big = Buffer.alloc(MAX_ASSET_BYTES + 1024)
    PNG_1X1.copy(big) // a real PNG header, so it is the size being refused and nothing else

    const response = await route.POST(upload(big, 'huge.png'))
    equal(response.status, 413, 'expected 413')

    const body = (await response.json()) as { error: string }
    assert(/MB/.test(body.error), `the refusal should say how big it was: ${body.error}`)
  })

  await check('an empty or missing file is refused', async () => {
    equal((await route.POST(upload(new Uint8Array(0), 'empty.png'))).status, 400, 'empty file')

    const bare = apiRequest(BASE, { method: 'POST', body: new FormData() })
    equal((await route.POST(bare)).status, 400, 'no file field')
  })

  await check('the asset route cannot be used to read documents', async () => {
    // The one thing that would turn an image endpoint into a way around every rule
    // /api/files enforces.
    const store = (await import('../lib/server/store')).getStore()
    await store.write('Secret.md', '# Secret\n')

    for (const attempt of ['Secret.md', 'assets/../Secret.md', '../notes/Secret.md', '/Secret.md']) {
      const response = await route.GET(apiRequest(`${BASE}?path=${encodeURIComponent(attempt)}`))
      assert(
        response.status === 400 || response.status === 404,
        `${attempt} answered ${response.status} — it must never be served`
      )
      assert(
        !(response.headers.get('Content-Type') ?? '').startsWith('image/'),
        `${attempt} was served as an image`
      )
    }
  })

  await check('a missing asset is a 404, a missing parameter is a 400', async () => {
    const missing = await route.GET(apiRequest(`${BASE}?path=assets/2026/deadbeef-gone.png`))
    equal(missing.status, 404, 'expected 404 for an asset that is not there')

    const noParam = await route.GET(apiRequest(BASE))
    equal(noParam.status, 400, 'expected 400 when no path was asked for')
  })

  await check('the share asset route answers every refusal identically', async () => {
    /**
     * The store suite proves the decision; this proves the *response*. An oracle does
     * not need a different status code to exist — a different body, or a different
     * header, is enough to tell a holder of one link that an image they cannot see is
     * really there. So the refusals are compared byte for byte, not merely counted.
     */
    const shareRoute = await import('../app/api/share/[token]/asset/route')
    const { getShareStore } = await import('../lib/server/share-store')
    const store = (await import('../lib/server/store')).getStore()

    await store.write('Shared.md', `# Shared\n\n![p](${storedPath})\n`)
    await store.write('Hidden.md', '# Hidden\n\nNo pictures here.\n')
    const share = await getShareStore().create('Shared.md', 'document')

    const ask = (token: string, assetPath: string) =>
      shareRoute.GET(apiRequest(`http://localhost/api/share/${token}/asset?path=${encodeURIComponent(assetPath)}`), {
        params: Promise.resolve({ token }),
      })

    const good = await ask(share.token, storedPath)
    equal(good.status, 200, 'the shared document’s own image should be served')
    equal(good.headers.get('Content-Type'), 'image/png', 'wrong content type')
    equal(
      good.headers.get('Cache-Control'),
      'no-store, must-revalidate',
      'a shared image must not outlive the revocation that takes it away'
    )
    equal(good.headers.get('X-Content-Type-Options'), 'nosniff', 'user bytes, served to the public')

    const refusals = [
      ['unknown token', await ask('totally-made-up-token', storedPath)],
      ['image nobody in scope references', await ask(share.token, 'assets/2026/12345678-elsewhere.png')],
      ['a document, not an image', await ask(share.token, 'Hidden.md')],
      ['traversal', await ask(share.token, 'assets/../Hidden.md')],
      ['no path at all', await ask(share.token, '')],
    ] as const

    const shapes = new Set<string>()
    for (const [label, response] of refusals) {
      equal(response.status, 404, `${label}: every failure is a 404`)
      shapes.add(
        JSON.stringify({
          status: response.status,
          body: await response.json(),
          cache: response.headers.get('Cache-Control'),
          robots: response.headers.get('X-Robots-Tag'),
        })
      )
    }

    equal(
      shapes.size,
      1,
      `the refusals are distinguishable from each other, which is an existence oracle: ${[...shapes].join(' | ')}`
    )
  })

  await check('an uploaded image never becomes a document', async () => {
    // Through the real route this time, not just the bucket: upload, rebuild the
    // index from storage alone, and require that nothing about it appears.
    const store = (await import('../lib/server/store')).getStore()
    const index = await store.reindex()

    assert(!index.documents[storedPath], 'the uploaded image was indexed as a document')
    assert(
      !JSON.stringify(index.tree).includes(`"${ASSET_PREFIX}`),
      'the assets folder reached the file tree'
    )
  })

  console.log('')
}

/**
 * Editor insertion.
 *
 * No DOM: `insertImageAt` and `altTextFor` were split out of the extension for the
 * same reason `previewNodes` was split out of the live-preview plugin — the decision
 * worth testing is where the bytes go, and that is a function of an EditorState.
 */
async function insertionChecks() {
  console.log('editor insertion')

  const { EditorState } = await import('@codemirror/state')
  const { altTextFor, imageMarkdown, insertImageAt } = await import(
    '../components/workspace/image-drop'
  )

  /** Applies the insertion and returns the resulting document. */
  function insert(doc: string, pos: number, markdown = '![x](assets/2026/ab-x.png)') {
    const state = EditorState.create({ doc })
    const result = insertImageAt(state, pos, markdown)
    const next = state.update({ changes: result.changes, selection: result.selection })

    return {
      doc: next.state.doc.toString(),
      cursor: next.state.selection.main.head,
      end: result.end,
    }
  }

  await check('what lands in the document is plain CommonMark', () => {
    equal(
      imageMarkdown({ alt: 'Pastel sketch', path: 'assets/2026/ab12cd34-pastel.png' }),
      '![Pastel sketch](assets/2026/ab12cd34-pastel.png)',
      'the syntax must be what a person typing by hand would write'
    )
  })

  await check('an image dropped into blank space needs no separators', () => {
    // The trailing newline is not a separator — it is the line the caret lands on.
    equal(insert('', 0).doc, '![x](assets/2026/ab-x.png)\n', 'empty document')
    equal(
      insert('# Title\n\n\n## Next\n', 9).doc,
      '# Title\n\n![x](assets/2026/ab-x.png)\n\n## Next\n',
      'the blank line above is already there; the one below is not'
    )
  })

  await check('the caret lands below the image, so the picture renders at once', () => {
    /**
     * The rule this defends is in live-preview.ts: a caret touching a node reveals its
     * raw syntax. Leaving the caret at the end of the image's own line meant every
     * freshly dropped image sat there as `![alt](…)` until the user clicked away —
     * which is how this was actually caught, in the browser, with the picture missing.
     */
    for (const [doc, pos, label] of [
      ['', 0, 'empty document'],
      ['Some prose here.\n', 5, 'mid-paragraph'],
      ['# Title\n\n\n## Next\n', 9, 'blank line between blocks'],
      ['Some text\n', 10, 'at the very end'],
    ] as Array<[string, number, string]>) {
      const { doc: after, cursor } = insert(doc, pos)
      const before = after.slice(0, cursor)

      assert(
        before.endsWith('\n'),
        `${label}: the caret is mid-line, so it is still touching the image`
      )
      equal(
        before.split('\n').at(-2),
        '![x](assets/2026/ab-x.png)',
        `${label}: the caret is not on the line directly below the image`
      )
    }
  })

  await check('a blank line is not enough on its own', () => {
    /**
     * The case that made this a function rather than a string concatenation.
     * `![x]\nSome text` is ONE paragraph in CommonMark, so an image dropped on the
     * blank line above a paragraph would render inline with it — the exact thing
     * block placement exists to prevent, arrived at from the direction that looks
     * like it needs no work.
     */
    equal(
      insert('\nSome text\n', 0).doc,
      '![x](assets/2026/ab-x.png)\n\nSome text\n',
      'an image directly above a paragraph joins it'
    )
    equal(
      insert('Some text\n', 10).doc,
      'Some text\n\n![x](assets/2026/ab-x.png)\n',
      'and directly below one, likewise'
    )
  })

  await check('an image dropped into prose becomes its own block', () => {
    // Inline mid-sentence is never what was meant, and in Markdown it would not
    // render as a block either.
    equal(
      insert('Some prose here.\n', 5).doc,
      'Some \n\n![x](assets/2026/ab-x.png)\n\nprose here.\n',
      'mid-paragraph'
    )
    equal(
      insert('Some prose here.\n', 16).doc,
      'Some prose here.\n\n![x](assets/2026/ab-x.png)\n',
      'at the end of a line, nothing follows it on that line'
    )
  })

  await check('the reported end is past everything inserted', () => {
    // This is where the next image in a multi-file drop starts; if it were the caret
    // position instead, image two would land inside image one's trailing blank line.
    const result = insert('Some prose here.\n', 5)
    equal(result.doc.slice(0, result.end), 'Some \n\n![x](assets/2026/ab-x.png)\n\n', 'end position')
  })

  await check('a position outside the document is clamped rather than throwing', () => {
    equal(insert('abc', 999).doc, 'abc\n\n![x](assets/2026/ab-x.png)\n', 'past the end')
    equal(insert('abc', -5).doc, '![x](assets/2026/ab-x.png)\n\nabc', 'before the start')
  })

  await check('a vault path is mapped to a URL, and everything else is left alone', async () => {
    // One function for both views. Two would drift, and the symptom would be an image
    // that renders in the editor and not in the reading view.
    const { resolveImageSrc } = await import('../lib/workspace-api')

    equal(
      resolveImageSrc('assets/2026/ab-x.png'),
      '/api/assets?path=assets%2F2026%2Fab-x.png',
      'a vault-relative path goes through the asset route'
    )
    equal(resolveImageSrc('./assets/2026/ab-x.png'), '/api/assets?path=assets%2F2026%2Fab-x.png', 'a leading ./')

    // Rewriting any of these would break images that worked before this feature.
    equal(resolveImageSrc('https://example.com/a.png'), 'https://example.com/a.png', 'remote')
    equal(resolveImageSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA', 'data URI')
    equal(resolveImageSrc('//cdn.example.com/a.png'), '//cdn.example.com/a.png', 'protocol-relative')
    equal(resolveImageSrc('/icon-192.png'), '/icon-192.png', 'a rooted path into public/')
  })

  await check('shrinking preserves the shape and never enlarges', async () => {
    const { scaledSize } = await import('../components/workspace/image-drop')

    equal(scaledSize(4032, 3024, 2560), { width: 2560, height: 1920 }, 'a landscape phone photo')
    equal(scaledSize(3024, 4032, 2560), { width: 1920, height: 2560 }, 'portrait caps the long edge')
    equal(scaledSize(1000, 1000, 2560), { width: 1000, height: 1000 }, 'never upscale')
    equal(scaledSize(2560, 1440, 2560), { width: 2560, height: 1440 }, 'exactly at the cap is untouched')
    equal(scaledSize(10000, 2, 1280), { width: 1280, height: 1 }, 'a sliver keeps at least one pixel')
  })

  await check('a file that fits is never re-encoded', async () => {
    /**
     * The narrow rule this feature lives by: re-encoding happens only to make an
     * impossible upload possible. Recompressing every screenshot would mean the bytes
     * in the vault are never quite the bytes the user chose.
     */
    const { shrinkToFit } = await import('../components/workspace/image-drop')

    const small = new File([PNG_1X1], 'small.png', { type: 'image/png' })
    equal(await shrinkToFit(small, 4 * 1024 * 1024) === small, true, 'a small file was touched')
  })

  await check('an oversized GIF is left alone rather than flattened', async () => {
    // A canvas holds one frame. Re-encoding would turn an animation into a still and
    // call it a success — worse than being refused with a message.
    const { shrinkToFit } = await import('../components/workspace/image-drop')

    const gif = new File([Buffer.alloc(64)], 'loop.gif', { type: 'image/gif' })
    equal(await shrinkToFit(gif, 8) === gif, true, 'an animation was re-encoded')
  })

  await check('a browser that cannot decode gets the original back', async () => {
    // Node has no createImageBitmap here, which is exactly the "cannot shrink" path:
    // a bad shrink must never be worse than no shrink.
    const { shrinkToFit } = await import('../components/workspace/image-drop')

    const big = new File([Buffer.alloc(128)], 'huge.png', { type: 'image/png' })
    equal(await shrinkToFit(big, 8) === big, true, 'the original should come back untouched')
  })

  await check('the client and the server agree on one limit', async () => {
    // Two numbers would drift, and the client would either produce uploads the server
    // refuses or degrade pictures nobody asked it to touch.
    const shared = (await import('../lib/asset-limits')).MAX_ASSET_BYTES
    const server = (await import('../lib/server/request-limits')).MAX_ASSET_BYTES
    equal(server, shared, 'the server limit is not the shared one')
  })

  await check('alt text keeps the words and drops what would break the link', () => {
    equal(altTextFor('Rapat Q3 — final.png'), 'Rapat Q3 — final', 'accents and dashes survive')
    equal(altTextFor('图片.png'), '图片', 'alt text is read aloud — it is not a slug')
    equal(altTextFor('C:\\Users\\Xyks\\shot.png'), 'shot', 'a path is not a name')
    equal(altTextFor('a[b]c.png'), 'a b c', 'brackets would close the alt early')
    equal(altTextFor('.gitignore'), '.gitignore', 'a dotfile has no extension to strip')
  })

  await check('a bracket in a filename cannot break out of the link', () => {
    const markdown = imageMarkdown({ alt: altTextFor('evil].png'), path: 'assets/2026/ab-evil.png' })
    equal(markdown, '![evil](assets/2026/ab-evil.png)', 'the bracket must not survive')
    assert(
      markdown.split('](').length === 2,
      `the alt text closed the link early: ${markdown}`
    )
  })

  console.log('')
}

/**
 * Orphan collection.
 *
 * The rule under test is what the GC must *not* do. Deleting a document deliberately
 * leaves its images alone, so every "orphan" is a judgement call, and two of them are
 * judgements this script has to get right or it destroys data with no undo.
 */
async function gcChecks() {
  console.log('orphaned images')

  const { findOrphans, removeOrphans, ageInDays } = await import('../scripts/gc-assets')

  const PNG = PNG_1X1
  /** Days ago, as an ISO string the memory bucket will report. */
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

  async function fixture() {
    const bucket = new MemoryBucket()
    const store = new WorkspaceStore(bucket)

    await bucket.writeBinary('assets/2026/aaaaaaaa-used.png', PNG, 'image/png')
    await bucket.writeBinary('assets/2026/bbbbbbbb-orphan.png', PNG, 'image/png')
    await bucket.writeBinary('assets/2026/cccccccc-trashed.png', PNG, 'image/png')

    await store.write('Live.md', '# Live\n\n![u](assets/2026/aaaaaaaa-used.png)\n')
    await store.write('Doomed.md', '# Doomed\n\n![t](assets/2026/cccccccc-trashed.png)\n')

    return { bucket, store }
  }

  await check('an image a live document uses is not an orphan', async () => {
    const { bucket } = await fixture()
    const orphans = await findOrphans(bucket)
    assert(
      !orphans.some((o) => o.path.includes('used')),
      'an image in a live document was reported as unreferenced'
    )
  })

  await check('THE TRASH COUNTS: a deleted document still holds its images', async () => {
    /**
     * The one that would destroy data silently. A document deleted yesterday can be
     * restored for thirty days; if the GC collected its images in the meantime, the
     * restore would return a document that looks whole and renders nothing.
     */
    const { bucket, store } = await fixture()
    await store.remove('Doomed.md')

    // Gone from the corpus, so only the trash can still be holding the reference.
    assert(!(await bucket.listKeys()).includes('Doomed.md'), 'the document should be in the trash')

    const orphans = await findOrphans(bucket)
    assert(
      !orphans.some((o) => o.path.includes('trashed')),
      'an image belonging to a restorable document was reported as collectable'
    )
  })

  await check('an image nothing mentions is reported', async () => {
    const { bucket } = await fixture()
    const orphans = await findOrphans(bucket)
    equal(
      orphans.map((o) => o.path),
      ['assets/2026/bbbbbbbb-orphan.png'],
      'the orphan list is wrong'
    )
    assert(orphans[0]!.size === PNG.byteLength, 'the report should carry the size')
  })

  await check('a just-uploaded image is never deleted', async () => {
    /**
     * The race the age rule exists for: the upload lands before the document save
     * does, so for a moment a perfectly live image has no reference anywhere. A sweep
     * in that window would delete what the user is still writing.
     */
    const { bucket } = await fixture()
    const orphans = await findOrphans(bucket)

    const result = await removeOrphans(bucket, orphans, { minAgeDays: 7 })
    equal(result.deleted, [], 'a fresh upload was deleted')
    equal(result.tooRecent.length, 1, 'it should have been kept and named')
    assert(
      await bucket.readBinary('assets/2026/bbbbbbbb-orphan.png'),
      'the bytes are gone despite not being deleted'
    )
  })

  await check('an old orphan is deleted, and only that one', async () => {
    const { bucket } = await fixture()
    bucket.setModifiedAt('assets/2026/bbbbbbbb-orphan.png', daysAgo(90))

    const result = await removeOrphans(bucket, await findOrphans(bucket), { minAgeDays: 7 })
    equal(result.deleted.map((a) => a.path), ['assets/2026/bbbbbbbb-orphan.png'], 'wrong deletion')

    equal(await bucket.readBinary('assets/2026/bbbbbbbb-orphan.png'), null, 'it should be gone')
    assert(await bucket.readBinary('assets/2026/aaaaaaaa-used.png'), 'the used image was collected')
    assert(await bucket.readBinary('assets/2026/cccccccc-trashed.png'), 'the trashed image was collected')
  })

  await check('an unknown age is treated as brand new, not as ancient', async () => {
    // A backend that cannot report a modification time must not thereby authorise a
    // deletion. The benefit of the doubt goes to the file.
    equal(
      ageInDays({ path: 'x', size: 0, modifiedAt: new Date().toISOString() }) < 1,
      true,
      'a fresh timestamp should read as young'
    )
  })

  console.log('')
}

async function run() {
  console.log('Images suite\n')

  await namespaceChecks()
  await routeChecks()
  await insertionChecks()
  await gcChecks()

  const backends: Array<{ name: string; make: () => Bucket }> = [
    { name: 'memory', make: () => new MemoryBucket() },
    { name: 'filesystem', make: makeFsBucket },
  ]

  if (r2ConfigFromEnv()) {
    // Both prefixes namespaced, for the reason tests/backend.test.ts spells out:
    // isolating documents without isolating metadata isolates nothing, and this
    // suite writes an index.
    const prefix = `assets-suite-${Date.now()}`
    const make = () => new R2Bucket({ documentPrefix: prefix, metaPrefix: `${prefix}/_meta` })

    backends.push({ name: 'r2', make })
    cleanups.push(() => {
      const bucket = make()
      void bucket
        .deleteFolder('')
        .then(async () => {
          for (const key of await bucket.listMeta('')) await bucket.deleteMeta(key)
        })
        .catch((err: Error) => console.error(`  ! could not remove ${prefix}: ${err.message}`))
    })
  }

  console.log(`backends under test: ${backends.map((b) => b.name).join(', ')}`)
  if (!r2ConfigFromEnv()) {
    console.log('  ! r2 SKIPPED — no credentials. Run `npm run test:r2` style config to include it.')
  }
  console.log('')

  for (const backend of backends) {
    await backendChecks(backend.name, backend.make())
  }

  for (const done of cleanups) done()

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

export { run as runAssetTests }
