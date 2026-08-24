'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, type Dispatch } from 'react'
import {
  activeTab as readActiveTab,
  createTabsReducer,
  deserializeTabs,
  serializeTabs,
  tabPath,
  EMPTY_TABS,
  TABS_STORAGE_KEY,
  type Tab,
  type TabAction,
  type TabMode,
  type TabsState,
} from './tabs'

/**
 * Holds the navigation session for the workspace.
 *
 * Thin on purpose: the interesting behaviour is in the reducer and the serializer,
 * where both can be tested without a browser. This exists to own the id supply, to
 * write the session to storage, and to hand back the two things every caller actually
 * wants — the active path and its mode — so the rest of the app does not reach into
 * the tab array to find them.
 */

/**
 * Ids only have to be unique within a session, so a counter beats `crypto.randomUUID`
 * here: that needs a secure context, and a workspace served over plain HTTP on a LAN
 * would have no ids at all.
 *
 * A restored session is reissued ids from this same counter rather than carrying the
 * stored ones, which is why nothing restored can collide with anything opened later.
 */
let counter = 0
const nextTabId = () => `tab-${++counter}`

/**
 * Reads the stored session, keeping only documents that still exist.
 *
 * Called from the workspace's boot, because deciding what still exists needs the index
 * and the index is a fetch. Returns null when there is nothing usable to restore, and
 * the caller falls back to opening the first document.
 */
export function readStoredTabs(exists: (path: string) => boolean): TabsState | null {
  try {
    return deserializeTabs(window.localStorage.getItem(TABS_STORAGE_KEY), exists, nextTabId)
  } catch {
    // Storage can be unavailable outright — Safari private mode, a locked-down
    // profile. A session that cannot be restored is not a reason to fail to boot.
    return null
  }
}

export interface TabSession {
  state: TabsState
  dispatch: Dispatch<TabAction>
  /** The focused tab, or null when nothing is open. */
  tab: Tab | null
  /** The document on screen. */
  path: string | null
  /** The focused tab's mode. Reading, when there is no tab to have one. */
  mode: TabMode
}

export function useTabSession(): TabSession {
  const reducer = useMemo(() => createTabsReducer(nextTabId), [])
  const [state, rawDispatch] = useReducer(reducer, EMPTY_TABS)

  /**
   * Whether anything has happened yet.
   *
   * Without it, the write below fires once on mount with an empty session and erases
   * what is in storage before the boot has had a chance to read it — the index is a
   * fetch, so the restore is always a few hundred milliseconds behind the first render.
   * Set on the first dispatch, which includes the restore itself.
   */
  const touchedRef = useRef(false)

  const dispatch = useCallback((action: TabAction) => {
    touchedRef.current = true
    rawDispatch(action)
  }, [])

  useEffect(() => {
    if (!touchedRef.current) return
    try {
      window.localStorage.setItem(TABS_STORAGE_KEY, serializeTabs(state))
    } catch {
      // A full quota or a blocked store costs the next restore, nothing else. It must
      // not take the session down with it.
    }
  }, [state])

  const tab = readActiveTab(state)

  return {
    state,
    dispatch,
    tab,
    path: tab ? tabPath(tab) : null,
    mode: tab?.mode ?? 'read',
  }
}
