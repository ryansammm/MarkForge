/**
 * Self-check for lib/vault/backup.ts. Asserts the round-trip
 * export → import cycle and the malformed-input errors. Not part of the
 * `npm test` suite — that suite runs under node with a stubbed WebCrypto,
 * and this module needs the real thing. The script is intentionally tiny:
 * the first assertion that fails is the bug.
 *
 * Usage:  node --experimental-vm-modules tests/backup.mjs
 *   (run with `node` from the project root; tsx/esbuild not required.)
 */

import { exportBackup, importBackup, InvalidBackupFileError, BackupPassphraseTooShortError, BACKUP_VERSION, suggestedBackupFilename } from '../lib/vault/backup.ts'
import { normalizeVaultData, emptyVault } from '../lib/vault/items.ts'

const PASSPHRASE = 'correct-horse-battery-staple-12'

const seed = normalizeVaultData({
  items: [
    {
      id: 'a',
      name: 'GitHub',
      username: 'octo',
      password: 'hunter2-very-secret',
      url: 'https://github.com',
      totp: 'JBSWY3DPEHPK3PXP',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ],
})

const file = await exportBackup(seed, { passphrase: PASSPHRASE })
assert(file.backupVersion === BACKUP_VERSION, 'version stamped')
assert(file.app.name === 'MarkForge', 'app marker present')
assert(typeof file.exportedAt === 'string', 'exportedAt present')
assert(file.note === '', 'note default empty')

const filename = suggestedBackupFilename(new Date('2024-06-15T12:34:56.000Z'))
assert(filename.startsWith('markforge-vault-backup-2024-06-15'), 'filename format')

const restored = await importBackup(file, PASSPHRASE)
assert(restored.data.items.length === 1, 'one item restored')
assert(restored.data.items[0].password === 'hunter2-very-secret', 'password intact')
assert(restored.data.items[0].totp === 'JBSWY3DPEHPK3PXP', 'totp intact')

await assertThrows(importBackup(file, 'wrong-passphrase-12-chars'), Error, 'wrong passphrase rejected')
await assertThrows(importBackup({ not: 'a backup' }, PASSPHRASE), InvalidBackupFileError, 'junk file rejected')
await assertThrows(exportBackup(emptyVault(), { passphrase: 'short' }), BackupPassphraseTooShortError, 'short passphrase refused')

console.log('backup self-check: PASS')

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function assertThrows(promise, Ctor, msg) {
  try {
    await promise
  } catch (err) {
    if (err instanceof Ctor) return
    console.error('FAIL:', msg, '- wrong error class:', err)
    process.exit(1)
  }
  console.error('FAIL:', msg, '- did not throw')
  process.exit(1)
}
