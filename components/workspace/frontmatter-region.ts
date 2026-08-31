import type { EditorState } from '@codemirror/state'

/**
 * Frontmatter is a hidden block: the editor keeps it in the buffer (so the
 * server still sees it) but every line of it is decorated with
 * `cm-frontmatter-hidden` and the line class makes the rendered row
 * `display: none`. Toolbar commands (heading, bullet, inline code, wikilink)
 * are line-level — they prepend a prefix to the current line — and if a
 * cursor lands on a hidden line, applying the prefix would mutate the
 * hidden text, the line would no longer be recognised as frontmatter, and
 * the block would suddenly appear in the document.
 *
 * This helper answers the question "is this position inside the frontmatter
 * block?" cheaply: scan the first few lines for the opening `---`, then
 * for the closing `---`. Mirrors the parser's definition rather than
 * importing it — js-yaml is a server-side dependency and the editor
 * shouldn't pay for it.
 */
const FRONTMATTER_RE = /^---\r?\n/

export function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  const doc = state.doc
  if (doc.length < 7) return null
  const firstLine = doc.line(1)
  if (!FRONTMATTER_RE.test(firstLine.text)) return null

  const limit = Math.min(doc.lines, 20)
  for (let i = 2; i <= limit; i++) {
    const line = doc.line(i)
    if (/^---\s*$/.test(line.text)) {
      return { from: firstLine.from, to: line.to }
    }
  }
  return null
}

export function positionInFrontmatter(state: EditorState, pos: number): boolean {
  const range = frontmatterRange(state)
  if (!range) return false
  return pos >= range.from && pos <= range.to
}

export function selectionInFrontmatter(state: EditorState): boolean {
  for (const r of state.selection.ranges) {
    if (positionInFrontmatter(state, r.from) || positionInFrontmatter(state, r.to)) {
      return true
    }
  }
  return false
}
