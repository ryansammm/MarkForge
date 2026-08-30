import { EditorState, Text } from '@codemirror/state'
import type { TransactionSpec } from '@codemirror/state'
import { copyToClipboard } from './clipboard'
import { detectBlockType, ensureBlockHasId, formatBlockMeta, joinBlocks, retypeBlock, splitBlocks, wordCount } from './blocks'
import type { BlockColor } from './blocks'

/**
 * Pure(ish) block transforms that return CodeMirror transaction specs.
 *
 * A transform reads the current `EditorState`, computes the affected
 * block range (the cursor's paragraph, or a paragraph range covering
 * a multi-line selection), and produces a `TransactionSpec` the editor
 * can dispatch. The transforms are pure over state — they do not call
 * back into the editor — so the menu and the keyboard keymap can share
 * them without duplicating logic.
 *
 * "Block" here means the same thing as in `lib/blocks.ts`: a run of
 * non-blank lines, separated from other blocks by a blank line. A
 * selection that crosses blank lines covers multiple blocks.
 */

export interface BlockRange {
  /** Inclusive range over the editor doc, in characters. */
  from: number
  to: number
  /** All blocks the range covers, in order. */
  blockIndex: number[]
  /**
   * The text of the range, joined back together. Stored so callers do
   * not have to re-slice the doc to know what the user is operating on.
   */
  text: string
}

/**
 * Finds the block range covering the cursor. If the selection is empty
 * it is the cursor's own paragraph; if the selection spans one or more
 * paragraphs it is the smallest range that covers them all.
 */
export function blockRangeAt(state: EditorState): BlockRange | null {
  const doc = state.doc
  const sel = state.selection.main
  const from = Math.min(sel.from, sel.to)
  const to = Math.max(sel.from, sel.to)

  const blocks = splitBlocks(doc.toString())
  if (blocks.length === 0) return null

  // Build a list of (from, to, blockIndex) for every block by walking
  // the doc's lines: each block starts on the first non-blank line and
  // ends at the trailing blank line.
  const ranges: { from: number; to: number; index: number }[] = []
  let pos = 0
  for (let i = 0; i < blocks.length; i++) {
    const firstLine = doc.lineAt(pos)
    let cursor = firstLine.from
    for (let l = 0; l < blocks[i].lines.length; l++) {
      const line = doc.lineAt(cursor)
      cursor = line.to + 1
    }
    if (cursor < doc.length && doc.sliceString(cursor, cursor + 1) === '\n') {
      pos = cursor + 1
    } else {
      pos = cursor
    }
    ranges.push({ from: firstLine.from, to: pos === doc.length ? doc.length : Math.max(pos - 1, firstLine.from), index: i })
  }

  const covering = ranges.filter((r) => r.to >= from && r.from <= to)
  if (covering.length === 0) return null

  const start = covering[0].from
  const end = covering[covering.length - 1].to
  const text = doc.sliceString(start, end)
  return { from: start, to: end, blockIndex: covering.map((r) => r.index), text }
}

/** The range, or fail loudly — the menu should not have to null-check. */
function requireRange(state: EditorState): BlockRange {
  const r = blockRangeAt(state)
  if (!r) throw new Error('blockRangeAt: no block at cursor')
  return r
}

/**
 * Turn the range into a different block type. Each affected block is
 * retried with `retypeBlock` (paragraph or list). Lists are atomic: a
 * bulleted list stays a bulleted list, only the first line's prefix is
 * replaced; the rest keep their bullets because they were already on
 * separate lines.
 *
 * If the range covers a single block, that block is retried. For multi-
 * block ranges every block is retried.
 */
export function turnInto(state: EditorState, type: ReturnType<typeof detectBlockType>): TransactionSpec {
  const range = requireRange(state)
  const blocks = splitBlocks(range.text)
  const retried = blocks.map((b) => {
    const lines = retypeBlock(b.lines, type)
    return { lines, meta: b.meta }
  })
  const newText = joinBlocks(retried)
  return { changes: { from: range.from, to: range.to, insert: newText } }
}

/**
 * Apply or remove a `color` (text) or `bg` (background) on every block
 * in the range. `default` clears the key. Each affected block gets an
 * id if it does not have one yet — the colour is meaningless without a
 * stable reference.
 */
export function setColor(
  state: EditorState,
  kind: 'color' | 'bg',
  value: BlockColor
): TransactionSpec {
  const range = requireRange(state)
  const blocks = splitBlocks(range.text)
  const retried = blocks.map((b) => {
    const ensured = b.meta.id
      ? { text: b.lines.join('\n'), meta: b.meta }
      : ensureBlockHasId(b.lines.join('\n'))
    const meta = { ...ensured.meta }
    if (value === 'default') {
      delete meta[kind]
    } else {
      meta[kind] = value
    }
    return { lines: ensured.text.split('\n').slice(0, -1), meta }
  })
  return { changes: { from: range.from, to: range.to, insert: joinBlocks(retried) } }
}

/**
 * Duplicate the range, inserting the copy right after the original.
 * New blocks get fresh ids. The cursor lands at the end of the new
 * range.
 */
export function duplicate(state: EditorState): TransactionSpec {
  const range = requireRange(state)
  const blocks = splitBlocks(range.text)
  const newBlocks = blocks.map((b) => {
    const ensured = ensureBlockHasId(b.lines.join('\n'))
    return { lines: ensured.text.split('\n').slice(0, -1), meta: ensured.meta }
  })
  const insert = '\n\n' + joinBlocks(newBlocks)
  const newCursor = range.to + insert.length
  return {
    changes: { from: range.to, to: range.to, insert },
    selection: { anchor: newCursor, head: newCursor },
    scrollIntoView: true,
  }
}

