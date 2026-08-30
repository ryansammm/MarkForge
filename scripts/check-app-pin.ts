/**
 * Task 12b self-check: app PIN gate.
 *
 * The gate credential is a 6-digit PIN. Resolution order:
 *   1. APP_PIN env
 *   2. app-settings.appPin from the bucket
 *   3. default 123098
 *
 * Surfaces verified here:
 *   - `isValidAppPin` accepts exactly 6 digits, nothing else
 *   - `resolveAppPin` honours the env > stored > default order
 *   - `validateEnv` warns for the misconfigurations a real operator hits
 *   - `sessionSecret` derives a v2-namespaced key from APP_PIN and rotates
 *     correctly when the PIN changes
 *
 * `AppSettingsStore.setAppPin` writes to the FsBucket; the in-memory bucket
 * is the test seam.
 *
 * Run with `pnpm tsx scripts/check-app-pin.ts`. Exit 0 = pass.
 */

import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { FsBucket } from '../lib/server/fs-bucket'
import {
  APP_PIN_LENGTH,
  AppSettingsStore,
  DEFAULT_APP_PIN,
  InvalidAppSettingsError,
  isValidAppPin,
  resolveAppPin,
} from '../lib/server/app-settings'
import { validateEnv } from '../lib/server/env'
import { sessionSecret } from '../lib/session'

const ok: string[] = []
const fail: string[] = []

function assert(name: string, condition: unknown, detail?: string): void {
  ;(condition ? ok : fail).push(detail ? `${name} (${detail})` : name)
}

async function withTempBucket<T>(fn: (bucket: FsBucket) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markforge-app-pin-'))
  const notesDir = path.join(root, 'notes')
  const metaDir = path.join(root, 'meta')
  await fs.mkdir(notesDir, { recursive: true })
  await fs.mkdir(metaDir, { recursive: true })
  try {
    return await fn(new FsBucket({ notesDir, metaDir }))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  // ---- 1. isValidAppPin ------------------------------------------------

  assert('isValidAppPin: 6 digits pass', isValidAppPin('123456'))
  assert('isValidAppPin: default 123098 passes', isValidAppPin(DEFAULT_APP_PIN))
  assert('isValidAppPin: 5 digits rejected', !isValidAppPin('12345'))
  assert('isValidAppPin: 7 digits rejected', !isValidAppPin('1234567'))
  assert('isValidAppPin: letters rejected', !isValidAppPin('abcdef'))
  assert('isValidAppPin: mixed rejected', !isValidAppPin('12345a'))
  assert('isValidAppPin: empty rejected', !isValidAppPin(''))
  assert('isValidAppPin: APP_PIN_LENGTH is 6', APP_PIN_LENGTH === 6)

  // ---- 2. resolveAppPin priority --------------------------------------

  // env wins over stored
  await withTempBucket(async (bucket) => {
    const store = new AppSettingsStore(bucket)
    await store.setAppPin('111111')
    const resolved = resolveAppPin({ APP_PIN: '222222' }, await store.load())
    assert('resolveAppPin: env wins over stored', resolved === '222222', `got ${resolved}`)
  })

  // stored wins over default
  await withTempBucket(async (bucket) => {
    const store = new AppSettingsStore(bucket)
    await store.setAppPin('333333')
    const resolved = resolveAppPin({}, await store.load())
    assert('resolveAppPin: stored wins over default', resolved === '333333', `got ${resolved}`)
  })

  // default when nothing configured
  assert(
    'resolveAppPin: default when env + stored empty',
    resolveAppPin({}, null) === DEFAULT_APP_PIN
  )

  // env with bad shape falls back to default
  assert(
    'resolveAppPin: bad env shape falls back to default',
    resolveAppPin({ APP_PIN: 'short' }, null) === DEFAULT_APP_PIN
  )

  // ---- 3. AppSettingsStore round-trip ---------------------------------

  await withTempBucket(async (bucket) => {
    const store = new AppSettingsStore(bucket)
    const initial = await store.load()
    assert('AppSettingsStore: initial load is null', initial === null)

    const written = await store.setAppPin('654321')
    assert('AppSettingsStore: setAppPin returns the new settings', written.appPin === '654321')
    assert('AppSettingsStore: updatedAt is a timestamp', !Number.isNaN(Date.parse(written.updatedAt)))

    const reloaded = await store.load()
    assert('AppSettingsStore: reload sees the new PIN', reloaded?.appPin === '654321')

    // setAppPin rejects bad shape
    let threw = false
    try {
      await store.setAppPin('not-6-digits')
    } catch (err) {
      threw = err instanceof InvalidAppSettingsError
    }
    assert('AppSettingsStore: setAppPin rejects bad shape', threw)
  })

  // ---- 4. validateEnv warns -------------------------------------------

  const w1 = validateEnv({ APP_PASSWORD: 'still-set' })
  assert(
    'validateEnv: APP_PASSWORD triggers deprecation warning',
    w1.warnings.some((w) => w.includes('APP_PASSWORD'))
  )

  const w2 = validateEnv({ APP_PIN: '1234' })
  assert(
    'validateEnv: short APP_PIN warns',
    w2.warnings.some((w) => w.includes('APP_PIN must be exactly 6 digits'))
  )

  const w3 = validateEnv({})
  assert('validateEnv: nothing set warns', w3.warnings.length > 0)
  assert('validateEnv: nothing set means gate off', w3.gated === false)

  const w4 = validateEnv({ APP_PIN: '123456' })
  assert('validateEnv: valid PIN is silent', w4.warnings.length === 0)
  assert('validateEnv: valid PIN means gate on', w4.gated === true)

  const w5 = validateEnv({}, { hasStoredPin: true })
  assert('validateEnv: stored PIN counts as gated', w5.gated === true)

  // ---- 5. sessionSecret rotation ---------------------------------------

  const before = sessionSecret({ APP_PIN: '111111' })!
  const after = sessionSecret({ APP_PIN: '222222' })!
  assert('sessionSecret: v2 namespace in derived key', before.includes('morrow-session-v2:pin:'))
  assert('sessionSecret: derived key is not the PIN verbatim', before !== '111111')
  assert('sessionSecret: rotating the PIN changes the key', before !== after)
  assert(
    'sessionSecret: SESSION_SECRET still wins',
    sessionSecret({ SESSION_SECRET: 'override', APP_PIN: '111111' }) === 'override'
  )

  // ---- report ----------------------------------------------------------

  for (const name of ok) console.log(`  ok  ${name}`)
  for (const name of fail) console.log(`  FAIL ${name}`)
  console.log(`\n${ok.length} passed, ${fail.length} failed`)
  if (fail.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
