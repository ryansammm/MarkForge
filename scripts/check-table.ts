// Self-check for table rendering in the read view.
// Verifies:
//   1. A markdown pipe table parses to a `table` mdast node through
//      the same plugin chain the doc viewer uses (parse + gfm +
//      breaks + block-color + toggle-list).
//   2. The table has 2 rows (header + 1 body) and 2 columns.
//   3. The header text round-trips through stripBlockComments
//      unchanged (the meta-strip pass must not eat the separator
//      row's `---` cell content).
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { remarkBlockColor } from '../lib/markdown/annotate-block-color'
import { remarkToggleList } from '../lib/markdown/remark-toggle-list'
import { stripBlockComments } from '../lib/markdown/strip-block-comments'
import assert from 'node:assert/strict'

const source = [
  '| name | value |',
  '| --- | --- |',
  '| alpha | 1 |',
  '| beta | 2 |',
].join('\n')

async function main() {
  // stripBlockComments must be a no-op on a pipe table (the `---` in
  // cell content would otherwise be misread as a block-id comment).
  const stripped = stripBlockComments(source)
  assert.equal(stripped, source, 'stripBlockComments must not touch pipe tables')

  // We don't import vfile directly (it isn't in package.json). Build
  // a tiny shim with just the `toString()` the plugins need.
  const fileShim = { toString: () => source, path: 'check.md' }
  const proc = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkBlockColor(source))
    .use(remarkToggleList)
  const tree = (await proc.run(proc.parse(fileShim as never), fileShim as never)) as unknown as {
    children: { type: string; children?: { type: string }[] }[]
  }

  // First child is the table.
  const table = tree.children[0]
  assert.ok(table, 'expected a top-level node')
  assert.equal(table.type, 'table', `expected table, got ${table.type}`)

  if (process.env.DUMP_TREE) {
    console.log(JSON.stringify(table, null, 2))
  }

  // Table rows are flat — remark-gfm emits a `table` with `tableRow`
  // children directly, no `thead`/`tbody` wrapper. The first row is
  // the header.
  const rows = (table.children ?? []) as unknown as { children: { children: { value?: string }[] }[] }[]
  assert.ok(rows.length >= 3, `expected at least 3 rows (header + 2 body), got ${rows.length}`)

  // Header cell text round-trips.
  const headerText = rows[0]?.children?.[0]?.children?.[0]?.value
  assert.equal(headerText, 'name', `expected header 'name', got '${headerText}'`)

  // First body row cell text round-trips.
  const bodyText = rows[1]?.children?.[0]?.children?.[0]?.value
  assert.equal(bodyText, 'alpha', `expected body 'alpha', got '${bodyText}'`)

  console.log('table self-check: OK (parse + stripBlockComments + round-trip)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
