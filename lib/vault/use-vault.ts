'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchVault, saveVault, VaultApiError } from './api'
import {
  createEnvelope,
  openRecord,
  resealEnvelope,
  unseal,
  UnsupportedVaultError,
  VaultUnlockError,
} from './crypto'
import { emptyVault, mergeVaults, normalizeVaultData, type VaultData } from './items'
import { VAULT_CREATE_ONLY, type VaultKdf } from './record'
import { cancelScheduledClear } from './clipboard'

/**
 * Lock state for the password vault.
 *
 * The invariant this hook exists to hold: **the derived key and the decrypted vault
 * live in refs and nowhere else.** Not in `localStorage`, not in `sessionStorage`, not
 * in a cookie, not in a service worker cache. The practical consequence is that a
 * reload locks the vault, and that is the intended behaviour rather than a limitation
 * — a browser that could restore an unlocked vault after a refresh could restore it
 * for whoever picks the laptop up next.
 *
 * The MarkForge session and the vault are separate credentials on purpose. Signing in
 * gets you the app; the master password gets you the vault; locking one does not touch
 * the other.
 */

export type VaultStatus =
  /** Asking the server whether a vault exists. */
  | 'loading'
  /** No vault on this workspace yet — offer to create one. */
  | 'absent'
  /** A vault exists and is sealed. */
  | 'locked'
  | 'unlocked'
  /** The record could not be read, or the browser cannot do the crypto. */
  | 'unavailable'

/** Idle time before the vault locks itself. */
export const AUTO_LOCK_MS = 15 * 60 * 1000

/**
 * Grace period once the tab is hidden.
 *
 * Shorter than the idle timeout because a hidden tab is the shape of "walked away
 * from the desk", and long enough that switching to the browser you are pasting the
 * password into does not lock the vault out from under you.
 */
export const HIDDEN_LOCK_MS = 60 * 1000

const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'focus'] as const

export interface VaultConflictState {
  message: string
  /** The revision the server holds, for the retry. */
  actualRevision: string | null
}

export interface UseVault {
  status: VaultStatus
  data: VaultData | null
  /** Load or crypto failure. Save failures surface through `saveError`/`conflict`. */
  error: string | null
  busy: boolean
  saveError: string | null
  conflict: VaultConflictState | null
  lockedReason: string | null
  updatedAt: string | null

  /**
   * The unlocked `CryptoKey`, or null when the vault is locked or absent.
   * Same handle the vault uses to seal and unseal — note body encryption
   * in `lib/client/note-crypto.ts` reuses it instead of deriving a second
   * key from the same master password.
   */
  getKey: () => CryptoKey | null
  /** The KDF parameters the key was derived with. Used to record what
   *  the key is keyed to; null when the vault is locked or absent. */
  getKdf: () => VaultKdf | null

  create: (masterPassword: string) => Promise<void>
  unlock: (masterPassword: string) => Promise<void>
  lock: (reason?: string) => void
  /** Seals and stores `next`. Rejects rather than resolving when the save fails. */
  commit: (next: VaultData) => Promise<void>
  resolveConflict: (strategy: 'merge' | 'overwrite') => Promise<void>
  refresh: () => Promise<void>
}

