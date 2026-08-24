'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarkdownDocument, WriteResult } from './file-store'

/**
 * Debounced save with an honest state machine.
 *
 * The rule this hook exists to enforce: **"saved" is only ever shown for a write the
 * server acknowledged.** An optimistic indicator that reports success on send is
 * worse than no indicator, because it converts a visible failure into silent data
 * loss discovered days later.
 *
 * The buffer is never discarded on failure. A failed save leaves the text in the
 * editor, the error visible, and a retry available.
 */

export type SaveStatus =
  | 'idle' // no unsaved changes
  | 'dirty' // edited, debounce still running
  | 'saving' // request in flight
  | 'saved' // server acknowledged
  | 'failed' // write rejected or unreachable — buffer retained
  | 'conflict' // etag mismatch: the file changed underneath us

export interface SaveState {
  status: SaveStatus
  error: string | null
  lastSavedAt: Date | null
  /** Present when status is 'conflict' — the etag the file actually has now. */
  conflictEtag: string | null
  /**
   * Where the server preserved the refused content, when status is 'conflict'.
   *
   * The refusal is correct — the file on storage is somebody else's newer work — but
   * without this the user's only copy of what they typed is a browser buffer, and
   * "your save was refused" is a polite way to describe losing it.
   */
  conflictPath: string | null
}

export const SAVE_DEBOUNCE_MS = 500

/**
 * A write that has been decided on but not sent.
 *
 * Carries its own path and precondition rather than reading them from the hook's
 * refs at send time, because the two can disagree: the refs describe the document
 * that is open *now*, and this describes the one the text was typed into.
 */
interface PendingWrite {
  path: string
  content: string
  /**
   * The `If-Match` to send. Present only for a chained write, where it is the etag
   * the previous write in the chain returned — the only value the server will accept
   * by then, and one the hook's own `etagRef` may never have been told about.
   */
  etag?: string
}

interface UseDocumentSaveOptions {
  path: string | null
  /** Etag of the loaded document, as read from the server. */
  initialEtag: string | undefined
  /**
   * Called after a write lands, so the index in memory can be patched.
   *
   * `content` is what is now on the server — the buffer that was sent, or the
   * server's own version of it when it wrote something different. Passed rather than
   * read back off this hook, because this fires for writes the editor has already
   * moved on from, and by then the buffer belongs to another document.
   */
  onSaved?: (result: WriteResult, content: string) => void
  /**
   * Called when the server wrote something different from what was sent — today,
   * an `id` injected into frontmatter on first save (R7).
   *
   * The editor must apply this to its buffer. If it does not, the next save sends
   * the pre-injection text back, the id is stripped, and a fresh one is assigned on
   * every save forever.
   */
  onContentReconciled?: (content: string) => void
  /**
   * Called when a write is refused because the file changed underneath, with the path
   * it was refused for.
   *
   * Reported separately from `state` because `state` only ever describes the document
   * on screen. A conflict raised for a document the user has already switched away
   * from would otherwise be dropped without a trace — see the 409 branch below.
   */
  onConflict?: (path: string) => void
}

interface UseDocumentSaveResult {
  state: SaveState
  /** Records an edit and (re)starts the debounce. */
  scheduleSave: (content: string) => void
  /** Saves immediately, bypassing the debounce. */
  saveNow: () => Promise<void>
  /** Retries after a failure, using the buffer still held here. */
  retry: () => Promise<void>
  /** True when the buffer differs from what the server has acknowledged. */
  hasUnsavedChanges: boolean
  /**
   * The text currently in the editor, or null before anything is typed.
   *
   * Exposed because the caller needs it to keep the reading view in step with a
   * save: what landed on the server is the buffer, and `WriteResult.content` is only
   * populated when the server wrote something *different*. One buffer, one owner —
   * the alternative was a second copy in the component, kept in sync by hand.
   */
  getBuffer: () => string | null
}

