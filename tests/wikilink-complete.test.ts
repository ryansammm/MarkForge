import {
  MAX_SUGGESTIONS,
  rankCandidates,
  scoreCandidate,
  toCandidate,
  type LinkCandidate,
} from '../components/workspace/wikilink-complete'
import type { MarkdownDocument } from '../lib/file-store'

/**
 * `[[` autocomplete suite.
 *
 * The bug this suite exists to keep fixed is not in the ranking — it was in the range
 * the completion source reported. Anchoring it at the `[[` made CodeMirror filter the
 * options against `[[dev` rather than `dev`, so the list appeared on `[[` and emptied
 * itself on the next keystroke. The source now anchors past the brackets and ranks
 * here instead of leaning on the default filter, so what these checks pin is the
 * behaviour that replaced it:
 *
 *   - a document is findable by its **filename** and its **folder**, not only by the
 *     title, because all three resolve (lib/resolve-link.ts)
 *   - the confident matches come first, and the fuzzy subsequence match comes last
 *   - an empty query lists everything, because that is the moment right after `[[`
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

function candidate(path: string, title: string): LinkCandidate {
  return toCandidate({
    path,
    title,
    frontmatter: {},
    outboundLinks: [],
  } as MarkdownDocument)
}

const corpus: LinkCandidate[] = [
  candidate('GDI/PTVI/GH/GH - Dev Notes.md', 'GH - Dev Notes'),
  candidate('GDI/PTVI/GH/GH - Meeting Notes.md', 'GH - Meeting Notes'),
  candidate('GDI/PTVI/Task List.md', 'Task List'),
  candidate('Sena/Morrow Project.md', 'Morrow Project'),
  // A document whose title was pinned in frontmatter and no longer matches its file.
  candidate('Sena/palword.md', 'Palworld Server'),
]

const titles = (query: string) => rankCandidates(corpus, query).map((c) => c.title)

export function runWikilinkCompleteTests(): boolean {
  console.log('Wikilink autocomplete suite\n')

  console.log('what the query finds')

  check('an empty query offers every document', () => {
    equal(rankCandidates(corpus, '').length, corpus.length, 'the list right after [[ was cut short')
  })

  check('typing narrows instead of emptying the list', () => {
    // The regression in one line: `dev` must still find something, and the document
    // whose title actually contains it has to lead. Before the fix the text handed to
    // the filter was `[[dev`, which matches nothing at all and left the popup empty.
    //
    // The list is longer than one: `dev` is also a subsequence of "Palworld Server",
    // which is what fuzzy matching means. It ranks below the literal hit and that is
    // the property worth pinning.
    const ranked = titles('dev')
    equal(ranked[0], 'GH - Dev Notes', 'a plain substring of the title did not lead')
    if (ranked.length === 0) throw new Error('the list was empty')
  })

  check('a document is findable by its filename', () => {
    // The title is pinned to "Palworld Server"; the file is palword.md. Both resolve,
    // so both have to be searchable.
    equal(titles('palword'), ['Palworld Server'], 'the filename was not searched')
  })

  check('a document is findable by its folder', () => {
    equal(titles('Sena/'), ['Morrow Project', 'Palworld Server'], 'the path was not searched')
  })

  check('case does not matter', () => {
    equal(titles('MEETING'), ['GH - Meeting Notes'], 'the match was case-sensitive')
  })

  check('a scattered subsequence still matches, last', () => {
    // `gdn` is not a substring of anything. It is in order inside "GH - Dev Notes".
    equal(titles('gdn'), ['GH - Dev Notes'], 'the fuzzy fallback did not fire')
  })

  check('a query matching nothing yields nothing', () => {
    equal(titles('zzzz'), [], 'invented a match')
  })

  console.log('')
  console.log('the order the matches arrive in')

  check('a prefix of the title beats a substring of another', () => {
    const ranked = titles('task')
    equal(ranked[0], 'Task List', 'the document whose title starts with the query was not first')
  })

  check('an exact title outranks everything', () => {
    equal(scoreCandidate(candidate('a/Notes.md', 'Notes'), 'notes'), 0, 'exact title was not tier 0')
    equal(
      scoreCandidate(candidate('a/Notes.md', 'Notes'), 'note'),
      1,
      'a title prefix was not tier 1'
    )
  })

  check('the fuzzy tier is below every literal one', () => {
    const literal = scoreCandidate(candidate('a/Dev Notes.md', 'Dev Notes'), 'notes')
    const fuzzy = scoreCandidate(candidate('a/Dev Notes.md', 'Dev Notes'), 'dns')
    if (literal === null || fuzzy === null) throw new Error('one of the two did not match at all')
    if (!(literal < fuzzy)) throw new Error(`a literal match (${literal}) did not beat a fuzzy one (${fuzzy})`)
  })

  check('ties are broken by title, so the order never wobbles', () => {
    equal(titles('gh'), ['GH - Dev Notes', 'GH - Meeting Notes'], 'equal matches came back unordered')
  })

  check('the list is capped', () => {
    const many = Array.from({ length: MAX_SUGGESTIONS + 25 }, (_, i) =>
      candidate(`bulk/Note ${i}.md`, `Note ${i}`)
    )
    equal(rankCandidates(many, '').length, MAX_SUGGESTIONS, 'the popup was handed the whole corpus')
  })

  console.log('')
  console.log('what a candidate is built from')

  check('the filename loses its extension and the folder is the parent', () => {
    const built = candidate('GDI/PTVI/GH/GH - Dev Notes.md', 'GH - Dev Notes')
    equal(built.filename, 'GH - Dev Notes', 'the .md survived')
    equal(built.folder, 'GDI/PTVI/GH', 'wrong folder')
  })

  check('a document at the root has no folder', () => {
    equal(candidate('Warisan Projek.md', 'Warisan Projek').folder, '', 'invented a folder')
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
  process.exit(runWikilinkCompleteTests() ? 0 : 1)
}
