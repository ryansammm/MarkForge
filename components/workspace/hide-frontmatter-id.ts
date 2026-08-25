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
 * Hides the `id:` line from the frontmatter in the editor.
 *
 * The `id` is internal metadata (assigned on first save, never overwritten)
 * and has no editing value. The line stays in the document buffer — the
 * server still sees it, and reconciliation is unaffected — but the user
 * never sees or interacts with it.
 *
 * When the cursor enters the hidden line, the raw `id: ...` is revealed
 * (atomic ranges skip over it during navigation).
 */

const HIDDEN_ID = 'cm-frontmatter-id-hidden'

class HiddenIdWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span')
    span.style.display = 'none'
    return span
  }
  eq() {
    return true
  }
}

function findIdLine(state: EditorState): number | null {
  const total = state.doc.lines
  const limit = Math.min(total, 10)
  for (let i = 1; i <= limit; i++) {
    const line = state.doc.line(i)
    if (line.text === '---') {
      if (i >= total) return null
      for (let j = i + 1; j <= Math.min(i + 10, total); j++) {
        const fm = state.doc.line(j)
        if (fm.text === '---') return null
        if (/^id\s*:/i.test(fm.text)) return j
      }
      return null
    }
  }
  return null
}

function buildDecorations(state: EditorState): DecorationSet {
  const lineNum = findIdLine(state)
  if (!lineNum) return Decoration.none

  const line = state.doc.line(lineNum)
  const deco = Decoration.replace({
    widget: new HiddenIdWidget(),
    inclusive: true,
  })

  return Decoration.set([deco.range(line.from, line.to)])
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