export function useDocumentSave({
  path,
  initialEtag,
  onSaved,
  onContentReconciled,
  onConflict,
}: UseDocumentSaveOptions): UseDocumentSaveResult {
  const [state, setState] = useState<SaveState>({
    status: 'idle',
    error: null,
    lastSavedAt: null,
    conflictEtag: null,
    conflictPath: null,
  })

  // Refs, not state: these are written from timers and async callbacks and must
  // never be a render behind.
  const bufferRef = useRef<string | null>(null)
  const savedContentRef = useRef<string | null>(null)
  const etagRef = useRef<string | undefined>(initialEtag)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef(false)
  /**
   * An edit that arrived while a write was in flight, captured with the path it
   * belongs to.
   *
   * The path and the text are captured here rather than re-read when the in-flight
   * write lands, and that is load-bearing. This used to be a bare "run again" flag,
   * and by the time it was acted on the buffer could already have been forgotten:
   * leaving the editor sets this hook's `path` to null, which resets the machine —
   * so pressing Read within the debounce of a save that was already in flight sent
   * the older text, dropped the newer, and left the reading view showing a version
   * that never reached storage. The next visit to the editor then opened on the
   * older text and the last thing typed was simply gone.
   */
  const pendingRef = useRef<PendingWrite | null>(null)
  const pathRef = useRef(path)
  /**
   * Set while a write is refused and the refusal has not been dealt with.
   *
   * A conflict is a decision, not a transient error, and until it is made every
   * further PUT is refused for the same reason — and the server preserves the
   * refused text each time it refuses. Autosaving through a conflict therefore
   * produced a `.conflict.md` copy per debounce interval: a directory full of
   * near-identical files, one per few hundred milliseconds of typing.
   */
  const conflictRef = useRef(false)
  /** The latest `initialEtag`, for effects that must not re-run when it changes. */
  const latestEtagRef = useRef(initialEtag)
  const onSavedRef = useRef(onSaved)
  const onReconciledRef = useRef(onContentReconciled)
  const onConflictRef = useRef(onConflict)
  latestEtagRef.current = initialEtag
  onSavedRef.current = onSaved
  onReconciledRef.current = onContentReconciled
  onConflictRef.current = onConflict

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  // Opening a different document resets the machine. Any pending debounce belongs
  // to the previous file and must not fire against the new one.
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pathRef.current = path
    bufferRef.current = null
    savedContentRef.current = null
    etagRef.current = latestEtagRef.current
    // `pendingRef` is deliberately *not* cleared. It holds text that has already been
    // decided on, tagged with the document it belongs to, and this reset fires when
    // that document is closed — which is exactly when dropping it would lose work.
    conflictRef.current = false
    setHasUnsavedChanges(false)
    setState({ status: 'idle', error: null, lastSavedAt: null, conflictEtag: null, conflictPath: null })
  }, [path])

  /**
   * Adopts a new baseline etag without disturbing the buffer.
   *
   * This used to be part of the reset above, which listed `initialEtag` alongside
   * `path` — so every successful save reset the machine, because a save is exactly
   * what changes the caller's etag. A keystroke that arrived while that save was in
   * flight was left in a buffer the machine had just been told to forget, and the
   * pending debounce then found nothing to send. The edit stayed on screen and never
   * reached storage.
   *
   * A changed etag means the document was re-read and is different on disk; that is a
   * new baseline for the next write, and nothing more. When it is merely our own save
   * coming back it already equals `etagRef` and this does nothing.
   */
  useEffect(() => {
    if (initialEtag === undefined || initialEtag === etagRef.current) return
    // A write in flight is about to produce the only etag that matters.
    if (inFlightRef.current) return
    etagRef.current = initialEtag
  }, [initialEtag])

  /**
   * Sends the buffer, or an explicitly captured write.
   *
   * With no argument it reads what is open now — the debounce, `saveNow`, `retry`.
   * With one, it sends that exact text to that exact path, which is how a write
   * coalesced during another one still reaches storage after the editor has closed.
   */
  const flush = useCallback(async (job?: PendingWrite): Promise<void> => {
    // A refused write stays refused until the conflict is resolved. `retry` clears
    // this; more typing does not.
    if (conflictRef.current) return

    const targetPath = job?.path ?? pathRef.current
    const content = job?.content ?? bufferRef.current

    if (!targetPath || content === null) return

    // Both checks are about the live buffer and mean nothing for a captured write:
    // it was already decided on, and it is being sent from inside the very write it
    // would otherwise coalesce into again.
    if (!job) {
      if (content === savedContentRef.current) return

      if (inFlightRef.current) {
        // Coalesce. Captured rather than left to be re-read, because the buffer may
        // not survive until the in-flight write lands — see `pendingRef`.
        pendingRef.current = { path: targetPath, content }
        return
      }
    }

    inFlightRef.current = true
    // Only when it describes what is on screen. A chained write can outlive the
    // editor, and "Saving…" for a document nobody has open is noise at best.
    if (pathRef.current === targetPath) {
      setState((prev) => ({ ...prev, status: 'saving', error: null }))
    }

    /** Set only on success: a failed write has no etag to chain from. */
    let chained: PendingWrite | null = null

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const ifMatch = job?.etag ?? etagRef.current
      if (ifMatch) headers['If-Match'] = `"${ifMatch}"`

      const response = await fetch(`/api/files?path=${encodeURIComponent(targetPath)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content }),
      })

      if (response.status === 409) {
        const body = (await response.json().catch(() => ({}))) as {
          actualEtag?: string
          error?: string
          conflictPath?: string
        }

        // Announced before the switched-away check below, and deliberately: a refused
        // save is the one response that still matters after the user has moved on.
        // The server kept what was typed at `conflictPath`, but nothing on screen
        // would say so, and this is how the tab it happened to gets marked.
        onConflictRef.current?.(targetPath)
        if (pathRef.current !== targetPath) return

        conflictRef.current = true
        setState({
          status: 'conflict',
          error: body.error ?? 'This file changed somewhere else since you opened it.',
          lastSavedAt: null,
          conflictEtag: body.actualEtag ?? null,
          conflictPath: body.conflictPath ?? null,
        })
        setHasUnsavedChanges(true)
        return
      }

      if (!response.ok) {
        // The document was switched while this was in flight — nothing landed, and
        // the failure is about a file that is no longer open.
        if (pathRef.current !== targetPath) return
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        const reason =
          response.status === 401
            ? 'Your session expired — sign in again to save.'
            : body.error ?? `Save failed (${response.status})`
        setState((prev) => ({ ...prev, status: 'failed', error: reason }))
        setHasUnsavedChanges(true)
        return
      }

      const result = (await response.json()) as WriteResult
      // The server may have written something other than what was sent. What is on
      // disk is what the buffer has to agree with, so that is what counts as saved.
      const persisted = result.content ?? content

      /*
        Announced before the switched-away check below, and this is the whole fix for
        the spurious conflict copies.

        This response carries the only etag the server will now accept, and `onSaved`
        is the one path by which it reaches the document cache. Dropping the whole
        response because the editor closed a moment ago — which is what leaving edit
        mode does, since it sets this hook's `path` to null — left the cache holding
        the etag from *before* the save. Nothing re-read the file, because a save that
        landed is by definition current, so the next edit of that document opened on
        that dead etag, its first autosave was refused as a conflict, and the server
        dutifully preserved the "rejected" text beside the document as a
        `.conflict.md` — a copy of work that was never in danger.

        Toggling Read/Edit with a debounce still pending was enough to trigger it.
      */
      onSavedRef.current?.(result, persisted)

      /*
        Claimed here, before the switched-away check below, for the same reason
        `onSaved` is announced there: this is work the user did, and whether it
        reaches storage cannot depend on which document happens to be on screen when
        the response lands. It is chained with the etag this write just produced —
        the only one the server will now accept, and one `etagRef` is about to be
        told about only if the editor is still open.
      */
      const pending = pendingRef.current
      if (pending && pending.path === targetPath && pending.content !== persisted) {
        pendingRef.current = null
        chained = { ...pending, etag: result.etag }
      }

      // Past here it is only the on-screen state, which belongs to whatever document
      // is open now.
      if (pathRef.current !== targetPath) return

      etagRef.current = result.etag
      savedContentRef.current = persisted

      if (result.content !== undefined && result.content !== content) {
        // Only reconcile when the buffer has not moved on; otherwise the user's
        // newer keystrokes would be thrown away to insert a frontmatter line.
        if (bufferRef.current === content) {
          bufferRef.current = result.content
          onReconciledRef.current?.(result.content)
        } else {
          // The buffer moved on. Leave it, but do not claim it is saved.
          savedContentRef.current = null
        }
      }

      const stillCurrent = bufferRef.current === savedContentRef.current
      setHasUnsavedChanges(!stillCurrent)
      setState({
        status: stillCurrent ? 'saved' : 'dirty',
        error: null,
        lastSavedAt: new Date(),
        conflictEtag: null,
        conflictPath: null,
      })
    } catch (err) {
      if (pathRef.current !== targetPath) return
      // Network unreachable. The buffer stays exactly where it is.
      setState((prev) => ({
        ...prev,
        status: 'failed',
        error:
          typeof navigator !== 'undefined' && !navigator.onLine
            ? 'You are offline — the change is still here and will save when you reconnect.'
            : `Could not reach the server: ${(err as Error).message}`,
      }))
      setHasUnsavedChanges(true)
    } finally {
      inFlightRef.current = false

      if (chained) {
        void flush(chained)
      } else if (pendingRef.current) {
        /*
          Something was coalesced but could not be chained — the write failed, so
          there is no etag to chain from, or what is pending belongs to a document
          this write was not for. Both are handled by starting over from the live
          refs, which by now describe whatever is actually open.

          Cleared first, so a write that keeps failing retries once and stops rather
          than looping against a server that is saying no.
        */
        pendingRef.current = null
        void flush()
      }
    }
  }, [])

  const scheduleSave = useCallback(
    (content: string) => {
      bufferRef.current = content

      if (content === savedContentRef.current) {
        setHasUnsavedChanges(false)
        setState((prev) => (prev.status === 'saved' ? prev : { ...prev, status: 'saved' }))
        return
      }

      setHasUnsavedChanges(true)
      setState((prev) =>
        // A conflict is not cleared by more typing — it needs a decision.
        prev.status === 'conflict' ? prev : { ...prev, status: 'dirty', error: null }
      )

      // ...and neither is it retried by more typing. The text is kept, the notice
      // stays up, and nothing is sent until `retry`. Rescheduling here meant every
      // keystroke bought another refusal and another preserved copy of it on disk.
      if (conflictRef.current) return

      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void flush()
      }, SAVE_DEBOUNCE_MS)
    },
    [flush]
  )

  const saveNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    await flush()
  }, [flush])

  const retry = useCallback(async () => {
    // The deliberate act that lifts the block in `flush`. Retrying a conflict sends
    // the buffer again with the etag the server reported, which is what "keep mine"
    // means; retrying a network failure just sends it again.
    conflictRef.current = false
    if (state.status === 'conflict' && state.conflictEtag) etagRef.current = state.conflictEtag
    setState((prev) => ({ ...prev, status: 'dirty', error: null }))
    await saveNow()
  }, [saveNow, state.status, state.conflictEtag])

  // A failed save should not stay failed forever once the network is back.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onOnline = () => {
      if (conflictRef.current) return
      if (bufferRef.current !== null && bufferRef.current !== savedContentRef.current) {
        void flush()
      }
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [flush])

  // Last line of defence against closing the tab on unsaved text.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (bufferRef.current !== null && bufferRef.current !== savedContentRef.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const getBuffer = useCallback(() => bufferRef.current, [])

  return { state, scheduleSave, saveNow, retry, hasUnsavedChanges, getBuffer }
}

/** Convenience for callers that only need a document's etag. */
export function documentEtag(doc: MarkdownDocument | null): string | undefined {
  return doc?.etag
}