/** Delete the range. The cursor lands at the deleted range's start. */
export function deleteBlock(state: EditorState): TransactionSpec {
  const range = requireRange(state)
  return {
    changes: { from: range.from, to: range.to, insert: '' },
    selection: { anchor: range.from, head: range.from },
  }
}

/**
 * The URL that points at a specific block. Returns `null` if the block
 * does not yet have an id (Copy link to block is gated on having one).
 */
export function blockAnchorUrl(state: EditorState, docPath: string): string | null {
  const range = requireRange(state)
  const blocks = splitBlocks(range.text)
  const first = blocks[0]
  if (!first?.meta.id) return null
  return `${docPath}#mkf:b:${first.meta.id}`
}

/**
 * Copy the block anchor URL to the clipboard. Resolves with a boolean
 * indicating success. The menu turns a `true` into a toast.
 */
export async function copyLink(state: EditorState, docPath: string): Promise<boolean> {
  const url = blockAnchorUrl(state, docPath)
  if (!url) return false
  return copyToClipboard(url)
}

/** The user-visible type label for a state's cursor block. */
export function blockTypeLabel(state: EditorState): string {
  const range = blockRangeAt(state)
  if (!range) return 'Text'
  const blocks = splitBlocks(range.text)
  const type = detectBlockType(blocks[0]?.lines ?? ['text'])
  return blockTypeLabelByType(type)
}

function blockTypeLabelByType(type: ReturnType<typeof detectBlockType>): string {
  switch (type) {
    case 'text': return 'Text'
    case 'h1': return 'Heading 1'
    case 'h2': return 'Heading 2'
    case 'h3': return 'Heading 3'
    case 'h4': return 'Heading 4'
    case 'bullet': return 'Bulleted list'
    case 'numbered': return 'Numbered list'
    case 'todo': return 'To-do list'
    case 'quote': return 'Quote'
    case 'code': return 'Code'
  }
}

/** Word count for the cursor block (the first block in the range). */
export function blockWordCount(state: EditorState): number {
  const range = blockRangeAt(state)
  if (!range) return 0
  return wordCount(range.text)
}

/**
 * Replace the buffer with a new text and put the cursor at `at`. Used
 * by the slash command `/page` to splice a wikilink into the current
 * document, and by Move to to drop a block into a destination.
 */
export function replaceBlock(state: EditorState, text: string, at?: number): TransactionSpec {
  const range = requireRange(state)
  const insertAt = at ?? range.from
  return {
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: insertAt, head: insertAt + text.length },
  }
}

/**
 * Detects whether the cursor block has an id already. Used by the menu
 * to decide whether Copy link to block and Color are available.
 */
export function blockHasId(state: EditorState): boolean {
  const range = blockRangeAt(state)
  if (!range) return false
  return splitBlocks(range.text).some((b) => Boolean(b.meta.id))
}

/** peek-only export so the menu can show "Last edited <date>". */
export function currentBlockMeta(state: EditorState) {
  const range = blockRangeAt(state)
  if (!range) return null
  return splitBlocks(range.text)[0]?.meta ?? null
}

// ponytail: keep `Text` (the CodeMirror text builder) available for
// downstream code that may want to construct multi-piece inserts.
void Text
// Re-export so callers do not have to import from blocks directly.
export { formatBlockMeta }

/**
 * Move a paragraph range to a new location in the document.
 *
 * Returns two specs in sequence: first cut the source range, then
 * insert the trimmed block text at the (post-cut) drop offset with
 * blank-line separators so the block model stays valid. The caller
 * dispatches them in order against the same `EditorView`; the second
 * spec is computed against the doc state after the first applies.
 *
 * Dropping inside the source range is a no-op (returns null).
 */
export function moveBlock(
  state: EditorState,
  sourceFrom: number,
  sourceTo: number,
  dropAt: number
): { cut: TransactionSpec; insert: (postCut: EditorState) => TransactionSpec | null } | null {
  const total = state.doc.length
  if (sourceFrom < 0 || sourceTo > total || sourceFrom >= sourceTo) return null

  const blockText = state.doc.sliceString(sourceFrom, sourceTo)
  const trimmed = blockText.replace(/^\n+|\n+$/g, '')
  if (trimmed === '') return null

  const cutLen = sourceTo - sourceFrom
  const adjustedDrop = dropAt > sourceTo ? dropAt - cutLen : dropAt

  const cut: TransactionSpec = {
    changes: { from: sourceFrom, to: sourceTo, insert: '' },
  }

  const insert = (postCut: EditorState): TransactionSpec | null => {
    // Clamp into the post-cut doc.
    const len = postCut.doc.length
    const at = Math.max(0, Math.min(adjustedDrop, len))
    const before = postCut.doc.sliceString(0, at)
    const after = postCut.doc.sliceString(at)
    const leadSep = before === '' || before.endsWith('\n\n') ? '' : '\n\n'
    const trailSep = after === '' || after.startsWith('\n\n') ? '' : '\n\n'
    const insertion = `${leadSep}${trimmed}${trailSep}`
    return { changes: { from: at, insert: insertion } }
  }

  return { cut, insert }
}

