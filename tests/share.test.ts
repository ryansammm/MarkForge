import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WorkspaceStore } from '../lib/server/workspace-store'
import { MemoryBucket } from '../lib/server/bucket'
import { ShareStore } from '../lib/server/share-store'
import { isPathInScope, type Share, type SharedDocumentResponse } from '../lib/share'
import type { ShareResolution } from '../lib/server/share-store'

/**
 * Share model suite (PRD R8, Sprint 6 P0).
 *
 * This replaces a suite that asserted the old behaviour — resolving a share by
 * document title — as correct, which locked in an unauthenticated read of the whole
 * corpus. The tests here exist to make that class of bug loud:
 *
 *   - a share resolves by token and by nothing else
 *   - every failure is the same 404: unknown token, revoked token, out-of-scope path
 *   - middleware exempts the public read route and NOT the management route
 */

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

/**
 * The document a resolution yielded.
 *
 * Fails the check when the share did not open — including when it opened only as far
 * as a password prompt, which is a different outcome from a readable document and
 * must never be mistaken for one.
 */
function opened(result: ShareResolution | null): SharedDocumentResponse {
  if (!result) throw new Error('the share did not resolve at all')
  if (result.kind !== 'ok') throw new Error(`the share resolved as "${result.kind}", not a document`)
  return result.lookup.response
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
  }
}

interface Workspace {
  dir: string
  notes: string
  files: WorkspaceStore
  shares: ShareStore
}

function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-share-'))
  const notes = path.join(dir, 'notes')
  fs.mkdirSync(notes, { recursive: true })
  const files = new WorkspaceStore(new MemoryBucket())
  return { dir, notes, files, shares: new ShareStore(files) }
}

const cleanup = (ws: Workspace) => fs.rmSync(ws.dir, { recursive: true, force: true })

