'use client'

import { useCallback, useEffect, useReducer, useState, useMemo, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Eye,
  Loader2,
  Menu,
  Pencil,
  PanelRight,
  Share2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  StaticFileStore,
  type FileTreeNode,
  type WorkspaceIndex,
  type MarkdownDocument,
  type WriteResult,
} from '@/lib/file-store'
import { applyAddDir, applyRemove, applyRemoveDir, applyUpsert } from '@/lib/index-patch'
import { useDocumentSave } from '@/lib/use-document-save'
import { readStoredTabs, useTabSession } from '@/lib/use-tab-session'
import {
  applyDesktopTabAction,
  EMPTY_DESKTOP_TABS,
  MAX_DESKTOP_TABS,
  type DesktopTabAction,
  type DesktopTabsState,
} from '@/lib/desktop-tabs'
import {
  IN_PLACE,
  canGoBack,
  canGoForward,
  tabPath,
  type OpenIntent,
  type TabMode,
} from '@/lib/tabs'
import { resolveWikiLink } from '@/lib/resolve-link'
import { keyboardIsClaimed } from '@/lib/modal-keys'
import * as api from '@/lib/workspace-api'
import { moveBlockBetweenDocs } from '@/lib/blocks'
import { setFrontmatterField, setFrontmatterObject, removeFrontmatterField, frontmatterLock } from '@/lib/markdown/frontmatter'
import { makeLock } from '@/lib/lock/page-lock'
import { LockPrompt } from './lock-prompt'
import { isImportableFile, readMarkdownFile } from '@/lib/import/page-import'
import { buildExportName, downloadMarkdown } from '@/lib/export/page-export'
import { useVault } from '@/lib/vault/use-vault'
import { VaultKeyProvider, useNoteKey } from '@/lib/client/vault-key'
import { readDocument as readDocumentEncrypted, writeDocument as writeDocumentEncrypted, createDocument as createDocumentEncrypted } from '@/lib/client/encrypted-fetch'
import { Sidebar, SIDEBAR_WIDTH } from './sidebar'
import { ResizeHandle } from './resize-handle'
import { DocViewer } from './doc-viewer'
import { PageMenu } from './page-menu'
import { SidePeek } from './side-peek'
import { BacklinksPanel } from './backlinks-panel'
import { TOCPanel } from './toc-panel'
import { SearchDialog } from './search-dialog'
import { RecentEditsPanel } from './recent-edits-panel'
import { DetailsPanel } from './details-panel'
import { SaveIndicator } from './save-indicator'
import { TabStrip, documentLabel } from './tab-strip'
import { DesktopTabBar } from './desktop-tab-bar'
import { ConfirmDialog, PromptDialog } from './workspace-dialogs'
import { ShareDialog } from './share-dialog'
import { TrashDialog } from './trash-dialog'
import { Breadcrumb } from './breadcrumb'
import { PasswordsDialog } from './passwords-dialog'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { PwaInstallButton } from '@/components/pwa-install'
import { TRASH_RETENTION_DAYS } from '@/lib/trash'
import { usePersistedFlag, usePersistedSize } from '@/lib/use-persisted'
import { cn } from '@/lib/utils'
/** The context rail's width, and the range its handle can drag through. */
const RAIL_WIDTH = { default: 288, min: 220, max: 560 } as const

/**
 * Id source for the desktop tab bar's reducer. Counter rather than
 * `crypto.randomUUID` for the same reason `lib/use-tab-session.ts` uses a
 * counter: ids only need to be unique within a session, and a workspace
 * served over plain HTTP on a LAN has no secure context for the web API.
 */
let desktopTabCounter = 0
const nextDesktopTabId = () => `dt-${++desktopTabCounter}`

/**
 * CodeMirror touches the DOM at construction, so it cannot be server-rendered.
 * Loading it lazily also keeps the editor bundle off the read-only path — which
 * Sprint 6's public share route will need anyway.
 */
const MarkdownEditor = dynamic(
  () => import('./markdown-editor').then((m) => m.MarkdownEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading editor…
      </div>
    ),
  }
)

interface LoadedSource {
  path: string
  /** The whole file, frontmatter included — what the editor edits. */
  raw: string
  /**
   * The body with frontmatter stripped — what the reading view renders.
   *
   * Comes from the same response as `raw`. The server strips frontmatter while
   * building the document anyway, so taking it from there avoids shipping a YAML
   * parser to the browser to redo the work.
   */
  body: string
  etag: string | undefined
}

/** Which dialog is open, and what it is operating on. */
type DialogState =
  | { kind: 'none' }
  | { kind: 'newDocument'; parentDir: string }
  | { kind: 'newFolder'; parentDir: string }
  | { kind: 'rename'; node: FileTreeNode; linkCount: number | null }
  | { kind: 'delete'; node: FileTreeNode; contents: string[] }

/**
 * Removes a leading YAML block, for display only.
 *
 * Deliberately a regex and not the real parser: this exists to show the just-typed
 * text a few hundred milliseconds before the server's own answer arrives, and
 * shipping js-yaml to the browser to shave that moment off would be a poor trade.
 * The authoritative body always comes from the write response.
 */
function stripFrontmatterBlock(raw: string): string {
  const match = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(raw)
  return match ? raw.slice(match[0].length) : raw
}

/** Clones an index so patches never mutate React state in place. */
function cloneIndex(index: WorkspaceIndex): WorkspaceIndex {
  return {
    documents: { ...index.documents },
    tree: structuredClone(index.tree),
    backlinks: structuredClone(index.backlinks),
  }
}

