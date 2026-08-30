/**
 * Self-check for the new block kinds (Task 3.5 of the notion-parity
 * proposal): callout (`> [!info|warn|warning|danger|success]`) and
 * toggle list (`- ` line with `type:toggle_list` meta).
 *
 * Round-trips sample documents through `splitBlocks`/`joinBlocks`,
 * `retypeBlock`, and `parseBlockMeta`/`formatBlockMeta`. Verifies the
 * detection path covers the new kinds and that the editor-side meta
 * round-trip preserves `type:toggle_list`.
 *
 * Render side (callout box, <details><summary>) is handled by the
 * doc viewer's `react-markdown` component override, which is exercised
 * by the visual Playwright smoke and a separate end-to-end check.
 *
 * Run with `pnpm tsx scripts/check-new-block-types.ts`. Exit 0 = pass.
 */
import {
  detectBlockType,
  formatBlockMeta,
  joinBlocks,
  retypeBlock,
  splitBlocks,
} from '../lib/blocks'

const failures: string[] = []
function check(label: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    console.log(`  FAIL ${label}${extra ? `  (${extra})` : ''}`)
    failures.push(label)
  }
}

console.log('blocks: Task 3.5 — new block kinds round-trip')

// --- callout detection ----------------------------------------------
check(
  'detect callout on `> [!info]` line',
  detectBlockType(['> [!info] Heads up: save first']) === 'callout'
)
check(
  'detect callout on `> [!warning]` line',
  detectBlockType(['> [!warning] Danger ahead']) === 'callout'
)
check(
  'detect callout on `> [!success]` line',
  detectBlockType(['> [!success] nice']) === 'callout'
)
check(
  'plain quote still detected as quote',
  detectBlockType(['> just a quote']) === 'quote'
)

// --- retype into callout --------------------------------------------
const quoteSrc = '> An old quote'
const calloutLines = retypeBlock(quoteSrc.split('\n'), 'callout')
const calloutOut = calloutLines.join('\n')
check(
  'retypeBlock: quote → callout emits `> [!info] ` prefix',
  calloutOut.startsWith('> [!info] '),
  calloutOut
)

// --- retype callout → text strips the marker ------------------------
const calloutBlock = splitBlocks('> [!info] hi')[0]
const out = retypeBlock(calloutBlock.lines, 'text')
check(
  'retypeBlock: callout → text strips `> [!info] ` marker',
  out.join('\n') === 'hi',
  out.join('\n')
)

// --- toggle list meta round-trip ------------------------------------
const toggleSrc = '<!-- mkf:b:abc color:gray -->\n- a toggle item\n- a second line'
const blocks = splitBlocks(toggleSrc)
const toggleBlock = blocks[0]
check(
  'parseBlockMeta reads `color:gray` from toggle block',
  toggleBlock.meta.color === 'gray',
  JSON.stringify(toggleBlock.meta)
)

// simulate a user retyping into toggle_list via turnInto: meta gets
// `type:toggle_list` set
const retypeToggle = retypeBlock(toggleBlock.lines, 'toggle_list')
const meta = { ...toggleBlock.meta, type: 'toggle_list' as const }
const roundTrip = joinBlocks([{ lines: retypeToggle, meta }])
check(
  'toggle_list round-trip preserves `- ` line',
  roundTrip.includes('- a toggle item'),
  roundTrip
)
check(
  'toggle_list round-trip emits `type:toggle_list` in block comment',
  roundTrip.includes('type:toggle_list'),
  roundTrip
)
check(
  'formatBlockMeta writes `type:toggle_list`',
  (formatBlockMeta(meta) ?? '').includes('type:toggle_list'),
  formatBlockMeta(meta) ?? ''
)

// --- retype toggle_list → bullet clears `type` ----------------------
const toggleRt = retypeBlock(retypeToggle, 'bullet')
const bulletRound = joinBlocks([{ lines: toggleRt, meta: {} }])
check(
  'retypeBlock: toggle_list → bullet drops the `type:toggle_list` flag (via turnInto clear path)',
  !bulletRound.includes('type:toggle_list'),
  bulletRound
)

if (failures.length === 0) {
  console.log('\nALL OK')
  process.exit(0)
}
console.error(`\n${failures.length} failure(s):`)
for (const f of failures) console.error(`  - ${f}`)
process.exit(1)
