'use client'

import { useEffect, useState } from 'react'
import { FileText, Folder, Loader2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import * as api from '@/lib/workspace-api'
import { TRASH_RETENTION_DAYS, type TrashEntry } from '@/lib/trash'

/**
 * Recover deleted documents.
 *
 * The undo toast covers the misclick you notice immediately. This covers the one you
 * notice on Thursday — which is the case that actually loses work, and the reason a
 * confirm dialog was never a recovery story.
 *
 * There is no "delete permanently" button here on purpose. Purging is by retention
 * window only; a control that destroys a recoverable document would reintroduce the
 * exact failure this feature removes.
 */

interface TrashDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a restore, so the workspace can pick the documents back up. */
  onRestored: () => void
}

function whenDeleted(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'unknown'

  const minutes = Math.floor((Date.now() - at.getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

export function TrashDialog({ open, onOpenChange, onRestored }: TrashDialogProps) {
  const [entries, setEntries] = useState<TrashEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false

    // Every state update stays inside a promise callback — the same shape
    // share-dialog.tsx uses, because a synchronous setState from an effect is a
    // lint error and a needless extra render.
    api
      .listTrash()
      .then(({ entries: list }) => {
        if (cancelled) return
        setEntries(list)
        setError(null)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open])

  const restore = async (entry: TrashEntry) => {
    setRestoring(entry.id)
    setError(null)
    try {
      const result = await api.restoreFromTrash(entry.id)
      setEntries((prev) => (result.skipped.length === 0 ? prev.filter((e) => e.id !== entry.id) : prev))
      onRestored()

      if (result.skipped.length > 0) {
        // Never silently: a partial restore means something is still only in the
        // trash, and the user is the one who has to decide what to do about it.
        toast.warning(
          `Restored ${result.restored.length}. Left in the trash because something already exists at that path: ${result.skipped.join(', ')}`,
          { duration: 12000 }
        )
      } else {
        toast.success(`Restored ${entry.label}`)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Trash</DialogTitle>
          <DialogDescription>
            Deleted documents are kept for {TRASH_RETENTION_DAYS} days. They are not in your
            workspace, your search, or any share link while they are here.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : entries.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            Nothing has been deleted.
          </p>
        ) : (
          <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2.5">
                {entry.kind === 'folder' ? (
                  <Folder className="size-4 shrink-0 text-(--icon-neutral)" />
                ) : (
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                )}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{entry.label}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {entry.path}
                    {entry.kind === 'folder' &&
                      ` · ${entry.files.length} document${entry.files.length === 1 ? '' : 's'}`}
                    {` · ${whenDeleted(entry.deletedAt)}`}
                  </p>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  disabled={restoring !== null}
                  onClick={() => void restore(entry)}
                >
                  {restoring === entry.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Undo2 className="size-3.5" />
                  )}
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