export function useVault(active: boolean): UseVault {
  const [status, setStatus] = useState<VaultStatus>('loading')
  const [data, setData] = useState<VaultData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<VaultConflictState | null>(null)
  const [lockedReason, setLockedReason] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Never state. See the note at the top of this file.
  const keyRef = useRef<CryptoKey | null>(null)
  const kdfRef = useRef<VaultKdf | null>(null)
  const revisionRef = useRef<string | null>(null)
  const dataRef = useRef<VaultData | null>(null)
  // Zero, not `Date.now()`: a clock read during render is impure, and the value is
  // meaningless until something unlocks the vault and stamps it.
  const lastActivityRef = useRef(0)

  const forget = useCallback(() => {
    keyRef.current = null
    dataRef.current = null
    setData(null)
    setSaveError(null)
    setConflict(null)
    // The clipboard is part of the vault's exposed surface, so locking wipes it now
    // rather than leaving a scheduled clear to run after the user has walked away.
    cancelScheduledClear()
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(' ').catch(() => undefined)
  }, [])

  const lock = useCallback(
    (reason?: string) => {
      forget()
      setLockedReason(reason ?? null)
      setStatus((prev) => (prev === 'unlocked' ? 'locked' : prev))
    },
    [forget]
  )

  const refresh = useCallback(async () => {
    try {
      const { record } = await fetchVault()
      revisionRef.current = record?.revision ?? null
      kdfRef.current = record?.kdf ?? null
      setUpdatedAt(record?.updatedAt ?? null)
      setError(null)
      setStatus(record ? 'locked' : 'absent')
      return
    } catch (err) {
      setError((err as Error).message)
      setStatus('unavailable')
    }
  }, [])

  useEffect(() => {
    if (!active) return
    // Only when there is nothing open: refetching while unlocked would replace the
    // revision this session is holding and silently disarm the conflict check.
    if (keyRef.current) return
    void refresh()
  }, [active, refresh])

  /** Stores the sealed vault and adopts the revision the server hands back. */
  const persist = useCallback(async (next: VaultData, ifMatch: string) => {
    const key = keyRef.current
    const kdf = kdfRef.current
    if (!key || !kdf) throw new Error('The vault is locked.')

    const envelope = await resealEnvelope(key, kdf, next)
    const result = await saveVault(envelope, ifMatch)

    revisionRef.current = result.revision
    setUpdatedAt(result.updatedAt)
    dataRef.current = next
    setData(next)
  }, [])

  const create = useCallback(
    async (masterPassword: string) => {
      setBusy(true)
      setSaveError(null)
      try {
        const fresh = emptyVault()
        const { key, kdf, envelope } = await createEnvelope(masterPassword, fresh)
        const result = await saveVault(envelope, VAULT_CREATE_ONLY)

        keyRef.current = key
        kdfRef.current = kdf
        revisionRef.current = result.revision
        dataRef.current = fresh
        setData(fresh)
        setUpdatedAt(result.updatedAt)
        setLockedReason(null)
        setError(null)
        setStatus('unlocked')
        lastActivityRef.current = Date.now()
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const unlock = useCallback(async (masterPassword: string) => {
    setBusy(true)
    try {
      // Read fresh rather than trusting the record from the last poll: another device
      // may have saved since, and unlocking a stale record then saving over it is the
      // exact overwrite the revision check exists to prevent.
      const { record } = await fetchVault()
      if (!record) {
        setStatus('absent')
        throw new VaultUnlockError('There is no vault on this workspace yet.')
      }

      const { key, data: opened } = await openRecord<unknown>(record, masterPassword)
      const vault = normalizeVaultData(opened)

      keyRef.current = key
      kdfRef.current = record.kdf
      revisionRef.current = record.revision
      dataRef.current = vault
      setData(vault)
      setUpdatedAt(record.updatedAt)
      setLockedReason(null)
      setError(null)
      setStatus('unlocked')
      lastActivityRef.current = Date.now()
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * Saves a change.
   *
   * On a revision conflict the local vault is **kept in memory and kept on screen**.
   * Discarding it would mean the user watches the credential they just typed vanish
   * because a different tab saved first, which is precisely the silent loss the
   * conflict check exists to make visible.
   */
  const commit = useCallback(
    async (next: VaultData) => {
      const revision = revisionRef.current
      if (!revision) throw new Error('The vault is locked.')

      setBusy(true)
      setSaveError(null)
      setConflict(null)

      // Shown immediately; `persist` confirms it or the catch below leaves it standing
      // beside an error the user has to act on.
      dataRef.current = next
      setData(next)

      try {
        await persist(next, revision)
      } catch (err) {
        if (err instanceof VaultApiError && err.code === 'VAULT_CONFLICT') {
          setConflict({ message: err.message, actualRevision: err.actualRevision ?? null })
        } else {
          setSaveError((err as Error).message)
        }
        throw err
      } finally {
        setBusy(false)
      }
    },
    [persist]
  )

  /**
   * Finishes a conflicted save.
   *
   * `merge` re-reads the stored vault, opens it with the key already in memory, and
   * unions the two by item id (see `mergeVaults`). `overwrite` keeps this device's
   * copy wholesale, which is the right answer when the other writer was a stale tab —
   * and is only ever reached by someone choosing it explicitly.
   */
  const resolveConflict = useCallback(
    async (strategy: 'merge' | 'overwrite') => {
      const local = dataRef.current
      const key = keyRef.current
      if (!local || !key) throw new Error('The vault is locked.')

      setBusy(true)
      setSaveError(null)
      try {
        const { record } = await fetchVault()
        if (!record) throw new Error('The vault no longer exists on the server.')

        let next = local
        if (strategy === 'merge') {
          // Opened with the key already in memory, not by re-deriving from a password
          // the user would have to type again. The salt is unchanged unless the master
          // password was changed elsewhere, in which case this throws and the message
          // tells them to unlock again — which is the truthful answer.
          const remote = normalizeVaultData(await unseal<unknown>(key, record.cipher))
          next = mergeVaults(local, remote)
        }

        kdfRef.current = record.kdf
        await persist(next, record.revision)
        setConflict(null)
      } catch (err) {
        setSaveError((err as Error).message)
        throw err
      } finally {
        setBusy(false)
      }
    },
    [persist]
  )

  // --- auto-lock ------------------------------------------------------------

  useEffect(() => {
    if (status !== 'unlocked') return

    // Stamped here as well as at unlock, so the countdown can never start from a
    // timestamp that was never set.
    lastActivityRef.current = Date.now()

    const noteActivity = () => {
      lastActivityRef.current = Date.now()
    }
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, noteActivity, { passive: true })
    }

    let hiddenSince: number | null = document.hidden ? Date.now() : null
    const onVisibility = () => {
      hiddenSince = document.hidden ? Date.now() : null
      if (!document.hidden) noteActivity()
    }
    document.addEventListener('visibilitychange', onVisibility)

    // Polled rather than a single long timeout: a laptop that sleeps for an hour fires
    // its timers late and unreliably, and the vault must be locked when the lid opens.
    const timer = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= AUTO_LOCK_MS) {
        lock('Locked after 15 minutes without activity.')
        return
      }
      if (hiddenSince !== null && Date.now() - hiddenSince >= HIDDEN_LOCK_MS) {
        lock('Locked because this tab was left in the background.')
      }
    }, 5_000)

    // Closing or reloading takes the key with it anyway; this also clears the
    // clipboard on the way out.
    const onUnload = () => forget()
    window.addEventListener('pagehide', onUnload)

    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, noteActivity)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onUnload)
      clearInterval(timer)
    }
  }, [status, lock, forget])

  useEffect(() => {
    return () => {
      // The dialog unmounting is not a lock — the vault stays open while the workspace
      // is in use — but the key must not outlive a full unmount of the hook.
      keyRef.current = null
      dataRef.current = null
    }
  }, [])

  return {
    status,
    data,
    error,
    busy,
    saveError,
    conflict,
    lockedReason,
    updatedAt,

    getKey: () => keyRef.current,
    getKdf: () => kdfRef.current,

    create,
    unlock,
    lock,
    commit,
    resolveConflict,
    refresh,
  }
}

export { UnsupportedVaultError, VaultUnlockError }
