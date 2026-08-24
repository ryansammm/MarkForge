import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Password vault suite.
 *
 * The release criteria in docs/password-manager-plan.md are claims about what is
 * *absent*, and absence is the hardest thing to keep true — it survives one refactor
 * at a time and then quietly stops. So most of this file asserts negatives:
 *
 *   crypto        a round trip works, a wrong password does not, and a tampered
 *                 ciphertext fails closed rather than decrypting to something.
 *   record        the format rejects any field it does not name — the mechanism that
 *                 stops plaintext ever being *able* to reach the server.
 *   store / API   revision conflicts are refused and reported, never merged silently;
 *                 a corrupt record never reads as "no vault".
 *   isolation     the vault is invisible to the index, a reindex, search, the trash,
 *                 shares, and /api/files. This is the section that matters.
 *   backup        a snapshot carries the ciphertext, notices damage, and restores to
 *                 something that still opens with the same master password.
 *
 * NOTE: the store resolves its roots from env at construction, so NOTES_DIR, META_DIR
 * and INDEX_PATH are set before any route module is imported.
 */

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-vault-'))
const notesDir = path.join(workspace, 'notes')
fs.mkdirSync(notesDir, { recursive: true })

process.env.NOTES_DIR = notesDir
process.env.INDEX_PATH = path.join(workspace, 'index.json')
process.env.META_DIR = workspace
// The route's own session guard is a no-op without a configured password, which is
// the documented local-development case and what these tests exercise.
delete process.env.APP_PASSWORD
delete process.env.SESSION_SECRET

import { MemoryBucket } from '../lib/server/bucket'
import { FsBucket } from '../lib/server/fs-bucket'
import { WorkspaceStore } from '../lib/server/workspace-store'
import { ShareStore } from '../lib/server/share-store'
import { SearchIndex } from '../lib/server/search'
import {
  VaultConflictError,
  VaultCorruptError,
  VaultStore,
  resetVaultStore,
} from '../lib/server/vault-store'
import {
  InvalidVaultRecordError,
  MIN_PBKDF2_ITERATIONS,
  VAULT_CREATE_ONLY,
  VAULT_FILE,
  parseVaultEnvelope,
  type VaultEnvelope,
} from '../lib/vault/record'
import {
  createEnvelope,
  deriveKey,
  openRecord,
  resealEnvelope,
  seal,
  unseal,
  UnsupportedVaultError,
  VaultUnlockError,
} from '../lib/vault/crypto'
import {
  emptyVault,
  filterItems,
  mergeVaults,
  normalizeVaultData,
  removeItem,
  upsertItem,
  type VaultData,
} from '../lib/vault/items'
import { activeAlphabets, entropyBits, generatePassword } from '../lib/vault/generator'

