'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Lock } from 'lucide-react'
import { PinKeypad } from '@/components/workspace/pin-keypad'

function LoginForm() {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const from = searchParams.get('from') || '/'

  async function submit() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
      if (res.ok) {
        router.push(from)
        router.refresh()
      } else {
        const data = await res.json()
        if (data.code === 'RATE_LIMITED') {
          setError('Too many attempts. Try again later.')
        } else {
          setError(data.error || 'Access denied')
        }
      }
    } catch {
      setError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-6 shadow-lg">
      <div className="flex flex-col items-center text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Lock className="size-6" />
        </div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Protected Workspace</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter your 6-digit PIN to access your private notes.
        </p>
      </div>

      <PinKeypad
        value={pin}
        onChange={setPin}
        onSubmit={() => {
          if (!loading && pin.length === 6) void submit()
        }}
        label="PIN"
        placeholder="123456"
        error={error || null}
        disabled={loading}
      />

      <button
        type="button"
        onClick={() => void submit()}
        disabled={loading || pin.length !== 6}
        className="w-full rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {loading ? 'Authenticating…' : 'Unlock Workspace'}
      </button>
    </div>
  )
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-12 text-foreground">
      <Suspense fallback={
        <div className="flex flex-col items-center gap-2">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-xs text-muted-foreground">Loading authentication...</p>
        </div>
      }>
        <LoginForm />
      </Suspense>
    </div>
  )
}
