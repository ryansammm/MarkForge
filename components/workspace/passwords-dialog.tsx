'use client'

import { useCallback, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordItemForm } from './password-item-form'
import { useVault } from '@/lib/vault/use-vault'
import { CLIPBOARD_CLEAR_SECONDS, copySecret } from '@/lib/vault/clipboard'
import {
  filterItems,
  removeItem,
  sortItems,
  upsertItem,
  type VaultItem,
  type VaultItemDraft,
} from '@/lib/vault/items'
import { cn } from '@/lib/utils'

/**
 * The password manager.
 *
 * A dialog rather than a route, for one reason that is not cosmetic: a route is a URL,
 * a URL is a thing browsers restore on startup and put in history, and the last thing
 * this feature needs is a deep link that reopens the vault screen. It also keeps the
 * vault's lock state tied to a component that unmounts when it is closed.
 *
 * Four screens, and which one shows is driven entirely by `useVault`:
 *
 *   absent      → set a master password (with the warning that nothing can recover it)
 *   locked      → unlock
 *   unlocked    → list, search, add, edit, delete, copy
 *   unavailable → the record could not be read; do not offer to create a new one
 *
 * The last one matters more than it looks. Offering "create a vault" over an
 * unreadable record is how a damaged file becomes a destroyed one.
 */

interface PasswordsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Pane = { kind: 'list' } | { kind: 'add' } | { kind: 'edit'; item: VaultItem }

const PANEL_ERROR = 'rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive'

