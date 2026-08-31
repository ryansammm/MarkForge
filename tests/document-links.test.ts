import { classifyHref, resolveRelativePath } from '../lib/resolve-link'
import type { MarkdownDocument } from '../lib/file-store'

/**
 * Ordinary Markdown link suite.
 *
 * The reading view used to render every `[text](href)` that was not a wikilink as
 * `<a target="_blank">`. For a link to another note — `[the notes](Dev Notes.md)`,
 * which is what a document written in Obsidian or by hand actually contains — that
 * asked the browser to open a filename as a URL: a new browser tab, outside the
 * workspace, showing nothing.
 *
 * So the property under test is the classification, and specifically its two edges:
 *
 *   - a link that really does point at the web must still be treated as external,
 *     because taking `https://…` in-app would be the same bug in reverse
 *   - a link to a document must resolve the way the rest of the app resolves things:
 *     by path first, then by name, so `[[Dev Notes]]` and `[x](Dev Notes)` land in
 *     the same place
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

function doc(path: string, title: string, extra: Partial<MarkdownDocument> = {}): MarkdownDocument {
  return { path, title, frontmatter: {}, outboundLinks: [], ...extra }
}

const documents: Record<string, MarkdownDocument> = {}
for (const entry of [
  doc('GDI/PTVI/GH/GH - Dev Notes.md', 'GH - Dev Notes'),
  doc('GDI/PTVI/GH/GH - Meeting Notes.md', 'GH - Meeting Notes'),
  doc('GDI/PTVI/Task List.md', 'Task List'),
  doc('Xyks/MarkForge Project.md', 'MarkForge Project'),
]) {
  documents[entry.path] = entry
}

const FROM = 'GDI/PTVI/GH/GH - Dev Notes.md'
const kind = (href: string, from: string | null = FROM) => classifyHref(href, from, documents).kind

export function runDocumentLinkTests(): boolean {
  console.log('Markdown link destination suite\n')

  console.log('links that belong to the browser')

  check('http and https stay external', () => {
    equal(kind('https://example.com/x'), 'external', 'an https link was captured by the app')
    equal(kind('http://example.com'), 'external', 'an http link was captured by the app')
  })

  check('other schemes stay external', () => {
    for (const href of ['mailto:someone@example.com', 'tel:+62211234', 'data:text/plain,hi']) {
      equal(kind(href), 'external', `${href} was not left to the browser`)
    }
  })

  check('a protocol-relative or rooted URL stays external', () => {
    // A rooted path is a URL into the deployment, not a vault path — `public/` is
    // served that way, and `resolveImageSrc` leaves these alone for the same reason.
    equal(kind('//cdn.example.com/x.png'), 'external', 'a protocol-relative URL was captured')
    equal(kind('/login'), 'external', 'a rooted path was captured')
  })

  console.log('')
  console.log('links inside the document')

  check('a bare fragment is an anchor, not a navigation', () => {
    const destination = classifyHref('#getting-started', FROM, documents)
    equal(destination, { kind: 'anchor', hash: 'getting-started' }, 'wrong destination for a fragment')
  })

  console.log('')
  console.log('links to other documents')

  check('a sibling file resolves', () => {
    const destination = classifyHref('GH - Meeting Notes.md', FROM, documents)
    equal(
      destination,
      { kind: 'document', path: 'GDI/PTVI/GH/GH - Meeting Notes.md' },
      'a link to the note next door did not resolve'
    )
  })

  check('./ and ../ are honoured', () => {
    equal(
      classifyHref('./GH - Meeting Notes.md', FROM, documents),
      { kind: 'document', path: 'GDI/PTVI/GH/GH - Meeting Notes.md' },
      './ did not resolve'
    )
    equal(
      classifyHref('../Task List.md', FROM, documents),
      { kind: 'document', path: 'GDI/PTVI/Task List.md' },
      '../ did not resolve'
    )
    equal(
      classifyHref('../../../Xyks/MarkForge Project.md', FROM, documents),
      { kind: 'document', path: 'Xyks/MarkForge Project.md' },
      'a walk back to the root did not resolve'
    )
  })

  check('percent-encoded spaces resolve', () => {
    // What an editor writes when it escapes a filename for you.
    equal(
      classifyHref('GH%20-%20Meeting%20Notes.md', FROM, documents),
      { kind: 'document', path: 'GDI/PTVI/GH/GH - Meeting Notes.md' },
      'an escaped filename did not resolve'
    )
  })

  check('a fragment on another document still opens that document', () => {
    equal(
      classifyHref('../Task List.md#today', FROM, documents),
      { kind: 'document', path: 'GDI/PTVI/Task List.md' },
      'the fragment prevented the document from resolving'
    )
  })

  check('a name resolves the way a wikilink does', () => {
    // `[the list](Task List)` and `[[Task List]]` have to land in the same place, or
    // the two link syntaxes disagree about what a workspace contains.
    equal(
      classifyHref('Task List', FROM, documents),
      { kind: 'document', path: 'GDI/PTVI/Task List.md' },
      'a bare title did not resolve'
    )
  })

  check('a relative link with nothing behind it is a ghost', () => {
    equal(
      classifyHref('Nothing Here.md', FROM, documents),
      { kind: 'missing', target: 'Nothing Here' },
      'an unresolved link was not reported as a ghost'
    )
  })

  check('a link from a root document resolves', () => {
    equal(
      classifyHref('Xyks/MarkForge Project.md', 'Warisan Projek.md', documents),
      { kind: 'document', path: 'Xyks/MarkForge Project.md' },
      'a link from the workspace root did not resolve'
    )
  })

  console.log('')
  console.log('path resolution')

  check('.. never climbs past the workspace root', () => {
    // There is nothing above the root. Honouring the climb would build a path no
    // lookup can ever match, which would turn a resolvable link into a ghost.
    equal(resolveRelativePath('a/b.md', '../../../c.md'), 'c.md', 'climbed out of the workspace')
  })

  check('redundant segments collapse', () => {
    equal(resolveRelativePath('a/b/c.md', './/.././d.md'), 'a/d.md', 'wrong resolution')
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
  process.exit(runDocumentLinkTests() ? 0 : 1)
}
