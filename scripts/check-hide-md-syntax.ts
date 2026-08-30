/**
 * Self-check for components/workspace/hide-md-syntax.ts ordering bug.
 *
 * The plugin used to add ranges in the order its regexes produced
 * them, which the CodeMirror `RangeSetBuilder` rejects with
 * "Ranges must be added sorted by `from` position and `startSide`".
 * The fix collects into an array, sorts by `from`, then adds. This
 * script proves the fix is necessary and sufficient: it constructs a
 * real `RangeSetBuilder`, feeds it the (un-sorted) ranges from a
 * markdown sample, expects the throw, then feeds the sorted ranges
 * and expects success.
 *
 * Run with: npx tsx scripts/check-hide-md-syntax.ts
 */
import assert from 'node:assert/strict'
import { RangeSetBuilder, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet } from '@codemirror/view'

const MARKER_PATTERNS: RegExp[] = [
  /\*+/g,
  /~~/g,
  /[\[\]()]/g,
  /^(\s*)(>|[-*+]|\d+\.)\s/gm,
]

// Sample chosen so the patterns' from-orders interleave: pattern 1
// (\*+) finds the asterisk late, pattern 3 (brackets) finds the
// bracket early, then pattern 1 finds another asterisk even later.
// The unsorted add sequence becomes 21, 10, 30 — the middle entry
// is out of order and the builder throws.
const SAMPLE = 'text [bracket] then *asterisk* and *another*'

function collect(text: string, from: number, to: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  for (const pattern of MARKER_PATTERNS) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(text)) !== null) {
      const start = from + m.index
      const end = start + m[0].length
      if (end > to) break
      out.push({ from: start, to: end })
    }
  }
  return out
}

function buildSorted(ranges: { from: number; to: number }[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const sorted = [...ranges].sort((a, b) => a.from - b.from)
  for (const r of sorted) {
    builder.add(r.from, r.to, Decoration.mark({ class: 'cm-md-syntax' }))
  }
  return builder.finish()
}

function buildUnsorted(ranges: { from: number; to: number }[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of ranges) {
    builder.add(r.from, r.to, Decoration.mark({ class: 'cm-md-syntax' }))
  }
  return builder.finish()
}

const ranges = collect(SAMPLE, 0, SAMPLE.length)
console.log(`collected ${ranges.length} ranges`)
console.log('unsorted froms:', ranges.map((r) => r.from).join(','))
const sortedFroms = [...ranges].sort((a, b) => a.from - b.from).map((r) => r.from)
console.log('sorted   froms:', sortedFroms.join(','))

// 1. The unsorted path MUST throw on this sample. If it doesn't, the
// test isn't exercising the bug — add a longer sample.
let unsortedThrew = false
try {
  buildUnsorted(ranges)
} catch (err) {
  unsortedThrew = true
  console.log('unsorted build threw as expected:', (err as Error).message)
}
assert(unsortedThrew, 'unsorted build should throw to demonstrate the bug')

// 2. The sorted path must succeed (no throw). DecorationSet has
// private iteration internals we don't reach into from a self-check;
// the throw/no-throw boundary is what we need to assert.
let sortedThrew = false
try {
  buildSorted(ranges)
} catch (err) {
  sortedThrew = true
  console.log('sorted build threw (UNEXPECTED):', (err as Error).message)
}
assert(!sortedThrew, 'sorted build should succeed')
console.log('sorted build ok')

// 3. Edge case: empty input → no ranges → no throw.
assert.doesNotThrow(() => buildSorted([]), 'empty input does not throw')
console.log('empty build ok')

// 4. Edge case: single range → no sorting needed → no throw.
assert.doesNotThrow(() => buildSorted([{ from: 0, to: 3 }]), 'single range does not throw')
console.log('single-range build ok')

console.log('OK')
