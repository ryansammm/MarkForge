/**
 * The navigation session: which documents are open, and where each has been.
 *
 * A pure reducer with no React in it, for the same reason the store and the rename
 * planner are pure — the parts that must not lose a document are the parts worth
 * testing without a browser (tests/tabs.test.ts).
 *
 * Phase 0 of docs/tabs-plan.md replaces `activePath` with this model while still
 * only ever opening one tab. Nothing here renders yet; the point is that every path
 * that mutates a document — rename, move, delete — goes through one place that knows
 * about every open tab, before there is more than one to get wrong.
 */

export type TabMode = 'read' | 'edit'

export interface Tab {
  id: string
  /**
   * Every path this tab has shown, oldest first. The one on screen is
   * `history[cursor]`.
   *
   * There is no separate `path` field on purpose: two fields holding the same answer
   * are two fields that can disagree, and a rename has to rewrite both.
   */
  history: string[]
  cursor: number
  mode: TabMode
}

export interface TabsState {
  tabs: Tab[]
  activeId: string | null
}

/**
 * How far back a single tab remembers. Old entries fall off the front.
 *
 * Bounded because a session left open for a week would otherwise grow a history
 * nobody will ever walk back through, and Phase 3 writes this to localStorage.
 */
export const MAX_HISTORY = 50

export const EMPTY_TABS: TabsState = { tabs: [], activeId: null }

/** How a click asked for a document to be opened. */
export interface OpenIntent {
  newTab: boolean
  background: boolean
}

/** Replacing what is on screen — the default, and what a plain click means. */
export const IN_PLACE: OpenIntent = { newTab: false, background: false }

/** Only the parts of a mouse event that matter, so this file stays free of the DOM. */
export interface ClickModifiers {
  button?: number
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
}

/**
 * Reads a click the way a browser reads one.
 *
 * Plain click replaces, modifier opens behind, modifier+shift opens in front, middle
 * click opens behind. Learned once, and already learned by anyone who uses a browser.
 *
 * Note that the editor does not use this: Mod-click there already means "follow this
 * wikilink" (live-preview.ts), so its new-tab gesture is Mod-Shift-click instead.
 */
export function openIntent(event: ClickModifiers): OpenIntent {
  if (event.button === 1) return { newTab: true, background: true }
  if (event.metaKey || event.ctrlKey) return { newTab: true, background: !event.shiftKey }
  return IN_PLACE
}

export type TabAction =
  /**
   * Shows a document. Without `newTab` this navigates the active tab, pushing onto
   * its history exactly as a browser does. With `newTab` it opens another tab beside
   * the active one, focused unless `background`.
   */
  | { type: 'open'; path: string; newTab?: boolean; background?: boolean }
  | { type: 'close'; id: string }
  /** Everything except this tab. */
  | { type: 'closeOthers'; id: string }
  /** Everything after this tab in the strip. */
  | { type: 'closeToRight'; id: string }
  | { type: 'activate'; id: string }
  /** Drag-to-reorder. Indices are positions in the strip. */
  | { type: 'reorder'; from: number; to: number }
  | { type: 'setMode'; mode: TabMode }
  | { type: 'toggleMode' }
  | { type: 'back' }
  | { type: 'forward' }
  // Reconciliation against what happened to the files themselves. Every one of these
  // must leave the session pointing only at paths that still exist.
  | { type: 'pathRenamed'; from: string; to: string }
  | { type: 'prefixMoved'; from: string; to: string }
  | { type: 'pathRemoved'; path: string }
  | { type: 'prefixRemoved'; prefix: string }
  /** Replaces the whole session, for a restore from storage. */
  | { type: 'restore'; state: TabsState }

// --- reading the session ------------------------------------------------------

/** The path a tab is currently showing. */
export function tabPath(tab: Tab): string {
  return tab.history[tab.cursor]
}

export function activeTab(state: TabsState): Tab | null {
  if (!state.activeId) return null
  return state.tabs.find((tab) => tab.id === state.activeId) ?? null
}

/** The path on screen, or null when nothing is open. */
export function activePath(state: TabsState): string | null {
  const tab = activeTab(state)
  return tab ? tabPath(tab) : null
}

export function canGoBack(tab: Tab | null): boolean {
  return tab !== null && tab.cursor > 0
}

export function canGoForward(tab: Tab | null): boolean {
  return tab !== null && tab.cursor < tab.history.length - 1
}

/** The tab currently showing `path`, if one is. */
export function findTabByPath(state: TabsState, path: string): Tab | null {
  return state.tabs.find((tab) => tabPath(tab) === path) ?? null
}

// --- helpers ------------------------------------------------------------------

/** Whether `path` is `prefix` itself or something inside it. */
function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * Drops matching entries from a history and moves the cursor to keep pointing at the
 * same document. Returns null when nothing is left to show.
 */
