import { extractHeadings } from '../lib/markdown/headings'

/**
 * Document outline suite.
 *
 * The outline's job is to be a list of places you can go. That makes two properties
 * load-bearing:
 *
 *   - **Only real headings.** A `#` line inside a fenced code block is a shell
 *     comment. Listing it puts entries in the outline that appear nowhere on the page
 *     and cannot be scrolled to — which is exactly what a real document produced.
 *   - **Slugs match the rendered ids.** The panel scrolls by element id, so its slugs
 *     have to be the ones `rehype-slug` will emit. Both sides use github-slugger;
 *     these checks pin the behaviour that makes them agree, especially duplicates.
 */

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures.push(`${name}\n      ${(err as Error).message}`)
    console.error(`  FAIL ${name}`)
    console.error(`       ${(err as Error).message}`)
  }
}

function equal(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n      expected: ${b}\n      actual:   ${a}`)
}

const titles = (body: string) => extractHeadings(body).map((h) => h.text)
const slugs = (body: string) => extractHeadings(body).map((h) => h.slug)

export function runHeadingTests(): boolean {
  console.log('Document outline suite\n')

  console.log('what counts as a heading')

  check('ATX headings are found, with their levels', () => {
    const found = extractHeadings('# One\n\ntext\n\n## Two\n\n### Three\n')
    equal(
      found.map((h) => [h.level, h.text]),
      [[1, 'One'], [2, 'Two'], [3, 'Three']],
      'wrong headings or levels'
    )
  })

  check('a comment inside a fenced code block is not a heading', () => {
    // The case from a real document: a runbook full of shell examples produced
    // outline entries like "Restore. Refuses if the target already holds documents".
    const body = [
      '## Restore from backup',
      '',
      '```bash',
      '# What is in the snapshot, and how it differs from live storage',
      'npm run backup -- --verify ./backups/x',
      '```',
      '',
      '## Taking a backup',
    ].join('\n')

    equal(titles(body), ['Restore from backup', 'Taking a backup'], 'a shell comment was listed')
  })

  check('tilde fences are respected too', () => {
    equal(titles('~~~\n# not a heading\n~~~\n\n# real\n'), ['real'], 'a tilde fence was ignored')
  })

  check('a longer fence inside a block does not end it', () => {
    const body = ['````', '```', '# still code', '```', '````', '', '# real'].join('\n')
    equal(titles(body), ['real'], 'a nested fence closed the outer block')
  })

  check('an unclosed fence swallows the rest of the document', () => {
    // The renderer treats it the same way, so the outline matching that is correct.
    equal(titles('# before\n\n```\n# inside\n'), ['before'], 'text after an open fence was listed')
  })

  check('a line of hashes with no text is not a heading', () => {
    equal(titles('#\n\n### \n\n# Real\n'), ['Real'], 'an empty heading was listed')
  })

  check('a closing sequence of hashes is not part of the text', () => {
    equal(titles('## Setup ##\n'), ['Setup'], 'trailing hashes leaked into the outline')
  })

  console.log('\nhow a heading reads')

  check('inline formatting is stripped', () => {
    // The page shows "The hard part"; an outline saying "The **hard** part" reads as
    // a rendering failure.
    equal(titles('## The **hard** part\n'), ['The hard part'], 'bold markers survived')
    equal(titles('## Use `npm run verify`\n'), ['Use npm run verify'], 'backticks survived')
  })

  check('links show their label, not their target', () => {
    equal(titles('## See [the plan](./plan.md)\n'), ['See the plan'], 'link syntax survived')
    equal(titles('## See [[Runbook|the runbook]]\n'), ['See the runbook'], 'wikilink syntax survived')
  })

  console.log('\nslugs')

  check('a slug is the lowercased, hyphenated text', () => {
    equal(slugs('## First: is it actually broken?\n'), ['first-is-it-actually-broken'], 'wrong slug')
  })

  check('duplicate headings get distinct slugs, in document order', () => {
    // github-slugger's suffixing, which is what rehype-slug emits on the page. If the
    // panel numbered them differently, the second "Notes" would scroll to the first.
    equal(slugs('## Notes\n\n## Notes\n\n## Notes\n'), ['notes', 'notes-1', 'notes-2'], 'wrong suffixes')
  })

  check('slugs are counted per document, not globally', () => {
    equal(slugs('## Notes\n'), ['notes'], 'a slugger was shared between documents')
  })

  check('the line number is kept for callers that want a position', () => {
    const [first, second] = extractHeadings('intro\n\n# One\n\ntext\n\n## Two\n')
    equal(first.line, 2, 'wrong line for the first heading')
    equal(second.line, 6, 'wrong line for the second heading')
  })

  check('a document with no headings yields nothing', () => {
    equal(extractHeadings('just prose, and a # hash mid-line\n'), [], 'found a heading that is not one')
  })

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures.`)
    return true
  }
  console.error(`FAIL — ${failures.length} failure(s) of ${passed + failures.length} checks:\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  return false
}

if (require.main === module) {
  process.exit(runHeadingTests() ? 0 : 1)
}
