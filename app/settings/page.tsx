'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, ArrowLeft, KeyRound, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useVault } from '@/lib/vault/use-vault'
import { Button } from '@/components/ui/button'
import { SettingsForm } from '@/components/workspace/settings-form'
import { PasswordsDialog } from '@/components/workspace/passwords-dialog'
import { cn } from '@/lib/utils'

/**
 * Settings page.
 *
 * Lives at `/settings` as a route, not a dialog, because the spec wants a
 * deep-linkable surface. The price is auth + vault gating on every render: a
 * tab someone bookmarked should not show a list of API keys to whoever opens
 * the link next.
 *
 * Two pieces, with two different gate stories:
 *
 *   - The App PIN card is independent of the vault — it is the same gate that
 *     the workspace already passed, and it should render even when there is no
 *     vault yet.
 *   - The SettingsForm (API keys, AI config) is the encrypted-vault UI and
 *     needs the vault unlocked. The same `PasswordsDialog` the workspace uses
 *     handles the create / unlock flow inline, so the page is not a hard
 *     redirect to /login for a missing master.
 *
 * Earlier the auth check was a `fetch('/api/health')`, which is intentionally
 * public — it answered 200 even when the session had expired, and a follow-up
 * vault fetch then bounced the user to /login. `/api/vault` is the same
 * request the vault hook makes, returns 401 when the session is gone, and
 * drives both the auth and the vault state from one network call.
 */
export default function SettingsPage() {
  const router = useRouter()
  const [authChecked, setAuthChecked] = useState(false)
  const [authed, setAuthed] = useState(false)
  const { theme, setTheme } = useTheme()
  /*
    The vault hook is gated on `active` — passing `false` here keeps the
    initial fetch from racing the auth check, then `authed=true` lets the
    hook fetch once we know the session is good.
  */
  const vault = useVault(authed)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/vault', { cache: 'no-store' })
        if (cancelled) return
        if (res.status === 401) {
          // Session gone — bounce to login. Anything else (200, 500) is an
          // authed user; vault hook can drive the rest.
          if (typeof window !== 'undefined') {
            window.location.replace(`/login?from=${encodeURIComponent('/settings')}`)
          }
          return
        }
        setAuthed(res.ok || res.status === 500)
      } catch {
        if (cancelled) return
        // Network failure — leave authChecked false so the spinner stays up
        // and the user can retry by reloading.
      } finally {
        if (!cancelled) setAuthChecked(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!authChecked) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span className="ml-2 text-sm">Loading…</span>
      </div>
    )
  }

  if (!authed) return null

  if (vault.status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span className="ml-2 text-sm">Opening vault…</span>
      </div>
    )
  }

  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-8 text-foreground">
      <header className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.push('/')}>
          <ArrowLeft className="size-3.5" />
          <span>Back to workspace</span>
        </Button>
        <h1 className="text-sm font-semibold tracking-tight">Settings</h1>
      </header>

      {/*
        The vault-gated section. The dialog appears the same way it does in
        the workspace, so an existing user can unlock from here without going
        back through the workspace. Renders nothing extra when the vault is
        already unlocked.
      */}
      {vault.status === 'unlocked' ? <SettingsForm vault={vault} /> : null}

      {/*
        Standalone unlock / create form. Renders when the vault exists but is
        locked, or has not been created yet. Skipped on `unavailable` (the
        record could not be read) so the form cannot offer to overwrite a
        damaged vault.
      */}
      {vault.status === 'locked' || vault.status === 'absent' ? (
        <PasswordsDialog
          open
          onOpenChange={() => {
            // The dialog sits inline; closing it just hides the form and
            // leaves the App PIN section (below) reachable.
          }}
          vault={vault}
        />
      ) : null}

      {vault.status === 'unavailable' ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          The vault could not be read. Try again, or restore from a backup.
        </div>
      ) : null}

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Sun className="size-5" />
          </div>
          <div className="flex-1 space-y-2">
            <h2 className="text-sm font-semibold tracking-tight">Appearance</h2>
            <p className="text-xs text-muted-foreground">
              Day, night, or follow the system. The header quick switch reflects this choice.
            </p>
            <div className="inline-flex overflow-hidden rounded-md border bg-muted/30 text-xs">
              {(['light', 'dark', 'system'] as const).map((value) => {
                const active = (theme ?? 'system') === value
                const label = value === 'light' ? 'Day' : value === 'dark' ? 'Night' : 'System'
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTheme(value)}
                    aria-pressed={active}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 transition-colors',
                      active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {value === 'dark' ? <Moon className="size-3" /> : <Sun className="size-3" />}
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <KeyRound className="size-5" />
          </div>
          <div className="flex-1 space-y-1">
            <h2 className="text-sm font-semibold tracking-tight">App PIN</h2>
            <p className="text-xs text-muted-foreground">
              The 6-digit PIN that gates the login screen. Rotating it signs
              out every device at once.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => router.push('/pin')}>
            Change PIN
          </Button>
        </div>
      </section>
    </main>
  )
}
