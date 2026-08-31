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
export type BlockInsertHandler = (context: BlockHandleContext) => void

let clickHandler: BlockHandleClickHandler | null = null
let insertHandler: BlockInsertHandler | null = null

export function setBlockHandleClickHandler(handler: BlockHandleClickHandler | null): void {
  clickHandler = handler
}

export function setBlockInsertHandler(handler: BlockInsertHandler | null): void {
  insertHandler = handler
}

/**
 * Module-level cache of the dragged block's text. The ViewPlugin writes
 * it just before the widget renders, so the widget's `dragstart`
 * handler can read it without re-slicing the doc.
 */
let lastDragText = ''

class BlockHandleWidget extends WidgetType {
  constructor(
    readonly blockIndex: number,
    readonly blockId: string | undefined,
    readonly from: number,
    readonly to: number,
    /** Full paragraph range (may span multiple lines), used for drag. */
    readonly blockFrom: number,
    readonly blockTo: number
  ) {
    super()
  }

  eq(other: BlockHandleWidget): boolean {
    return (
      other.blockIndex === this.blockIndex &&
      other.blockId === this.blockId &&
      other.blockFrom === this.blockFrom &&
      other.blockTo === this.blockTo
    )
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-block-handle'
    wrap.setAttribute('aria-label', 'Block actions')

    const plus = document.createElement('button')
    plus.type = 'button'
    plus.className = 'cm-block-handle-plus'
    plus.textContent = '+'
    plus.title = 'Add block below'
    plus.setAttribute('aria-label', 'Add block below')
    plus.addEventListener('mousedown', (event) => event.preventDefault())
    plus.addEventListener('click', (event) => {
      if (!insertHandler) return
      event.preventDefault()
      event.stopPropagation()
      const rect = wrap.getBoundingClientRect()
      insertHandler({
        blockIndex: this.blockIndex,
        blockId: this.blockId,
        from: this.from,
        to: this.to,
        rect,
      })
    })

    const grip = document.createElement('span')
    grip.className = 'cm-block-handle-grip'
    grip.textContent = '⠿'
    grip.title = 'Drag to reorder, click for menu'
    grip.setAttribute('aria-label', 'Block menu')
    grip.setAttribute('draggable', 'true')
    if (this.blockId) grip.dataset.blockId = this.blockId
    grip.addEventListener('mousedown', (event) => {
      // A mousedown on the handle should not move the cursor into the
      // first character of the paragraph. Capture and re-emit a click
      // synchronously if the user did not drag.
      event.preventDefault()
    })
    grip.addEventListener('click', (event) => {
      if (!clickHandler) return
      event.preventDefault()
      event.stopPropagation()
      const rect = grip.getBoundingClientRect()
      clickHandler({
        blockIndex: this.blockIndex,
        blockId: this.blockId,
        from: this.from,
        to: this.to,
        rect,
      })
    })
    grip.addEventListener('dragstart', (event) => {
      if (!event.dataTransfer) return
      const payload = JSON.stringify({
        from: this.blockFrom,
        to: this.blockTo,
        blockId: this.blockId ?? null,
        blockIndex: this.blockIndex,
      })
      event.dataTransfer.setData('application/x-mkf-block', payload)
      event.dataTransfer.setData('text/plain', lastDragText)
      event.dataTransfer.effectAllowed = 'move'
      wrap.classList.add('cm-block-handle-dragging')
    })
    grip.addEventListener('dragend', () => {
      wrap.classList.remove('cm-block-handle-dragging')
    })

    wrap.append(plus, grip)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const state = view.state
  const blocks = splitBlocks(state.doc.toString())
  if (blocks.length === 0) {
    lastDragText = ''
    return Decoration.none
  }

  const builder = new RangeSetBuilder<Decoration>()
  let pos = 0
  const total = state.doc.length
  let blockIndex = 0

  for (const block of blocks) {
    const firstLine = state.doc.lineAt(pos)
    // The block's full range covers all non-blank lines, terminated by
    // a single trailing blank line if one exists.
    let blockEnd = firstLine.from
    for (let i = 0; i < block.lines.length; i++) {
      const l = state.doc.lineAt(blockEnd)
      blockEnd = l.to + 1
    }
    const blockFrom = firstLine.from
    let blockTo = blockEnd
    if (blockTo < total && state.doc.sliceString(blockTo - 1, blockTo) === '\n') {
      // `blockEnd` is one past the last char of the last line; if the
      // last char is a newline, the line is blank-terminated already.
    }
    // Include one trailing blank line if present, so a drop carries the
    // separator away from the source.
    if (blockTo < total && state.doc.sliceString(blockTo, blockTo + 1) === '\n') {
      blockTo += 1
    }
    const blockText = state.doc.sliceString(blockFrom, blockTo)
    lastDragText = blockText

    const widget = new BlockHandleWidget(
      blockIndex,
      block.meta.id,
      firstLine.from,
      firstLine.to,
      blockFrom,
      blockTo
    )
    builder.add(firstLine.from, firstLine.from, Decoration.widget({ widget, side: -1 }))
    blockIndex++

    pos = blockTo
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
