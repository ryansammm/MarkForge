'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, ArrowLeft, KeyRound } from 'lucide-react'
import { useVault } from '@/lib/vault/use-vault'
import { Button } from '@/components/ui/button'
import { SettingsForm } from '@/components/workspace/settings-form'

/**
 * Settings page.
 *
 * Lives at `/settings` as a route, not a dialog, because the spec wants a
 * deep-linkable surface. The price is auth + vault gating on every render: a
 * tab someone bookmarked should not show a list of API keys to whoever opens
 * the link next.
 *
 * Lock state is the same one the workspace uses, so the encryption key the
 * form writes with is the key the editor later reads with.
 */
export default function SettingsPage() {
  const router = useRouter()
  const [authChecked, setAuthChecked] = useState(false)
  const [authed, setAuthed] = useState(false)
  const vault = useVault(authed)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        if (cancelled) return
        setAuthed(res.ok)
      } catch {
        if (cancelled) return
        setAuthed(false)
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

  if (!authed) {
    if (typeof window !== 'undefined') {
      window.location.replace(`/login?from=${encodeURIComponent('/settings')}`)
    }
    return null
  }

  if (vault.status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span className="ml-2 text-sm">Opening vault…</span>
      </div>
    )
  }

  if (vault.status === 'absent' || vault.status === 'unavailable' || vault.status === 'locked') {
    if (typeof window !== 'undefined') {
      window.location.replace(`/login?from=${encodeURIComponent('/settings')}`)
    }
    return null
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
      <SettingsForm vault={vault} />

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
