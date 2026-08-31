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
  const text = view.state.doc.toString()
  const activeLines = new Set<number>()
  for (const r of view.state.selection.ranges) {
    activeLines.add(view.state.doc.lineAt(r.from).from)
  }

  const entries: { from: number; to: number; deco: Decoration }[] = []
  WIKILINK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const line = view.state.doc.lineAt(start)
    if (activeLines.has(line.from)) continue

    const label = (match[1] ?? '').trim() || 'Untitled'
    entries.push({
      from: start,
      to: end,
      deco: Decoration.mark({ class: 'cm-page-ref-hidden' }),
    })
    entries.push({
      from: line.from,
      to: line.from,
      deco: Decoration.widget({
        widget: new PageRefWidget(label, start, end),
        side: -1,
        block: false,
      }),
    })
  }
  // ponytail: sort by [from, startSide] to satisfy RangeSetBuilder's contract.
  // startSide comes from the Decoration itself: widget side -1 → -1, mark → 0.
  entries.sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide)
  const builder = new RangeSetBuilder<Decoration>()
  for (const e of entries) builder.add(e.from, e.to, e.deco)
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
