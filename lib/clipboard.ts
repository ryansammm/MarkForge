/**
 * Copies a string to the system clipboard. Resolves with `true` on
 * success.
 *
 * Uses the async Clipboard API where it is available (modern browsers
 * and Electron renderers). Falls back to a hidden `<textarea>` and
 * `document.execCommand('copy')` in environments that block the async
 * API (rare; a defensive path for older Electron versions and the
 * occasional sandbox).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path
    }
  }
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  return ok
}
