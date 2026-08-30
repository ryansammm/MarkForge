'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PinKeypad } from '@/components/workspace/pin-keypad'

/**
 * App PIN change page.
 *
 * Lives at `/pin` (not under `/settings`) so the user can rotate the PIN
 * before the vault is unlocked — a fresh install, a borrowed device, or a
 * forgotten vault are the moments this matters. Auth-gated only.
 *
 * The page verifies the current PIN against `/api/auth`, then PUTs the new
 * one to `/api/settings/pin`. Rotating invalidates every existing session
 * (`lib/session.ts` derives the signing key from the PIN), so the warning
 * banner is the point, not decoration.
 */
export default function PinSettingsPage() {
  const router = useRouter()
  const [authChecked, setAuthChecked] = useState(false)
  const [authed, setAuthed] = useState(false)
  const [currentPin, setCurrentPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [stage, setStage] = useState<'idle' | 'verifying' | 'saving' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

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
      window.location.replace(`/login?from=${encodeURIComponent('/pin')}`)
    }
    return null
  }

  async function handleSubmit() {
    setError(null)
    if (stage === 'idle') {
      setStage('verifying')
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: currentPin }),
        })
        if (!res.ok) {
          setError('Current PIN is incorrect.')
          setStage('idle')
          setCurrentPin('')
          return
        }
        setStage('saving')
      } catch {
        setError('Could not verify PIN.')
        setStage('idle')
        return
      }
    }

    if (stage === 'saving') {
      try {
        const res = await fetch('/api/settings/pin', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: newPin }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          setError(data.error ?? 'Could not save new PIN.')
          setStage('verifying')
          setNewPin('')
          return
        }
        setStage('done')
      } catch {
        setError('Could not save new PIN.')
        setStage('verifying')
      }
    }
  }

  return (
    <main className="mx-auto max-w-md space-y-4 px-4 py-8 text-foreground">
      <header className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.push('/settings')}>
          <ArrowLeft className="size-3.5" />
          <span>Back</span>
        </Button>
        <h1 className="text-sm font-semibold tracking-tight">App PIN</h1>
      </header>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <p className="text-xs text-muted-foreground">
          The 6-digit PIN gates the app at the login screen. Rotating it signs out
          every device at once — there is no per-device revocation.
        </p>
      </section>

      {stage === 'done' ? (
        <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm">
          <p className="font-medium text-emerald-700 dark:text-emerald-300">PIN updated.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            You will need to sign in again on this device.
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => router.push('/login')}>
              Sign in again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => router.push('/')}>
              Stay signed out
            </Button>
          </div>
        </section>
      ) : (
        <>
          {stage === 'idle' ? (
            <PinKeypad
              value={currentPin}
              onChange={setCurrentPin}
              label="Current PIN"
              placeholder="123456"
              autoFocus
              onSubmit={handleSubmit}
              error={error}
            />
          ) : null}
          {stage === 'verifying' ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span className="ml-2">Verifying…</span>
            </div>
          ) : null}
          {stage === 'saving' ? (
            <PinKeypad
              value={newPin}
              onChange={setNewPin}
              label="New PIN"
              placeholder="123456"
              autoFocus
              onSubmit={handleSubmit}
              error={error}
            />
          ) : null}
        </>
      )}
    </main>
  )
}
