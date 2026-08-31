import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { splitBlocks, formatBlockMeta } from '@/lib/blocks'

/**
 * Inline toggle list in edit mode.
 *
 * Renders a `▼`/`▶` widget before the first line of any block whose
 * meta is `type:toggle_list`. The raw meta line stays in the doc
 * (so the block round-trips on save); the widget hides it on
 * non-active lines via `.cm-toggle-meta-hidden`. Clicking the arrow
 * flips the meta's `open` flag.
 *
 * Read mode does the real work: `lib/markdown/remark-toggle-list.ts`
 * emits `<details><summary>…</summary>…</details>` and the browser
 * handles collapse natively.
 */

const META_RE = /<!--\s*mkf:b:[a-z0-9]+(?:\s+[^>]*?)?type:toggle_list[^>]*?-->/

class ToggleArrowWidget extends WidgetType {
  constructor(readonly open: boolean, readonly blockIndex: number) {
    super()
  }

  eq(other: ToggleArrowWidget): boolean {
    return other.open === this.open && other.blockIndex === this.blockIndex
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-toggle-arrow'
    el.contentEditable = 'false'
    el.setAttribute('role', 'button')
    el.setAttribute('aria-label', this.open ? 'Collapse toggle' : 'Expand toggle')
    el.textContent = this.open ? '▼' : '▶'
    el.style.cssText = 'cursor:pointer;padding:0 4px;user-select:none'
    el.addEventListener('mousedown', (event) => event.preventDefault())
    el.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const view = (el as HTMLElement & { __cmView?: EditorView }).__cmView
      if (!view) return
      toggleOpenState(view, this.blockIndex)
    })
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

function toggleOpenState(view: EditorView, blockIndex: number) {
  const blocks = splitBlocks(view.state.doc.toString())
  const block = blocks[blockIndex]
  if (!block) return
  const currentOpen = block.meta.open !== 'false'
  const newMeta = { ...block.meta, open: currentOpen ? 'false' : undefined }
  const newComment = formatBlockMeta(newMeta)

  let pos = 0
  for (let i = 0; i < blockIndex; i++) {
    pos += blocks[i].lines.join('\n').length + 2
  }
  if (pos > view.state.doc.length) return
  const blockText = block.lines.join('\n')
  const blockStart = pos
  const blockEnd = blockStart + blockText.length
  const body = block.lines.slice(0, -1).join('\n')
  const replacement = newComment ? `${body}\n${newComment}` : body

  view.dispatch({
    changes: { from: blockStart, to: blockEnd, insert: replacement },
  })
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const blocks = splitBlocks(view.state.doc.toString())
  if (blocks.length === 0) return Decoration.none

  let pos = 0
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.meta.type === 'toggle_list') {
      const blockText = block.lines.join('\n')
      const lastLine = block.lines[block.lines.length - 1] ?? ''
      if (META_RE.test(lastLine)) {
        const metaStart = pos + blockText.length - lastLine.length
        builder.add(metaStart, metaStart + lastLine.length, Decoration.line({ class: 'cm-toggle-meta-hidden' }))
      }
      builder.add(
        pos,
        pos,
        Decoration.widget({ widget: new ToggleArrowWidget(block.meta.open !== 'false', i), side: -1 })
      )
    }
    pos += block.lines.join('\n').length + 2
  }
  return builder.finish()
}

export function toggleListEdit() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
        view.dom.addEventListener('focus', () => {
          (view.dom as HTMLElement & { __cmView?: EditorView }).__cmView = view
        })
        ;(view.dom as HTMLElement & { __cmView?: EditorView }).__cmView = view
      }
      update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = build(update.view)
        }
      }
    },
    { decorations: (v) => v.decorations }
  )
}
