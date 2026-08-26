/**
 * Client-side grimoire state.
 *
 * Tracks the active grimoire ID so API calls can include it in headers.
 * Stored in localStorage so the last active grimoire survives page reloads.
 */

let currentGrimoireId: string | null = null
const listeners = new Set<() => void>()

const STORAGE_KEY = 'markforge-active-grimoire'

export function getActiveGrimoireId(): string | null {
  if (typeof window === 'undefined') return null
  if (currentGrimoireId === null) {
    currentGrimoireId = localStorage.getItem(STORAGE_KEY)
  }
  return currentGrimoireId
}

export function setActiveGrimoireId(id: string | null): void {
  currentGrimoireId = id
  if (typeof window !== 'undefined') {
    if (id) {
      localStorage.setItem(STORAGE_KEY, id)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  }
  for (const listener of listeners) listener()
}

export function onGrimoireChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Returns headers to include in API requests for grimoire scoping.
 */
export function grimoireHeaders(): Record<string, string> {
  const id = getActiveGrimoireId()
  return id ? { 'X-Grimoire-Id': id } : {}
}
