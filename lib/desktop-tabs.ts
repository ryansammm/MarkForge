/**
 * The desktop tab bar at the top of an Electron window.
 *
 * A second tab system, deliberately separate from `lib/tabs.ts`. The in-app
 * tabs handle navigation inside one workspace (with history and modes);
 * these tabs are the OS-window-strip on top: flat `{ id, path }`, no
 * history, no mode. The two coordinate through the workspace app — the
 * sidebar opens an in-app tab and mirrors it here so the strip shows what
 * is on screen.
 *
 * In-memory only: the spec says closing the app loses the list. Re-opening
 * starts with the previously-active document as the single tab (the
 * workspace app seeds it from the URL/path).
 *
 * Pure reducer, no React, no DOM. Same testing story as `lib/tabs.ts` —
 * see `tests/tabs.test.ts` for the pattern this mirrors.
 */

export const MAX_DESKTOP_TABS = 6

export interface DesktopTab {
  id: string
  path: string
}

export interface DesktopTabsState {
  tabs: DesktopTab[]
  activeId: string | null
}

export const EMPTY_DESKTOP_TABS: DesktopTabsState = { tabs: [], activeId: null }

export type DesktopTabAction =
  | { type: 'open'; path: string }
  | { type: 'close'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'reorder'; from: number; to: number }

/**
 * Opens a path, activating it if the path is already open.
 *
 * Returns `null` when the limit is reached and the open is refused — the
 * caller toasts. Returning a new state shape is the "ok" path, returning
 * null is the "rejected" path. The reducer never partially opens.
 */
export function applyDesktopTabAction(
  state: DesktopTabsState,
  action: DesktopTabAction,
  newId: () => string
): DesktopTabsState | null {
  switch (action.type) {
    case 'open': {
      const existing = state.tabs.find((tab) => tab.path === action.path)
      if (existing) {
        return existing.id === state.activeId
          ? state
          : { tabs: state.tabs, activeId: existing.id }
      }
      if (state.tabs.length >= MAX_DESKTOP_TABS) return null
      const tab: DesktopTab = { id: newId(), path: action.path }
      return { tabs: [...state.tabs, tab], activeId: tab.id }
    }
    case 'close': {
      const from = state.tabs.findIndex((tab) => tab.id === action.id)
      if (from === -1) return state
      const tabs = state.tabs.filter((tab) => tab.id !== action.id)
      if (tabs.length === 0) return EMPTY_DESKTOP_TABS
      let activeId = state.activeId
      if (activeId === action.id) {
        // Focus moves right, falling back to left — the same rule the in-app
        // tab reducer uses.
        const right = state.tabs.slice(from + 1).find((tab) => tab.id !== action.id)
        const left = state.tabs.slice(0, from).reverse().find((tab) => tab.id !== action.id)
        activeId = (right ?? left)?.id ?? null
      }
      return { tabs, activeId }
    }
    case 'activate':
      return state.tabs.some((tab) => tab.id === action.id)
        ? { tabs: state.tabs, activeId: action.id }
        : state
    case 'reorder': {
      const { from, to } = action
      if (from === to) return state
      if (from < 0 || from >= state.tabs.length) return state
      if (to < 0 || to >= state.tabs.length) return state
      const tabs = [...state.tabs]
      const [moved] = tabs.splice(from, 1)
      tabs.splice(to, 0, moved)
      return { tabs, activeId: state.activeId }
    }
  }
}

/** The path on the active tab, or null when nothing is open. */
export function activeDesktopPath(state: DesktopTabsState): string | null {
  if (!state.activeId) return null
  return state.tabs.find((tab) => tab.id === state.activeId)?.path ?? null
}