function scrub(
  history: string[],
  at: number,
  drop: (path: string) => boolean
): { history: string[]; cursor: number } | null {
  const kept: string[] = []
  let cursor = 0

  history.forEach((path, i) => {
    if (drop(path)) return
    // The last surviving entry at or before the old cursor. When the current entry
    // itself survives — the only case the callers below allow — this lands on it.
    if (i <= at) cursor = kept.length
    kept.push(path)
  })

  if (kept.length === 0) return null
  return { history: kept, cursor: Math.min(cursor, kept.length - 1) }
}

function scrubHistory(tab: Tab, drop: (path: string) => boolean): Tab | null {
  const next = scrub(tab.history, tab.cursor, drop)
  return next ? { ...tab, ...next } : null
}

/** Rewrites every history entry through `map`, collapsing runs it makes identical. */
function mapHistory(tab: Tab, map: (path: string) => string): Tab {
  const next = tab.history.map(map)
  if (next.every((path, i) => path === tab.history[i])) return tab
  return { ...tab, history: next }
}

/**
 * Removes tabs and picks what to look at next.
 *
 * Focus moves to the right, falling back to the left when the closed tab was last —
 * the rule every browser uses, and the only one that does not feel like the session
 * jumped somewhere random.
 */
function closeIds(state: TabsState, doomed: Set<string>): TabsState {
  if (doomed.size === 0) return state

  const tabs = state.tabs.filter((tab) => !doomed.has(tab.id))
  if (tabs.length === 0) return EMPTY_TABS

  let activeId = state.activeId
  if (activeId && doomed.has(activeId)) {
    const from = state.tabs.findIndex((tab) => tab.id === activeId)
    const right = state.tabs.slice(from + 1).find((tab) => !doomed.has(tab.id))
    const left = state.tabs.slice(0, from).reverse().find((tab) => !doomed.has(tab.id))
    activeId = (right ?? left)?.id ?? null
  }

  return { tabs, activeId }
}

/** Closes every tab whose current path matches, then scrubs the rest's history. */
function forgetPaths(state: TabsState, drop: (path: string) => boolean): TabsState {
  const doomed = new Set(
    state.tabs.filter((tab) => drop(tabPath(tab))).map((tab) => tab.id)
  )

  const closed = closeIds(state, doomed)
  return {
    ...closed,
    tabs: closed.tabs.map((tab) => scrubHistory(tab, drop) ?? tab),
  }
}

/** Applies `change` to the active tab, if there is one. */
function updateActive(state: TabsState, change: (tab: Tab) => Tab): TabsState {
  if (!state.activeId) return state
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === state.activeId ? change(tab) : tab)),
  }
}

/** Pushes a path onto a tab's history, discarding anything ahead of the cursor. */
function pushHistory(tab: Tab, path: string): Tab {
  if (tabPath(tab) === path) return tab

  const history = [...tab.history.slice(0, tab.cursor + 1), path]
  // Trimming from the front keeps the newest entries, which are the ones anyone
  // walks back through.
  const overflow = Math.max(0, history.length - MAX_HISTORY)
  return { ...tab, history: history.slice(overflow), cursor: history.length - overflow - 1 }
}

// --- storage ------------------------------------------------------------------

export const TABS_STORAGE_KEY = 'markforge:tabs'

/** Bumped when the shape below changes. An older payload is dropped, not guessed at. */
const STORAGE_VERSION = 1

/**
 * What gets written.
 *
 * Ids are not stored. They mean nothing outside the session that made them, and
 * reissuing them on restore is what makes it impossible for a restored tab to collide
 * with one opened afterwards. The active tab is therefore stored as an index.
 */
interface StoredTab {
  history: string[]
  cursor: number
  mode: TabMode
}

export function serializeTabs(state: TabsState): string {
  const stored: { v: number; active: number; tabs: StoredTab[] } = {
    v: STORAGE_VERSION,
    active: state.tabs.findIndex((tab) => tab.id === state.activeId),
    tabs: state.tabs.map((tab) => ({ history: tab.history, cursor: tab.cursor, mode: tab.mode })),
  }
  return JSON.stringify(stored)
}

function isStoredTab(value: unknown): value is StoredTab {
  if (typeof value !== 'object' || value === null) return false
  const tab = value as Record<string, unknown>
  return (
    Array.isArray(tab.history) &&
    tab.history.every((entry) => typeof entry === 'string') &&
    typeof tab.cursor === 'number' &&
    Number.isInteger(tab.cursor)
  )
}

/**
 * Rebuilds a session from storage, keeping only documents that still exist.
 *
 * Every failure returns null rather than a partial session, and the caller falls back
 * to opening the first document as it always did. This runs on a value the user can
 * edit by hand and that an older build may have written, so nothing in it is trusted:
 * a stored path that has since been deleted is a tab that would open on a 404, and a
 * cursor out of range is a Back button pointing at nothing.
 */
