/**
 * Applying the server's own version of a document to the editor's buffer.
 *
 * A save can come back with bytes that differ from what was sent: the store splices
 * an `id` and a `created` stamp into frontmatter on a document's first in-app save
 * (`ensureDocumentMeta`). The editor has to adopt those, or the next save writes the
 * pre-splice text back and the id is stripped and reassigned forever.
 *
 * That much always worked. What did not is the part this module exists for: **a
 * reconcile is a one-time event, and it was being held as a value.**
 *
 * The workspace keeps the server's version in a state slot, which outlives the
 * editor — leaving edit mode unmounts the editor, entering it mounts a fresh one, and
 * a mount runs every effect. So re-entering the editor re-applied whatever reconcile
 * was still sitting in that slot, however old. In practice:
 *
 *   1. open a document that has no `created:` yet, type something
 *   2. the first autosave lands; the server returns the text plus the stamp; the
 *      workspace remembers it
 *   3. keep typing for a while — a link, a code block — none of which touches the
 *      remembered value
 *   4. switch to reading view: correct, the newest text is there
 *   5. switch back to editing: the editor mounts, re-applies the remembered version
 *      from step 2, and everything typed in step 3 is reverted *and then autosaved
 *      over the top of the real file*
 *
 * The fix is to record which version has been applied. On mount that record is seeded
 * with whatever the workspace is currently holding — because the buffer was just
 * built from `initialValue`, which the workspace keeps at the server's latest bytes,
 * so a fresh editor has by definition nothing to reconcile.
 */

export interface BufferEdit {
  from: number
  to: number
  insert: string
}

/**
 * Narrowest single replacement turning `from` into `to`.
 *
 * Dispatching this instead of replacing the whole document is what keeps the cursor
 * where the user left it: CodeMirror maps selections through a change, so an
 * insertion above the cursor shifts it correctly rather than dumping it at 0.
 */
export function minimalEdit(from: string, to: string): BufferEdit | null {
  if (from === to) return null

  let prefix = 0
  const maxPrefix = Math.min(from.length, to.length)
  while (prefix < maxPrefix && from[prefix] === to[prefix]) prefix++

  let suffix = 0
  const maxSuffix = Math.min(from.length - prefix, to.length - prefix)
  while (suffix < maxSuffix && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]) suffix++

  return {
    from: prefix,
    to: from.length - suffix,
    insert: to.slice(prefix, to.length - suffix),
  }
}

/**
 * Whether the editor should adopt `incoming`, and what to remember afterwards.
 *
 * `applied` is the version this editor instance has already dealt with — which on a
 * fresh instance is whatever the workspace was holding when it mounted, not null.
 * Returning it unchanged alongside a null edit is how "nothing to do" is said.
 */
export function reconcileEdit(
  buffer: string,
  incoming: string | null | undefined,
  applied: string | null
): { edit: BufferEdit | null; applied: string | null } {
  if (incoming == null) return { edit: null, applied }
  // Already dealt with. This is the guard that stops a remount from replaying an old
  // version over newer typing.
  if (incoming === applied) return { edit: null, applied }

  // Recorded even when the buffer already matches: it has been dealt with either way,
  // and leaving it unrecorded would mean re-testing it on every later render.
  return { edit: minimalEdit(buffer, incoming), applied: incoming }
}