async function run() {
  console.log('Share model suite\n')

  console.log('resolution is by token, and only by token')
  {
    const ws = makeWorkspace()
    try {
      await ws.files.write('Notes/Public.md', '---\nid: doc-public\n---\n\n# Public\n\nHello.\n')
      await ws.files.write('Notes/Private.md', '# Private\n\nSecrets.\n')
      const share = await ws.shares.create('Notes/Public.md', 'document')

      await check('a live token resolves', async () => {
        const result = await ws.shares.resolve(share.token)
        assert(result, 'should resolve')
        equal(opened(result).path, 'Notes/Public.md', 'wrong document')
        assert(opened(result).body.includes('Hello.'), 'content missing')
      })

      await check('the token is unguessable, not derived from the path', () => {
        assert(share.token.length >= 20, `token too short: ${share.token.length} chars`)
        assert(!/public|notes|\.md/i.test(share.token), `token leaks the path: ${share.token}`)
      })

      await check('THE BUG THIS REPLACES: a title is not a token', async () => {
        for (const guess of ['Public', 'Notes/Public.md', 'doc-public', 'Private', 'Notes/Private.md']) {
          const result = await ws.shares.resolve(guess)
          assert(result === null, `"${guess}" resolved — resolution is not token-only`)
        }
      })

      await check('an unshared document is unreachable through any share', async () => {
        const result = await ws.shares.resolve(share.token, 'Notes/Private.md')
        assert(result === null, 'a document-scoped share exposed a sibling')
      })

      await check('an unknown token is null', async () => {
        equal(await ws.shares.resolve('not-a-real-token'), null, 'should not resolve')
        equal(await ws.shares.resolve(''), null, 'empty token should not resolve')
      })

      await check('frontmatter never reaches a public reader', async () => {
        await ws.files.write(
          'Sensitive.md',
          '---\nid: doc-sensitive\nsalary_band: L7\nclient: Acme Corp\n---\n\n# Sensitive\n\nPublic part.\n'
        )
        const s = await ws.shares.create('Sensitive.md', 'document')
        const result = await ws.shares.resolve(s.token)

        assert(result, 'should resolve')
        const payload = JSON.stringify(opened(result))
        assert(!payload.includes('salary_band'), 'frontmatter key leaked into the response')
        assert(!payload.includes('Acme Corp'), 'frontmatter value leaked into the response')
        assert(opened(result).body.includes('Public part.'), 'body missing')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nrevocation')
  {
    const ws = makeWorkspace()
    try {
      await ws.files.write('Doc.md', '# Doc\n')
      const share = await ws.shares.create('Doc.md', 'document')

      await check('a revoked token stops resolving', async () => {
        assert(await ws.shares.resolve(share.token), 'should resolve before revocation')
        await ws.shares.revoke(share.token)
        equal(await ws.shares.resolve(share.token), null, 'still resolving after revocation')
      })

      await check('revoked and unknown are indistinguishable (PRD R8)', async () => {
        // Both must be null so the route returns an identical 404. A 403 for the
        // revoked case would confirm the document exists.
        equal(await ws.shares.resolve(share.token), null, 'revoked')
        equal(await ws.shares.resolve('never-existed'), null, 'unknown')
      })

      await check('revoking twice is not an error', async () => {
        equal(await ws.shares.revoke(share.token), true, 'second revoke should still find it')
      })

      await check('revoking an unknown token reports not-found', async () => {
        equal(await ws.shares.revoke('nope'), false, 'should report false')
      })

      await check('the revoked share stays listed, so it is auditable', async () => {
        const list = await ws.shares.list()
        equal(list.length, 1, 'share disappeared from the list')
        assert(list[0].revokedAt !== null, 'revokedAt not recorded')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nsubtree scope')
  {
    const ws = makeWorkspace()
    try {
      await ws.files.write('Guide/Index.md', '# Index\n\nSee [[Chapter One]] and [[Secret Note]].\n')
      await ws.files.write('Guide/Chapter One.md', '# Chapter One\n\nInside the shared folder.\n')
      await ws.files.write('Guide-Private/Secret Note.md', '# Secret Note\n\nNot shared.\n')

      const share = await ws.shares.create('Guide', 'subtree')

      await check('the folder root lands on Index.md, not the alphabetically first file', async () => {
        // "Guide/Chapter One.md" sorts before "Guide/Index.md", so this fails if the
        // index-name preference is dropped and the fallback takes over.
        const result = await ws.shares.resolve(share.token)
        assert(result, 'a subtree share should resolve without a ?path')
        equal(opened(result).path, 'Guide/Index.md', 'wrong landing document')
      })

      await check('a document inside the subtree resolves', async () => {
        const result = await ws.shares.resolve(share.token, 'Guide/Chapter One.md')
        assert(result, 'in-scope document should resolve')
        equal(opened(result).title, 'Chapter One', 'wrong document')
      })

      await check('a sibling folder sharing a name prefix does NOT resolve', async () => {
        // "Guide-Private" starts with "Guide". Without the trailing-slash check in
        // isPathInScope, sharing Guide/ would also publish Guide-Private/.
        const result = await ws.shares.resolve(share.token, 'Guide-Private/Secret Note.md')
        assert(result === null, 'prefix collision exposed a private folder')
      })

      await check('isPathInScope rejects the prefix collision directly', () => {
        const subtree = { path: 'Guide', scope: 'subtree' } as Share
        assert(isPathInScope(subtree, 'Guide/Chapter One.md'), 'in-scope path rejected')
        assert(isPathInScope(subtree, 'Guide'), 'the folder itself should be in scope')
        assert(!isPathInScope(subtree, 'Guide-Private/Secret Note.md'), 'prefix collision accepted')
        assert(!isPathInScope(subtree, 'Elsewhere.md'), 'unrelated path accepted')
      })

      await check('in-scope links are clickable, out-of-scope links are not listed', async () => {
        const result = await ws.shares.resolve(share.token, 'Guide/Index.md')
        assert(result, 'should resolve')
        const links = opened(result).inScopeLinks
        equal(links['Chapter One'], 'Guide/Chapter One.md', 'in-scope link missing')
        assert(
          !('Secret Note' in links),
          'an out-of-scope document was named in inScopeLinks — that leaks its existence'
        )
      })

      await check('a document-scoped share lists no clickable links at all', async () => {
        await ws.files.write('Solo.md', '# Solo\n\nSee [[Chapter One]].\n')
        const solo = await ws.shares.create('Solo.md', 'document')
        const result = await ws.shares.resolve(solo.token)
        equal(opened(result).inScopeLinks, {}, 'a single-document share should have no in-scope links')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\ncreation guards')
  {
    const ws = makeWorkspace()
    try {
      await check('cannot share a document that does not exist', async () => {
        let threw = false
        try {
          await ws.shares.create('Nope.md', 'document')
        } catch {
          threw = true
        }
        assert(threw, 'should have refused')
      })

      await check('cannot share a folder that has no documents', async () => {
        let threw = false
        try {
          await ws.shares.create('Empty', 'subtree')
        } catch {
          threw = true
        }
        assert(threw, 'should have refused')
      })

      await check('cannot escape the workspace with a relative path', async () => {
        let threw = false
        try {
          await ws.shares.create('../escape', 'subtree')
        } catch {
          threw = true
        }
        assert(threw, 'should have refused')
      })

      await check('two shares of the same document get different tokens', async () => {
        await ws.files.write('Twice.md', '# Twice\n')
        const a = await ws.shares.create('Twice.md', 'document')
        const b = await ws.shares.create('Twice.md', 'document')
        assert(a.token !== b.token, 'tokens collided')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nexpiring links')
  {
    const ws = makeWorkspace()
    try {
      await check('a share with no expiry keeps working', async () => {
        await ws.files.write('Forever.md', '# Forever\n')
        const share = await ws.shares.create('Forever.md', 'document')
        equal(share.expiresAt, null, 'an expiry was invented')
        assert(await ws.shares.resolve(share.token), 'a share with no expiry stopped working')
      })

      await check('an expired share is indistinguishable from one that never existed', async () => {
        await ws.files.write('Temporary.md', '# Temporary\n')
        const share = await ws.shares.create('Temporary.md', 'document', { expiresInDays: 7 })
        assert(share.expiresAt, 'no expiry was recorded')
        assert(await ws.shares.resolve(share.token), 'the link did not work before expiry')

        // Move the expiry into the past rather than the clock into the future: the
        // store reads the record, so this is the same code path a real expiry takes.
        const raw = JSON.parse(
          (await ws.files.bucket.readMeta('shares.json'))!
        ) as { shares: Share[] }
        raw.shares[raw.shares.length - 1].expiresAt = new Date(Date.now() - 1000).toISOString()
        await ws.files.bucket.writeMeta('shares.json', JSON.stringify(raw))

        equal(await ws.shares.resolve(share.token), null, 'an expired link still resolved')
      })

      await check('an unparseable expiry fails closed', async () => {
        await ws.files.write('Broken.md', '# Broken\n')
        const share = await ws.shares.create('Broken.md', 'document', { expiresInDays: 7 })

        const raw = JSON.parse((await ws.files.bucket.readMeta('shares.json'))!) as { shares: Share[] }
        raw.shares[raw.shares.length - 1].expiresAt = 'whenever'
        await ws.files.bucket.writeMeta('shares.json', JSON.stringify(raw))

        // A corrupt record must not become a link that outlives its own expiry.
        equal(await ws.shares.resolve(share.token), null, 'a corrupt expiry left the link live')
      })

      await check('a nonsensical expiry is refused at creation', async () => {
        await ws.files.write('Guarded.md', '# Guarded\n')
        for (const days of [0, -3, Number.NaN]) {
          const failed = await ws.shares
            .create('Guarded.md', 'document', { expiresInDays: days })
            .then(() => false, () => true)
          assert(failed, `expiresInDays=${days} was accepted`)
        }
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\npassword-protected links')
  {
    const ws = makeWorkspace()
    try {
      await check('a protected share resolves as locked, not as a document', async () => {
        await ws.files.write('Secret.md', '# Secret\n\nconfidential\n')
        const share = await ws.shares.create('Secret.md', 'document', { password: 'correct horse' })

        const result = await ws.shares.resolve(share.token)
        assert(result && result.kind === 'locked', 'a protected share handed over its contents')
        equal(result.label, 'Secret', 'the label should still name the share for the prompt')
        assert(
          !JSON.stringify(result).includes('confidential'),
          'the locked response leaked the document body'
        )
      })

      await check('it opens once unlocked', async () => {
        await ws.files.write('Openable.md', '# Openable\n\nvisible\n')
        const share = await ws.shares.create('Openable.md', 'document', { password: 'letmein' })

        const result = await ws.shares.resolve(share.token, undefined, { unlocked: true })
        assert(opened(result).body.includes('visible'), 'an unlocked share did not open')
      })

      await check('the right password verifies and a wrong one does not', async () => {
        await ws.files.write('Checked.md', '# Checked\n')
        const share = await ws.shares.create('Checked.md', 'document', { password: 'p4ssw0rd' })

        equal(await ws.shares.checkPassword(share.token, 'p4ssw0rd'), true, 'the right password failed')
        equal(await ws.shares.checkPassword(share.token, 'P4ssw0rd'), false, 'a wrong password passed')
        equal(await ws.shares.checkPassword(share.token, ''), false, 'an empty password passed')
      })

      await check('checkPassword cannot be used to probe for tokens', async () => {
        await ws.files.write('Plain.md', '# Plain\n')
        const open = await ws.shares.create('Plain.md', 'document')

        // An unprotected share and a token that does not exist answer identically, so
        // this cannot tell an attacker which tokens are real.
        equal(await ws.shares.checkPassword(open.token, 'anything'), false, 'an unprotected share unlocked')
        equal(await ws.shares.checkPassword('no-such-token', 'anything'), false, 'an unknown token unlocked')
      })

      await check('a revoked protected share cannot be unlocked', async () => {
        await ws.files.write('Revoked.md', '# Revoked\n')
        const share = await ws.shares.create('Revoked.md', 'document', { password: 'shibboleth' })
        await ws.shares.revoke(share.token)

        equal(await ws.shares.checkPassword(share.token, 'shibboleth'), false, 'a revoked share unlocked')
        equal(await ws.shares.resolve(share.token, undefined, { unlocked: true }), null, 'a revoked share opened')
      })

      await check('the password never leaves the server', async () => {
        await ws.files.write('Hidden.md', '# Hidden\n')
        const created = await ws.shares.create('Hidden.md', 'document', { password: 'super-secret' })

        // What the API returns, and what the manage list returns, are the two ways a
        // hash could reach a browser.
        assert(!JSON.stringify(created).includes('super-secret'), 'the create response echoed the password')
        assert(!('passwordHash' in created), 'the create response carried the hash')
        equal(created.hasPassword, true, 'the share does not report that it is protected')

        const listed = await ws.shares.list()
        assert(!JSON.stringify(listed).includes('super-secret'), 'the manage list echoed the password')
        assert(!JSON.stringify(listed).includes('scrypt$'), 'the manage list carried the hash')
        assert(listed.some((s) => s.hasPassword), 'the manage list does not report protection')
      })

      await check('the stored hash is not the password', async () => {
        await ws.files.write('Stored.md', '# Stored\n')
        await ws.shares.create('Stored.md', 'document', { password: 'plaintext-please' })

        const raw = (await ws.files.bucket.readMeta('shares.json'))!
        assert(!raw.includes('plaintext-please'), 'shares.json holds the password in the clear')
        assert(raw.includes('scrypt$'), 'the password was not hashed with scrypt')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\ntokens survive an index rebuild')
  {
    const ws = makeWorkspace()
    try {
      await check('shares.json is independent of index.json', async () => {
        await ws.files.write('Durable.md', '# Durable\n')
        const share = await ws.shares.create('Durable.md', 'document')

        // Sprint 5 wipes and rebuilds the index. A link already sent must not break.
        fs.rmSync(path.join(ws.dir, 'index.json'), { force: true })

        const result = await ws.shares.resolve(share.token)
        assert(result, 'the token stopped working after the index was wiped')
        equal(opened(result).title, 'Durable', 'wrong document after rebuild')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nimages inside a share')
  {
    const ws = makeWorkspace()
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
      'base64'
    )
    const SHARED_IMAGE = 'assets/2026/aaaaaaaa-shared.png'
    const PRIVATE_IMAGE = 'assets/2026/bbbbbbbb-private.png'

    try {
      await ws.files.bucket.writeBinary(SHARED_IMAGE, PNG, 'image/png')
      await ws.files.bucket.writeBinary(PRIVATE_IMAGE, PNG, 'image/png')

      await ws.files.write('Public/Note.md', `# Public\n\n![shared](${SHARED_IMAGE})\n`)
      await ws.files.write('Private/Secret.md', `# Secret\n\n![private](${PRIVATE_IMAGE})\n`)

      const share = await ws.shares.create('Public/Note.md', 'document')

      await check('an image the shared document embeds is served', async () => {
        const asset = await ws.shares.resolveAsset(share.token, SHARED_IMAGE)
        assert(asset, 'the image in the shared document was not served')
        equal(asset!.contentType, 'image/png', 'wrong content type')
        equal(
          Buffer.from(asset!.bytes).toString('base64'),
          PNG.toString('base64'),
          'the bytes changed on the way out'
        )
      })

      await check('an image only a private document references is not', async () => {
        /**
         * The whole point of scoping. Without it a share would be a read capability
         * over every image in the vault, gated only by guessing eight hex characters —
         * and unguessability is not the security model used anywhere else here.
         */
        equal(
          await ws.shares.resolveAsset(share.token, PRIVATE_IMAGE),
          null,
          'a private document’s image was served to a public link'
        )
      })

      await check('EVERY refusal is the same answer: null', async () => {
        // The property the route turns into one identical 404. A distinguishable
        // response for "exists but out of scope" is an existence oracle over the
        // asset namespace, which is precisely what the share model exists to deny.
        const refusals: Array<[string, Promise<unknown>]> = [
          ['out of scope', ws.shares.resolveAsset(share.token, PRIVATE_IMAGE)],
          ['no such image', ws.shares.resolveAsset(share.token, 'assets/2026/cccccccc-gone.png')],
          ['unknown token', ws.shares.resolveAsset('not-a-real-token', SHARED_IMAGE)],
          ['empty token', ws.shares.resolveAsset('', SHARED_IMAGE)],
          ['a document, not an image', ws.shares.resolveAsset(share.token, 'Public/Note.md')],
          ['traversal out of the namespace', ws.shares.resolveAsset(share.token, 'assets/../Private/Secret.md')],
          ['the private document itself', ws.shares.resolveAsset(share.token, 'Private/Secret.md')],
        ]

        for (const [label, promise] of refusals) {
          equal(await promise, null, `${label}: expected null, and every failure must look alike`)
        }
      })

      await check('a revoked share stops serving its images', async () => {
        const doomed = await ws.shares.create('Public/Note.md', 'document')
        assert(await ws.shares.resolveAsset(doomed.token, SHARED_IMAGE), 'should serve while live')

        await ws.shares.revoke(doomed.token)
        equal(
          await ws.shares.resolveAsset(doomed.token, SHARED_IMAGE),
          null,
          'a revoked link kept serving the picture it used to show'
        )
      })

      await check('a locked share serves nothing until it is unlocked', async () => {
        const locked = await ws.shares.create('Public/Note.md', 'document', { password: 'hunter2' })

        equal(
          await ws.shares.resolveAsset(locked.token, SHARED_IMAGE),
          null,
          'a password-protected share handed out its images without the password'
        )
        assert(
          await ws.shares.resolveAsset(locked.token, SHARED_IMAGE, { unlocked: true }),
          'once unlocked it should serve'
        )
      })

      await check('a subtree share covers the images of every document under it', async () => {
        const nested = 'assets/2026/dddddddd-nested.png'
        await ws.files.bucket.writeBinary(nested, PNG, 'image/png')
        await ws.files.write('Public/Deep/Nested.md', `# Nested\n\n![n](${nested})\n`)

        const subtree = await ws.shares.create('Public', 'subtree')
        assert(
          await ws.shares.resolveAsset(subtree.token, nested),
          'an image referenced deeper in the subtree was refused'
        )
        equal(
          await ws.shares.resolveAsset(subtree.token, PRIVATE_IMAGE),
          null,
          'the subtree share reached outside its own folder'
        )
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nmiddleware exemptions')
  {
    const { NextRequest } = await import('next/server')
    const previous = process.env.APP_PIN
    process.env.APP_PIN = '123456'

    try {
      const { middleware } = await import('../middleware')
      // Async since Phase 2: verifying a signed session is an HMAC computation, and
      // Web Crypto is promise-based.
      const statusFor = async (pathname: string) => {
        const res = await middleware(new NextRequest(`http://localhost:3000${pathname}`, { method: 'GET' }))
        return res?.status ?? 200
      }

      await check('the public read route is reachable without signing in', async () => {
        equal(await statusFor('/api/share/sometoken'), 200, '/api/share/<token> should be exempt')
        equal(await statusFor('/share/sometoken'), 200, '/share/<token> should be exempt')
      })

      await check('the share asset route is exempt too, and /api/assets is not', async () => {
        // If the image route were not under the exempt prefix, every picture on every
        // shared page would come back 401. And if the authenticated one leaked out of
        // the gate, the entire asset namespace would be public.
        equal(
          await statusFor('/api/share/sometoken/asset'),
          200,
          '/api/share/<token>/asset should be exempt'
        )
        equal(await statusFor('/api/assets'), 401, '/api/assets must stay behind the gate')
      })

      await check('THE PLURAL TRAP: /api/shares stays behind the password gate', async () => {
        // "/api/shares".startsWith("/api/share") is true. A prefix test without the
        // trailing slash would exempt the management route, handing every live token
        // to anyone who asked for the list.
        const status = await statusFor('/api/shares')
        assert(
          status === 401,
          `/api/shares returned ${status} to an unauthenticated caller — it must be 401`
        )
      })

      await check('the workspace itself is still gated', async () => {
        const status = await statusFor('/')
        assert(status === 302 || status === 307, `expected a redirect, got ${status}`)
        equal(await statusFor('/api/files'), 401, '/api/files should be 401')
      })

      await check('the old password-as-cookie no longer opens the gate', async () => {
        // The pre-Phase-2 cookie was the password itself. Anyone still holding one —
        // or anyone who learned the password from a log that captured a cookie header
        // — must be sent back to the login page, not let in.
        const request = new NextRequest('http://localhost:3000/api/files', { method: 'GET' })
        request.cookies.set('app_access_token', 'test-password')
        request.cookies.set('markforge_session', 'test-password')

        const response = await middleware(request)
        equal(response?.status, 401, 'a legacy password cookie was accepted as a session')
      })
    } finally {
      if (previous === undefined) delete process.env.APP_PIN
      else process.env.APP_PIN = previous
    }
  }

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

export { run as runShareTests }
