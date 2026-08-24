'use client'

import { useCallback, useEffect, useState, useMemo, useRef } from 'react'
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
import { Sidebar, SIDEBAR_WIDTH } from './sidebar'
import { ResizeHandle } from './resize-handle'
import { DocViewer } from './doc-viewer'
import { BacklinksPanel } from './backlinks-panel'
import { TOCPanel } from './toc-panel'
import { SearchDialog } from './search-dialog'
import { RecentEditsPanel } from './recent-edits-panel'
import { DetailsPanel } from './details-panel'
import { SaveIndicator } from './save-indicator'
import { TabStrip, documentLabel } from './tab-strip'
import { ConfirmDialog, PromptDialog } from './workspace-dialogs'
import { ShareDialog } from './share-dialog'
import { TrashDialog } from './trash-dialog'
import { PasswordsDialog } from './passwords-dialog'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { PwaInstallButton } from '@/components/pwa-install'
import { TRASH_RETENTION_DAYS } from '@/lib/trash'
import { usePersistedFlag, usePersistedSize } from '@/lib/use-persisted'
import { cn } from '@/lib/utils'

/** The context rail's width, and the range its handle can drag through. */
const RAIL_WIDTH = { default: 288, min: 220, max: 560 } as const

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
  const [loading, setLoading] = useState(true)
  /** Set when the backend reports that writes will not survive. Never dismissible. */
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  /** Drawer state below md. Closed by default so a phone opens on the document. */
  const [sidebarOpen, setSidebarOpen] = useState(false)
  /** Context rail, remembered across sessions and across tabs. */
  const [railOpen, setRailOpen] = usePersistedFlag('morrow:rail-open', true)
  /**
   * Panel widths, remembered the same way the rail's open state is.
   *
   * Both panels show truncated names — documents in one, backlinks and headings in
   * the other — and until now the only remedy for a title that did not fit was to
   * hover it. Being able to widen the panel is the direct fix; the tooltips added
   * alongside are what covers the names that are too long at any sensible width.
   */
  const [sidebarWidth, setSidebarWidth] = usePersistedSize(
    'morrow:sidebar-width',
    SIDEBAR_WIDTH.default,
    SIDEBAR_WIDTH
  )
  const [railWidth, setRailWidth] = usePersistedSize('morrow:rail-width', RAIL_WIDTH.default, RAIL_WIDTH)

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

  const router = useRouter()

  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' })
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const fileStore = useMemo(() => new StaticFileStore('/api/index'), [])

  /** Reading or editing, for the tab on screen. */
  const setMode = useCallback(
    (next: TabMode) => dispatchTabs({ type: 'setMode', mode: next }),
    [dispatchTabs]
  )

  useEffect(() => {
    async function loadWorkspaceData() {
      try {
        const index = await fileStore.getIndex()
        setIndexData(index)

        // Restored here rather than inside the hook because deciding what still
        // exists needs the index, and the index is this fetch. Documents deleted
        // since the last session are dropped on the way in.
        const restored = readStoredTabs((path) => path in index.documents)
        if (restored) {
          dispatchTabs({ type: 'restore', state: restored })
          return
        }

        const paths = Object.keys(index.documents)
        if (paths.length > 0) dispatchTabs({ type: 'open', path: paths[0] })
      } catch (err) {
        console.error('Failed to load workspace index:', err)
      } finally {
        setLoading(false)
      }
    }
    loadWorkspaceData()
  }, [fileStore, dispatchTabs])

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
      .then((health: { durable?: boolean; warning?: string }) => {
        if (cancelled || health.durable !== false) return
        setStorageWarning(
          health.warning ?? 'Storage is not durable on this deployment — edits may not survive.'
        )
      })
      .catch(() => {
        // A health check that cannot be reached is not itself a reason to alarm
        // anyone; the save indicator is what reports a save that does not land.
      })

    return () => {
      cancelled = true
    }
  }, [])

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

    api
      .readDocument(requestedPath)
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
      // On a phone the drawer is covering the thing you just chose to read — but a
      // background open is a request to stay where you are, drawer included.
      if (!intent.background) setSidebarOpen(false)
    },
    [flushPendingSave, dispatchTabs]
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

      const path = api.joinPath(parentDir, `${name}.md`)
      const result = await api.createDocument(path, body ?? api.newDocumentTemplate(name))

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
    [patchIndex, dispatchTabs, setMode, putSource]
  )

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
      closeDialog()
    } catch (err) {
      setDialogError((err as Error).message)
      setDialogBusy(false)
    }
  }, [dialog, patchIndex, closeDialog, undoDelete, dispatchTabs])

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

  // Sharing is an explicit act with an explicit token, handled in ShareDialog.
  // This used to build a URL from the document's title, which meant every note was
  // readable by anyone who could guess its name — see docs/sprint-6-share-model.md.

  if (loading) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-xs text-muted-foreground">Loading workspace index...</p>
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
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <Sidebar
        tree={indexData?.tree || []}
        activePath={activePath}
        onSelectFile={navigateTo}
        onOpenSearch={() => openSearch(false)}
        onCreateDocument={openNewDocument}
        onCreateFolder={openNewFolder}
        onRenameNode={openRename}
        onDeleteNode={openDelete}
        onOpenTrash={() => setTrashOpen(true)}
        onOpenPasswords={() => setPasswordsOpen(true)}
        onSignOut={() => void signOut()}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
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
          Above the header, not below it: the breadcrumb, the Edit button and the save
          indicator all describe the active tab, so the thing that chooses which tab
          that is has to come first.

          Hidden at one tab. A single-document session should not spend 36 pixels of
          height being told it has one document open.
        */}
        {tabs.length > 1 && (
          <TabStrip
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
        )}

        <header className="flex h-14 items-center justify-between gap-4 border-b px-6 bg-background/80 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2">
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

            {activeDoc && mode === 'read' && (
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
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {mode === 'edit' && activeDoc ? (
            <div className="flex-1 overflow-hidden px-8 py-6">
              <div className="mx-auto h-full max-w-3xl">
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
                ) : (
                  <MarkdownEditor
                    docPath={source.path}
                    initialValue={source.raw}
                    allDocs={indexData?.documents || {}}
                    onChange={scheduleSave}
                    onRequestSave={saveNow}
                    reconciledContent={reconciled}
                    onNavigateWikilink={handleNavigateWikilink}
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
              /*
                A cached body renders straight away, stale or not. Coming back to a
                tab should show the document, not a skeleton; the refetch behind it
                will replace the text if the file changed underneath.
              */
              body={source?.body ?? null}
              loading={!source}
              error={sourceError?.path === activePath ? sourceError.message : null}
              scrollFor={scrollFor}
              onScroll={rememberScroll}
            />
          )}

          {/*
            Hidden below lg as well as when toggled off: on a narrow screen a 288px
            context rail is most of the viewport, and the document is the point.
          */}
          {activeDoc && mode === 'read' && railOpen && (
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
        </div>
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
      <PasswordsDialog open={passwordsOpen} onOpenChange={setPasswordsOpen} />

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
  )
}