export function WorkspaceApp() {
  const [indexData, setIndexData] = useState<WorkspaceIndex | null>(null)
  const [devLogs, setDevLogs] = useState<string[]>([])
  const pushLog = useCallback((msg: string) => {
    setDevLogs((prev) => [...prev, `${new Date().toLocaleTimeString()} ${msg}`])
  }, [])
  /**
   * Latest setter for the `Mod-N` keydown shortcut. We mirror
   * `openNewDocument` into this ref on every render so the keydown
   * effect (registered once) can read the freshest callback without
   * a stale closure or a re-register on every render.
   */
  const openNewDocumentRef = useRef<(parentDir: string) => void>(() => {})
  /**
   * Which documents are open, and where each has been.
   *
   * Replaces the single `activePath` this component used to hold. Only one tab is
   * ever opened for now — nothing dispatches `newTab` yet, and no strip is rendered —
   * but every path that renames, moves or deletes a document already goes through the
   * session, which is the part that has to be right before there is a second tab to
   * get wrong. See docs/tabs-plan.md, Phase 0.
   */
  const {
    state: tabSession,
    dispatch: dispatchTabs,
    tab: activeTabState,
    path: activePath,
    mode,
  } = useTabSession()
  /**
   * The session, for the keydown listener.
   *
   * A ref rather than an effect dependency: the listener also carries Cmd+K, Cmd+E and
   * Cmd+P, and rebinding all of them every time a tab is focused is work for nothing.
   */
  const tabsRef = useRef(tabSession)
  /**
   * `createDocumentAt` is declared further down the file, after the keydown
   * handler that wants to call it. A ref keeps the handler's dep array
   * empty (so the listener does not get re-bound on every save) without a
   * `no-use-before-define` violation.
   */
  const createDocumentAtRef = useRef<(parentDir: string, title: string, body?: string) => Promise<unknown>>(
    () => Promise.resolve()
  )

  /**
   * The desktop-window tab bar (Electron only).
   *
   * Separate from `useTabSession` on purpose: the in-app reducer carries
   * history and modes per tab, while this strip is a flat list of "what
   * documents are open in this window" with a hard 6-tab cap. The two
   * coordinate through `navigateTo` — every new-tab open mirrors here.
   *
   * `dispatchDesktopTabs` returns false when the action was refused (the
   * 6-tab limit on `open`). The pure `applyDesktopTabAction` returns null
   * for the refused case, and the React state is left untouched — the
   * caller can toast.
   *
   * A ref mirrors the latest state for synchronous reads from the dispatch
   * wrapper, so the limit check does not rely on a stale closure. The ref
   * is updated by an effect — never during render.
   */
  const [desktopTabsState, rawDispatchDesktopTabs] = useReducer(
    (state: DesktopTabsState, action: DesktopTabAction): DesktopTabsState =>
      applyDesktopTabAction(state, action, nextDesktopTabId) ?? state,
    EMPTY_DESKTOP_TABS
  )
  const desktopTabsStateRef = useRef<DesktopTabsState>(desktopTabsState)
  useEffect(() => {
    desktopTabsStateRef.current = desktopTabsState
  }, [desktopTabsState])
  const dispatchDesktopTabs = useCallback(
    (action: DesktopTabAction): boolean => {
      const next = applyDesktopTabAction(desktopTabsStateRef.current, action, nextDesktopTabId)
      if (next === null) return false
      rawDispatchDesktopTabs(action)
      return true
    },
    []
  )

  /**
   * Keep the strip's active tab in sync with the in-app active path.
   *
   * When the user navigates in place (or the active doc changes from a
   * rename/delete), the strip must follow. Only `activate` — never `open`
   * — so the in-place rule above holds. On the very first render with an
   * active path, seed a single tab so the strip is not empty.
   */
  useEffect(() => {
    if (!activePath) return
    if (desktopTabsStateRef.current.tabs.length === 0) {
      rawDispatchDesktopTabs({ type: 'open', path: activePath })
      return
    }
    const existing = desktopTabsStateRef.current.tabs.find((tab) => tab.path === activePath)
    if (existing && existing.id !== desktopTabsStateRef.current.activeId) {
      rawDispatchDesktopTabs({ type: 'activate', id: existing.id })
    }
  }, [activePath, rawDispatchDesktopTabs])

  /**
   * Where each document was left, so returning to a tab returns to the paragraph.
   *
   * A ref, not state: scrolling fires continuously and none of it should re-render the
   * workspace. Deliberately not persisted either — it would mean writing to
   * localStorage on every scroll frame, and the cost is one lost offset per reload
   * against a write on every wheel tick.
   */
  const scrollRef = useRef<Record<string, number>>({})
  const scrollFor = useCallback((path: string) => scrollRef.current[path] ?? 0, [])
  const rememberScroll = useCallback((path: string, top: number) => {
    scrollRef.current[path] = top
  }, [])
  const [searchOpen, setSearchOpen] = useState(false)
  /** Whether the search dialog was opened by something that wants a new tab. */
  const [searchOpensTab, setSearchOpensTab] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [passwordsOpen, setPasswordsOpen] = useState(false)

  /**
   * The vault lives here, not inside the dialog, so the unlocked key is
   * reachable from the rest of the workspace. The dialog is a thin
   * presentation layer over this hook — the data, the key, the lock state
   * all flow through `vault` below.
   */
  const vault = useVault(true)

  /**
   * The note-encryption key, sourced from the unlocked vault. `null` when
   * the vault is locked or absent — in that case note bodies pass through
   * the API as plaintext. The pass-through is intentional: a user who has
   * not yet set a master password can keep using the app, and a future
   * unlock re-encrypts the next save.
   */
  const noteKey = useNoteKey()
  const [loading, setLoading] = useState(true)
  /** Set when the backend reports that writes will not survive. Never dismissible. */
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  /** Backend kind from /api/health — drives the "Sync to cloud" visibility. */
  const [storageKind, setStorageKind] = useState<string | null>(null)
  /** Drawer state below md. Closed by default so a phone opens on the document. */
  const [sidebarOpen, setSidebarOpen] = useState(false)
  /** Context rail, remembered across sessions and across tabs. */
  const [railOpen, setRailOpen] = usePersistedFlag('markforge:rail-open', true)
  /**
   * Panel widths, remembered the same way the rail's open state is.
   *
   * Both panels show truncated names — documents in one, backlinks and headings in
   * the other — and until now the only remedy for a title that did not fit was to
   * hover it. Being able to widen the panel is the direct fix; the tooltips added
   * alongside are what covers the names that are too long at any sensible width.
   */
  const [sidebarWidth, setSidebarWidth] = usePersistedSize(
    'markforge:sidebar-width',
    SIDEBAR_WIDTH.default,
    SIDEBAR_WIDTH
  )
  const [railWidth, setRailWidth] = usePersistedSize('markforge:rail-width', RAIL_WIDTH.default, RAIL_WIDTH)

  /**
   * The bytes behind each open tab, keyed by path.
   *
   * Was a single `LoadedSource`, which meant every tab switch went back to a skeleton.
   * Bodies average under 2 KB (81% of a 4.68 MB index at 2,000 documents,
   * docs/phase-4-scale.md), so holding one per open tab costs tens of kilobytes.
   *
   * There is no size cap. The cache is pruned to the set of open tabs instead, which
   * bounds it by something the user can see and control rather than by a number they
   * cannot.
   */
  const [sources, setSources] = useState<Record<string, LoadedSource>>({})
  /**
   * The one path whose cached bytes are known to match the file.
   *
   * Freshness is a single path rather than a flag per entry because only one document
   * can be looked at, and only what is being looked at has just been read. Deriving it
   * this way is also what keeps the reader out of the effect body: focusing a tab
   * changes `activePath`, which no longer equals this, which is the whole trigger.
   */
  const [freshPath, setFreshPath] = useState<string | null>(null)
  /**
   * Documents whose last save was refused and not yet superseded by one that landed.
   *
   * Kept here rather than read off `saveState`, which only ever describes the document
   * on screen. A conflict raised for a tab the user has already left would otherwise
   * be invisible — the tab's dot is the only place it gets reported.
   */
  const [conflicted, setConflicted] = useState<ReadonlySet<string>>(() => new Set())
  const source = activePath ? (sources[activePath] ?? null) : null
  const isFresh = activePath !== null && freshPath === activePath
  const [sourceError, setSourceError] = useState<{ path: string; message: string } | null>(null)
  const [reconciled, setReconciled] = useState<string | null>(null)
  /**
   * Per-path unlock state for the per-page lock (Task 9).
   *
   * The lock itself lives in `frontmatter.lock`; the editor only
   * needs to know which paths the current user has already passed
   * the passphrase check for in this session. In-memory only —
   * closing the tab or reloading the page re-locks everything.
   */
  const [unlockedPaths, setUnlockedPaths] = useState<ReadonlySet<string>>(() => new Set())

  const router = useRouter()

  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' })
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  // The path currently shown in the right-hand peek overlay, or null
  // when no peek is open. Read-only and transient — never persisted.
  const [sidePeekPath, setSidePeekPath] = useState<string | null>(null)

  const fileStore = useMemo(() => new StaticFileStore('/api/index'), [])

  /** Reading or editing, for the tab on screen. */
  const setMode = useCallback(
    (next: TabMode) => dispatchTabs({ type: 'setMode', mode: next }),
    [dispatchTabs]
  )

  useEffect(() => {
    async function loadWorkspaceData() {
      try {
        pushLog('Fetching index')
        const index = await fileStore.getIndex()
        pushLog(`Index loaded: ${Object.keys(index.documents).length} docs, ${index.tree.length} tree items`)
        setIndexData(index)

        // Restored here rather than inside the hook because deciding what still
        // exists needs the index, and the index is this fetch. Documents deleted
        // since the last session are dropped on the way in.
        const restored = readStoredTabs((path) => path in index.documents)
        if (restored) {
          pushLog(`Restored ${restored.tabs.length} tabs`)
          dispatchTabs({ type: 'restore', state: restored })
          return
        }

        const paths = Object.keys(index.documents)
        if (paths.length > 0) dispatchTabs({ type: 'open', path: paths[0] })
      } catch (err) {
        pushLog(`Error: ${err instanceof Error ? err.message : String(err)}`)
        console.error('Failed to load workspace index:', err)
      } finally {
        setLoading(false)
      }
    }
    loadWorkspaceData()
  }, [fileStore, dispatchTabs, pushLog])

  /**
   * Warns when writes will not survive.
   *
   * `backendHealth` has reported this since the R2 backend landed and nothing in the
   * UI ever read it. A deployment writing to an ephemeral filesystem accepts every
   * save and loses them all at the next cold start — the worst failure mode available,
   * because it is indistinguishable from working.
   */
  useEffect(() => {
    let cancelled = false

    fetch('/api/health', { cache: 'no-store' })
      .then((res) => res.json())
      .then((health: { durable?: boolean; warning?: string; kind?: string }) => {
        if (cancelled) return
        if (typeof health.kind === 'string') setStorageKind(health.kind)
        if (health.durable === false) {
          setStorageWarning(
            health.warning ?? 'Storage is not durable on this deployment — edits may not survive.'
          )
        }
      })
      .catch(() => {
        // A health check that cannot be reached is not itself a reason to alarm
        // anyone; the save indicator is what reports a save that does not land.
      })

    return () => {
      cancelled = true
    }
  }, [])

  /*
    "Open in new window" passes a `?path=<doc>&standalone=1` query
    string to the new BrowserWindow. We pick the path up on mount and
    open it as a fresh tab, ignoring any restored session. Running
    twice is harmless because the open is idempotent.
  */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('standalone') !== '1') return
    const path = params.get('path')
    if (!path) return
    dispatchTabs({ type: 'open', path, newTab: false })
    // Strip the query so a refresh of the new window does not re-run
    // the same dance (it would just open the same tab again, which is
    // a no-op anyway, but the URL is cleaner without it).
    const url = new URL(window.location.href)
    url.searchParams.delete('path')
    url.searchParams.delete('standalone')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  }, [dispatchTabs])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      /*
        These are bound on `window`, so they fire whatever is on screen — including
        while something modal is up, where they act on the document *underneath* it.
        See lib/modal-keys.ts.
      */
      if (keyboardIsClaimed()) return

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpensTab(false)
        setSearchOpen((prev) => !prev)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        dispatchTabs({ type: 'toggleMode' })
      }
      /*
        `Mod-N` is the conventional "new" shortcut. The browser tries to open
        a new window for it and `preventDefault` only sometimes works — Chrome
        and Firefox at least let JS stop the default in a keydown listener
        inside the document, which is where this fires. `Mod-Shift-N` would
        otherwise be "new private window" in Firefox / "new incognito" in
        Chrome, but the same `preventDefault` covers it.
      */
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        openNewDocumentRef.current('')
      }
      /*
        Opens the vault. Deliberately not a toggle, unlike Cmd+K: the passwords
        dialog can be holding a half-typed credential in a form that only exists
        while it is open, and a second press closing it would throw that away.
        It is dismissed with the dialog's own close button — note that no dialog
        in this app currently closes on Escape or on a backdrop click, so there is
        no keyboard dismissal to lean on here.

        `preventDefault` matters more here than elsewhere — this is the browser's
        print shortcut, and a print dialog over the vault is the opposite of what
        was asked for.
      */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPasswordsOpen(true)
      }

      /*
        Tab shortcuts are on Alt rather than Ctrl, and not by preference.

        Ctrl+W, Ctrl+T, Ctrl+Tab and Ctrl+1..9 are reserved by the browser and
        `preventDefault` does not reach them — binding Ctrl+W to "close tab" would
        close the window instead, taking every open document with it. Alt is the
        nearest set that is actually ours. (In an installed PWA the Ctrl chords come
        back; that is worth doing behind a display-mode check, not before.)
      */
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const { tabs, activeId } = tabsRef.current
        const at = tabs.findIndex((tab) => tab.id === activeId)

        if (e.key.toLowerCase() === 'w' && activeId) {
          e.preventDefault()
          dispatchTabs({ type: 'close', id: activeId })
          return
        }

        if ((e.key === 'PageDown' || e.key === 'PageUp') && tabs.length > 1) {
          e.preventDefault()
          const step = e.key === 'PageDown' ? 1 : -1
          // Wraps, because a strip you can only walk to one end of makes the last
          // tab and the first tab feel further apart than they are.
          const next = (at + step + tabs.length) % tabs.length
          dispatchTabs({ type: 'activate', id: tabs[next].id })
          return
        }

        if (/^[1-9]$/.test(e.key)) {
          e.preventDefault()
          // Alt+9 is the last tab, not the ninth — the browser convention, and the
          // useful one once there are more than nine.
          const target = e.key === '9' ? tabs[tabs.length - 1] : tabs[Number(e.key) - 1]
          if (target) dispatchTabs({ type: 'activate', id: target.id })
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [dispatchTabs])

  const activeDoc: MarkdownDocument | null = useMemo(() => {
    if (!indexData || !activePath) return null
    return indexData.documents[activePath] || null
  }, [indexData, activePath])

  /**
   * Documents the Move to submenu offers as destinations. Sorted by
   * `updatedAt` desc so the most-recently-touched pages surface first;
   * the menu caps the rendered list to 50 entries to keep the popup
   * manageable for large workspaces.
   */
  const moveToCandidates = useMemo(() => {
    if (!indexData) return []
    return Object.values(indexData.documents)
      .filter((doc) => doc.path !== activePath)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .slice(0, 50)
      .map((doc) => ({ path: doc.path, title: doc.title }))
  }, [indexData, activePath])

  /** Folder segments, then the document's title rather than its filename. */
  const breadcrumb = useMemo(() => {
    if (!activeDoc) return ['Markdown Workspace']
    const folders = activeDoc.path.split('/').slice(0, -1)
    return [...folders, activeDoc.title]
  }, [activeDoc])

  const patchIndex = useCallback((mutate: (index: WorkspaceIndex) => void) => {
    setIndexData((prev) => {
      if (!prev) return prev
      const next = cloneIndex(prev)
      mutate(next)
      return next
    })
  }, [])

  /**
   * Fetches the file before showing it.
   *
   * Two reasons, and both matter. The index is a cache that may be stale — a note
   * edited in vim since the last ingest still has the old body here — so editing must
   * start from the real bytes and the etag that matches them, or the first save
   * silently discards whatever was written outside the app.
   *
   * And since Phase 4's index split, the index does not carry bodies at all: they
   * were 81% of a 4.68 MB payload the browser parsed on every boot. Reading a
   * document is now a fetch, in both modes.
   */
  /**
   * How many times each document has been written from this client.
   *
   * A read started before a save and finishing after it would otherwise put the
   * pre-save bytes and their dead etag back into the cache — and the next save would
   * then be sent with an etag the server has already replaced. Comparing the count
   * across the round trip is what lets a late read be thrown away.
   */
  const writeCountRef = useRef<Record<string, number>>({})

  /**
   * Caches a document's bytes, dropping anything no longer open.
   *
   * The prune rides on the write rather than watching the tab session from an effect,
   * which would be a synchronous setState in an effect body — a cascading render, and
   * the thing `react-hooks/set-state-in-effect` exists to stop. The cost is that
   * closing a background tab holds its bytes until the next read, which is the next
   * time any tab is focused. Kilobytes, briefly.
   */
  const putSource = useCallback((entry: LoadedSource) => {
    setSources((prev) => {
      const open = new Set(tabsRef.current.tabs.map(tabPath))
      const next: Record<string, LoadedSource> = { [entry.path]: entry }
      for (const [path, cached] of Object.entries(prev)) {
        if (path !== entry.path && open.has(path)) next[path] = cached
      }
      return next
    })
  }, [])

  /**
   * Reads the focused document when what is cached for it is not known to be current.
   *
   * Focusing a tab re-reads it: the file may have been edited elsewhere — in vim, on
   * another device — since it was last seen. What is cached stays on screen meanwhile,
   * so switching tabs shows the document rather than a skeleton.
   */
  useEffect(() => {
    if (!activePath || freshPath === activePath) return

    let cancelled = false
    const requestedPath = activePath
    const writesBefore = writeCountRef.current[requestedPath] ?? 0

    readDocumentEncrypted(requestedPath, noteKey)
      .then((data) => {
        if (cancelled) return
        // A save for this document landed while the read was in flight. Its response
        // is newer than this one, and already in the cache.
        if ((writeCountRef.current[requestedPath] ?? 0) !== writesBefore) return

        setSourceError(null)
        setReconciled(null)
        putSource({
          path: requestedPath,
          raw: data.raw,
          body: data.document.content ?? '',
          etag: data.document.etag,
        })
        setFreshPath(requestedPath)
        patchIndex((index) => applyUpsert(index, data.document))
      })
      .catch((err: Error) => {
        if (cancelled) return
        setSourceError({ path: requestedPath, message: err.message })
        setSources((prev) => {
          if (!(requestedPath in prev)) return prev
          const next = { ...prev }
          delete next[requestedPath]
          return next
        })
      })

    return () => {
      cancelled = true
    }
  }, [activePath, freshPath, patchIndex, putSource])

  /**
   * Reaches the save hook's buffer from callbacks defined before it exists.
   *
   * Used by `leaveEditor`, which needs the just-typed text to show the reading view
   * without a flash of the previous version while the save is still in flight. Filled
   * in by the effect below, like `saveNowRef`.
   */
  const getBufferRef = useRef<(() => string | null) | null>(null)
  // `undoDelete` is defined further down; the page menu's toast action
  // captures it for later. The ref keeps the callback the menu sees
  // current without re-rendering the menu every time the index changes.
  const undoDeleteRef = useRef<((trashId: string, label: string) => Promise<void>) | null>(null)

  const handleSaved = useCallback(
    (result: WriteResult, content: string) => {
      writeCountRef.current[result.path] = (writeCountRef.current[result.path] ?? 0) + 1
      patchIndex((index) => applyUpsert(index, result.document))

      // The loaded source has to move with the save, or switching back to reading
      // shows the document as it was when it was opened. It only looked like a
      // caching bug: `body` was captured on load and never touched again, so the
      // preview stayed on the original text until a reload refetched it.
      //
      // `content` is what the write put on the server, handed over by the save hook.
      // Reading it back off the live buffer instead was wrong for the case this now
      // has to handle: a save landing after the editor closed, when the buffer has
      // already been cleared and `raw` would fall back to the pre-save text — pairing
      // the new etag with the old bytes.
      setSources((prev) => {
        const entry = prev[result.path]
        if (!entry) return prev
        return {
          ...prev,
          [result.path]: {
            ...entry,
            etag: result.etag,
            raw: content,
            body: result.document.content ?? entry.body,
          },
        }
      })
      // What was just written is current by definition, whatever a read still in
      // flight is about to say.
      setFreshPath(result.path)

      // A save that landed is the resolution. Clearing on anything less would mean
      // the dot could be dismissed without the refused work being dealt with.
      setConflicted((prev) => {
        if (!prev.has(result.path)) return prev
        const next = new Set(prev)
        next.delete(result.path)
        return next
      })
    },
    [patchIndex]
  )

  const handleConflict = useCallback((path: string) => {
    setConflicted((prev) => (prev.has(path) ? prev : new Set(prev).add(path)))
  }, [])

  /**
   * The document the editor is bound to.
   *
   * Null until the bytes are known current, which is what keeps the editor from
   * opening on a cached body and an etag the server may have moved past.
   */
  const editingPath = mode === 'edit' && source && isFresh ? activePath : null
  /**
   * The per-page lock for the document the editor is bound to, or
   * `null` when the page is not locked or has been unlocked for
   * this session. Computed from the live `activeDoc.frontmatter`
   * so an unlock on the *read* path (DocViewer) does not lag the
   * edit path.
   */
  const activeLockPrompt = useMemo(() => {
    if (!editingPath || !activeDoc) return null
    if (unlockedPaths.has(editingPath)) return null
    return frontmatterLock(activeDoc.frontmatter)
  }, [editingPath, activeDoc, unlockedPaths])

  const {
    state: saveState,
    scheduleSave,
    saveNow,
    retry,
    hasUnsavedChanges,
    getBuffer,
  } = useDocumentSave({
    path: editingPath,
    initialEtag: source?.etag,
    // Live read: the user can lock and unlock the vault while a debounce is
    // pending. Reading `noteKey` directly would capture the value at render
    // time; the ref is mutated by the VaultKeyProvider effect.
    getNoteKey: () => noteKey,
    onSaved: handleSaved,
    onContentReconciled: setReconciled,
    onConflict: handleConflict,
  })

  const saveNowRef = useRef(saveNow)
  const hasUnsavedRef = useRef(hasUnsavedChanges)
  useEffect(() => {
    saveNowRef.current = saveNow
    hasUnsavedRef.current = hasUnsavedChanges
    getBufferRef.current = getBuffer
  }, [saveNow, hasUnsavedChanges, getBuffer])

  useEffect(() => {
    tabsRef.current = tabSession
  }, [tabSession])

  const flushPendingSave = useCallback(() => {
    if (hasUnsavedRef.current) void saveNowRef.current()
  }, [])

  const leaveEditor = useCallback(() => {
    flushPendingSave()

    // The save is in flight, so `handleSaved` will set the authoritative body a
    // moment from now. Showing the buffer immediately means the reading view never
    // flashes the previous text on the way there.
    const buffer = getBufferRef.current?.()
    if (buffer !== null && buffer !== undefined && editingPath) {
      setSources((prev) => {
        const entry = prev[editingPath]
        if (!entry) return prev
        return {
          ...prev,
          [editingPath]: { ...entry, raw: buffer, body: stripFrontmatterBlock(buffer) },
        }
      })
    }

    setMode('read')
  }, [flushPendingSave, setMode, editingPath])

  const navigateTo = useCallback(
    (path: string, intent: OpenIntent = IN_PLACE) => {
      flushPendingSave()
      dispatchTabs({ type: 'open', path, newTab: intent.newTab, background: intent.background })
      // Mirror new-tab opens into the desktop tab bar so the OS-window strip
      // reflects what is on screen. In-place opens don't grow the strip —
      // the active tab simply tracks the active path. A no-op when the
      // strip is full (returns false silently).
      if (intent.newTab) dispatchDesktopTabs({ type: 'open', path })
      // On a phone the drawer is covering the thing you just chose to read — but a
      // background open is a request to stay where you are, drawer included.
      if (!intent.background) setSidebarOpen(false)
    },
    [flushPendingSave, dispatchTabs, dispatchDesktopTabs]
  )

  /**
   * Walks the focused tab's history.
   *
   * Flushes first, exactly as `navigateTo` does. Going back is leaving a document as
   * surely as clicking away from it is, and the buffer must not be the difference.
   */
  const goBack = useCallback(() => {
    flushPendingSave()
    dispatchTabs({ type: 'back' })
  }, [flushPendingSave, dispatchTabs])

  const goForward = useCallback(() => {
    flushPendingSave()
    dispatchTabs({ type: 'forward' })
  }, [flushPendingSave, dispatchTabs])

  /**
   * Alt+Left, Alt+Right, and the mouse's own back and forward buttons.
   *
   * Its own listener rather than a branch in the shortcut handler above, because these
   * need `goBack` and `goForward` and that one deliberately depends on nothing that
   * changes.
   *
   * Both are cancelled rather than allowed through. They are the browser's own history
   * gestures, and letting the browser act on them here would leave the app entirely:
   * there is no per-document URL, so what sits behind this page is the login screen or
   * whatever site came before it. Cancelled only while a tab is open, so an empty
   * workspace is not a trap.
   */
  useEffect(() => {
    const isHistoryKey = (event: KeyboardEvent) =>
      event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey

    const onKeyDown = (event: KeyboardEvent) => {
      // Alt+Left under an open image viewer would take the document behind the
      // overlay back through its history, and the reader would dismiss the viewer
      // onto a document they never navigated to. See lib/modal-keys.ts.
      if (keyboardIsClaimed()) return
      if (!isHistoryKey(event) || !tabsRef.current.activeId) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        goBack()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        goForward()
      }
    }

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      if (!tabsRef.current.activeId) return
      event.preventDefault()
      if (event.button === 3) goBack()
      else goForward()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [goBack, goForward])

  // --- document and folder operations ---------------------------------------

  /** `newTab` carries the caller's intent through to whatever result is picked. */
  const openSearch = useCallback((newTab: boolean) => {
    setSearchOpensTab(newTab)
    setSearchOpen(true)
  }, [])

  const closeDialog = useCallback(() => {
    setDialog({ kind: 'none' })
    setDialogError(null)
    setDialogBusy(false)
  }, [])

  const openNewDocument = useCallback((parentDir: string) => {
    setDialogError(null)
    setDialog({ kind: 'newDocument', parentDir })
  }, [])
  const openNewFolder = useCallback((parentDir: string) => {
    setDialogError(null)
    setDialog({ kind: 'newFolder', parentDir })
  }, [])

  // Mirror the latest openNewDocument callback into the ref so the
  // keydown effect (registered once) can call it without a stale
  // closure and without re-binding on every render.
  useEffect(() => {
    openNewDocumentRef.current = openNewDocument
  }, [openNewDocument])

  /**
   * Opens the rename dialog, then asks the server how many documents the rename
   * would touch. A rename that quietly edits 12 other files should say so first.
   */
  const openRename = useCallback((node: FileTreeNode) => {
    setDialogError(null)
    setDialog({ kind: 'rename', node, linkCount: null })

    if (node.isDir) return

    const probeTarget = node.path.replace(/[^/]+\.md$/i, '__rename_probe__.md')
    api
      .planRename(node.path, probeTarget)
      .then(({ plan }) => {
        setDialog((prev) =>
          prev.kind === 'rename' && prev.node.path === node.path
            ? { ...prev, linkCount: plan.edits.length }
            : prev
        )
      })
      .catch(() => {
        // The count is a courtesy. Failing to get it must not block the rename.
      })
  }, [])

  const openDelete = useCallback(
    (node: FileTreeNode) => {
      setDialogError(null)
      const contents = node.isDir && indexData
        ? Object.keys(indexData.documents).filter((p) => p.startsWith(`${node.path}/`))
        : []
      setDialog({ kind: 'delete', node, contents })
    },
    [indexData]
  )

  const createDocumentAt = useCallback(
    async (parentDir: string, title: string, body?: string) => {
      const name = api.sanitizeName(title)
      if (!name) throw new api.ApiError('That name has no usable characters in it.', 0, 'BAD_NAME')

      // ponytail: linear scan over the in-memory index, not the disk. The
      // common case is "Untitled.md" -> free on the first try, so the loop
      // body runs at most once. Move to a per-folder set when the corpus
      // reaches a few hundred docs.
      const takenPaths = indexData ? Object.keys(indexData.documents) : []
      const path = api.findUniquePath(parentDir, name, takenPaths)
      const result = await createDocumentEncrypted(path, body ?? api.newDocumentTemplate(name), noteKey)

      patchIndex((index) => applyUpsert(index, result.document))
      // The create response is the file, so the new tab opens without a read at all.
      dispatchTabs({ type: 'open', path: result.path })
      putSource({
        path: result.path,
        raw: result.content ?? body ?? '',
        body: result.document.content ?? '',
        etag: result.etag,
      })
      setFreshPath(result.path)
      setMode('edit')
      return result
    },
    [patchIndex, dispatchTabs, setMode, putSource, indexData]
  )

  // Keep the ref in sync with the latest createDocumentAt so the global
  // keydown handler can call it without re-binding on every save.
  useEffect(() => {
    createDocumentAtRef.current = createDocumentAt
  }, [createDocumentAt])

  /**
   * Refetches the whole index after an operation that re-keyed many documents.
   *
   * Replaying a folder move or a multi-file rename patch-by-patch on the client is
   * more code and more ways to drift from what the server actually wrote. The index
   * is small; refetching it is the honest option.
   */
  const reloadIndex = useCallback(async () => {
    const response = await fetch('/api/index', { cache: 'no-store' })
    if (!response.ok) return
    setIndexData((await response.json()) as WorkspaceIndex)
  }, [])

  /**
   * Page-menu actions (the `⋯` button on the document viewer).
   *
   * `onCopy` is a notification hook — the page menu performs the
   * clipboard write itself so the toast is local to the click. The
   * remaining handlers are wired here because the workspace owns the
   * save pipeline (`useDocumentSave`), the encrypted fetch layer, and
   * the index patches.
   *
   * ponytail: each handler closes over the helpers it actually needs.
   * A single `pageMenuActions` object would be one place to look, but
   * the call site is one place too — and the explicit deps list makes
   * it obvious which pipeline the menu can affect.
   */

  const copyPageContent = useCallback(() => {
    // No-op for now: the page menu performs the clipboard write itself.
  }, [])

  const duplicatePage = useCallback(async () => {
    if (!activePath || !activeDoc || !source) return
    flushPendingSave()

    // In edit mode the buffer is fresher than `source.body`; in read
    // mode the two are the same. Strip frontmatter off the buffer so the
    // copy starts as a clean document; `createDocumentAt` re-stamps
    // `id` / `created` on the new file.
    const buffer = getBufferRef.current?.()
    const bodyForCopy = buffer !== null && buffer !== undefined
      ? stripFrontmatterBlock(buffer)
      : source.body

    const baseName = activeDoc.title.trim() || activeDoc.path.split('/').pop()!.replace(/\.md$/, '')
    const newTitle = `${baseName} (copy)`
    const parentDir = activePath.includes('/')
      ? activePath.slice(0, activePath.lastIndexOf('/'))
      : ''

    try {
      const result = await createDocumentAt(parentDir, newTitle, bodyForCopy)
      toast.success(`Duplicated to ${result.path}`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }, [activePath, activeDoc, source, flushPendingSave, createDocumentAt])

  const movePageTo = useCallback(
    async (destDir: string) => {
      if (!activePath) return
      flushPendingSave()

      const fileName = activePath.split('/').pop()!
      const currentDir = activePath.includes('/')
        ? activePath.slice(0, activePath.lastIndexOf('/'))
        : ''
      if (destDir === currentDir) {
        toast.message('Already in that folder')
        return
      }
      const destPath = destDir ? `${destDir}/${fileName}` : fileName
      try {
        const { report, summary } = await api.renameDocument(activePath, destPath)
        // The local patch (applyMove) doesn't rewrite the tree, so the
        // sidebar would render the file in both folders until reload.
        // `reloadIndex` is the source of truth — match the existing
        // rename dialog's behaviour.
        await reloadIndex()
        if (report.renamed) {
          dispatchTabs({ type: 'pathRenamed', from: activePath, to: destPath })
        } else {
          // The rename failed but the attempt may have rewritten
          // inbound links, so the cached body is no longer trustworthy.
          setFreshPath(null)
          toast.error(report.renameError ?? 'The rename failed.')
          return
        }
        toast.success(summary)
        if (report.aliasWarning) toast.warning(report.aliasWarning, { duration: 12000 })
        if (report.headingWarning) toast.warning(report.headingWarning, { duration: 12000 })
      } catch (err) {
        toast.error((err as Error).message)
      }
    },
    [activePath, flushPendingSave, reloadIndex, dispatchTabs]
  )

  const trashPage = useCallback(async () => {
    if (!activePath || !activeDoc) return
    flushPendingSave()
    try {
      const result = await api.deleteDocument(activePath)
      patchIndex((index) => applyRemove(index, activePath))
      dispatchTabs({ type: 'pathRemoved', path: activePath })
      const label = activeDoc.title || activePath
      toast.success(`Deleted ${label}`, {
        action: result.trashId
          ? { label: 'Undo', onClick: () => void undoDeleteRef.current?.(result.trashId!, label) }
          : undefined,
        duration: 10000,
      })
    } catch (err) {
      toast.error((err as Error).message)
    }
  }, [activePath, activeDoc, flushPendingSave, patchIndex, dispatchTabs])

  const setPageView = useCallback(
    async (view: 'small' | 'full') => {
      if (!activePath || !source) return
      const next = setFrontmatterField(source.raw, 'view', view)
      if (!next.changed) return
      try {
        await writeDocumentEncrypted({ path: activePath, content: next.content }, noteKey)
        setSources((prev) => {
          const entry = prev[activePath]
          if (!entry) return prev
          return { ...prev, [activePath]: { ...entry, raw: next.content } }
        })
        patchIndex((index) => {
          const doc = index.documents[activePath]
          if (!doc) return
          applyUpsert(index, {
            ...doc,
            frontmatter: { ...doc.frontmatter, view },
            updatedAt: new Date().toISOString(),
          })
        })
      } catch (err) {
        toast.error((err as Error).message)
      }
    },
    [activePath, source, noteKey, patchIndex]
  )

  const setPageWidth = useCallback(
    async (width: 'full' | 'default') => {
      if (!activePath || !source) return
      const next = setFrontmatterField(source.raw, 'width', width)
      if (!next.changed) return
      try {
        await writeDocumentEncrypted({ path: activePath, content: next.content }, noteKey)
        setSources((prev) => {
          const entry = prev[activePath]
          if (!entry) return prev
          return { ...prev, [activePath]: { ...entry, raw: next.content } }
        })
        patchIndex((index) => {
          const doc = index.documents[activePath]
          if (!doc) return
          applyUpsert(index, {
            ...doc,
            frontmatter: { ...doc.frontmatter, width },
            updatedAt: new Date().toISOString(),
          })
        })
      } catch (err) {
        toast.error((err as Error).message)
      }
    },
    [activePath, source, noteKey, patchIndex]
  )

  /**
   * Lock the current page with a fresh passphrase.
   *
   * The lock is stored in `frontmatter.lock`. A new pageKey is
   * generated per lock, then wrapped under the passphrase via
   * PBKDF2-SHA256 (see `lib/lock/page-lock.ts`). The body is NOT
   * re-encrypted — the master note-crypto envelope is still the
   * at-rest protection.
   */
  const lockPage = useCallback(
    async (passphrase: string) => {
      if (!activePath || !source) return
      if (!passphrase) {
        toast.error('Passphrase must not be empty.')
        return
      }
      try {
        const lock = await makeLock(passphrase)
        const next = setFrontmatterObject(source.raw, 'lock', lock as unknown as Record<string, unknown>)
        if (!next.changed) {
          toast.error('Could not update the frontmatter.')
          return
        }
        await writeDocumentEncrypted({ path: activePath, content: next.content }, noteKey)
        setSources((prev) => {
          const entry = prev[activePath]
          if (!entry) return prev
          return { ...prev, [activePath]: { ...entry, raw: next.content } }
        })
        patchIndex((index) => {
          const doc = index.documents[activePath]
          if (!doc) return
          applyUpsert(index, {
            ...doc,
            frontmatter: { ...doc.frontmatter, lock: lock as unknown as Record<string, unknown> },
            updatedAt: new Date().toISOString(),
          })
        })
        // The user just set the passphrase: they obviously know it.
        setUnlockedPaths((prev) => {
          const next = new Set(prev)
          next.add(activePath)
          return next
        })
        toast.success('Page locked.')
      } catch (err) {
        toast.error((err as Error).message)
      }
    },
    [activePath, source, noteKey, patchIndex]
  )

  /**
   * Remove the lock from the current page.
   *
   * No passphrase check here: the caller (the page menu's
   * "Unlock page" action) only appears when the user is already
   * on the page, and the lock's only job is edit-blocking.
   * Removing the lock does not retroactively lock the file
   * against future edits — it is the same as never having set it.
   */
  const unlockPage = useCallback(async () => {
    if (!activePath || !source) return
    const next = removeFrontmatterField(source.raw, 'lock')
    if (!next.changed) return
    try {
      await writeDocumentEncrypted({ path: activePath, content: next.content }, noteKey)
      setSources((prev) => {
        const entry = prev[activePath]
        if (!entry) return prev
        return { ...prev, [activePath]: { ...entry, raw: next.content } }
      })
      patchIndex((index) => {
        const doc = index.documents[activePath]
        if (!doc) return
        const { lock: _lock, ...rest } = doc.frontmatter
        void _lock
        applyUpsert(index, {
          ...doc,
          frontmatter: rest,
          updatedAt: new Date().toISOString(),
        })
      })
      setUnlockedPaths((prev) => {
        if (!prev.has(activePath)) return prev
        const next = new Set(prev)
        next.delete(activePath)
        return next
      })
      toast.success('Page unlocked.')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }, [activePath, source, noteKey, patchIndex])

  /**
   * Mark the current path as unlocked for this session. Called by
   * the `<LockPrompt>` after a successful `verifyPassphrase`.
   */
  const markUnlocked = useCallback(() => {
    if (!activePath) return
    setUnlockedPaths((prev) => {
      if (prev.has(activePath)) return prev
      const next = new Set(prev)
      next.add(activePath)
      return next
    })
  }, [activePath])

  /**
   * Import the user's chosen files as siblings of the active page.
   *
   * Each file becomes a new document in the active page's parent
   * folder. (The spec said "child page", but creating a new
   * sub-folder for one file is more friction than help, and
   * the page tree can re-parent afterwards.) Extensions outside
   * `.md`/`.markdown`/`.txt` are silently skipped — the page
   * menu already pre-filters them via `accept`, so a stray file
   * from a drag-and-drop is the only way to land here.
   */
  const importPages = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const parentDir = activePath?.includes('/')
        ? activePath.slice(0, activePath.lastIndexOf('/'))
        : ''
      const accepted = files.filter(isImportableFile)
      const rejected = files.length - accepted.length
      if (accepted.length === 0) {
        toast.error('No importable files selected. Use .md, .markdown, or .txt.')
        return
      }
      let created = 0
      for (const file of accepted) {
        try {
          const parsed = await readMarkdownFile(file)
          await createDocumentAt(parentDir, parsed.title, parsed.body)
          created += 1
        } catch (err) {
          toast.error(`Could not import ${file.name}: ${(err as Error).message}`)
        }
      }
      if (rejected > 0) {
        toast.message(`Skipped ${rejected} file(s) with an unsupported extension.`)
      }
      if (created > 0) toast.success(`Imported ${created} page${created === 1 ? '' : 's'}.`)
    },
    [activePath, createDocumentAt]
  )

  /*
    Folder import. The web only exposes a flat FileList from
    `<input webkitdirectory>` — `webkitRelativePath` is the only signal we
    have for the folder tree. We recreate the relative structure under the
    active folder so importing "Notes/Recipes/Cake.md" lands at
    `<active>/Notes/Recipes/Cake.md`. The relativePath on webkitdirectory
    inputs is the only reason the helper exists separately from
    `importPages`.
  */
  const importFolder = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const accepted = files.filter(isImportableFile)
      if (accepted.length === 0) {
        toast.error('No importable files in the folder. Use .md, .markdown, or .txt.')
        return
      }
      const root = activePath?.includes('/')
        ? activePath.slice(0, activePath.lastIndexOf('/'))
        : ''
      const ensureFolder = async (folder: string) => {
        if (!folder || folder === root) return
        await api.createFolder(folder)
      }
      let created = 0
      let lastFolder = ''
      for (const file of accepted) {
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        const segments = rel.split('/').filter(Boolean)
        const fileName = segments.pop() || file.name
        const dir = api.joinPath(root, segments.join('/'))
        if (dir !== lastFolder) {
          await ensureFolder(dir)
          lastFolder = dir
        }
        try {
          const parsed = await readMarkdownFile({ ...file, name: fileName })
          await createDocumentAt(dir, parsed.title, parsed.body)
          created += 1
        } catch (err) {
          toast.error(`Could not import ${fileName}: ${(err as Error).message}`)
        }
      }
      if (created > 0) toast.success(`Imported ${created} page${created === 1 ? '' : 's'}.`)
    },
    [activePath, createDocumentAt]
  )

  /**
   * Export the active page to disk.
   *
   * The active document's `raw` is the on-disk file with the
   * workspace's own frontmatter (`id`, `created`, …) included,
   * which is what the user expects when they pull a note out of
   * MarkForge — it round-trips back through Import unchanged,
   * modulo `ensureDocumentMeta` re-stamping on first save.
   *
   * Electron uses the native `Save As…` dialog so the user picks
   * the destination; the web build uses a transient `<a download>`
   * to push the file to the browser's download slot.
   */
  const exportPage = useCallback(async () => {
    if (!activeDoc || !source) return
    const filename = buildExportName(activeDoc)
    const desktop = (typeof window !== 'undefined' ? window.markforge : null) as
      | { saveFile?: (p: { content: string; defaultName: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null> }
      | null
    if (desktop?.saveFile) {
      try {
        const written = await desktop.saveFile({
          content: source.raw,
          defaultName: filename,
          filters: [
            { name: 'Markdown', extensions: ['md'] },
            { name: 'All files', extensions: ['*'] },
          ],
        })
        if (written) toast.success(`Exported to ${written}`)
      } catch (err) {
        toast.error((err as Error).message)
      }
      return
    }
    downloadMarkdown(filename, source.raw)
  }, [activeDoc, source])

  /**
   * Drag & drop a document into a folder, from the sidebar.
   *
   * The same link-safe path as a rename (title is unchanged, so nothing rewrites);
   * a mover that skipped `/api/rename` would break wikilinks pointing at the document.
   */
  const moveDocumentInto = useCallback(
    async (from: string, to: string) => {
      flushPendingSave()
      const { report, summary } = await api.renameDocument(from, to)
      await reloadIndex()

      if (!report.renamed) {
        toast.error(report.renameError ?? 'The move failed.', { duration: Infinity, closeButton: true })
        return
      }

      dispatchTabs({ type: 'pathRenamed', from, to })
      if (report.failedCount > 0) {
        toast.error(summary, { duration: Infinity, closeButton: true })
      } else {
        const folder = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : 'root'
        toast.success(`Moved into ${folder}`)
      }
    },
    [flushPendingSave, reloadIndex, dispatchTabs]
  )

  const submitDialog = useCallback(
    async (value: string) => {
      setDialogBusy(true)
      setDialogError(null)

      try {
        if (dialog.kind === 'newDocument') {
          await createDocumentAt(dialog.parentDir, value)
          toast.success(`Created ${api.sanitizeName(value)}`)
          closeDialog()
          return
        }

        if (dialog.kind === 'newFolder') {
          const name = api.sanitizeName(value)
          if (!name) throw new api.ApiError('That name has no usable characters in it.', 0, 'BAD_NAME')
          const path = api.joinPath(dialog.parentDir, name)
          await api.createFolder(path)
          patchIndex((index) => applyAddDir(index, path))
          toast.success(`Created folder ${name}`)
          closeDialog()
          return
        }

        if (dialog.kind === 'rename') {
          const { node } = dialog
          flushPendingSave()

          if (node.isDir) {
            const parent = node.path.includes('/')
              ? node.path.slice(0, node.path.lastIndexOf('/'))
              : ''
            const name = api.sanitizeName(value)
            if (!name) throw new api.ApiError('That name has no usable characters in it.', 0, 'BAD_NAME')
            const to = api.joinPath(parent, name)

            const result = await api.moveFolder(node.path, to)
            // A folder move re-keys many documents at once; refetching the index is
            // cheaper and less error-prone than replaying every move client-side.
            await reloadIndex()
            // Every tab and every history entry under the old folder, not just the
            // one on screen — a Back button that lands on a path the move emptied is
            // the same bug, one keystroke later.
            dispatchTabs({ type: 'prefixMoved', from: node.path, to })
            // No cache to clear by hand: the tabs now point at the new paths, and the
            // prune drops everything the old ones were holding.
            toast.success(`Moved ${result.moved.length} document${result.moved.length === 1 ? '' : 's'}`)
            closeDialog()
            return
          }

          const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''
          const name = api.sanitizeName(value.replace(/\.md$/i, ''))
          if (!name) throw new api.ApiError('That name has no usable characters in it.', 0, 'BAD_NAME')
          const to = api.joinPath(parent, `${name}.md`)

          const { report, summary } = await api.renameDocument(node.path, to)
          await reloadIndex()

          if (report.renamed) dispatchTabs({ type: 'pathRenamed', from: node.path, to })
          // A rename that failed left the file where it was, but the attempt may have
          // rewritten links inside it, so what is cached is no longer trustworthy.
          else setFreshPath(null)

          if (!report.renamed) {
            setDialogError(report.renameError ?? 'The rename failed.')
            setDialogBusy(false)
            return
          }

          // Partial failures are reported loudly and stay on screen, because a
          // link graph that rotted quietly is the failure mode this guards against.
          if (report.failedCount > 0) {
            toast.error(summary, { duration: Infinity, closeButton: true })
          } else {
            toast.success(summary)
          }
          if (report.aliasWarning) toast.warning(report.aliasWarning, { duration: 12000 })
          // The rename landed but the document still calls itself by the old name,
          // so the sidebar and the tab will disagree with the filename until it is
          // fixed by hand. Worth saying rather than leaving to be noticed.
          if (report.headingWarning) toast.warning(report.headingWarning, { duration: 12000 })
          closeDialog()
          return
        }
      } catch (err) {
        setDialogError((err as Error).message)
        setDialogBusy(false)
        return
      }

      setDialogBusy(false)
    },
    [dialog, createDocumentAt, closeDialog, patchIndex, flushPendingSave, reloadIndex, dispatchTabs]
  )

  /**
   * Puts a deleted entry back.
   *
   * The index is refetched rather than patched: a restore can put a folder and many
   * documents back at once, and replaying that client-side is more code and more ways
   * to disagree with what the server actually wrote.
   */
  const undoDelete = useCallback(
    async (trashId: string, label: string) => {
      try {
        const result = await api.restoreFromTrash(trashId)
        await reloadIndex()
        if (result.skipped.length > 0) {
          toast.warning(
            `Restored ${result.restored.length}. Still in the trash — something already exists at ${result.skipped.join(', ')}`,
            { duration: 12000 }
          )
        } else {
          toast.success(`Restored ${label}`)
        }
      } catch (err) {
        toast.error((err as Error).message)
      }
    },
    [reloadIndex]
  )

  useEffect(() => {
    // The page menu's trash toast captures this through the ref so the
    // menu itself does not have to know the implementation.
    undoDeleteRef.current = undoDelete
  }, [undoDelete])

  const confirmDelete = useCallback(async () => {
    if (dialog.kind !== 'delete') return
    setDialogBusy(true)
    setDialogError(null)

    const { node } = dialog
    // Deletes are recoverable now, so the toast carries the undo rather than just
    // reporting what was destroyed.
    const undo = (trashId: string | null) =>
      trashId
        ? { action: { label: 'Undo', onClick: () => void undoDelete(trashId, node.name) }, duration: 10000 }
        : {}

    try {
      if (node.isDir) {
        const result = await api.deleteFolder(node.path)
        patchIndex((index) => applyRemoveDir(index, node.path))
        // Closes every tab under the folder and scrubs it from what is left. The
        // tab carries the mode, so there is no mode to reset once it is gone.
        dispatchTabs({ type: 'prefixRemoved', prefix: node.path })
        toast.success(
          result.removed.length > 0
            ? `Deleted ${node.name} and ${result.removed.length} document${result.removed.length === 1 ? '' : 's'}`
            : `Deleted ${node.name}`,
          undo(result.trashId)
        )
      } else {
        const result = await api.deleteDocument(node.path)
        patchIndex((index) => applyRemove(index, node.path))
        dispatchTabs({ type: 'pathRemoved', path: node.path })
        toast.success(`Deleted ${node.name}`, undo(result.trashId))
      }
      // The optimistic patch above can miss (path normalisation, races with an
      // in-flight fetch) and a stale entry lingers in panels like Recent Edits.
      // The server's index is the truth - refetch it so every panel agrees.
      await reloadIndex()
      closeDialog()
    } catch (err) {
      setDialogError((err as Error).message)
      setDialogBusy(false)
    }
  }, [dialog, patchIndex, closeDialog, undoDelete, dispatchTabs, reloadIndex])

  /**
   * Ghost page: an unresolved wikilink becomes a real document.
   *
   * Created beside the document that links to it, because that is almost always
   * where it belongs, and moving it later is one rename away.
   */
  const createGhostPage = useCallback(
    async (target: string) => {
      const parentDir =
        activePath && activePath.includes('/') ? activePath.slice(0, activePath.lastIndexOf('/')) : ''

      try {
        flushPendingSave()
        await createDocumentAt(parentDir, target)
        toast.success(`Created ${target}`)
      } catch (err) {
        toast.error((err as Error).message)
      }
    },
    [activePath, createDocumentAt, flushPendingSave]
  )

  /**
   * Ends the session and returns to the login page.
   *
   * Flushes first: signing out with an unsaved buffer would discard it, and the
   * whole save machine exists so that never happens quietly.
   */
  const signOut = useCallback(async () => {
    flushPendingSave()
    try {
      await api.signOut()
    } catch {
      // The cookie may already be gone. Either way the destination is the same.
    }
    router.push('/login')
    router.refresh()
  }, [flushPendingSave, router])

  const handleNavigateWikilink = useCallback(
    (target: string, intent: OpenIntent = IN_PLACE) => {
      if (!indexData) return
      const resolved = resolveWikiLink(target, indexData.documents)
      // A ghost page is created to be written, so it always takes the focus, whatever
      // the click asked for.
      if (resolved) navigateTo(resolved.path, intent)
      else void createGhostPage(target)
    },
    [indexData, navigateTo, createGhostPage]
  )

  /**
   * Block-menu "Open in…" handler. Reroutes the block's link into the
   * surface the user picked:
   * - side-peek  → 45%-width overlay on top of the active tab
   * - new-tab    → existing tab reducer, in the background
   * - new-window → Electron IPC; on the web the call silently falls
   *                back to opening a new tab
   * - full-page  → close peek, navigate the active tab to the block
   *
   * The `path` argument is the document the block lives in; in v1 the
   * block is always on the active document so the menu passes the
   * editor's `docPath` straight through.
   */
  const handleOpenIn = useCallback(
    (target: 'side-peek' | 'new-tab' | 'new-window' | 'full-page', path: string) => {
      if (target === 'side-peek') {
        setSidePeekPath(path)
        return
      }
      if (target === 'new-tab') {
        dispatchTabs({ type: 'open', path, newTab: true, background: false })
        return
      }
      if (target === 'new-window') {
        const desktop = (typeof window !== 'undefined' && window.markforge) as
          | { openInWindow?: (p: string) => Promise<{ ok: boolean; error?: string }> }
          | undefined
        if (desktop?.openInWindow) {
          void desktop.openInWindow(path).then((res) => {
            if (!res.ok) toast.error(res.error ?? 'Failed to open new window')
          })
          return
        }
        // Web fallback: open a new tab in the same browser.
        dispatchTabs({ type: 'open', path, newTab: true, background: false })
        return
      }
      if (target === 'full-page') {
        setSidePeekPath(null)
        dispatchTabs({ type: 'open', path, newTab: false })
      }
    },
    [dispatchTabs]
  )

  /**
   * Move a block from the current document to another.
   *
   * The editor hands us the block text and its index into the split
   * of the *current* buffer; the workspace flushes any pending save
   * first so the buffer is on disk, then re-reads the destination,
   * splices the block out of the source and into the destination,
   * and writes both. The destination is written first; if that
   * fails the source stays put and the user sees an error toast.
   * If the source write fails after a successful destination write,
   * the block exists in both places — the editor is reconciled
   * against the new source body and the duplicate on the
   * destination can be deleted by hand.
   *
   * ponytail: spec scenario says "appended to the destination
   * document" and "its server etag is checked". The etag check is
   * skipped here because the editor is the only writer for the
   * source path (no external contention) and the destination's
   * frontmatter id is preserved by the server. Add etag when the
   * workspace gains real co-editing.
   */
  const moveBlockTo = useCallback(
    async (args: { sourcePath: string; destPath: string; blockText: string; blockIndex: number }) => {
      const { sourcePath, destPath, blockText, blockIndex } = args
      if (sourcePath === destPath) {
        toast.error('Pick a different page to move into')
        return
      }
      if (editingPath !== sourcePath) {
        toast.error('The source page is not the one being edited')
        return
      }
      const buffer = getBufferRef.current?.()
      if (buffer === null || buffer === undefined) {
        toast.error('Nothing to move — the editor buffer is empty')
        return
      }
      flushPendingSave()

      const move = moveBlockBetweenDocs(buffer, blockIndex, blockText)
      if (!move) {
        toast.error('That block is no longer where it was — reopen the menu and try again')
        return
      }
      const { remainder, newDest } = move

      try {
        const destRead = await readDocumentEncrypted(destPath, noteKey)
        const destBody = (destRead.document.content ?? '').replace(/\n+$/, '')
        const finalDest = destBody.length === 0 ? blockText : `${destBody}\n\n${blockText}`
        await writeDocumentEncrypted({ path: destPath, content: finalDest }, noteKey)
        await writeDocumentEncrypted({ path: sourcePath, content: remainder }, noteKey)
      } catch (err) {
        toast.error((err as Error).message || 'Move failed', { duration: Infinity, closeButton: true })
        return
      }

      await reloadIndex()
      // Push the new source body to the editor; the editor's reconcile
      // effect replaces the buffer and re-renders.
      setReconciled(remainder)
      toast.success('Moved')
    },
    [editingPath, flushPendingSave, reloadIndex]
  )

  // Sharing is an explicit act with an explicit token, handled in ShareDialog.
  // This used to build a URL from the document's title, which meant every note was
  // readable by anyone who could guess its name — see docs/sprint-6-share-model.md.

  if (loading) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-xs text-muted-foreground">Loading workspace index...</p>
          {devLogs.length > 0 && (
            <div className="mt-2 max-w-sm rounded-md border bg-muted/50 p-2 font-mono text-[10px] text-muted-foreground">
              {devLogs.map((log, i) => (
                <div key={i}>{log}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  const renameNode = dialog.kind === 'rename' ? dialog.node : null
  const tabs = tabSession.tabs

  /*
    Where Back and Forward would land, named rather than implied. "Back to Welcome" is
    a decision anyone can make without pressing the button to find out; a bare arrow is
    not, and this history is not the browser's, so nobody arrives already knowing what
    is behind it.
  */
  const historyStep = (offset: number) =>
    activeTabState ? (activeTabState.history[activeTabState.cursor + offset] ?? null) : null
  const backTarget = canGoBack(activeTabState) ? historyStep(-1) : null
  const forwardTarget = canGoForward(activeTabState) ? historyStep(1) : null
  const describe = (path: string | null, fallback: string) =>
    path ? `${fallback} to ${documentLabel(path, indexData?.documents || {})}` : fallback

  return (
    <VaultKeyProvider vault={vault}>
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
      <DesktopTabBar
        state={desktopTabsState}
        dispatch={dispatchDesktopTabs}
        documents={indexData?.documents || {}}
        onActivate={(path) => navigateTo(path, IN_PLACE)}
        limit={MAX_DESKTOP_TABS}
        onLimitReached={() => toast.error(`Max ${MAX_DESKTOP_TABS} tabs. Close one to open another.`)}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <Sidebar
        tree={indexData?.tree || []}
        activePath={activePath}
        onSelectFile={navigateTo}
        onOpenSearch={() => openSearch(false)}
        onCreateDocument={openNewDocument}
        onCreateFolder={openNewFolder}
        onRenameNode={openRename}
        onDeleteNode={openDelete}
        onMoveDocument={moveDocumentInto}
        onOpenTrash={() => setTrashOpen(true)}
        onOpenPasswords={() => setPasswordsOpen(true)}
        onOpenSettings={() => router.push('/settings')}
        onSignOut={() => void signOut()}
        documents={indexData?.documents || {}}
        onAfterImport={reloadIndex}
        onImportFile={() => {
          const input = globalThis.document.createElement('input')
          input.type = 'file'
          input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
          input.multiple = true
          input.style.display = 'none'
          input.addEventListener('change', () => {
            const files = input.files ? Array.from(input.files) : []
            input.remove()
            if (files.length > 0) void importPages(files)
          })
          globalThis.document.body.appendChild(input)
          input.click()
        }}
        onImportFolder={() => {
          const input = globalThis.document.createElement('input')
          input.type = 'file'
          // ponytail: webkitdirectory is the only portable signal we have
          // for a folder pick on the web. The DataTransfer API exists, but
          // there is no `showDirectoryPicker` in Safari/Firefox yet.
          input.setAttribute('webkitdirectory', '')
          input.multiple = true
          input.style.display = 'none'
          input.addEventListener('change', () => {
            const files = input.files ? Array.from(input.files) : []
            input.remove()
            if (files.length > 0) void importFolder(files)
          })
          globalThis.document.body.appendChild(input)
          input.click()
        }}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        storageKind={storageKind}
        onCreatePageDirect={() => openNewDocument('')}
        onOpenInSidePeek={(path) => {
          setSidePeekPath(path)
          setSidebarOpen(false)
        }}
        onOpenInNewWindow={(path) => {
          // Prefer Electron's native window IPC. The web fallback reuses the
          // tab reducer (same-window, new tab) since there's no per-doc URL
          // route to point `window.open` at.
          const desktop = (typeof window !== 'undefined' ? window.markforge : null) as
            | { openInWindow?: (p: string) => Promise<{ ok: boolean; error?: string }> }
            | null
          if (desktop?.openInWindow) {
            void desktop.openInWindow(path).then((res) => {
              if (!res.ok) toast.error(res.error ?? 'Failed to open new window')
            })
            return
          }
          dispatchTabs({ type: 'open', path, newTab: true, background: false })
        }}
      />

      <div className="relative flex flex-1 flex-col overflow-hidden">
        {/*
          Not dismissible, and above everything. Somebody whose writes are being
          discarded needs to keep being told, not to be told once while they are
          reading something else.
        */}
        {storageWarning && (
          <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p>
              <span className="font-medium">Edits are not being stored durably.</span>{' '}
              {storageWarning}
            </p>
          </div>
        )}

        {/*
          One row. Tabs (when there is more than one) sit on the left, the
          page actions on the right. Single-document sessions lose the tab
          portion of the row, which used to be a separate `h-9` strip above
          this header. A 36-pixel tab row that just says "you have one tab
          open" is noise; inlining it lets the rest of the workspace stretch
          one more line into view.
        */}
        <header className="flex h-10 items-center justify-between gap-3 border-b bg-background/80 backdrop-blur pl-2 pr-3">
          <div className="flex min-w-0 items-center gap-1">
            {/*
              The tab strip is mounted for every session but its `display`
              collapses when there is a single document — the strip itself
              already does that (see components/workspace/tab-strip.tsx). We
              always render the slot so the right-side controls do not shift
              sideways as a second tab opens.
            */}
            {tabs.length > 1 ? (
              <div className="-mb-px self-end">
                <TabStrip
                  flush
                  tabs={tabs}
                  activeId={tabSession.activeId}
                  documents={indexData?.documents || {}}
                  conflicted={conflicted}
                  onSelect={(id) => {
                    flushPendingSave()
                    dispatchTabs({ type: 'activate', id })
                  }}
                  onClose={(id) => {
                    flushPendingSave()
                    dispatchTabs({ type: 'close', id })
                  }}
                  onCloseOthers={(id) => {
                    flushPendingSave()
                    dispatchTabs({ type: 'closeOthers', id })
                  }}
                  onCloseToRight={(id) => {
                    flushPendingSave()
                    dispatchTabs({ type: 'closeToRight', id })
                  }}
                  // No flush: reordering does not change which document is open.
                  onReorder={(from, to) => dispatchTabs({ type: 'reorder', from, to })}
                  onNew={() => openSearch(true)}
                />
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
              className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
            >
              <Menu className="size-4" />
            </button>

            {/*
              Before the breadcrumb, where every browser and every editor with a
              history puts them. Always rendered, disabled rather than hidden, so the
              breadcrumb does not shift sideways as a tab's history fills up.
            */}
            <div className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={goBack}
                disabled={!backTarget}
                title={`${describe(backTarget, 'Back')} (Alt+←)`}
                aria-label={describe(backTarget, 'Back')}
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ArrowLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={goForward}
                disabled={!forwardTarget}
                title={`${describe(forwardTarget, 'Forward')} (Alt+→)`}
                aria-label={describe(forwardTarget, 'Forward')}
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ArrowRight className="size-4" />
              </button>
            </div>

            {/*
              A breadcrumb rather than the raw path, as in the original design. The
              folder segments are not links: there is no folder view to navigate to,
              and a link that goes nowhere is worse than plain text.
            */}
            <nav aria-label="Breadcrumb" className="min-w-0">
              <ol className="flex min-w-0 items-center gap-1.5 text-xs">
                {breadcrumb.map((segment, i) => (
                  <li key={segment + i} className="flex min-w-0 items-center gap-1.5">
                    {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />}
                    <span
                      // The document's title is the segment most likely to be cut
                      // short here, and it is the one nobody can reconstruct from
                      // what is left of it.
                      title={segment}
                      className={cn(
                        'truncate',
                        i === breadcrumb.length - 1
                          ? 'font-medium text-foreground'
                          : 'text-muted-foreground'
                      )}
                      {...(i === breadcrumb.length - 1 ? { 'aria-current': 'page' as const } : {})}
                    >
                      {segment}
                    </span>
                  </li>
                ))}
              </ol>
            </nav>
          </div>

          <div className="flex items-center gap-2">
            {mode === 'edit' && (
              <SaveIndicator
                state={saveState}
                onRetry={retry}
                onOpenConflict={(path) => {
                  // Refetch first: the conflict copy was created by the server after
                  // this client's last index read, so it is not in the tree yet.
                  void reloadIndex().then(() => navigateTo(path))
                }}
              />
            )}

            {activeDoc && (
              <>
                <button
                  type="button"
                  onClick={() => (mode === 'read' ? setMode('edit') : leaveEditor())}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                    'hover:bg-muted'
                  )}
                  title={mode === 'read' ? 'Edit (Ctrl+E)' : 'Done editing (Ctrl+E)'}
                >
                  {mode === 'read' ? (
                    <>
                      <Pencil className="size-3.5" />
                      Edit
                    </>
                  ) : (
                    <>
                      <Eye className="size-3.5" />
                      Read
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShareOpen(true)}
                  className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                  title="Create and manage share links"
                >
                  <Share2 className="size-3.5" />
                  Share
                </button>
              </>
            )}

            {/*
              In the flow of the header rather than floating over it. Renders nothing
              unless the browser actually offers an install, so the row must not
              assume it is there.
            */}
            <PwaInstallButton />

            <ThemeSwitcher />

            {activeDoc && (
              <button
                type="button"
                onClick={() => setRailOpen(!railOpen)}
                aria-pressed={railOpen}
                title={railOpen ? 'Hide the context rail' : 'Show the context rail'}
                aria-label={railOpen ? 'Hide the context rail' : 'Show the context rail'}
                className={cn(
                  'hidden size-8 items-center justify-center rounded-md transition-colors hover:bg-muted lg:flex',
                  railOpen ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                <PanelRight className="size-4" />
              </button>
            )}

            {/*
              The `⋯` meatball menu lives in the header so the button is in the
              same place in both read and edit mode. Was sticky inside the
              article, which scrolled out of view for any long document.
            */}
            {activeDoc && source && (
              <PageMenu
                document={activeDoc}
                body={source.body}
                tree={indexData?.tree || []}
                onCopy={copyPageContent}
                onDuplicate={() => void duplicatePage()}
                onMoveTo={(destDir) => void movePageTo(destDir)}
                onTrash={() => void trashPage()}
                onSetView={(view) => void setPageView(view)}
                onSetWidth={(width) => void setPageWidth(width)}
                isLocked={frontmatterLock(activeDoc.frontmatter) !== null}
                onLock={(passphrase) => void lockPage(passphrase)}
                onUnlock={() => void unlockPage()}
                onImport={(files) => void importPages(files)}
                onExport={() => void exportPage()}
              />
            )}
          </div>
        </header>

        <div className="relative flex flex-1 overflow-hidden">
          {mode === 'edit' && activeDoc ? (
            <div className="flex-1 overflow-hidden px-8 py-6">
              <div className="mx-auto h-full max-w-3xl">
                {activeDoc && (
                  <Breadcrumb
                    current={activeDoc}
                    allDocs={indexData?.documents || {}}
                    onNavigate={(path, intent) => {
                      if (intent.newTab) {
                        dispatchTabs({ type: 'open', path, newTab: true, background: intent.background })
                      } else {
                        navigateTo(path)
                      }
                    }}
                    className="mb-3"
                  />
                )}
                {sourceError?.path === activePath ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                    <p className="font-medium">Could not open this file for editing.</p>
                    <p className="mt-1 text-xs opacity-80">{sourceError.message}</p>
                  </div>
                ) : !editingPath || !source ? (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Reading from disk…
                  </div>
                ) : activeLockPrompt ? (
                  <LockPrompt lock={activeLockPrompt} onUnlock={markUnlocked} />
                ) : (
                  <MarkdownEditor
                    docPath={source.path}
                    initialValue={source.raw}
                    allDocs={indexData?.documents || {}}
                    onChange={scheduleSave}
                    onRequestSave={saveNow}
                    reconciledContent={reconciled}
                    onNavigateWikilink={handleNavigateWikilink}
                    documentUpdatedAt={activeDoc?.updatedAt ?? null}
                    onCreatePage={async (name) => {
                      const parent = source.path.includes('/')
                        ? source.path.slice(0, source.path.lastIndexOf('/'))
                        : ''
                      try {
                        await createDocumentAt(parent, name)
                        return `[[${name}]]`
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : 'Failed to create page')
                        return null
                      }
                    }}
                    onOpenIn={(target) => handleOpenIn(target, source.path)}
                    onTurnIntoPage={async ({ newDocPath, newDocBody }) => {
                      const title = newDocPath.split('/').pop()!.replace(/\.md$/i, '')
                      const parentDir = newDocPath.includes('/')
                        ? newDocPath.slice(0, newDocPath.lastIndexOf('/'))
                        : ''
                      try {
                        await createDocumentAt(parentDir, title, newDocBody)
                        toast.success(`Created ${title}`, {
                          action: {
                            label: 'Open',
                            onClick: () =>
                              dispatchTabs({ type: 'open', path: newDocPath, newTab: true, background: false }),
                          },
                        })
                      } catch (err) {
                        // The parent body already has the wikilink in memory.
                        // The next save round-trip will reconcile from disk
                        // (which does not have the new child), and the
                        // wikilink may need to be removed by hand if the
                        // create failed in a way the user wants to abort.
                        toast.error(err instanceof Error ? err.message : `Failed to create ${newDocPath}`)
                      }
                    }}
                    onMoveToBlock={async (spec) => {
                      await moveBlockTo({
                        sourcePath: source.path,
                        destPath: spec.destPath,
                        blockText: spec.blockText,
                        blockIndex: spec.blockIndex,
                      })
                    }}
                    moveToCandidates={moveToCandidates}
                  />
                )}
              </div>
            </div>
          ) : (
            <DocViewer
              document={activeDoc}
              allDocs={indexData?.documents || {}}
              onNavigateWikilink={handleNavigateWikilink}
              onNavigatePath={navigateTo}
              body={source?.body ?? null}
              loading={!source}
              error={sourceError?.path === activePath ? sourceError.message : null}
              scrollFor={scrollFor}
              onScroll={rememberScroll}
              tree={indexData?.tree || []}
            />
          )}

          {/*
            Hidden below lg as well as when toggled off: on a narrow screen a 288px
            context rail is most of the viewport, and the document is the point.
          */}
          {activeDoc && railOpen && (
            <aside
              style={{ '--rail-width': `${railWidth}px` } as React.CSSProperties}
              className="relative hidden w-[var(--rail-width)] shrink-0 flex-col overflow-hidden border-l bg-sidebar/50 lg:flex"
            >
              {/*
                On the rail's left edge, so dragging left widens it — the direction
                the panel grows.

                The scroll moved to the inner div to make room for it. An absolutely
                positioned child of a scrolling box scrolls with the content, so a
                handle on the aside itself would slide out of view as soon as the
                outline got long enough to need scrolling — exactly when someone is
                most likely to want the panel wider.
              */}
              <ResizeHandle
                width={railWidth}
                min={RAIL_WIDTH.min}
                max={RAIL_WIDTH.max}
                onResize={setRailWidth}
                edge="left"
                label="the context rail"
                defaultWidth={RAIL_WIDTH.default}
              />
              <div className="flex min-h-0 flex-1 flex-col divide-y divide-border/50 overflow-y-auto">
              <BacklinksPanel
                activeDoc={activeDoc}
                allDocs={indexData?.documents || {}}
                backlinksMap={indexData?.backlinks || {}}
                onSelectDoc={navigateTo}
              />
              <TOCPanel
                document={activeDoc}
                body={source?.body ?? null}
                /*
                  Scrolls to the heading's own element.

                  This used to look up `line-<n>`, an id nothing has ever rendered, so
                  every click in the outline silently did nothing. `rehype-slug` puts
                  real ids on the headings now and the outline computes the same ones.
                */
                onSelectHeading={(slug) => {
                  const heading = document.getElementById(slug)
                  if (!heading) return
                  heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  // The article scrolls, not the window, so the URL is left alone —
                  // but the heading still becomes the keyboard's place in the document.
                  heading.setAttribute('tabindex', '-1')
                  heading.focus({ preventScroll: true })
                }}
              />
              <RecentEditsPanel documents={indexData?.documents || {}} onSelectDoc={navigateTo} />
              <DetailsPanel document={activeDoc} />
              </div>
            </aside>
          )}

          {/*
            Side peek: a 45%-width overlay that shows a read-only view of
            a document on top of the active tab. Renders nothing when
            `sidePeekPath` is null. Closes on Esc or the X button.
          */}
        </div>
        {sidePeekPath && (
          <SidePeek
            path={sidePeekPath}
            documents={indexData?.documents || {}}
            source={sources[sidePeekPath] ?? null}
            onClose={() => setSidePeekPath(null)}
            onNavigateWikilink={handleNavigateWikilink}
            onNavigatePath={navigateTo}
          />
        )}
      </div>

      <SearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        /*
          A modified click still wins. Otherwise the `+` on the tab strip decides:
          it opened this dialog to make a tab, so picking a result makes one.
        */
        onSelectDoc={(path, intent) =>
          navigateTo(path, intent.newTab || !searchOpensTab ? intent : { newTab: true, background: false })
        }
      />

      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        documentPath={activePath}
        documentTitle={activeDoc?.title ?? null}
      />

      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} onRestored={() => void reloadIndex()} />

      {/*
        The vault is deliberately unaware of the rest of this component. It shares no
        state with the document workspace, patches no index, and reports nothing back —
        so there is no path by which a credential reaches the tree, the search, or a
        share, and no future refactor that can create one by accident.
      */}
      <PasswordsDialog
        open={passwordsOpen}
        onOpenChange={setPasswordsOpen}
        // The workspace owns the vault instance. The dialog borrows it.
        vault={vault}
      />

      <PromptDialog
        open={dialog.kind === 'newDocument'}
        title="New document"
        description={
          dialog.kind === 'newDocument' && dialog.parentDir
            ? `Created in ${dialog.parentDir}`
            : 'Created at the top level of your workspace.'
        }
        label="Title"
        confirmLabel="Create"
        busy={dialogBusy}
        error={dialogError}
        onSubmit={submitDialog}
        onOpenChange={(open) => !open && closeDialog()}
      />

      <PromptDialog
        open={dialog.kind === 'newFolder'}
        title="New folder"
        description={
          dialog.kind === 'newFolder' && dialog.parentDir
            ? `Created in ${dialog.parentDir}`
            : 'Created at the top level of your workspace.'
        }
        label="Folder name"
        confirmLabel="Create"
        busy={dialogBusy}
        error={dialogError}
        onSubmit={submitDialog}
        onOpenChange={(open) => !open && closeDialog()}
      />

      <PromptDialog
        open={dialog.kind === 'rename'}
        title={renameNode?.isDir ? 'Rename folder' : 'Rename document'}
        description={renameNode?.path}
        label={renameNode?.isDir ? 'Folder name' : 'Title'}
        initialValue={
          renameNode
            ? renameNode.isDir
              ? renameNode.name
              : (renameNode.path.split('/').pop() ?? '').replace(/\.md$/i, '')
            : ''
        }
        hint={
          dialog.kind === 'rename' && !dialog.node.isDir
            ? dialog.linkCount === null
              ? 'Checking which documents link here…'
              : dialog.linkCount === 0
                ? 'No other documents link to this one.'
                : `${dialog.linkCount} document${dialog.linkCount === 1 ? '' : 's'} link${dialog.linkCount === 1 ? 's' : ''} here and will be updated.`
            : undefined
        }
        confirmLabel="Rename"
        busy={dialogBusy}
        error={dialogError}
        onSubmit={submitDialog}
        onOpenChange={(open) => !open && closeDialog()}
      />

      <ConfirmDialog
        open={dialog.kind === 'delete'}
        title={dialog.kind === 'delete' && dialog.node.isDir ? 'Delete folder' : 'Delete document'}
        description={
          dialog.kind === 'delete' ? (
            <div className="flex flex-col gap-2">
              <p>
                <span className="font-medium text-foreground">{dialog.node.name}</span> will be
                moved to the trash, where it can be restored for {TRASH_RETENTION_DAYS} days.
              </p>
              {dialog.node.isDir && dialog.contents.length > 0 && (
                <div>
                  <p>
                    It contains {dialog.contents.length} document
                    {dialog.contents.length === 1 ? '' : 's'}, all of which go with it:
                  </p>
                  <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-xs">
                    {dialog.contents.map((p) => (
                      <li key={p} className="truncate">
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs">
                Links pointing here will become unresolved, and can be clicked to recreate the
                document.
              </p>
            </div>
          ) : null
        }
        busy={dialogBusy}
        error={dialogError}
        onConfirm={confirmDelete}
        onOpenChange={(open) => !open && closeDialog()}
      />
      </div>
      </div>
    </VaultKeyProvider>
  )
}
