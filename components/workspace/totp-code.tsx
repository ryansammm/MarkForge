'use client'

import { useEffect, useState } from 'react'
import { Clock, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { currentCode, secondsRemaining } from '@/lib/vault/totp'
import { copySecret } from '@/lib/vault/clipboard'

interface TotpCodeProps {
  /** Base32 secret. If empty/malformed the component renders nothing. */
  secret: string | undefined
  /**
   * Tick interval in ms. Default 1000. The countdown dial rounds to whole
   * seconds, so a faster tick is wasted work.
   */
  tickMs?: number
}

/**
 * Live TOTP code + countdown dial.
 *
 * A 1-second `setInterval` keeps the displayed code and the seconds-left in
 * sync with the server's clock (well, the local clock — this is a single
 * browser, no network). The code is recomputed on every tick, which is
 * the only way the rollover from `123 456` to `789 012` lands in the same
 * paint frame as the dial flipping from `01` to `30`.
 *
 * Render returns `null` when the secret does not decode: a paste of
 * `otpauth://…&secret=BASE32` instead of just the secret is the obvious
 * way to land here, and showing `000000` would be worse than showing
 * nothing at all.
 */
export function TotpCode({ secret, tickMs = 1000 }: TotpCodeProps) {
  const [snapshot, setSnapshot] = useState<{ code: string; secondsLeft: number } | null>(null)

  useEffect(() => {
    if (!secret) {
      // The interval below is what produces the live tick; nothing to set
      // up. The previous snapshot is still in state, so the explicit
      // clear below is the only way to keep the UI in sync with a
      // secret that became empty mid-life. Set in render is the lint
      // rule's actual complaint, and `set-state-in-effect` would
      // re-introduce the same problem in a different costume.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSnapshot(null)
      return
    }
    let cancelled = false
    const tick = async () => {
      const next = await currentCode(secret)
      if (!cancelled) setSnapshot(next)
    }
    void tick()
    const interval = window.setInterval(() => void tick(), tickMs)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [secret, tickMs])

  if (!secret) return null
  if (!snapshot) return null

  const dialPct = (snapshot.secondsLeft / 30) * 100

  const copyCode = async () => {
    try {
      // Strip the visual space — the receiving form expects `123456`.
      await copySecret(snapshot.code.replace(/\s+/g, ''))
      toast.success(`Code copied — the clipboard clears in 15s`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div className="flex items-center gap-1.5 font-mono">
      <span className="tabular-nums text-xs tracking-wider">{snapshot.code}</span>
      <span
        className="relative inline-flex size-3.5 items-center justify-center"
        title={`Expires in ${snapshot.secondsLeft}s`}
        aria-label={`Code expires in ${snapshot.secondsLeft} seconds`}
      >
        <Clock className="size-3.5 text-muted-foreground" aria-hidden />
        <svg
          className="pointer-events-none absolute inset-0 -rotate-90"
          viewBox="0 0 14 14"
          aria-hidden
        >
          <circle
            cx="7"
            cy="7"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray={`${(dialPct / 100) * 37.7} 37.7`}
            className="text-primary"
          />
        </svg>
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        title="Copy code"
        aria-label="Copy the 2FA code"
        onClick={() => void copyCode()}
      >
        <Copy />
      </Button>
    </div>
  )
}

/** Re-exports the seconds helper for callers that want to format it
 *  (e.g. a tooltip that shows the absolute time of the next rollover). */
export { secondsRemaining }
