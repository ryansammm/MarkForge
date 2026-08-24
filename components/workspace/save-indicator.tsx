'use client'

import { AlertTriangle, Check, CloudOff, Loader2, Pencil, RefreshCw } from 'lucide-react'
import type { SaveState } from '@/lib/use-document-save'
import { cn } from '@/lib/utils'

/**
 * Save state, stated plainly.
 *
 * "Saved" appears only for a write the server acknowledged. Everything else names
 * what is actually true — pending, in flight, or failed — because the failure mode
 * this guards against is a user trusting a green tick over a write that never landed.
 */

interface SaveIndicatorProps {
  state: SaveState
  onRetry: () => void
  /** Opens the conflict copy the server wrote, when a save was refused. */
  onOpenConflict?: (path: string) => void
}

function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** What a screen reader hears. Silence about a failed save is the worst outcome. */
function announcement(state: SaveState): string {
  switch (state.status) {
    case 'saving':
      return 'Saving'
    case 'saved':
      return 'Saved'
    case 'conflict':
      return state.conflictPath
        ? `Not saved. This file changed elsewhere. Your version was kept as ${state.conflictPath}.`
        : 'Not saved. This file changed elsewhere.'
    case 'failed':
      return `Save failed. ${state.error ?? ''}`
    default:
      return ''
  }
}

export function SaveIndicator({ state, onRetry, onOpenConflict }: SaveIndicatorProps) {
  const base = 'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors'

  /*
    The indicator is the only thing that ever says a save did not land, and until now
    it said it in colour and an icon. `assertive` rather than `polite` for the same
    reason: a failed save interrupts what you are doing, because continuing to type
    into a buffer that is not being written is the thing to prevent.
  */
  const live = (
    <span
      role="status"
      aria-live={state.status === 'failed' || state.status === 'conflict' ? 'assertive' : 'polite'}
      className="sr-only"
    >
      {announcement(state)}
    </span>
  )

  // The live region is rendered alongside whatever is on screen, once, rather than
  // repeated into every branch.
  return (
    <>
      {live}
      {visual(state, base, onRetry, onOpenConflict)}
    </>
  )
}

function visual(
  state: SaveState,
  base: string,
  onRetry: () => void,
  onOpenConflict?: (path: string) => void
) {
  if (state.status === 'saving') {
    return (
      <span className={cn(base, 'text-muted-foreground')}>
        <Loader2 className="size-3.5 animate-spin" />
        Saving…
      </span>
    )
  }

  if (state.status === 'dirty') {
    return (
      <span className={cn(base, 'text-muted-foreground')}>
        <Pencil className="size-3.5" />
        Unsaved
      </span>
    )
  }

  if (state.status === 'saved') {
    return (
      <span className={cn(base, 'text-emerald-600 dark:text-emerald-400')}>
        <Check className="size-3.5" />
        Saved
        {state.lastSavedAt && (
          <span className="font-normal opacity-60">{relativeTime(state.lastSavedAt)}</span>
        )}
      </span>
    )
  }

  if (state.status === 'conflict') {
    return (
      <span
        className={cn(base, 'bg-amber-500/10 text-amber-700 dark:text-amber-400')}
        title={state.error ?? undefined}
      >
        <AlertTriangle className="size-3.5" />
        Changed elsewhere — not saved
        {/*
          Naming the conflict copy is the difference between a refusal the user can
          act on and one that just reads as lost work. It is a real Markdown file
          beside the original, openable here or anywhere else.
        */}
        {state.conflictPath && (
          <span className="font-normal opacity-80">
            · your version is in{' '}
            <button
              type="button"
              onClick={() => onOpenConflict?.(state.conflictPath!)}
              className="font-mono underline underline-offset-2 hover:opacity-80"
            >
              {state.conflictPath.split('/').pop()}
            </button>
          </span>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 inline-flex items-center gap-1 rounded border border-current/30 px-1.5 py-0.5 hover:bg-current/10"
        >
          <RefreshCw className="size-3" />
          Overwrite
        </button>
      </span>
    )
  }

  if (state.status === 'failed') {
    const offline = typeof navigator !== 'undefined' && !navigator.onLine
    return (
      <span
        className={cn(base, 'bg-destructive/10 text-destructive')}
        title={state.error ?? undefined}
      >
        {offline ? <CloudOff className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
        {offline ? 'Offline — not saved' : 'Save failed'}
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 inline-flex items-center gap-1 rounded border border-current/30 px-1.5 py-0.5 hover:bg-current/10"
        >
          <RefreshCw className="size-3" />
          Retry
        </button>
      </span>
    )
  }

  return null
}
