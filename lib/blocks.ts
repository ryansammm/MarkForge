/**
 * Paragraph-based block model for the Notion-style block menu.
 *
 * A block is a run of consecutive non-blank lines. A blank line, or the
 * start/end of the document, terminates a block. A list of items with no
 * blank line between them is one block.
 *
 * Each block can carry a hidden HTML comment at the end that holds its
 * id and optional styling keys:
 *
 *     paragraph text…
 *     <!-- mkf:b:a3f2kq18 color:red bg:yellow -->
 *
 * The comment is part of the file (so block ids survive a save+reopen and
 * the file is readable in any editor) but invisible in the reading view
 * (see `lib/markdown/strip-block-comments.ts`). Nothing in the buffer
 * model is the source of truth for the id; the comment is.
 *
 * This module is text-only. It does not import CodeMirror. The editor
 * extension in `components/workspace/block-handle.ts` calls into these
 * functions when it needs to read or rewrite a block.
 */

const BLOCK_META_RE = /<!--\s*mkf:b:([a-z0-9]+)(?:\s+(.*?))?\s*-->/

export interface BlockMeta {
  id?: string
  color?: string
  bg?: string
}

export interface Block {
  /** Lines that make up the block, without the trailing blank separator. */
  lines: string[]
  /** Parsed metadata from the trailing comment, if any. */
  meta: BlockMeta
}

export const BLOCK_COLORS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const

export type BlockColor = (typeof BLOCK_COLORS)[number]

/**
 * 8 random bytes as base36, lowercased. ~12 chars. Plenty for the scale
 * of a notes app and still readable in the file.
 */
export function newBlockId(): string {
  const bytes = new Uint8Array(8)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let n = 0
  for (let i = 0; i < bytes.length; i++) n = n * 256 + bytes[i]
  return n.toString(36)
}

/**
 * Splits raw text into a list of blocks. A block is a run of non-blank
 * lines; blank lines (or the document boundaries) separate blocks.
 *
 * The trailing comment line, if present, is the last line of the block
 * it belongs to — a comment is the only "line" that may be present
 * alongside blank-line-separated paragraphs without ending a block.
 */
export function splitBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let current: string[] = []

  const flush = () => {
    if (current.length === 0) return
    const { lines, meta } = peelMeta(current)
    blocks.push({ lines, meta })
    current = []
  }

  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') {
      flush()
      continue
    }
    current.push(rawLine)
  }
  flush()

  return blocks
}

function peelMeta(lines: string[]): { lines: string[]; meta: BlockMeta } {
  if (lines.length === 0) return { lines, meta: {} }
  const last = lines[lines.length - 1] ?? ''
  const trimmed = last.trimEnd()
  const m = trimmed.match(BLOCK_META_RE)
  if (!m) return { lines, meta: {} }

  // Standalone-comment form: the line is exactly the comment (or the
  // comment with a trailing space). The whole line is the meta.
  if (m.index === 0) {
    return { lines: lines.slice(0, -1), meta: parseKeys(m[1], m[2]) }
  }

  // Inline form: prose before the comment, on the same line.
  const before = trimmed.slice(0, m.index).replace(/\s+$/, '')
  const out = lines.slice(0, -1)
  if (before.length > 0) out.push(before)
  return { lines: out, meta: parseKeys(m[1], m[2]) }
}

function parseKeys(id: string, rest: string | undefined): BlockMeta {
  const meta: BlockMeta = { id }
  if (!rest) return meta
  for (const part of rest.split(/\s+/)) {
    const [k, v] = part.split(':')
    if (k === 'color' && v) meta.color = v
    else if (k === 'bg' && v) meta.bg = v
  }
  return meta
}

/**
 * Inverse of `splitBlocks` — reassemble blocks into raw text. The meta
 * comment, if any, is appended to the block on its own line.
 */
export function joinBlocks(blocks: Block[]): string {
  return blocks
    .map(({ lines, meta }) => {
      const c = formatBlockMeta(meta)
      if (!c) return lines.join('\n')
      return [...lines, c].join('\n')
    })
    .join('\n\n')
}

/**
 * Render the meta comment string, or `null` if there is nothing to write.
 */
export function formatBlockMeta(meta: BlockMeta): string | null {
  if (!meta.id) {
    if (meta.color || meta.bg) {
      // ponytail: an id is required to carry meta, but the user picked a
      // color before the menu assigned one. We give the block an id here
      // — the same call site that picked the color will then have a
      // stable reference for Copy link to block too.
      meta = { ...meta, id: newBlockId() }
    } else {
      return null
    }
  }
  const parts = [`mkf:b:${meta.id}`]
  if (meta.color && meta.color !== 'default') parts.push(`color:${meta.color}`)
  if (meta.bg && meta.bg !== 'default') parts.push(`bg:${meta.bg}`)
  return `<!-- ${parts.join(' ')} -->`
}

/**
 * Make sure a paragraph ends with a `mkf:b:<id>` comment, assigning one
 * if needed. Returns the rewritten paragraph and the new meta (so the
 * caller can know the id without re-parsing).
 */
export function ensureBlockHasId(paragraph: string): { text: string; meta: BlockMeta } {
  const { lines, meta } = peelMeta(paragraph.split('\n'))
  if (meta.id) return { text: paragraph, meta }
  const next: BlockMeta = { ...meta, id: newBlockId() }
  const comment = formatBlockMeta(next)
  if (!comment) return { text: paragraph, meta }
  const rebuilt = [...lines, comment].join('\n')
  return { text: rebuilt, meta: next }
}

/**
 * The first markdown prefix of the block, or `null` for plain text.
 * "List" types group consecutive same-prefix lines.
 */
