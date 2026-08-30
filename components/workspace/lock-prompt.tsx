'use client'

import { useCallback, useState } from 'react'
import { Lock, Unlock } from 'lucide-react'
import { toast } from 'sonner'
import { verifyPassphrase } from '@/lib/lock/page-lock'
import { cn } from '@/lib/utils'

/**
 * Gate that replaces the editor when a page is locked.
 *
 * The body above the prompt stays visible (it is rendered by the
 * same `<MarkdownPreview>` that runs in the read-only "no edit
 * intent" path). The editor itself is not mounted while the lock
 * is closed, so even a hand-crafted `contenteditable` from a
 * browser extension cannot type into the document.
 *
 * The shake is a one-shot CSS animation, not a keyframe library,
 * because the project ships zero animation deps and the only
 * signal we want to send is "wrong passphrase". `data-state="bad"`
 * triggers the keyframe and is cleared as soon as the user types
 * again.
 */
export interface LockPromptProps {
  /** Lock object read from frontmatter. The prompt will not render if this is null. */
  lock: {
    kdf: 'PBKDF2-SHA256'
    salt: string
    iterations: number
    hash: string
  }
  /** Called with no arguments when the user types the right passphrase. */
  onUnlock: () => void
}

export function LockPrompt({ lock, onUnlock }: LockPromptProps) {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<'idle' | 'bad'>('idle')

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (busy) return
      if (!passphrase) {
        setState('bad')
        return
      }
      setBusy(true)
      try {
        const ok = await verifyPassphrase(passphrase, lock)
        if (ok) {
          onUnlock()
          return
        }
        setState('bad')
        setPassphrase('')
      } catch (err) {
        toast.error((err as Error).message || 'Could not verify passphrase.')
        setState('bad')
      } finally {
        setBusy(false)
      }
    },
    [busy, lock, onUnlock, passphrase]
  )

  return (
    <form
      onSubmit={submit}
      // The keyframe only runs while `data-state="bad"`. Toggling back
      // to `"idle"` on each keystroke is what stops the shake and lets
      // the next wrong attempt shake again.
      data-state={state}
      className={cn(
        'my-6 flex flex-col items-center gap-3 rounded-lg border bg-card p-6 text-center shadow-sm',
        // Inline animation so we don't add a CSS file or a keyframe lib.
        // 0.4s ≈ 6 small horizontal nudges, which is the conventional
        // "wrong password" feel without being theatrical.
        'data-[state=bad]:[animation:lock-shake_0.4s_ease-in-out]'
      )}
    >
      <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Lock className="size-4" aria-hidden />
      </span>
      <div className="space-y-1">
        <h3 className="text-sm font-medium">This page is locked</h3>
        <p className="text-xs text-muted-foreground">
          Type the passphrase to edit. Reading stays available.
        </p>
      </div>
      <input
        type="password"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={passphrase}
        onChange={(event) => {
          setPassphrase(event.target.value)
          if (state === 'bad') setState('idle')
        }}
        placeholder="Passphrase"
        className="w-full max-w-xs rounded-md border bg-background px-3 py-1.5 text-sm outline-none ring-primary/20 placeholder:text-muted-foreground focus:border-primary focus:ring-2"
      />
      <button
        type="submit"
        disabled={busy || !passphrase}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        <Unlock className="size-3.5" aria-hidden />
        {busy ? 'Checking…' : 'Unlock'}
      </button>
    </form>
  )
}
