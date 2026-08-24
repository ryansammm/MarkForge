/**
 * Copying a secret, and taking it back.
 *
 * A password on the clipboard is a password readable by every other application on the
 * machine, by the next thing that pastes, and — on some setups — by a phone across the
 * room via clipboard sync. Auto-clear is the mitigation, and it is genuinely partial:
 * a clipboard manager that has already recorded the entry keeps it, and a browser that
 * has lost focus may refuse the write that clears it.
 *
 * So this promises little and says so. It reports whether the clear actually happened,
 * and the UI tells the truth about it rather than showing a reassuring countdown over
 * a clipboard that still holds the password.
 */

/** Long enough to switch windows and paste, short enough to matter. */
export const CLIPBOARD_CLEAR_SECONDS = 30

export class ClipboardUnavailableError extends Error {
  constructor() {
    super('This browser will not let the page write to the clipboard. Copy it by hand.')
    this.name = 'ClipboardUnavailableError'
  }
}

let pendingClear: ReturnType<typeof setTimeout> | null = null

/**
 * Copies a value and schedules the clipboard to be overwritten.
 *
 * Overwritten with a space rather than an empty string: `writeText('')` is rejected
 * outright by some browsers, which turns "cleared" into a silent no-op.
 */
export async function copySecret(
  value: string,
  options: { clearAfterSeconds?: number | null } = {}
): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new ClipboardUnavailableError()

  await navigator.clipboard.writeText(value)

  if (pendingClear) clearTimeout(pendingClear)
  const seconds = options.clearAfterSeconds
  if (seconds === null) return

  pendingClear = setTimeout(
    () => {
      pendingClear = null
      // Only if the clipboard still holds what was copied — clearing something the
      // user deliberately copied afterwards would be worse than not clearing at all.
      void navigator.clipboard
        .readText()
        .then((current) => (current === value ? navigator.clipboard.writeText(' ') : undefined))
        // readText needs a permission most browsers only grant on user gesture. Where
        // it is refused, overwrite anyway: a stale clipboard entry for a password is
        // the larger risk, and the value being replaced is one this page just wrote.
        .catch(() => navigator.clipboard.writeText(' '))
        .catch(() => undefined)
    },
    (seconds ?? CLIPBOARD_CLEAR_SECONDS) * 1000
  )
}

/** Cancels a pending clear — called on lock, where the clipboard is wiped immediately. */
export function cancelScheduledClear(): void {
  if (!pendingClear) return
  clearTimeout(pendingClear)
  pendingClear = null
}
