'use client'

import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useVault } from '@/lib/vault/use-vault'

/**
 * The unlocked password-vault key, exposed for note body encryption.
 *
 * The key lives inside `useVault`; this provider mirrors that key into a
 * context that the note editor and the encrypted-fetch wrapper can read.
 *
 * When the vault is `absent` (no record yet) the key is null, and the
 * editor treats notes as plaintext. Creating a master password moves the
 * provider into `unlocked`; the next save encrypts.
 *
 * No React state holds the key. `useSyncExternalStore` re-renders consumers
 * when nullability flips; key material itself never sits in render state.
 */

const VaultKeyContext = createContext<CryptoKey | null>(null)

export function VaultKeyProvider({ vault, children }: { vault: ReturnType<typeof useVault>; children: ReactNode }) {
  // Snapshot of the current key. Updated by subscribe; read by getSnapshot.
  const snapshotRef = useRef<CryptoKey | null>(null)
  const listenersRef = useRef<Set<() => void>>(new Set())

  const getSnapshot = (): CryptoKey | null => snapshotRef.current
  const getServerSnapshot = (): CryptoKey | null => null

  const subscribe = (onChange: () => void) => {
    listenersRef.current.add(onChange)
    // Poll lightly. The vault hook does not expose subscription; for now
    // this catches unlock/lock transitions within ~250ms. Tighter
    // coupling is a follow-up if it ever shows up in testing.
    const id = setInterval(() => {
      const next = vault.getKey()
      if (next !== snapshotRef.current) {
        snapshotRef.current = next
        for (const l of listenersRef.current) l()
      }
    }, 250)
    return () => {
      clearInterval(id)
      listenersRef.current.delete(onChange)
    }
  }

  const key = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return <VaultKeyContext.Provider value={key}>{children}</VaultKeyContext.Provider>
}

/** The unlocked key, or null when the vault is locked or absent. */
export function useNoteKey(): CryptoKey | null {
  return useContext(VaultKeyContext)
}
