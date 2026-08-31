import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { splitBlocks } from '@/lib/blocks'

/**
 * Inline page reference in edit mode.
 *
 * `[[wikilink]]` is the project's link syntax — the reading view
 * resolves it to a clickable link. The editor cannot do the same with a
 * CodeMirror widget without owning a React root, so instead we render a
 * small chip ("📄 Title") in the editor and reveal the raw text on the
 * active line. Behaviour: typing inside a chip moves the cursor past it,
 * clicking reveals the wikilink source for editing.
 *
 * The chip is the same one the reading view shows for unresolved
 * links, so the user sees one consistent shape no matter which mode
 * they are in.
 */

const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g

class PageRefWidget extends WidgetType {
  constructor(readonly label: string, readonly from: number, readonly to: number) {
    super()
  }

  eq(other: PageRefWidget): boolean {
    return other.label === this.label && other.from === this.from && other.to === this.to
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-page-ref'
    el.setAttribute('aria-label', `Page: ${this.label}`)
    el.textContent = `📄 ${this.label}`
    el.title = this.label
    el.contentEditable = 'false'
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
  // The block model splits on blank lines; we only need to know whether
  // a match is on the cursor's line, so re-derive the line of every
  // match.
  const lines = new Map<number, number>() // from -> lineFrom
  for (const r of activeRanges) {
    const line = view.state.doc.lineAt(r.from)
    lines.set(line.from, line.from)
  }

  WIKILINK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const line = view.state.doc.lineAt(start)
    if (lines.has(line.from)) continue

    const label = (match[1] ?? '').trim() || 'Untitled'
    builder.add(start, end, Decoration.mark({ class: 'cm-page-ref-hidden' }))
    builder.add(
      line.from,
      line.from,
      Decoration.widget({ widget: new PageRefWidget(label, start, end), side: -1, block: false })
    )
  }
  void splitBlocks
  return builder.finish()
}

export function pageRefEdit() {
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
