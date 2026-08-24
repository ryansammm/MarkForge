'use client'

import { useCallback, useSyncExternalStore } from 'react'

/**
 * Layout state remembered in localStorage — a boolean, or a pixel size.
 *
 * `useSyncExternalStore` rather than `useState` + an effect, because localStorage is
 * exactly what it is for: mutable state living outside React, which has to be read
 * without doing it during render (impure) or after mount (a cascading render, and a
 * visible flash of the wrong layout).
 *
 * The server snapshot is the fallback, so server and client markup agree and
 * hydration does not warn.
 */

const listeners = new Set<() => void>()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  // Other tabs, so a rail toggled in one window is not stale in the next.
  window.addEventListener('storage', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

export function usePersistedFlag(
  key: string,
  fallback: boolean
): [boolean, (value: boolean) => void] {
  const getSnapshot = useCallback(() => {
    const stored = window.localStorage.getItem(key)
    // Anything that is not exactly "true" or "false" falls back rather than being
    // read as false. A value left by an older build — or by anything else that ever
    // wrote to this key — should not silently turn a feature off.
    if (stored === 'true') return true
    if (stored === 'false') return false
    return fallback
  }, [key, fallback])

  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallback)

  const setValue = useCallback(
    (next: boolean) => {
      window.localStorage.setItem(key, String(next))
      // `storage` does not fire in the tab that wrote it.
      for (const listener of listeners) listener()
    },
    [key]
  )

  return [value, setValue]
}

/**
 * A pixel size remembered in localStorage, clamped to a range.
 *
 * The clamp is applied on read as well as on write, and not for tidiness: the range
 * is a property of the layout, and a width stored by an earlier build — or on a much
 * wider monitor — must not be able to leave a panel wider than the window it is
 * being restored into.
 */
export function usePersistedSize(
  key: string,
  fallback: number,
  { min, max }: { min: number; max: number }
): [number, (value: number) => void] {
  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, Math.round(value))),
    [min, max]
  )

  const getSnapshot = useCallback(() => {
    const stored = Number(window.localStorage.getItem(key))
    // `Number('')` is 0 and `Number(null)` is 0, so an unset key has to be caught by
    // the finite check rather than by the clamp, which would happily return `min`.
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : clamp(fallback)
  }, [key, fallback, clamp])

  const value = useSyncExternalStore(subscribe, getSnapshot, () => clamp(fallback))

  const setValue = useCallback(
    (next: number) => {
      window.localStorage.setItem(key, String(clamp(next)))
      for (const listener of listeners) listener()
    },
    [key, clamp]
  )

  return [value, setValue]
}

/**
 * A list of string ids remembered in localStorage - the pinned-documents rail.
 * Toggle semantics: id in the list is removed, otherwise appended at the end,
 * so pin order is the order you pinned things in.
 *
 * useSyncExternalStore requires a STABLE snapshot between renders - parsing
 * JSON into a fresh array on every call would loop forever. The cache returns
 * the same array reference until the stored string actually changes.
 */
const listCache = new Map<string, { raw: string | null; value: string[] }>()

function parseList(key: string): string[] {
  const raw = window.localStorage.getItem(key)
  const hit = listCache.get(key)
  if (hit && hit.raw === raw) return hit.value
  let value: string[] = []
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    if (Array.isArray(parsed)) value = parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    value = []
  }
  listCache.set(key, { raw, value })
  return value
}

export function usePersistedList(key: string): [string[], (id: string) => void] {
  const getSnapshot = useCallback(() => parseList(key), [key])

  const value = useSyncExternalStore(subscribe, getSnapshot, () => [])

  const toggle = useCallback(
    (id: string) => {
      const current = parseList(key)
      const next = current.includes(id)
        ? current.filter((v) => v !== id)
        : [...current.filter((v) => v !== id), id]
      window.localStorage.setItem(key, JSON.stringify(next))
      for (const listener of listeners) listener()
    },
    [key]
  )

  return [value, toggle]
}
