import { EditorView, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'

/**
 * Hides the internal frontmatter lines the user has no reason to
 * touch: `id`, `created`, `view`, and `width`. The first two are
 * bookkeeping written by the store on first save; the last two are
 * per-document layout toggles set through the `⋯` menu, not user
 * content. None of them belong in the body of a document.
 *
 * When a block contains *only* internal keys (a brand-new page, or
 * a legacy document that has not been edited since this change
 * shipped), the two `---` delimiters are hidden too: a frontmatter
 * block with nothing visible inside is worse than no block at all.
 * A block with at least one user field keeps its `---` fences
 * visible, so `title:`, `tags:`, etc. stay framed.
 *
 * Hidden lines remain in the document buffer — the server still
 * sees them, reconciliation is unaffected, and the keys are still
 * indexed for search.
 *
 * Implementation note: a `Decoration.replace` with a hidden
 * widget corrupts the line's tile tree when the viewport
 * re-measures (the widget's zero-length position races the
 * content scan, surfacing as a `Cannot read properties of
 * undefined (reading 'isText')` from `@codemirror/view`). A
 * line class hides the rendered DOM without touching the content
 * tree.
 */

const HIDE_RE = /^(id|created|width|view)\s*:/i

function buildDecorations(state: EditorState): DecorationSet {
  const total = state.doc.lines
  if (total < 2) return Decoration.none

  const first = state.doc.line(1)
  if (first.text !== '---') return Decoration.none

  const lineStarts: number[] = []
  let closingLine: number | null = null
  let hasUserField = false

  const limit = Math.min(total, 20)
  for (let i = 2; i <= limit; i++) {
    const line = state.doc.line(i)
    if (line.text === '---') {
      closingLine = i
      break
    }
    if (HIDE_RE.test(line.text)) {
      lineStarts.push(line.from)
    } else {
      hasUserField = true
    }
  }

  if (lineStarts.length === 0) return Decoration.none

  // Hide the two `---` fences too when the block holds only
  // bookkeeping. A blank `--- / ---` pair dangling over the body
  // is the visual the user complained about.
  if (!hasUserField && closingLine !== null) {
    lineStarts.push(first.from)
    lineStarts.push(state.doc.line(closingLine).from)
  }

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
