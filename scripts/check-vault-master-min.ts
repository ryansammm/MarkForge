/**
 * Task 12a self-check: vault master password minimum length 8.
 *
 * The master password is the one credential that decrypts note bodies. A
 * 7-character password is a 7-character password, and the floor lives at
 * every entry point (create, unlock, derive) so a tampered call site
 * cannot bypass it.
 *
 * Run with `pnpm tsx scripts/check-vault-master-min.ts`. Exit 0 = pass.
 */

import {
  MIN_VAULT_MASTER_LENGTH,
  isValidVaultMaster,
} from '../lib/vault/record'
import {
  VaultPasswordTooShortError,
  createEnvelope,
  deriveKey,
  openRecord,
  newKdfParams,
} from '../lib/vault/crypto'
import type { PasswordVaultRecord } from '../lib/vault/record'

const ok: string[] = []
const fail: string[] = []

function assert(name: string, condition: unknown, detail?: string): void {
  ;(condition ? ok : fail).push(detail ? `${name} (${detail})` : name)
}

async function main(): Promise<void> {
  // ---- 1. isValidVaultMaster shape -----------------------------------

  assert('MIN_VAULT_MASTER_LENGTH is 8', MIN_VAULT_MASTER_LENGTH === 8)

  assert('isValidVaultMaster: 8 chars accepted', isValidVaultMaster('12345678'))
  assert('isValidVaultMaster: 12 chars accepted', isValidVaultMaster('long-master-pw'))
  assert('isValidVaultMaster: 7 chars rejected', !isValidVaultMaster('1234567'))
  assert('isValidVaultMaster: empty rejected', !isValidVaultMaster(''))
  assert('isValidVaultMaster: number rejected', !isValidVaultMaster(12345678 as unknown))
  assert('isValidVaultMaster: null rejected', !isValidVaultMaster(null as unknown))

  // ---- 2. deriveKey enforces the floor --------------------------------

  const kdf = newKdfParams({ iterations: 100_000 })

  for (const bad of ['', 'short', '1234567']) {
    let threw = false
    try {
      await deriveKey(bad, kdf)
    } catch (err) {
      threw = err instanceof VaultPasswordTooShortError
    }
    assert(`deriveKey: rejects "${bad}"`, threw)
  }

  const key = await deriveKey('long-enough-pw', kdf)
  assert('deriveKey: 8-char password derives a key', key instanceof CryptoKey)

  // ---- 3. createEnvelope enforces the floor ---------------------------

  for (const bad of ['1234567', '']) {
    let threw = false
    try {
      await createEnvelope(bad, { items: [] })
    } catch (err) {
      threw = err instanceof VaultPasswordTooShortError
    }
    assert(`createEnvelope: rejects "${bad}"`, threw)
  }

  // ---- 4. openRecord enforces the floor -------------------------------

  const { envelope } = await createEnvelope('original-master-pw', { items: [] })
  const record: PasswordVaultRecord = {
    ...envelope,
    revision: 'test-rev',
    updatedAt: new Date().toISOString(),
  }

  for (const bad of ['1234567', '']) {
    let threw = false
    try {
      await openRecord(record, bad)
    } catch (err) {
      threw = err instanceof VaultPasswordTooShortError
    }
    assert(`openRecord: rejects "${bad}"`, threw)
  }

  // A valid-length wrong password still fails with VaultUnlockError,
  // not the length error, so the gate doesn't pretend a too-short input
  // was a wrong guess.
  let wrongType = ''
  try {
    await openRecord(record, 'another-long-pw')
  } catch (err) {
    wrongType = err instanceof VaultPasswordTooShortError
      ? 'too-short'
      : err instanceof Error
        ? err.name
        : 'unknown'
  }
  assert(
    'openRecord: wrong-but-valid-length password throws VaultUnlockError, not TooShort',
    wrongType === 'VaultUnlockError',
    `got ${wrongType}`
  )

  // ---- 5. error message includes the length --------------------------

  let message = ''
  try {
    await deriveKey('abc', kdf)
  } catch (err) {
    message = (err as Error).message
  }
  assert(
    'VaultPasswordTooShortError message names the floor',
    message.includes(String(MIN_VAULT_MASTER_LENGTH)),
    message
  )

  // ---- report ---------------------------------------------------------

  for (const name of ok) console.log(`  ok  ${name}`)
  for (const name of fail) console.log(`  FAIL ${name}`)
  console.log(`\n${ok.length} passed, ${fail.length} failed`)
  if (fail.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