export function detectBlockType(lines: string[]): 'text' | 'h1' | 'h2' | 'h3' | 'h4' | 'bullet' | 'numbered' | 'todo' | 'quote' | 'code' {
  const first = lines[0] ?? ''
  if (/^```/.test(first)) return 'code'
  if (/^# /.test(first)) return 'h1'
  if (/^## /.test(first)) return 'h2'
  if (/^### /.test(first)) return 'h3'
  if (/^#### /.test(first)) return 'h4'
  if (/^- \[[ x]\] /.test(first)) return 'todo'
  if (/^[-*+] /.test(first)) return 'bullet'
  if (/^\d+\. /.test(first)) return 'numbered'
  if (/^> /.test(first)) return 'quote'
  return 'text'
}

export function blockTypeLabel(type: ReturnType<typeof detectBlockType>): string {
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

const PREFIX_BY_TYPE: Record<ReturnType<typeof detectBlockType>, string> = {
  text: '',
  h1: '# ',
  h2: '## ',
  h3: '### ',
  h4: '#### ',
  bullet: '- ',
  numbered: '1. ',
  todo: '- [ ] ',
  quote: '> ',
  code: '```',
}

const NUMBERED_RE = /^\d+\. /
const BULLET_RE = /^[-*+] /
const TODO_RE = /^- \[[ x]\] /

/**
 * Convert a block to a different type, preserving the prose.
 *
 * - Strips the old prefix from line 0.
 * - Applies the new prefix to every non-blank line.
 * - For `code`, opens with ` ``` ` and closes with ` ``` ` on its own line.
 */
export function retypeBlock(lines: string[], type: ReturnType<typeof detectBlockType>): string[] {
  const stripPrefix = (line: string) =>
    line.replace(/^#{1,4} /, '')
      .replace(NUMBERED_RE, '')
      .replace(BULLET_RE, '')
      .replace(TODO_RE, '')
      .replace(/^> /, '')
      .replace(/^```\w*\s*$/, '')

  const stripped = lines.map(stripPrefix)
  const prefix = PREFIX_BY_TYPE[type]
  if (type === 'code') {
    return ['```', ...stripped, '```']
  }
  return stripped.map((line) => (line.length === 0 ? '' : `${prefix}${line}`))
}

/**
 * Words as a person would count them, not the raw split length.
 *
 * Skips code fences, link syntax, and the markdown markers themselves.
 * Stops at the first meta comment line so the id does not get counted.
 */
export function wordCount(text: string): number {
  // Strip the meta comment if it is the last line.
  const lines = text.split('\n')
  const withoutMeta = (() => {
    const last = lines[lines.length - 1] ?? ''
    if (BLOCK_META_RE.test(last)) return lines.slice(0, -1).join('\n')
    return text
  })()

  // Remove fenced code blocks.
  const noFences = withoutMeta.replace(/```[\s\S]*?```/g, ' ')

  // Replace wikilinks and inline links with their visible text.
  const noLinks = noFences
    .replace(/!?\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]*))?\]\]/g, (_m, t: string, a?: string) => a || t)
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')

  // Drop markdown markers and count whitespace-separated tokens.
  const tokens = noLinks
    .replace(/[#>*_`~]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^[-*+.]+$/.test(t))

  return tokens.length
}

// ponytail: one runnable self-check. Runs only under `node lib/blocks.ts`
// or via the small `if (require.main === module)` block at the bottom.
// Fails loudly if a refactor breaks the basic round-trip — the menu
// depends on this exactly.
if (typeof require !== 'undefined' && require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const assert = require('node:assert/strict')

  const sample = [
    '# Project A',
    '',
    'first paragraph',
    'spans two lines',
    '',
    '- item one',
    '- item two',
    '',
    'last paragraph with <!-- mkf:b:a3f2kq18 color:red bg:yellow -->',
  ].join('\n')

  const blocks = splitBlocks(sample)
  assert.equal(blocks.length, 4, 'expected 4 blocks')
  assert.equal(blocks[0].meta.id, undefined, 'block 0 has no id')
  assert.equal(blocks[1].lines.length, 2, 'block 1 is 2 lines')
  assert.equal(blocks[3].meta.id, 'a3f2kq18', 'block 3 has id a3f2kq18')
  assert.equal(blocks[3].meta.color, 'red', 'block 3 color red')
  assert.equal(blocks[3].meta.bg, 'yellow', 'block 3 bg yellow')

  // Inline form normalises to standalone form on output — that is the
  // contract the editor and reading view rely on.
  const reassembled = joinBlocks(blocks)
  const expected = [
    '# Project A',
    '',
    'first paragraph',
    'spans two lines',
    '',
    '- item one',
    '- item two',
    '',
    'last paragraph with',
    '<!-- mkf:b:a3f2kq18 color:red bg:yellow -->',
  ].join('\n')
  assert.equal(reassembled, expected, 'round-trip normalises inline to standalone')

  const ensured = ensureBlockHasId('plain text')
  assert.ok(ensured.meta.id, 'ensureBlockHasId assigns an id')
  assert.ok(ensured.text.endsWith('-->'), 'ensureBlockHasId appends a comment')

  assert.equal(detectBlockType(['# Title']), 'h1', 'h1 detected')
  assert.equal(detectBlockType(['- item']), 'bullet', 'bullet detected')
  assert.equal(detectBlockType(['> quote']), 'quote', 'quote detected')
  assert.equal(detectBlockType(['just text']), 'text', 'text detected')

  const turned = retypeBlock(['# old heading', 'body'], 'bullet')
  assert.deepEqual(turned, ['- old heading', '- body'], 'retype into bullet')

  const wc = wordCount('hello **world** `code` [[Other]] end')
  assert.equal(wc, 5, 'word count skips markers, keeps 5 prose words')

  console.log('lib/blocks.ts: ok')
}
