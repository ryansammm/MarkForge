import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

/**
 * Inline AI fence in edit mode.
 *
 * The reading view turns ` ```ai ` fences into the styled `<AiBlock>`
 * component. The editor cannot do the same with a CodeMirror widget —
 * a React component embedded in a CodeMirror widget would own its own
 * React root, fight with CodeMirror's focus tracking, and re-render on
 * every editor update. The pragmatic alternative is a static placeholder
 * that says what the block is, the active line reveals the raw fence so
 * the user can edit the prompt and the model output.
 *
 * Hidden characters keep the `cm-ai-fence-hidden` class; `globals.css`
 * paints them invisible. The widget is anchored at the opening fence
 * and replaces the entire fence with a small card preview.
 */

const FENCE_RE = /^(\s*)```\s*ai\b([^\n]*)?\n([\s\S]*?)\n?(\s*```\s*)?$/

class AiFenceWidget extends WidgetType {
  constructor(readonly from: number, readonly to: number) {
    super()
  }

  eq(other: AiFenceWidget): boolean {
    return other.from === this.from && other.to === this.to
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-ai-fence-widget'
    el.setAttribute('aria-label', 'AI block')
    el.textContent = 'AI block — type or click to edit the prompt'
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const text = view.state.doc.toString()
  const activeRanges = view.state.selection.ranges

  FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCE_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const onActiveLine = activeRanges.some(
      (r) => r.from >= start && r.from <= end
    )
    if (onActiveLine) continue

    // Hide every character of the fence with a mark decoration so the
    // user does not see the raw ` ```ai ` text on an unfocused line.
    builder.add(start, end, Decoration.mark({ class: 'cm-ai-fence-hidden' }))

    // Replace the line with a small preview widget. Anchor at the line
    // start so the widget sits where the fence was.
    const lineStart = view.state.doc.lineAt(start).from
    builder.add(
      lineStart,
      lineStart,
      Decoration.widget({ widget: new AiFenceWidget(start, end), side: -1, block: true })
    )
  }
  return builder.finish()
}

export function aiBlockEdit() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(update: {
        docChanged: boolean
        viewportChanged: boolean
        selectionSet: boolean
        view: EditorView
      }) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = build(update.view)
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  )
}