export function deserializeTabs(
  raw: string | null,
  exists: (path: string) => boolean,
  newId: () => string
): TabsState | null {
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const payload = parsed as Record<string, unknown>
  if (payload.v !== STORAGE_VERSION) return null
  if (!Array.isArray(payload.tabs)) return null

  const tabs: Tab[] = []
  let activeIndex = -1

  payload.tabs.forEach((stored, i) => {
    if (!isStoredTab(stored)) return

    // Trimmed before scrubbing: a hand-written payload could carry any number of
    // entries, and the cap is what the running session is allowed to hold.
    const capped = stored.history.slice(-MAX_HISTORY)
    const at = Math.min(Math.max(stored.cursor - (stored.history.length - capped.length), 0), capped.length - 1)

    const next = scrub(capped, at, (path) => !exists(path))
    if (!next) return

    if (i === payload.active) activeIndex = tabs.length
    tabs.push({
      id: newId(),
      history: next.history,
      cursor: next.cursor,
      mode: stored.mode === 'edit' ? 'edit' : 'read',
    })
  })

  if (tabs.length === 0) return null
  // The tab that was focused may be one of the ones that did not survive.
  return { tabs, activeId: tabs[activeIndex === -1 ? 0 : activeIndex].id }
}

// --- the reducer --------------------------------------------------------------

/**
 * Builds the reducer.
 *
 * `newId` is injected rather than called inside, so the reducer stays a pure
 * function of its arguments and the tests can assert on the ids they expect.
 */
export function createTabsReducer(newId: () => string) {
  return function tabsReducer(state: TabsState, action: TabAction): TabsState {
    switch (action.type) {
      case 'open': {
        const existing = findTabByPath(state, action.path)
        if (action.newTab && existing) {
          // Already open. Opening it again should show it, not clone it — but a
          // background open is a request not to be moved, so it is honoured.
          return action.background ? state : { ...state, activeId: existing.id }
        }

        if (action.newTab || !state.activeId) {
          const tab: Tab = { id: newId(), history: [action.path], cursor: 0, mode: 'read' }
          // Beside its opener rather than at the end, so a tab opened from a link
          // appears next to the document that linked to it.
          const from = state.tabs.findIndex((t) => t.id === state.activeId)
          const at = from === -1 ? state.tabs.length : from + 1
          return {
            tabs: [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)],
            activeId: action.background && state.activeId ? state.activeId : tab.id,
          }
        }

        return updateActive(state, (tab) => pushHistory(tab, action.path))
      }

      case 'close':
        return closeIds(state, new Set([action.id]))

      case 'closeOthers':
        return state.tabs.some((tab) => tab.id === action.id)
          ? closeIds(state, new Set(state.tabs.filter((tab) => tab.id !== action.id).map((t) => t.id)))
          : state

      case 'closeToRight': {
        const from = state.tabs.findIndex((tab) => tab.id === action.id)
        if (from === -1) return state
        return closeIds(state, new Set(state.tabs.slice(from + 1).map((tab) => tab.id)))
      }

      case 'reorder': {
        const { from, to } = action
        if (from === to) return state
        if (from < 0 || from >= state.tabs.length) return state
        if (to < 0 || to >= state.tabs.length) return state
        const tabs = [...state.tabs]
        const [moved] = tabs.splice(from, 1)
        tabs.splice(to, 0, moved)
        // Focus follows the tab, not the position: dragging a tab you are reading
        // must not land you on a different document.
        return { ...state, tabs }
      }

      case 'activate':
        return state.tabs.some((tab) => tab.id === action.id)
          ? { ...state, activeId: action.id }
          : state

      case 'setMode':
        return updateActive(state, (tab) =>
          tab.mode === action.mode ? tab : { ...tab, mode: action.mode }
        )

      case 'toggleMode':
        return updateActive(state, (tab) => ({
          ...tab,
          mode: tab.mode === 'read' ? 'edit' : 'read',
        }))

      case 'back':
        return updateActive(state, (tab) =>
          canGoBack(tab) ? { ...tab, cursor: tab.cursor - 1 } : tab
        )

      case 'forward':
        return updateActive(state, (tab) =>
          canGoForward(tab) ? { ...tab, cursor: tab.cursor + 1 } : tab
        )

      case 'pathRenamed': {
        const { from, to } = action
        return {
          ...state,
          tabs: state.tabs.map((tab) => mapHistory(tab, (path) => (path === from ? to : path))),
        }
      }

      case 'prefixMoved': {
        const { from, to } = action
        return {
          ...state,
          tabs: state.tabs.map((tab) =>
            mapHistory(tab, (path) => (isUnder(path, from) ? to + path.slice(from.length) : path))
          ),
        }
      }

      case 'restore':
        return action.state

      case 'pathRemoved':
        return forgetPaths(state, (path) => path === action.path)

      case 'prefixRemoved':
        return forgetPaths(state, (path) => isUnder(path, action.prefix))
    }
  }
}
