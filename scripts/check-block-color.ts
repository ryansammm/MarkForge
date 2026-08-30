import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, RootContent } from 'mdast'
import { remarkBlockColor } from '../lib/markdown/annotate-block-color'

/**
 * Smoke test for lib/markdown/annotate-block-color.ts. The plugin
 * must stamp each block-level node whose trailing comment carries
 * `color:X` or `bg:Y` with the corresponding `data-color` /
 * `data-bg` attribute on `hProperties`.
 *
 * Run with: npx tsx scripts/check-block-color.ts
 */

interface HProps {
  data?: { hProperties?: Record<string, unknown> }
}

function color(node: unknown): string | undefined {
  return (node as HProps).data?.hProperties?.['data-color'] as string | undefined
}
function bg(node: unknown): string | undefined {
  return (node as HProps).data?.hProperties?.['data-bg'] as string | undefined
}
function text(node: { children?: unknown[] }): string {
  const out: string[] = []
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    const obj = n as { value?: unknown; children?: unknown[] }
    if (typeof obj.value === 'string') out.push(obj.value)
    if (Array.isArray(obj.children)) for (const c of obj.children) visit(c)
  }
  for (const c of node.children ?? []) visit(c)
  return out.join('')
}

const raw = [
  'First paragraph without color.',
  '<!-- mkf:b:abc color:red -->',
  '',
  'Second paragraph with red text and yellow background.',
  '<!-- mkf:b:def color:red bg:yellow -->',
  '',
  'A heading with a blue background.',
  '# Hello',
  '<!-- mkf:b:ghi bg:blue -->',
  '',
  '> just a quote',
  '',
  'Last paragraph, no metadata.',
].join('\n')

const parsed = unified().use(remarkParse).parse(raw) as Root
const tree = unified().use(remarkParse).use(remarkBlockColor(raw)).runSync(parsed) as Root
const blocks = tree.children.filter((c): c is RootContent & { position: { start: { line: number } } } =>
  ['paragraph', 'heading', 'blockquote', 'listItem'].includes(c.type)
)

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ok  ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
    failures++
  }
}

const p1 = blocks.find((b) => b.type === 'paragraph' && text(b).startsWith('First'))
const p2 = blocks.find((b) => b.type === 'paragraph' && text(b).startsWith('Second'))
const heading = blocks.find((b) => b.type === 'heading' && text(b) === 'Hello')
const quote = blocks.find((b) => b.type === 'blockquote' && text(b).includes('just a quote'))
const pLast = blocks.find((b) => b.type === 'paragraph' && text(b).startsWith('Last'))

check('first paragraph has red color', color(p1) === 'red', `got ${color(p1)}`)
check('first paragraph has no bg', !bg(p1))
check('second paragraph has red color', color(p2) === 'red')
check('second paragraph has yellow bg', bg(p2) === 'yellow')
check('heading has no color', !color(heading))
check('heading has blue bg', bg(heading) === 'blue')
check('blockquote has no color', !color(quote))
check('blockquote has no bg', !bg(quote))
check('last paragraph has no color', !color(pLast))
check('last paragraph has no bg', !bg(pLast))

if (failures > 0) {
  console.error(`\n${failures} failure(s).`)
  process.exit(1)
}
console.log(`\nlib/markdown/annotate-block-color.ts: ok (${blocks.length} blocks checked)`)