let passed = 0
const failures: string[] = []

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
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n      expected: ${b}\n      actual:   ${a}`)
}

async function rejects(promise: Promise<unknown>, message: string): Promise<unknown> {
  const outcome = await promise.then(
    () => null,
    (err: unknown) => err ?? new Error('rejected with no error')
  )
  if (outcome === null) throw new Error(message)
  return outcome
}

/**
 * The KDF floor, not the production 600,000.
 *
 * Every derivation in this file costs real time by design; paying the production cost
 * a few dozen times would make the suite something people skip. `record.ts` enforces
 * the floor, so this seam cannot produce a vault weaker than the format allows.
 */
const TEST_KDF = { iterations: MIN_PBKDF2_ITERATIONS }

const MASTER = 'correct horse battery staple'

function sampleVault(): VaultData {
  const { data } = upsertItem(emptyVault(), {
    name: 'GitHub',
    url: 'https://github.com',
    username: 'octocat',
    password: 'hunter2-but-longer',
    notes: 'recovery codes in the drawer',
    tags: ['work'],
  })
  return data
}

function memoryVaultStore(): { vault: VaultStore; files: WorkspaceStore; bucket: MemoryBucket } {
  const bucket = new MemoryBucket()
  const files = new WorkspaceStore(bucket)
  return { vault: new VaultStore(files), files, bucket }
}

async function run() {
  console.log('Password vault suite\n')

  // --- crypto ---------------------------------------------------------------

  console.log('crypto — the property the whole feature rests on')

  await check('a vault round-trips through seal and unseal', async () => {
    const data = sampleVault()
    const { key, envelope } = await createEnvelope(MASTER, data, TEST_KDF)
    const back = await unseal<VaultData>(key, envelope.cipher)
    equal(back, data, 'the decrypted vault differs from what was sealed')
  })

  await check('the sealed record contains no plaintext anywhere', async () => {
    // The claim in the plan, tested as a string search over the exact bytes that
    // reach storage — not over a shape somebody believes is right.
    const data = sampleVault()
    const { envelope } = await createEnvelope(MASTER, data, TEST_KDF)
    const serialized = JSON.stringify(envelope)

    for (const secret of [
      'GitHub',
      'github.com',
      'octocat',
      'hunter2-but-longer',
      'recovery codes',
      'work',
      MASTER,
    ]) {
      assert(!serialized.includes(secret), `the record leaks "${secret}" in the clear`)
    }
  })

  await check('a wrong master password does not open the vault', async () => {
    const { envelope } = await createEnvelope(MASTER, sampleVault(), TEST_KDF)
    const record = { ...envelope, revision: 'r1', updatedAt: new Date().toISOString() }

    const err = await rejects(
      openRecord(record, 'correct horse battery stapl'),
      'a wrong password opened the vault'
    )
    assert(err instanceof VaultUnlockError, `wrong error type: ${(err as Error).name}`)
  })

  await check('a tampered ciphertext fails closed', async () => {
    // AES-GCM authenticates. Without that the server could edit the blob and the
    // browser would decrypt whatever it was handed.
    const { key, envelope } = await createEnvelope(MASTER, sampleVault(), TEST_KDF)

    const bytes = Buffer.from(envelope.cipher.ciphertext, 'base64')
    bytes[Math.floor(bytes.length / 2)] ^= 0x01
    const tampered = { ...envelope.cipher, ciphertext: bytes.toString('base64') }

    const err = await rejects(unseal(key, tampered), 'a modified ciphertext still decrypted')
    assert(err instanceof VaultUnlockError, `wrong error type: ${(err as Error).name}`)
  })

  await check('a swapped nonce fails closed', async () => {
    const { key, envelope } = await createEnvelope(MASTER, sampleVault(), TEST_KDF)
    const other = await seal(key, emptyVault())

    await rejects(
      unseal(key, { ...envelope.cipher, nonce: other.nonce }),
      'the ciphertext decrypted under the wrong nonce'
    )
  })

  await check('every encryption uses a fresh nonce', async () => {
    const { key, kdf } = await createEnvelope(MASTER, emptyVault(), TEST_KDF)
    const nonces = new Set<string>()
    for (let i = 0; i < 16; i++) {
      nonces.add((await resealEnvelope(key, kdf, emptyVault())).cipher.nonce)
    }
    equal(nonces.size, 16, 'a nonce was reused, which breaks the cipher')
  })

  await check('two vaults with the same password get different salts and ciphertext', async () => {
    const a = await createEnvelope(MASTER, sampleVault(), TEST_KDF)
    const b = await createEnvelope(MASTER, sampleVault(), TEST_KDF)
    assert(a.kdf.salt !== b.kdf.salt, 'the salt is not random — vaults share a key')
    assert(
      a.envelope.cipher.ciphertext !== b.envelope.cipher.ciphertext,
      'identical vaults produced identical ciphertext'
    )
  })

  await check('the derived key cannot be exported', async () => {
    const { key } = await createEnvelope(MASTER, emptyVault(), TEST_KDF)
    equal(key.extractable, false, 'the vault key is extractable — script on the page could read it')
  })

  await check('an unsupported KDF is refused rather than guessed at', async () => {
    const err = await rejects(
      deriveKey(MASTER, { algorithm: 'argon2id', salt: 'AAAA', memoryKiB: 65536, iterations: 3, parallelism: 4 }),
      'an unimplemented KDF was silently accepted'
    )
    assert(err instanceof UnsupportedVaultError, `wrong error type: ${(err as Error).name}`)
  })

  // --- record format --------------------------------------------------------

  console.log('\nrecord — the format is the thing that stops plaintext reaching the server')

  const validEnvelope = async (): Promise<VaultEnvelope> =>
    (await createEnvelope(MASTER, sampleVault(), TEST_KDF)).envelope

  await check('a well-formed envelope parses', async () => {
    const envelope = await validEnvelope()
    equal(parseVaultEnvelope(envelope), envelope, 'a valid record was rejected')
  })

  await check('an extra top-level field is rejected', async () => {
    // The mistake this catches: `{ ...envelope, itemNames: [...] }` added for a
    // "harmless" debug feature. It would validate under a permissive parser.
    const envelope = { ...(await validEnvelope()), itemNames: ['GitHub'] }
    const err = await rejects(
      Promise.resolve().then(() => parseVaultEnvelope(envelope)),
      'a record carrying plaintext alongside the ciphertext was accepted'
    )
    assert(err instanceof InvalidVaultRecordError, `wrong error type: ${(err as Error).name}`)
  })

  await check('an extra field inside cipher is rejected', async () => {
    const base = await validEnvelope()
    await rejects(
      Promise.resolve().then(() =>
        parseVaultEnvelope({ ...base, cipher: { ...base.cipher, hint: 'my dog' } })
      ),
      'a smuggled field inside cipher was accepted'
    )
  })

  await check('a weak iteration count is refused', async () => {
    const base = await validEnvelope()
    await rejects(
      Promise.resolve().then(() =>
        parseVaultEnvelope({ ...base, kdf: { ...base.kdf, iterations: 1000 } })
      ),
      'a record that would brute-force in an afternoon was accepted'
    )
  })

  await check('an absurd iteration count is refused', async () => {
    const base = await validEnvelope()
    await rejects(
      Promise.resolve().then(() =>
        parseVaultEnvelope({ ...base, kdf: { ...base.kdf, iterations: 500_000_000 } })
      ),
      'a record that would hang the owner’s browser was accepted'
    )
  })

  await check('a truncated salt or nonce is refused', async () => {
    const base = await validEnvelope()
    await rejects(
      Promise.resolve().then(() => parseVaultEnvelope({ ...base, kdf: { ...base.kdf, salt: 'AAAA' } })),
      'a short salt was accepted'
    )
    await rejects(
      Promise.resolve().then(() =>
        parseVaultEnvelope({ ...base, cipher: { ...base.cipher, nonce: 'AAAA' } })
      ),
      'a short nonce was accepted'
    )
  })

  // --- store ----------------------------------------------------------------

  console.log('\nstore — one blob, and the rule that two devices cannot silently overwrite')

  await check('a bootstrap write creates the vault and assigns a revision', async () => {
    const { vault } = memoryVaultStore()
    const record = await vault.write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })

    assert(record.revision.length > 0, 'no revision was assigned')
    const read = await vault.read()
    equal(read?.revision, record.revision, 'the stored record disagrees with what was returned')
  })

  await check('reading a workspace with no vault returns null', async () => {
    const { vault } = memoryVaultStore()
    equal(await vault.read(), null, 'a missing vault did not read as absent')
  })

  await check('a second bootstrap is refused', async () => {
    const { vault } = memoryVaultStore()
    await vault.write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })

    const err = await rejects(
      vault.write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY }),
      'a second create replaced an existing vault'
    )
    assert(err instanceof VaultConflictError, `wrong error type: ${(err as Error).name}`)
  })

  await check('a stale revision is refused and the stored vault is untouched', async () => {
    const { vault } = memoryVaultStore()
    const first = await vault.write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })
    const second = await vault.write(await validEnvelope(), { ifMatch: first.revision })

    const stale = await validEnvelope()
    const err = (await rejects(
      vault.write(stale, { ifMatch: first.revision }),
      'a stale write overwrote a newer vault'
    )) as VaultConflictError

    equal(err.actualRevision, second.revision, 'the conflict did not report the current revision')
    const current = await vault.read()
    equal(current?.cipher.ciphertext, second.cipher.ciphertext, 'the stale write landed anyway')
  })

  await check('every write changes the revision, even for identical content', async () => {
    // A content hash would collide here, and a colliding revision makes a stale write
    // look current — the exact failure the check exists to prevent.
    const { vault } = memoryVaultStore()
    const envelope = await validEnvelope()
    const first = await vault.write(envelope, { ifMatch: VAULT_CREATE_ONLY })
    const second = await vault.write(envelope, { ifMatch: first.revision })
    assert(first.revision !== second.revision, 'two identical writes share a revision')
  })

  await check('a corrupt record never reads as “no vault”', async () => {
    // If it did, the app would offer to create one and the first save would destroy
    // whatever was recoverable.
    const { vault, bucket } = memoryVaultStore()
    await bucket.writeMeta(VAULT_FILE, '{ not json')

    const err = await rejects(vault.read(), 'a corrupt record read as an absent vault')
    assert(err instanceof VaultCorruptError, `wrong error type: ${(err as Error).name}`)
  })

  await check('a corrupt record cannot be overwritten by a bootstrap', async () => {
    const { vault, bucket } = memoryVaultStore()
    await bucket.writeMeta(VAULT_FILE, '{ not json')

    await rejects(
      vault.write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY }),
      'a bootstrap destroyed a damaged but possibly recoverable vault'
    )
    equal(await bucket.readMeta(VAULT_FILE), '{ not json', 'the damaged record was modified')
  })

  await check('a write against a vault that no longer exists is refused', async () => {
    const { vault } = memoryVaultStore()
    await rejects(
      vault.write(await validEnvelope(), { ifMatch: 'some-revision' }),
      'a write recreated a vault that had been deleted underneath it'
    )
  })

  await check('concurrent writers do not both win', async () => {
    const bucket = new MemoryBucket()
    const files = new WorkspaceStore(bucket)
    // Two stores over one bucket: the serverless case, where each process has its own
    // queue and only the compare-and-set is shared.
    const a = new VaultStore(files)
    const b = new VaultStore(files)

    const first = await a.write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })

    const results = await Promise.allSettled([
      a.write(await validEnvelope(), { ifMatch: first.revision }),
      b.write(await validEnvelope(), { ifMatch: first.revision }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    equal(fulfilled.length, 1, 'both writers accepted the same revision')
  })

  await check('the vault survives the filesystem backend', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-vault-fs-'))
    const notes = path.join(dir, 'notes')
    fs.mkdirSync(notes, { recursive: true })

    const files = new WorkspaceStore(
      new FsBucket({ notesDir: notes, metaDir: dir, indexPath: path.join(dir, 'index.json') })
    )
    const vault = new VaultStore(files)

    const created = await vault.write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })
    assert(fs.existsSync(path.join(dir, VAULT_FILE)), 'the vault is not a file on disk')
    assert(!fs.existsSync(path.join(notes, VAULT_FILE)), 'the vault was written into the corpus')

    const read = await vault.read()
    equal(read?.revision, created.revision, 'the record did not survive a filesystem round trip')

    // The bytes on disk are the same bytes the store returned, and hold no plaintext.
    const onDisk = fs.readFileSync(path.join(dir, VAULT_FILE), 'utf-8')
    for (const secret of ['GitHub', 'octocat', 'hunter2-but-longer', MASTER]) {
      assert(!onDisk.includes(secret), `the file on disk leaks "${secret}"`)
    }

    fs.rmSync(dir, { recursive: true, force: true })
  })

  await check('a vault written on one backend opens on another', async () => {
    // The restore path in miniature: ciphertext is portable, and nothing about the
    // backend is baked into it.
    const { vault: source } = memoryVaultStore()
    // Held, not regenerated: item ids and timestamps are fresh on every call, so the
    // comparison has to be against the exact vault that was sealed.
    const original = sampleVault()
    const { envelope } = await createEnvelope(MASTER, original, TEST_KDF)
    await source.write(envelope, { ifMatch: VAULT_CREATE_ONLY })
    const stored = await source.read()

    const { vault: target, bucket } = memoryVaultStore()
    await bucket.writeMeta(VAULT_FILE, JSON.stringify(stored, null, 2))

    const moved = await target.read()
    assert(moved, 'the record did not survive the move')
    const { data } = await openRecord<VaultData>(moved, MASTER)
    equal(normalizeVaultData(data), original, 'the moved vault decrypted to the wrong contents')
  })

  // --- API ------------------------------------------------------------------

  console.log('\nAPI — /api/vault')

  const routeStore = new VaultStore(
    new WorkspaceStore(
      new FsBucket({
        notesDir,
        metaDir: workspace,
        indexPath: path.join(workspace, 'index.json'),
      })
    )
  )
  resetVaultStore(routeStore)

  const route = await import('../app/api/vault/route')
  type Handler = (req: never) => Promise<Response>
  const GET = route.GET as unknown as Handler
  const PUT = route.PUT as unknown as Handler

  function request(url: string, init?: RequestInit) {
    const req = new Request(url, init) as Request & { nextUrl: URL; cookies: unknown }
    Object.defineProperty(req, 'nextUrl', { value: new URL(url), writable: false })
    Object.defineProperty(req, 'cookies', { value: { get: () => undefined }, writable: false })
    return req
  }

  const put = (body: unknown, ifMatch?: string) =>
    PUT(
      request('http://localhost/api/vault', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(ifMatch ? { 'If-Match': `"${ifMatch}"` } : {}),
        },
        body: JSON.stringify(body),
      }) as never
    )

  let liveRevision = ''

  await check('GET reports no vault before one is created', async () => {
    const res = await GET(request('http://localhost/api/vault') as never)
    equal(res.status, 200, 'unexpected status')
    equal(((await res.json()) as { record: unknown }).record, null, 'a vault appeared from nowhere')
  })

  await check('PUT without If-Match is refused', async () => {
    const res = await put(await validEnvelope())
    equal(res.status, 400, 'an unconditional write was accepted')
  })

  await check('PUT with the create sentinel bootstraps the vault', async () => {
    const res = await put(await validEnvelope(), VAULT_CREATE_ONLY)
    equal(res.status, 200, 'the bootstrap failed')

    const body = (await res.json()) as { revision: string; updatedAt: string }
    assert(body.revision, 'no revision came back')
    liveRevision = body.revision
  })

  await check('the PUT response does not echo the ciphertext back', async () => {
    const res = await put(await validEnvelope(), liveRevision)
    const body = (await res.json()) as Record<string, unknown>
    equal(Object.keys(body).sort(), ['revision', 'updatedAt'], 'the response carries more than it needs')
    liveRevision = body.revision as string
  })

  await check('GET returns the record and nothing is cached', async () => {
    const res = await GET(request('http://localhost/api/vault') as never)
    equal(res.headers.get('cache-control'), 'no-store', 'the vault is cacheable')
    // A revision in a response header is a revision in every proxy log.
    equal(res.headers.get('etag'), null, 'the revision leaked into a header')

    const { record } = (await res.json()) as { record: { revision: string } | null }
    equal(record?.revision, liveRevision, 'the wrong record came back')
  })

  await check('a stale If-Match gets a 409 carrying the current revision', async () => {
    const res = await put(await validEnvelope(), 'not-the-current-revision')
    equal(res.status, 409, 'a stale write was not refused')

    const body = (await res.json()) as { code: string; actualRevision: string }
    equal(body.code, 'VAULT_CONFLICT', 'wrong error code')
    equal(body.actualRevision, liveRevision, 'the client cannot recover without the real revision')
  })

  await check('a 409 body carries no ciphertext', async () => {
    const res = await put(await validEnvelope(), 'stale')
    const body = (await res.json()) as Record<string, unknown>
    equal(
      Object.keys(body).sort(),
      ['actualRevision', 'code', 'error'],
      'the conflict response is handing out vault data'
    )
  })

  await check('a record carrying plaintext is rejected at the route', async () => {
    const envelope = await validEnvelope()
    const res = await put({ ...envelope, itemNames: ['GitHub'] }, liveRevision)
    equal(res.status, 400, 'the route accepted a record with a plaintext field')

    // And the rejection changed nothing.
    const stored = await routeStore.read()
    equal(stored?.revision, liveRevision, 'a rejected write still altered the vault')
  })

  await check('a body over the size limit is refused', async () => {
    const envelope = await validEnvelope()
    const huge = { ...envelope, cipher: { ...envelope.cipher, ciphertext: 'A'.repeat(600_000) } }
    const res = await put(huge, liveRevision)
    equal(res.status, 413, 'an oversized body was accepted')
  })

  // --- isolation ------------------------------------------------------------

  console.log('\nisolation — the vault is invisible to everything that reads the corpus')

  await check('the vault is not a corpus key and survives a reindex', async () => {
    const bucket = new MemoryBucket()
    const files = new WorkspaceStore(bucket)
    const vault = new VaultStore(files)

    await files.write('Note.md', '# Note\n')
    await vault.write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })

    equal(await bucket.listKeys(), ['Note.md'], 'the vault is in the document keyspace')

    const index = await files.reindex()
    equal(Object.keys(index.documents), ['Note.md'], 'a reindex picked the vault up as a document')
    assert(await vault.read(), 'the reindex destroyed the vault')
  })

  await check('the vault does not appear in the index or its backlinks', async () => {
    const bucket = new MemoryBucket()
    const files = new WorkspaceStore(bucket)
    await new VaultStore(files).write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })
    await files.write('Note.md', '# Note\n')

    const serialized = JSON.stringify(await files.getIndex())
    assert(!serialized.includes(VAULT_FILE), 'the index names the vault file')
    assert(!serialized.includes('cipher'), 'the index carries vault data')
  })

  await check('the vault is not reachable through the document store', async () => {
    // Two separate walls: the name is not a .md path, and metadata is a different
    // namespace from the corpus regardless.
    const bucket = new MemoryBucket()
    const files = new WorkspaceStore(bucket)
    await new VaultStore(files).write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })

    equal(await files.getFile(VAULT_FILE).catch(() => 'refused'), 'refused', 'the store served the vault')
    equal(await files.readDocument('password-vault.md').catch(() => null), null, 'a .md alias resolved')
  })

  await check('the vault does not reach the search corpus', async () => {
    const bucket = new MemoryBucket()
    const files = new WorkspaceStore(bucket)
    await files.write('Note.md', '# Note\n\nOrdinary prose.\n')
    await new VaultStore(files).write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })

    const search = new SearchIndex(files)
    const hits = await search.query('cipher')
    equal(hits, [], 'searching for vault data returned something')
    const all = await search.query('Note')
    equal(all.map((hit) => hit.path), ['Note.md'], 'the search corpus is not just the documents')
  })

  await check('no share can be created over the vault', async () => {
    const bucket = new MemoryBucket()
    const files = new WorkspaceStore(bucket)
    await new VaultStore(files).write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })

    const shares = new ShareStore(files)
    await rejects(shares.create(VAULT_FILE, 'document'), 'a share was created over the vault')
    await rejects(shares.create(VAULT_FILE, 'subtree'), 'a subtree share covered the vault')
  })

  await check('a subtree share of the workspace root cannot resolve the vault', async () => {
    const bucket = new MemoryBucket()
    const files = new WorkspaceStore(bucket)
    await files.write('Public/Note.md', '# Note\n')
    await new VaultStore(files).write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })

    const shares = new ShareStore(files)
    const share = await shares.create('Public', 'subtree')
    equal(await shares.resolve(share.token, VAULT_FILE), null, 'a share resolved the vault')
  })

  await check('deleting every document leaves the vault alone', async () => {
    const bucket = new MemoryBucket()
    const files = new WorkspaceStore(bucket)
    const vault = new VaultStore(files)

    await files.write('Folder/Note.md', '# Note\n')
    const created = await vault.write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })

    await files.removeDirectory('Folder')
    equal((await vault.read())?.revision, created.revision, 'a folder delete took the vault with it')

    // And the trash did not swallow it either.
    const entries = await files.listTrash()
    assert(
      !entries.some((entry) => entry.files.includes(VAULT_FILE)),
      'the vault ended up in the trash'
    )
  })

  await check('purging the trash does not purge the vault', async () => {
    const bucket = new MemoryBucket()
    const files = new WorkspaceStore(bucket)
    const vault = new VaultStore(files)

    await files.write('Note.md', '# Note\n')
    await files.remove('Note.md')
    const created = await vault.write(await validEnvelope(), { ifMatch: VAULT_CREATE_ONLY })

    const { purged } = await files.purgeTrash({ now: Date.now() + 400 * 24 * 60 * 60 * 1000 })
    assert(!purged.includes(VAULT_FILE), 'the trash purge swept the vault')
    equal((await vault.read())?.revision, created.revision, 'the vault did not survive a purge')
  })

  // --- items ----------------------------------------------------------------

  console.log('\nitems — the plaintext model, which only ever exists in a browser')

  await check('adding and editing an item keeps its id and created date', () => {
    const first = upsertItem(emptyVault(), { name: 'Mail', password: 'a' }, { now: '2026-01-01T00:00:00.000Z' })
    const second = upsertItem(
      first.data,
      { name: 'Mail', password: 'b' },
      { id: first.item.id, now: '2026-02-01T00:00:00.000Z' }
    )

    equal(second.data.items.length, 1, 'editing created a second item')
    equal(second.item.id, first.item.id, 'the id changed on edit')
    equal(second.item.createdAt, '2026-01-01T00:00:00.000Z', 'the created date was overwritten')
    equal(second.item.updatedAt, '2026-02-01T00:00:00.000Z', 'the updated date did not move')
  })

  await check('empty optional fields are dropped rather than stored as empty strings', () => {
    const { item } = upsertItem(emptyVault(), { name: ' Mail ', url: '  ', username: '', password: 'p' })
    equal(item.name, 'Mail', 'the name was not trimmed')
    equal(item.url, undefined, 'an empty url was stored')
    equal(item.username, undefined, 'an empty username was stored')
  })

  await check('a password with meaningful whitespace is stored verbatim', () => {
    // Trimming produces a credential that does not work and cannot be debugged.
    const { item } = upsertItem(emptyVault(), { name: 'Legacy', password: ' spaced ' })
    equal(item.password, ' spaced ', 'the password was trimmed')
  })

  await check('an unnamed item is refused', () => {
    let threw = false
    try {
      upsertItem(emptyVault(), { name: '   ', password: 'p' })
    } catch {
      threw = true
    }
    assert(threw, 'an item with no name was accepted and would be unfindable')
  })

  await check('search matches names, usernames, sites and tags — not passwords or notes', () => {
    const { data } = upsertItem(emptyVault(), {
      name: 'Mail',
      username: 'octocat',
      url: 'https://mail.example',
      password: 'zebra-crossing',
      notes: 'flamingo',
      tags: ['personal'],
    })

    equal(filterItems(data.items, 'octo').length, 1, 'username search missed')
    equal(filterItems(data.items, 'MAIL').length, 1, 'search is case sensitive')
    equal(filterItems(data.items, 'personal').length, 1, 'tag search missed')
    equal(filterItems(data.items, 'zebra').length, 0, 'the search box is an oracle for passwords')
    equal(filterItems(data.items, 'flamingo').length, 0, 'the search box is an oracle for notes')
  })

  await check('deleting removes exactly one item', () => {
    const one = upsertItem(emptyVault(), { name: 'A', password: 'a' })
    const two = upsertItem(one.data, { name: 'B', password: 'b' })
    const after = removeItem(two.data, one.item.id)
    equal(after.items.map((item) => item.name), ['B'], 'the wrong item was deleted')
  })

  await check('a merge unions disjoint edits from two devices', () => {
    const base = upsertItem(emptyVault(), { name: 'Shared', password: 'x' })
    const local = upsertItem(base.data, { name: 'Laptop', password: 'l' }).data
    const remote = upsertItem(base.data, { name: 'Phone', password: 'p' }).data

    const merged = mergeVaults(local, remote)
    equal(
      merged.items.map((item) => item.name).sort(),
      ['Laptop', 'Phone', 'Shared'],
      'the merge dropped a credential'
    )
  })

  await check('a merge keeps the newer version of an item edited on both sides', () => {
    const base = upsertItem(emptyVault(), { name: 'Shared', password: 'x' }, { now: '2026-01-01T00:00:00.000Z' })
    const local = upsertItem(base.data, { name: 'Shared', password: 'newer' }, { id: base.item.id, now: '2026-03-01T00:00:00.000Z' }).data
    const remote = upsertItem(base.data, { name: 'Shared', password: 'older' }, { id: base.item.id, now: '2026-02-01T00:00:00.000Z' }).data

    equal(mergeVaults(local, remote).items[0].password, 'newer', 'the merge kept the older edit')
    equal(mergeVaults(remote, local).items[0].password, 'newer', 'the merge is order-dependent')
  })

  await check('decrypted junk reads as an empty vault rather than crashing', () => {
    equal(normalizeVaultData(null), emptyVault(), 'null did not normalize')
    equal(normalizeVaultData({ items: 'nope' }), emptyVault(), 'a bad items field did not normalize')
    equal(
      normalizeVaultData({ version: 1, items: [{ id: 'a', name: 'A', password: 'p' }, { junk: true }] }).items.length,
      1,
      'malformed items were not filtered out'
    )
  })

  // --- generator ------------------------------------------------------------

  console.log('\ngenerator')

  await check('a generated password has the requested length', () => {
    for (const length of [8, 16, 20, 64, 128]) {
      const generated = generatePassword({
        length,
        lowercase: true,
        uppercase: true,
        digits: true,
        symbols: true,
      })
      equal(generated.length, length, `wrong length for ${length}`)
    }
  })

  await check('every enabled character class actually appears', () => {
    // Without the guarantee, a 20-character password omits symbols about 12% of the
    // time and the user finds out when the site rejects it.
    const options = { length: 20, lowercase: true, uppercase: true, digits: true, symbols: true }
    const [lower, upper, digits, symbols] = activeAlphabets(options)

    for (let i = 0; i < 200; i++) {
      const generated = generatePassword(options)
      for (const [set, label] of [
        [lower, 'lowercase'],
        [upper, 'uppercase'],
        [digits, 'digits'],
        [symbols, 'symbols'],
      ] as const) {
        assert(
          [...generated].some((char) => set.includes(char)),
          `no ${label} in "${generated}"`
        )
      }
    }
  })

  await check('disabled character classes never appear', () => {
    const options = { length: 32, lowercase: true, uppercase: false, digits: false, symbols: false }
    for (let i = 0; i < 50; i++) {
      const generated = generatePassword(options)
      assert(/^[a-z]+$/.test(generated), `unexpected characters in "${generated}"`)
    }
  })

  await check('look-alike characters are excluded', () => {
    const options = { length: 128, lowercase: true, uppercase: true, digits: true, symbols: true }
    for (let i = 0; i < 20; i++) {
      assert(!/[lI1O0]/.test(generatePassword(options)), 'a look-alike character got through')
    }
  })

  await check('generated passwords do not repeat', () => {
    const options = { length: 20, lowercase: true, uppercase: true, digits: true, symbols: true }
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(generatePassword(options))
    equal(seen.size, 500, 'the generator repeated itself — it is not using a CSPRNG properly')
  })

  await check('choosing no character class is refused rather than silently defaulted', () => {
    let threw = false
    try {
      generatePassword({ length: 20, lowercase: false, uppercase: false, digits: false, symbols: false })
    } catch {
      threw = true
    }
    assert(threw, 'an impossible generator request produced something')
  })

  await check('the entropy readout tracks the alphabet', () => {
    const wide = entropyBits({ length: 20, lowercase: true, uppercase: true, digits: true, symbols: true })
    const narrow = entropyBits({ length: 20, lowercase: true, uppercase: false, digits: false, symbols: false })
    assert(wide > narrow, 'a wider alphabet did not report more entropy')
    assert(wide > 100, `20 characters over the full alphabet should clear 100 bits, got ${wide}`)
  })

  // --- backup ---------------------------------------------------------------

  console.log('\nbackup — the vault is the one thing in the snapshot that cannot be rebuilt')

  await check('a snapshot carries the vault, and a restore still opens with the same password', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-vault-backup-'))
    const notes = path.join(dir, 'notes')
    fs.mkdirSync(notes, { recursive: true })

    const bucket = new FsBucket({
      notesDir: notes,
      metaDir: dir,
      indexPath: path.join(dir, 'index.json'),
    })
    const files = new WorkspaceStore(bucket)
    const vault = new VaultStore(files)

    await files.write('Note.md', '# Note\n')
    const original = sampleVault()
    const { envelope } = await createEnvelope(MASTER, original, TEST_KDF)
    await vault.write(envelope, { ifMatch: VAULT_CREATE_ONLY })

    // The snapshot, taken the way scripts/backup.ts takes it.
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-vault-snap-'))
    const stored = await bucket.readMeta(VAULT_FILE)
    assert(stored, 'the vault was not in the metadata namespace')
    fs.mkdirSync(path.join(snapshot, 'meta'), { recursive: true })
    fs.writeFileSync(path.join(snapshot, 'meta', VAULT_FILE), stored, 'utf-8')

    // Restore into an empty bucket and open it.
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-vault-restore-'))
    fs.mkdirSync(path.join(restoreDir, 'notes'), { recursive: true })
    const restored = new WorkspaceStore(
      new FsBucket({
        notesDir: path.join(restoreDir, 'notes'),
        metaDir: restoreDir,
        indexPath: path.join(restoreDir, 'index.json'),
      })
    )
    await restored.bucket.writeMeta(
      VAULT_FILE,
      fs.readFileSync(path.join(snapshot, 'meta', VAULT_FILE), 'utf-8')
    )

    const record = await new VaultStore(restored).read()
    assert(record, 'the vault did not survive the restore')
    const { data } = await openRecord<VaultData>(record, MASTER)
    equal(normalizeVaultData(data), original, 'the restored vault decrypted to the wrong contents')

    for (const target of [dir, snapshot, restoreDir]) {
      fs.rmSync(target, { recursive: true, force: true })
    }
  })

  await check('the backup script lists the vault among the metadata it keeps', async () => {
    // Asserted against the script's own source rather than by running it: what matters
    // is that a future edit to metaKeys cannot silently drop the one file in the
    // snapshot that nothing else can reconstruct.
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'backup.ts'), 'utf-8')
    assert(source.includes('VAULT_FILE'), 'scripts/backup.ts no longer references the vault')
    assert(
      source.includes('metaEtags'),
      'the backup no longer records metadata hashes — vault damage would go unnoticed'
    )
  })

  console.log('')
  fs.rmSync(workspace, { recursive: true, force: true })
  resetVaultStore(null)

  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures.`)
    return true
  }
  console.error(`FAIL — ${failures.length} failure(s) of ${passed + failures.length} checks:\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  return false
}

export const runVaultTests = run

if (require.main === module) {
  run().then((ok) => process.exit(ok ? 0 : 1))
}
