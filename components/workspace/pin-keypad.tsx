'use client'

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { APP_PIN_LENGTH } from '@/lib/app-settings-shared'

/**
 * 6-digit PIN keypad.
 *
 * Six single-cell inputs in a row, with auto-advance on type, backspace to
 * move left, and a paste handler that fills the row from a 6-digit string and
 * auto-submits. Numeric keyboard on mobile via `inputMode="numeric"`; the
 * browser's built-in autofill is asked for one-time codes so an SMS-style
 * paste works.
 *
 * The display is `••••` rather than the digits themselves so a shoulder
 * surfer does not get a free read.
 */
export interface PinKeypadProps {
  value: string
  onChange: (value: string) => void
  /**
   * Optional form label rendered above the cells. The login page omits this —
   * its card already says "Enter your 6-digit PIN…" — so the label would only
   * repeat the obvious. The PIN-change page keeps its "Current PIN" /
   * "New PIN" labels because there the same shape appears twice in a row
   * and the label is the only thing telling them apart.
   */
  label?: string
  /**
   * Visual hint shown in each empty cell. Defaults to a neutral dot per
   * cell — putting the real default in here would teach a shoulder surfer
   * the only PIN worth trying, and the form already shows the default in
   * a one-liner below the keypad on /login.
   */
  placeholder?: string
  autoFocus?: boolean
  error?: string | null
  disabled?: boolean
  /** Fires when all 6 cells are filled, with the just-completed value. */
  onSubmit?: (value: string) => void
}

export function PinKeypad({
  value,
  onChange,
  label,
  placeholder = '••••••',
  autoFocus = true,
  error = null,
  disabled = false,
  onSubmit,
}: PinKeypadProps) {
  // ponytail: `label` falls through to `aria-label` on each cell when omitted,
  // so screen readers still get "PIN digit 1…6" without a visible label.
  const refs = useRef<Array<HTMLInputElement | null>>([])

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus()
  }, [autoFocus])

  function setCell(index: number, char: string) {
    if (!/^\d?$/.test(char)) return
    const next = (value.padEnd(APP_PIN_LENGTH, ' ').split('').slice(0, APP_PIN_LENGTH) as string[])
      .map((c) => (c === ' ' ? '' : c))
    next[index] = char
    const joined = next.join('').slice(0, APP_PIN_LENGTH)
    onChange(joined)
    if (char && index < APP_PIN_LENGTH - 1) {
      refs.current[index + 1]?.focus()
    }
    if (next.every((c) => c) && onSubmit) onSubmit(joined)
  }

  function handleChange(index: number, e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, '')
    if (raw.length > 1) {
      // Pasted or autofilled — fill the row from the right.
      const digits = raw.slice(-APP_PIN_LENGTH).split('')
      const joined = digits.join('')
      onChange(joined)
      const focusIndex = Math.min(digits.length, APP_PIN_LENGTH) - 1
      refs.current[focusIndex]?.focus()
      if (digits.length === APP_PIN_LENGTH && onSubmit) onSubmit(joined)
      return
    }
    setCell(index, raw)
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !value[index] && index > 0) {
      refs.current[index - 1]?.focus()
    }
    if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault()
      refs.current[index - 1]?.focus()
    }
    if (e.key === 'ArrowRight' && index < APP_PIN_LENGTH - 1) {
      e.preventDefault()
      refs.current[index + 1]?.focus()
    }
  }

  const cells = Array.from({ length: APP_PIN_LENGTH }, (_, i) => i)

  return (
    <div className="space-y-2">
      {label ? (
        <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      ) : null}
      <div className="flex justify-center gap-2">
        {cells.map((i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="password"
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            maxLength={APP_PIN_LENGTH}
            value={value[i] ?? ''}
            placeholder={placeholder[i] ?? ''}
            disabled={disabled}
            onChange={(e) => handleChange(i, e)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={`${label ?? 'PIN'} digit ${i + 1}`}
            className={cn(
              'h-12 w-10 rounded-md border bg-background text-center text-lg font-medium tabular-nums',
              'outline-none ring-primary/20 focus:border-primary focus:ring-2',
              'placeholder:text-muted-foreground/40',
              error ? 'border-destructive' : 'border-input'
            )}
          />
        ))}
      </div>
      {error ? (
        <p className="text-center text-xs font-medium text-destructive">{error}</p>
      ) : null}
    </div>
  )
}
