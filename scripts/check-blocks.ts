/**
 * One runnable self-check for `lib/blocks.ts`. Run with:
 *
 *     npx tsx scripts/check-blocks.ts
 *
 * Fails loudly if a refactor breaks the basic round-trip the block
 * menu relies on (split, join, id assign, type detect, retype,
 * word count). Stays out of the source file so the Next.js bundle
 * does not pull in `node:assert` or any runtime guards.
 */

import assert from 'node:assert/strict'
import {
  splitBlocks,
  joinBlocks,
  ensureBlockHasId,
  detectBlockType,
  retypeBlock,
  wordCount,
} from '../lib/blocks'

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
