import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { splitBlocks } from '@/lib/blocks'

/**
 * Hover-only drag handle (⠿) for every paragraph.
 *
 * A block menu opens when the user clicks the handle. The handle also
 * doubles as the source of a drag-and-drop reorder gesture: HTML5 dnd on
 * the handle element with a payload identifying the paragraph range, so
 * the editor's `drop` handler can splice the range into a new position.
 *
 * The widget sits absolutely positioned to the left of the first line of
 * a paragraph, so the text never reflows when the handle shows or hides.
 * CSS in the editor theme owns the visual state (`.cm-block-handle`).
 *
 * Communication with the React parent uses a module-level callback the
 * editor sets at mount. CodeMirror widgets are not React, and lifting
 * state up through a ref would couple the extension to a specific editor
 * instance — the global is replaced on every mount, and torn down on
 * unmount, so two editors briefly mounted during a hot reload never see
 * each other's handle clicks.
 */

export interface BlockHandleContext {
  blockIndex: number
  blockId: string | undefined
  from: number
  to: number
  /** DOM rect of the handle, used to anchor the menu. */
  rect: DOMRect
}

export type BlockHandleClickHandler = (context: BlockHandleContext) => void

let clickHandler: BlockHandleClickHandler | null = null

export function setBlockHandleClickHandler(handler: BlockHandleClickHandler | null): void {
  clickHandler = handler
}

class BlockHandleWidget extends WidgetType {
  constructor(
    readonly blockIndex: number,
    readonly blockId: string | undefined,
    readonly from: number,
    readonly to: number
  ) {
    super()
  }

  eq(other: BlockHandleWidget): boolean {
    return other.blockIndex === this.blockIndex && other.blockId === this.blockId
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-block-handle'
    el.textContent = '⠿'
    el.setAttribute('aria-label', 'Block menu')
    el.setAttribute('draggable', 'true')
    if (this.blockId) el.dataset.blockId = this.blockId
    el.addEventListener('mousedown', (event) => {
      // A mousedown on the handle should not move the cursor into the
      // first character of the paragraph. Capture and re-emit a click
      // synchronously if the user did not drag.
      event.preventDefault()
    })
    el.addEventListener('click', (event) => {
      if (!clickHandler) return
      event.preventDefault()
      event.stopPropagation()
      const rect = el.getBoundingClientRect()
      clickHandler({
        blockIndex: this.blockIndex,
        blockId: this.blockId,
        from: this.from,
        to: this.to,
        rect,
      })
    })
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const state = view.state
  const blocks = splitBlocks(state.doc.toString())
  if (blocks.length === 0) return Decoration.none

  const builder = new RangeSetBuilder<Decoration>()
  let pos = 0
  const total = state.doc.length
  let blockIndex = 0

  for (const block of blocks) {
    const firstLine = state.doc.lineAt(pos)
    const widget = new BlockHandleWidget(
      blockIndex,
      block.meta.id,
      firstLine.from,
      firstLine.to
    )
    builder.add(firstLine.from, firstLine.from, Decoration.widget({ widget, side: -1 }))
    blockIndex++

    // Advance pos past the block's lines and one trailing blank line
    // (if any). After this `pos` is at the start of the next block, or
    // at the end of the document.
    let cursor = firstLine.from
    for (let i = 0; i < block.lines.length; i++) {
      const l = state.doc.lineAt(cursor)
      cursor = l.to + 1
    }
    if (cursor < total && state.doc.sliceString(cursor, cursor + 1) === '\n') {
      // Trailing blank line that separates this block from the next.
      pos = cursor + 1
    } else {
      pos = cursor
    }
  }

  return builder.finish()
}

export function blockHandle() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view)
      }
      update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view)
        }
      }
    },
    { decorations: (p) => p.decorations }
  )
}
