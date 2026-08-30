import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
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
 */

const HIDE_RE = /^(id|created|title)\s*:/i

class HiddenLineWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span')
    span.style.display = 'none'
    return span
  }
  eq() {
    return true
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const total = state.doc.lines
  if (total < 2) return Decoration.none

  const first = state.doc.line(1)
  if (first.text !== '---') return Decoration.none

  const ranges: { from: number; to: number }[] = []

  // Opening delimiter
  ranges.push({ from: first.from, to: first.to })

  const limit = Math.min(total, 20)
  for (let i = 2; i <= limit; i++) {
    const line = state.doc.line(i)
    if (line.text === '---') {
      // Closing delimiter
      ranges.push({ from: line.from, to: line.to })
      break
    }
    if (HIDE_RE.test(line.text)) {
      ranges.push({ from: line.from, to: line.to })
    }
  }

  if (ranges.length === 0) return Decoration.none

  const deco = new HiddenLineWidget()
  return Decoration.set(
    ranges.map((r) => Decoration.replace({ widget: deco, inclusive: true }).range(r.from, r.to))
  )
}

export function hideFrontmatterId() {
  const plugin = ViewPlugin.fromClass(
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

  return [
    plugin,
    EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.decorations ?? Decoration.none
    ),
  ]
}
