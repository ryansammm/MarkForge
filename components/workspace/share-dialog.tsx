'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, Clock, Copy, FileText, Folder, Link2, Loader2, Lock, Trash2 } from 'lucide-react'
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
import { shareUrl, type ShareSummary } from '@/lib/share'
import { cn } from '@/lib/utils'

/**
 * Create and manage share links.
 *
 * The manage list is not decoration — a share link has no expiry and cannot be
 * un-sent, so the only way to stay in control of what is public is to be able to
 * see every live link and switch any of them off.
 */

interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Path of the document currently open, if any. */
  documentPath: string | null
  documentTitle: string | null
}

export function ShareDialog({ open, onOpenChange, documentPath, documentTitle }: ShareDialogProps) {
  const [shares, setShares] = useState<ShareSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState<'document' | 'subtree' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Options applied to the next link created. Deliberately not editable afterwards:
  // changing the expiry of a link already sent is a different, more surprising act
  // than revoking it and sending a new one.
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null)
  const [password, setPassword] = useState('')
  /** When the list was last fetched. Zero until it has been. */
  const [loadedAt, setLoadedAt] = useState(0)

  const folderPath =
    documentPath && documentPath.includes('/')
      ? documentPath.slice(0, documentPath.lastIndexOf('/'))
      : null

  // No setState before the first await, so opening the dialog does not trigger a
  // synchronous state update from inside an effect.
  const refresh = useCallback(async () => {
    try {
      const { shares: list } = await api.listShares()
      setShares(list)
      setLoadedAt(Date.now())
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Inlined rather than calling refresh(): every state update has to be visibly
  // inside a promise callback, or the effect counts as updating state synchronously.
  useEffect(() => {
    if (!open) return
    let cancelled = false

    api
      .listShares()
      .then(({ shares: list }) => {
        if (cancelled) return
        setShares(list)
        setLoadedAt(Date.now())
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

  const create = useCallback(
    async (scope: 'document' | 'subtree') => {
      const target = scope === 'document' ? documentPath : folderPath
      if (!target) return

      setCreating(scope)
      setError(null)
      try {
        const { share } = await api.createShare(target, scope, {
          ...(expiresInDays ? { expiresInDays } : {}),
          ...(password ? { password } : {}),
        })
        await refresh()
        const url = shareUrl(window.location.origin, share.token)
        await navigator.clipboard.writeText(url).catch(() => undefined)
        setCopied(share.token)
        setPassword('')
        toast.success(
          share.hasPassword ? 'Protected link created and copied' : 'Share link created and copied',
          {
            description: share.hasPassword
              ? 'Send the password separately — a link and its password in the same message protect nothing.'
              : url,
          }
        )
        setTimeout(() => setCopied(null), 2000)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setCreating(null)
      }
    },
    [documentPath, folderPath, refresh, expiresInDays, password]
  )

  const copy = useCallback(async (token: string) => {
    const url = shareUrl(window.location.origin, token)
    await navigator.clipboard.writeText(url).catch(() => undefined)
    setCopied(token)
    toast.success('Link copied')
    setTimeout(() => setCopied(null), 2000)
  }, [])

  const revoke = useCallback(
    async (share: ShareSummary) => {
      try {
        await api.revokeShare(share.token)
        await refresh()
        toast.success(`"${share.label}" is no longer shared`, {
          description: 'Anyone opening the old link now sees "Not found".',
        })
      } catch (err) {
        toast.error((err as Error).message)
      }
    },
    [refresh]
  )

  // Expired links are not live, and they are not revoked either. Grouping them with
  // revoked ones says the true thing: they no longer work.
  //
  // `loadedAt` rather than Date.now() in render: reading the clock while rendering is
  // impure, and the display only has to be accurate as of when the list was fetched.
  // The server is the authority on whether a link still works, in any case.
  const hasExpired = (share: ShareSummary) =>
    Boolean(loadedAt && share.expiresAt && Date.parse(share.expiresAt) <= loadedAt)

  const live = shares.filter((s) => s.revokedAt === null && !hasExpired(s))
  const revoked = shares.filter((s) => s.revokedAt !== null || hasExpired(s))

  const expiryLabel = (share: ShareSummary) => {
    if (!share.expiresAt || !loadedAt) return null
    const at = Date.parse(share.expiresAt)
    if (Number.isNaN(at)) return 'expiry unreadable'
    const days = Math.ceil((at - loadedAt) / (24 * 60 * 60 * 1000))
    if (days <= 0) return 'expired'
    return days === 1 ? 'expires tomorrow' : `expires in ${days} days`
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
          <DialogDescription>
            Anyone with the link can read, with no sign-in — unless you give the link an expiry
            or a password below.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          <Button
            type="button"
            variant="outline"
            className="justify-start"
            disabled={!documentPath || creating !== null}
            onClick={() => void create('document')}
          >
            {creating === 'document' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileText className="size-3.5" />
            )}
            Share this document
            {documentTitle && <span className="truncate opacity-60">— {documentTitle}</span>}
          </Button>

          <Button
            type="button"
            variant="outline"
            className="justify-start"
            disabled={!folderPath || creating !== null}
            onClick={() => void create('subtree')}
          >
            {creating === 'subtree' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Folder className="size-3.5" />
            )}
            {folderPath ? `Share the folder "${folderPath}"` : 'Share folder (document is at the top level)'}
          </Button>

          <p className="px-1 text-xs text-muted-foreground">
            Sharing a folder keeps links between its documents clickable. Links pointing outside
            it render as plain text, never as broken links.
          </p>

          <div className="mt-1 flex flex-col gap-2 rounded-lg border bg-muted/30 p-2.5">
            <div className="flex items-center gap-2">
              <Clock className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Expires</span>
              <div className="ml-auto flex gap-1">
                {[
                  { label: 'Never', value: null },
                  { label: '7 days', value: 7 },
                  { label: '30 days', value: 30 },
                ].map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => setExpiresInDays(option.value)}
                    className={cn(
                      'rounded-md border px-2 py-1 text-xs transition-colors',
                      expiresInDays === option.value
                        ? 'border-primary bg-primary/10 font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2">
              <Lock className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Optional"
                autoComplete="new-password"
                className="ml-auto w-40 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
              />
            </label>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              These apply to the next link you create. An existing link cannot be changed — revoke
              it and make a new one, so nobody is holding a link whose rules moved under them.
            </p>
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Link2 className="size-3.5" />
            Active links ({live.length})
            {loading && <Loader2 className="size-3 animate-spin" />}
          </div>

          {live.length === 0 && !loading && (
            <p className="py-2 text-xs text-muted-foreground">Nothing is shared right now.</p>
          )}

          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {live.map((share) => (
              <li
                key={share.token}
                className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-xs"
              >
                {share.scope === 'subtree' ? (
                  <Folder className="size-3.5 shrink-0 text-(--icon-neutral)" />
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{share.label}</span>
                    {share.hasPassword && (
                      <Lock
                        className="size-3 shrink-0 text-muted-foreground"
                        aria-label="Password protected"
                      />
                    )}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {share.path}
                    {expiryLabel(share) && ` · ${expiryLabel(share)}`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void copy(share.token)}
                  title="Copy link"
                  aria-label={`Copy link to ${share.label}`}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {copied === share.token ? (
                    <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void revoke(share)}
                  title="Stop sharing"
                  aria-label={`Stop sharing ${share.label}`}
                  className={cn(
                    'flex size-6 items-center justify-center rounded text-muted-foreground',
                    'hover:bg-destructive/10 hover:text-destructive'
                  )}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>

          {revoked.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {revoked.length} revoked link{revoked.length === 1 ? '' : 's'} — those URLs now
              return &ldquo;Not found&rdquo;.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