export function PasswordsDialog({ open, onOpenChange }: PasswordsDialogProps) {
  const vault = useVault(open)

  const [pane, setPane] = useState<Pane>({ kind: 'list' })
  const [query, setQuery] = useState('')
  const [revealedId, setRevealedId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<VaultItem | null>(null)

  const [masterPassword, setMasterPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const items = useMemo(
    () => (vault.data ? sortItems(filterItems(vault.data.items, query)) : []),
    [vault.data, query]
  )

  /**
   * Clears every secret this component is holding, then closes.
   *
   * Secrets only. The search box, the open pane and the revealed row are *not* reset
   * here, and that is the whole point: the dialog animates out over ~100ms and stays
   * mounted for it, so clearing the query on the way down re-ran the filter and
   * flashed the entire vault on screen — every name and site the search was hiding —
   * in the last frames before it disappeared.
   *
   * Those four are reset on the way *in* instead (see below), which is the only
   * moment nobody can see the list change.
   */
  const close = useCallback(() => {
    setMasterPassword('')
    setConfirmPassword('')
    setFormError(null)
    onOpenChange(false)
  }, [onOpenChange])

  /**
   * Resets the view when the dialog opens.
   *
   * Adjusted during render rather than in an effect, so it lands before the browser
   * paints and the vault never opens showing the previous session's search for a
   * frame. React re-runs this component immediately when it sees a set during render;
   * nothing else has rendered yet, so there is nothing to tear.
   */
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQuery('')
      setPane({ kind: 'list' })
      setRevealedId(null)
      setPendingDelete(null)
    }
  }

  const lockNow = useCallback(() => {
    setRevealedId(null)
    setQuery('')
    setPane({ kind: 'list' })
    setPendingDelete(null)
    vault.lock()
  }, [vault])

  const submitMasterPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setFormError(null)

    try {
      if (vault.status === 'absent') {
        if (masterPassword.length < 12) {
          setFormError('Use at least 12 characters. This is the only thing protecting the vault.')
          return
        }
        if (masterPassword !== confirmPassword) {
          setFormError('The two passwords do not match.')
          return
        }
        await vault.create(masterPassword)
      } else {
        await vault.unlock(masterPassword)
      }
      // Cleared the moment it is no longer needed. The derived key lives on; the
      // password itself has no reason to stay in a React state slot.
      setMasterPassword('')
      setConfirmPassword('')
    } catch (err) {
      setFormError((err as Error).message)
    }
  }

  const saveItem = async (draft: VaultItemDraft) => {
    if (!vault.data) return
    const id = pane.kind === 'edit' ? pane.item.id : undefined
    const { data } = upsertItem(vault.data, draft, { id })

    try {
      await vault.commit(data)
      setPane({ kind: 'list' })
      toast.success(id ? 'Password updated' : 'Password added')
    } catch {
      // Kept on screen: `commit` has already put the change into the open vault, and
      // the conflict banner below is what the user acts on. Closing the form here
      // would hide the thing they just typed behind an error about something else.
    }
  }

  const confirmDelete = async () => {
    if (!vault.data || !pendingDelete) return
    const target = pendingDelete
    try {
      await vault.commit(removeItem(vault.data, target.id))
      setPendingDelete(null)
      toast.success(`Deleted ${target.name}`)
    } catch {
      // Same as saveItem: the error is already on screen.
    }
  }

  const copy = async (value: string, label: string) => {
    try {
      await copySecret(value)
      toast.success(`${label} copied — the clipboard clears in ${CLIPBOARD_CLEAR_SECONDS}s`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            Passwords
          </DialogTitle>
          <DialogDescription>
            {vault.status === 'unlocked'
              ? 'Unlocked in this tab only. It locks itself after 15 minutes, when this tab goes to the background, and on every reload.'
              : 'A separate vault, encrypted in your browser. Morrow stores it without being able to read it.'}
          </DialogDescription>
        </DialogHeader>

        {vault.status === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking for a vault…
          </div>
        )}

        {vault.status === 'unavailable' && (
          <div className="flex flex-col gap-2 py-6">
            <p className={PANEL_ERROR}>{vault.error}</p>
            <p className="text-xs text-muted-foreground">
              Nothing has been changed. If the record is damaged, restore it from a backup
              (<code className="font-mono">npm run backup -- --restore &lt;dir&gt;</code>) before
              using the vault again — creating a new one here would replace it.
            </p>
          </div>
        )}

        {(vault.status === 'absent' || vault.status === 'locked') && (
          <form onSubmit={submitMasterPassword} className="flex flex-col gap-3 py-2">
            {vault.lockedReason && (
              <p className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                <Lock className="size-3.5 shrink-0" />
                {vault.lockedReason}
              </p>
            )}

            {vault.status === 'absent' && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                <p>
                  <span className="font-medium">There is no way to recover this password.</span> The
                  key never leaves your browser, so Morrow cannot reset it, read your vault, or help
                  you back in. Write it down somewhere safe before you continue.
                </p>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="master-password">
                Master password
              </label>
              <Input
                id="master-password"
                type="password"
                value={masterPassword}
                onChange={(e) => setMasterPassword(e.target.value)}
                autoFocus
                autoComplete="off"
                required
              />
            </div>

            {vault.status === 'absent' && (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="confirm-password">
                  Confirm master password
                </label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="off"
                  required
                />
              </div>
            )}

            {formError && <p className={PANEL_ERROR}>{formError}</p>}

            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                Not your Morrow sign-in password. Deriving the key takes a moment on purpose.
              </p>
              <Button type="submit" disabled={vault.busy}>
                {vault.busy && <Loader2 className="animate-spin" />}
                {vault.status === 'absent' ? 'Create vault' : 'Unlock'}
              </Button>
            </div>
          </form>
        )}

        {vault.status === 'unlocked' && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {vault.conflict && (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
                <p>
                  <span className="font-medium">This vault changed somewhere else.</span>{' '}
                  {vault.conflict.message} Your change is still here and has not been saved yet.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={vault.busy}
                    onClick={() => void vault.resolveConflict('merge').catch(() => undefined)}
                  >
                    Merge and save
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={vault.busy}
                    onClick={() => void vault.resolveConflict('overwrite').catch(() => undefined)}
                  >
                    Keep this copy
                  </Button>
                </div>
              </div>
            )}

            {vault.saveError && <p className={PANEL_ERROR}>{vault.saveError}</p>}

            {pane.kind === 'list' ? (
              <>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search names, usernames, sites and tags"
                      className="pl-8"
                      aria-label="Search the vault"
                    />
                  </div>
                  <Button size="sm" onClick={() => setPane({ kind: 'add' })}>
                    <Plus />
                    Add
                  </Button>
                  <Button size="sm" variant="outline" onClick={lockNow} title="Lock the vault">
                    <Lock />
                    Lock
                  </Button>
                </div>

                {items.length === 0 ? (
                  <p className="py-10 text-center text-xs text-muted-foreground">
                    {vault.data?.items.length === 0
                      ? 'Nothing saved yet. Add your first credential.'
                      : 'Nothing matches that search.'}
                  </p>
                ) : (
                  <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
                    {items.map((item) => (
                      <li key={item.id} className="flex items-center gap-3 py-2.5">
                        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />

                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{item.name}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {item.username || 'no username'}
                            {item.url ? ` · ${item.url}` : ''}
                            {item.tags?.length ? ` · ${item.tags.join(', ')}` : ''}
                          </p>
                          {revealedId === item.id && (
                            <p className="mt-1 truncate rounded bg-muted px-1.5 py-1 font-mono text-xs">
                              {item.password}
                            </p>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-0.5">
                          {item.username && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              title="Copy username"
                              aria-label={`Copy the username for ${item.name}`}
                              onClick={() => void copy(item.username!, 'Username')}
                            >
                              <Copy />
                            </Button>
                          )}
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="Copy password"
                            aria-label={`Copy the password for ${item.name}`}
                            onClick={() => void copy(item.password, 'Password')}
                          >
                            <KeyRound />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title={revealedId === item.id ? 'Hide password' : 'Show password'}
                            aria-label={`${revealedId === item.id ? 'Hide' : 'Show'} the password for ${item.name}`}
                            onClick={() =>
                              setRevealedId((prev) => (prev === item.id ? null : item.id))
                            }
                          >
                            {revealedId === item.id ? <EyeOff /> : <Eye />}
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="Edit"
                            aria-label={`Edit ${item.name}`}
                            onClick={() => setPane({ kind: 'edit', item })}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="hover:text-destructive"
                            title="Delete"
                            aria-label={`Delete ${item.name}`}
                            onClick={() => setPendingDelete(item)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {pendingDelete && (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs">
                    <p>
                      Delete <span className="font-medium">{pendingDelete.name}</span>? There is no
                      trash for the vault — this cannot be undone.
                    </p>
                    <span className="flex shrink-0 items-center gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setPendingDelete(null)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={vault.busy}
                        onClick={() => void confirmDelete()}
                      >
                        {vault.busy && <Loader2 className="animate-spin" />}
                        Delete
                      </Button>
                    </span>
                  </div>
                )}

                <p className={cn('text-[11px] text-muted-foreground')}>
                  {vault.data?.items.length ?? 0} item
                  {(vault.data?.items.length ?? 0) === 1 ? '' : 's'}
                  {vault.updatedAt ? ` · saved ${new Date(vault.updatedAt).toLocaleString()}` : ''}
                </p>
              </>
            ) : (
              <PasswordItemForm
                item={pane.kind === 'edit' ? pane.item : null}
                busy={vault.busy}
                onSubmit={(draft) => void saveItem(draft)}
                onCancel={() => setPane({ kind: 'list' })}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
