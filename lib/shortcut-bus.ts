/**
 * Cross-component shortcut actions that fire from a global keydown handler
 * but land on a component that lives deep inside the tree.
 *
 * The bus is a deliberately small emitter — three subscribers at most, no
 * event payload worth naming. The point is to keep the keyboard listener
 * in `workspace-app.tsx` from needing a ref into the sidebar's
 * `GrimoireSwitcher` to trigger "new grimoire" from `Cmd/Ctrl-Shift-N`.
 */

type ShortcutAction = 'open-new-grimoire'

const listeners = new Set<(action: ShortcutAction) => void>()

/** Subscribe to shortcut actions. Returns the unsubscribe function. */
export function onShortcutAction(action: ShortcutAction, fn: () => void): () => void {
  const handler = (received: ShortcutAction) => {
    if (received === action) fn()
  }
  listeners.add(handler)
  return () => {
    listeners.delete(handler)
  }
}

/** Fire a shortcut action to every active subscriber. */
export function fireShortcutAction(action: ShortcutAction): void {
  for (const handler of listeners) handler(action)
}
