import { EditorView, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'

/**
 * Hides `id:`, `created:`, `title:`, and the `---` delimiters from the frontmatter.
 *
 * Edit mode is body-first: the document's title is shown in the breadcrumb
 * (filename-derived) and the reading view's `<h1>`. Putting it in the editor too
 * repeats the same word twice and makes the body look like it has a stray
 * heading at the top. `tags`, `updated`, `aliases` etc. stay visible.
 *
 * Hidden lines remain in the document buffer — the server still sees them,
 * reconciliation is unaffected, and the title is still indexed for search.
 *
 * Implementation note: a `Decoration.replace` with a hidden widget corrupts the
 * line's tile tree when the viewport re-measures (the widget's zero-length
 * position races the content scan, surfacing as a `Cannot read properties of
 * undefined (reading 'isText')` from `@codemirror/view`). A line class hides
 * the rendered DOM without touching the content tree.
 */

const HIDE_RE = /^(id|created|title)\s*:/i

function buildDecorations(state: EditorState): DecorationSet {
  const total = state.doc.lines
  if (total < 2) return Decoration.none

  const first = state.doc.line(1)
  if (first.text !== '---') return Decoration.none

  const lineStarts: number[] = [first.from]

  const limit = Math.min(total, 20)
  for (let i = 2; i <= limit; i++) {
    const line = state.doc.line(i)
    if (line.text === '---') {
      lineStarts.push(line.from)
      break
    }
    if (HIDE_RE.test(line.text)) {
      lineStarts.push(line.from)
    }
  }

  if (lineStarts.length === 0) return Decoration.none

  return Decoration.set(
    lineStarts.map((from) => Decoration.line({ class: 'cm-frontmatter-hidden' }).range(from))
  )
}

export function hideFrontmatterId() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state)
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view.state)
        }
      }
    },
    { decorations: (p) => p.decorations }
  )
}
