import { EditorView, Decoration, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

/**
 * Renders a per-line hint behind empty paragraphs: `Press 'space' for
 * AI or '/' for commands`. Shown only on the editor's active line —
 * `globals.css` hides `.mkf-empty-hint` everywhere except
 * `.cm-focused .cm-activeLine`.
 *
 * The widget sits at `line.from` with `side: 1` so it appears after
 * the line break that precedes the empty line. Block-id comments
 * (`<!-- mkf:b:... -->`) are NOT empty lines in the editor's sense
 * (they have text), so this widget does not appear on them.
 */
class EmptyBlockHint extends WidgetType {
  toDOM() {
    const el = document.createElement('span')
    el.className = 'mkf-empty-hint'
    el.textContent = "Press 'space' for AI or '/' for commands"
    return el
  }
  ignoreEvent() {
    return true
  }
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      if (line.text === '' && line.from < view.state.doc.length) {
        builder.add(
          line.from,
          line.from,
          Decoration.widget({ widget: new EmptyBlockHint(), side: 1 })
        )
      }
      pos = line.to + 1
      if (line.to >= to) break
    }
  }
  return builder.finish()
}

export function emptyBlockPlaceholder() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(update: {
        docChanged: boolean
        viewportChanged: boolean
        view: EditorView
      }) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = build(update.view)
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  )
}
