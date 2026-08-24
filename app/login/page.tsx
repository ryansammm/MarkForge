'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Lock } from 'lucide-react'

function LoginForm() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const from = searchParams.get('from') || '/'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      if (res.ok) {
        router.push(from)
        router.refresh()
      } else {
        const data = await res.json()
        setError(data.error || 'Access denied')
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
          Enter your password to access your private notes.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Workspace password"
            required
            autoFocus
            className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground outline-none ring-primary/20 placeholder:text-muted-foreground focus:border-primary focus:ring-2"
          />
        </div>

        {error && (
          <p className="text-center text-xs font-medium text-destructive">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? 'Authenticating...' : 'Unlock Workspace'}
        </button>
      </form>
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
