/**
 * Self-check for the cross-doc block move helper used by the
 * "Move to" submenu (see components/workspace/workspace-app.tsx →
 * `moveBlockTo`). The helper is pure markdown in / markdown out; we
 * can exercise it in Node without CodeMirror or jsdom.
 *
 * Run with: npx tsx scripts/check-move-block.ts
 */
import assert from 'node:assert/strict'
import { joinBlocks, moveBlockBetweenDocs, splitBlocks } from '../lib/blocks'

const src = joinBlocks([
  { lines: ['First paragraph.'], meta: {} },
  { lines: ['## Second (heading).'], meta: {} },
  { lines: ['Third with id.'], meta: { id: 'abc123' } },
  { lines: ['Fourth bullet', '- sub', '- sub2'], meta: {} },
])
const dest = joinBlocks([{ lines: ['Existing dest line.'], meta: {} }])

function ok(label: string): void {
  console.log('OK:', label)
}

// 1. Move the first block.
{
  const r = moveBlockBetweenDocs(src, 0, dest)
  assert(r, 'move index 0 returns a result')
  assert.equal(
    r.remainder,
    joinBlocks(splitBlocks(src).filter((_, i) => i !== 0)),
    'remainder drops the first block'
  )
  assert.equal(
    r.newDest,
    `${dest}\n\n${joinBlocks([splitBlocks(src)[0]!])}`,
    'newDest appends the first block'
  )
  ok('moves first block')
}

// 2. Move a middle block.
{
  const r = moveBlockBetweenDocs(src, 2, dest)
  assert(r, 'move index 2 returns a result')
  const expectedRemainder = joinBlocks(splitBlocks(src).filter((_, i) => i !== 2))
  assert.equal(r.remainder, expectedRemainder)
  const expectedNewDest = `${dest}\n\n${joinBlocks([splitBlocks(src)[2]!])}`
  assert.equal(r.newDest, expectedNewDest)
  ok('moves middle block; keeps id and trailing comment intact')
  assert.equal(r.block.meta.id, 'abc123', 'id survives the move')
}

// 3. Move the last block.
{
  const r = moveBlockBetweenDocs(src, 3, dest)
  assert(r, 'move index 3 returns a result')
  assert.equal(r.remainder, joinBlocks(splitBlocks(src).slice(0, 3)))
  ok('moves last block')
}

// 4. Empty dest: newDest equals the moved block alone (no leading blank).
{
  const r = moveBlockBetweenDocs(src, 0, '')
  assert(r, 'move into empty dest returns a result')
  assert.equal(r.newDest, joinBlocks([splitBlocks(src)[0]!]))
  ok('empty dest → newDest has no leading blank lines')
}

// 5. Out-of-range index returns null.
{
  const r = moveBlockBetweenDocs(src, 99, dest)
  assert.equal(r, null)
  ok('out-of-range index → null')
}

// 6. Block text from `block` field is identical to the source block
// (so the caller can show the user what was actually moved).
{
  const r = moveBlockBetweenDocs(src, 2, dest)
  assert(r, 'returns a result for index 2')
  const expected = joinBlocks([splitBlocks(src)[2]!])
  assert.equal(joinBlocks([r.block]), expected, 'returned block text matches the source block')
  ok('returned block text equals the source block')
}

console.log('OK')
