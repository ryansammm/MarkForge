/**
 * Who owns the keyboard right now.
 *
 * The workspace binds two sets of shortcuts on `window` — Alt+Arrow for history and
 * Alt+digit / Alt+W for tabs (components/workspace/workspace-app.tsx). Neither knows
 * anything about dialogs, and a listener on `window` fires whatever is on screen, so
 * with the image viewer open Alt+Left would walk the document *underneath* the overlay
 * back through its history. The reader would then dismiss the viewer onto a different
 * document than the one they left, with nothing on screen having suggested that would
 * happen.
 *
 * `stopPropagation` from inside the dialog would also work today — a portal is still a
 * React subtree, and the event bubbles to `window` last — but it depends on the popup
 * seeing every key first, which stops being true the moment focus is anywhere else on
 * the page. This is the same rule stated where it can be read: while something modal is
 * up, the global shortcuts stand down.
 *
 * A depth counter rather than a boolean, so a viewer opened from inside another dialog
 * does not hand the keyboard back when the inner one closes.
 */

let depth = 0

/**
 * Take the keyboard for as long as something modal is on screen. Call the returned
 * function to give it back — from an effect cleanup, so an unmount cannot leave the
 * shortcuts switched off for the rest of the session.
 */
export function claimKeyboard(): () => void {
  depth++
  let released = false
  return () => {
    if (released) return
    released = true
    depth = Math.max(0, depth - 1)
  }
}

/** Whether a global shortcut should stand down. */
export function keyboardIsClaimed(): boolean {
  return depth > 0
}
