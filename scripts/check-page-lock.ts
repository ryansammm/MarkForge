/**
 * Task 9 self-check: per-page lock.
 *
 * Four surfaces to verify:
 *
 *   1. `makeLock` produces a lock object whose hash actually verifies
 *      the passphrase it was built from. Each call returns a fresh
 *      salt, so the same passphrase yields a different object.
 *   2. `verifyPassphrase` returns false for any wrong passphrase and
 *      for a structurally different lock object.
 *   3. `setFrontmatterObject` round-trips through `splitFrontmatter`
 *      and `frontmatterLock`. Removing the key with
 *      `removeFrontmatterField` returns the document to its original
 *      state (modulo whitespace at the seam).
 *   4. `isPageLock` is a real type guard: an object missing a
 *      required field is not a lock.
 *
 * Run with `pnpm tsx scripts/check-page-lock.ts`. Exit 0 = pass.
 */
import { setFrontmatterObject, removeFrontmatterField, frontmatterLock, splitFrontmatter } from '../lib/markdown/frontmatter'
import { makeLock, verifyPassphrase, isPageLock } from '../lib/lock/page-lock'

const ok: string[] = []
const fail: string[] = []

function assert(name: string, condition: unknown, detail?: string): void {
  ;(condition ? ok : fail).push(detail ? `${name} (${detail})` : name)
}

async function main(): Promise<void> {
  // ---- 1. makeLock + verifyPassphrase -----------------------------------

  const lockA = await makeLock('correct horse battery staple')
  assert('makeLock: kdf is PBKDF2-SHA256', lockA.kdf === 'PBKDF2-SHA256')
  assert('makeLock: salt is non-empty base64url', lockA.salt.length > 0 && /^[A-Za-z0-9_-]+$/.test(lockA.salt))
  assert('makeLock: hash is non-empty base64url', lockA.hash.length > 0 && /^[A-Za-z0-9_-]+$/.test(lockA.hash))
  assert('makeLock: iterations is the agreed floor', lockA.iterations === 100_000)

  assert('verifyPassphrase: correct passphrase opens the lock', await verifyPassphrase('correct horse battery staple', lockA))
  assert(
    'verifyPassphrase: wrong passphrase is rejected',
    !(await verifyPassphrase('wrong passphrase', lockA))
  )
  assert(
    'verifyPassphrase: empty passphrase is rejected',
    !(await verifyPassphrase('', lockA))
  )
  assert(
    'verifyPassphrase: case-sensitive (Wrong != wrong)',
    !(await verifyPassphrase('correct horse Battery staple', lockA))
  )

  const lockB = await makeLock('correct horse battery staple')
  assert(
    'makeLock: same passphrase produces a different lock (per-call salt)',
    lockA.salt !== lockB.salt && lockA.hash !== lockB.hash
  )
  assert(
    'verifyPassphrase: lockB opens with the same passphrase',
    await verifyPassphrase('correct horse battery staple', lockB)
  )

  // ---- 2. unknown kdf is rejected ---------------------------------------

  const malformed = {
    kdf: 'argon2id' as unknown as 'PBKDF2-SHA256',
    salt: lockA.salt,
    iterations: 100_000,
    hash: lockA.hash,
  }
  assert('verifyPassphrase: unknown kdf is rejected', !(await verifyPassphrase('correct horse battery staple', malformed)))

  // ---- 3. frontmatter round-trip ----------------------------------------

  const original = [
    '---',
    'title: A locked note',
    'tags: [private]',
    '---',
    '',
    '# Body',
    '',
    'Some text here.',
    '',
  ].join('\n')

  const next = setFrontmatterObject(original, 'lock', lockA as unknown as Record<string, unknown>)
  assert('setFrontmatterObject: changed=true', next.changed)

  const split = splitFrontmatter(next.content)
  const lockField = frontmatterLock(split.frontmatter)
  assert('round-trip: frontmatterLock sees the lock', lockField !== null)
  if (lockField) {
    assert('round-trip: salt round-tripped', lockField.salt === lockA.salt)
    assert('round-trip: hash round-tripped', lockField.hash === lockA.hash)
    assert('round-trip: iterations round-tripped', lockField.iterations === lockA.iterations)
  }

  // Verify the lock on disk actually opens the lock the user set.
  if (lockField) {
    const ok3 = await verifyPassphrase('correct horse battery staple', lockField)
    assert('round-trip: passphrase still opens the on-disk lock', ok3)
  }

  // Remove the lock and confirm the document goes back to a no-lock
  // state (modulo the line removal).
  const removed = removeFrontmatterField(next.content, 'lock')
  assert('removeFrontmatterField: changed=true after write+read', removed.changed)
  const splitAfter = splitFrontmatter(removed.content)
  assert('removeFrontmatterField: lock is gone', frontmatterLock(splitAfter.frontmatter) === null)
  assert('removeFrontmatterField: other frontmatter survived', splitAfter.frontmatter.title === 'A locked note')

  // Empty-frontmatter case: setFrontmatterObject adds the block.
  const noFm = '# Just a body\n'
  const added = setFrontmatterObject(noFm, 'lock', lockA as unknown as Record<string, unknown>)
  assert('setFrontmatterObject: adds frontmatter block when missing', added.changed)
  const splitAdded = splitFrontmatter(added.content)
  assert('setFrontmatterObject: frontmatterLock sees the new lock', frontmatterLock(splitAdded.frontmatter) !== null)

  // Removing a lock that does not exist is a no-op.
  const noLock = removeFrontmatterField(noFm, 'lock')
  assert('removeFrontmatterField: missing key returns changed=false', noLock.changed === false)

  // ---- 4. isPageLock type guard ----------------------------------------

  assert('isPageLock: a real lock is a lock', isPageLock(lockA))
  assert('isPageLock: null is not a lock', !isPageLock(null))
  assert('isPageLock: undefined is not a lock', !isPageLock(undefined))
  assert('isPageLock: {} is not a lock', !isPageLock({}))
  assert('isPageLock: missing salt is not a lock', !isPageLock({ kdf: 'PBKDF2-SHA256', hash: 'x', iterations: 100000 }))
  assert(
    'isPageLock: iterations below floor is not a lock',
    !isPageLock({ kdf: 'PBKDF2-SHA256', salt: 'a', hash: 'b', iterations: 1000 })
  )

  console.log(`page-lock: Task 9 check`)
  ok.forEach((name) => console.log(`  ok  ${name}`))
  fail.forEach((name) => console.log(`  FAIL ${name}`))
  console.log('')
  console.log(`${ok.length}/${ok.length + fail.length} pass`)
  if (fail.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
