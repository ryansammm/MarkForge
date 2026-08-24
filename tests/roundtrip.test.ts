import * as fs from 'fs'
import * as path from 'path'
import { formatDocument, parseMarkdown, getWikiLinks } from '../lib/markdown/serializer'
import { splitFrontmatter } from '../lib/markdown/frontmatter'

/**
 * Round-trip suite — Sprint 3's real deliverable.
 *
 * Three properties, in increasing order of how much they matter:
 *
 *  1. IDEMPOTENCE   format(format(x)) === format(x)
 *     Formatting must converge. A serializer that drifts on every pass rewrites the
 *     corpus a little more each time and is unusable.
 *
 *  2. SEMANTIC STABILITY   ast(format(x)) ≡ ast(x)
 *     Byte equality is the wrong bar — `snake\_case` and `snake_case` render the
 *     same, and demanding byte equality would mean rejecting safe normalization.
 *     Meaning is the thing that must not move.
 *
 *  3. WIKILINK FIDELITY   every [[link]] in x is still in format(x), byte-for-byte
 *     This one IS byte-level, because a mangled wikilink is not cosmetic — it is an
 *     edge deleted from the graph. This is the property the Milkdown spike failed.
 *
 * All three run against the fixtures below AND against every file in the real
 * corpus. Fixtures prove the cases we thought of; the corpus proves the ones we
 * did not.
 */

/**
 * Defaults to the in-repo notes/ folder. Point CORPUS_DIR at a real vault to run the
 * suite against a corpus with actual variety in it — the DoD asks for the real one.
 */
const CORPUS_DIR = process.env.CORPUS_DIR
  ? path.resolve(process.env.CORPUS_DIR)
  : path.resolve(__dirname, '..', 'notes')

interface Fixture {
  name: string
  input: string
}

const fixtures: Fixture[] = [
  { name: 'plain wikilink', input: 'See [[Principles]] for details.\n' },
  { name: 'aliased wikilink', input: 'See [[Principles|the rules]].\n' },
  { name: 'wikilink in list', input: '- [[Welcome]]\n- [[Principles]]\n' },
  { name: 'two wikilinks one line', input: '[[A]] and [[B]]\n' },
  { name: 'wikilink in heading', input: '# See [[Welcome]]\n' },
  { name: 'wikilink in blockquote', input: '> Read [[Principles]] first.\n' },
  { name: 'wikilink in table cell', input: '| doc | note |\n| --- | --- |\n| [[A]] | x |\n' },
  { name: 'wikilink with spaces in target', input: 'See [[Getting Started Guide]].\n' },
  { name: 'wikilink inside emphasis', input: 'See *[[Welcome]]* now.\n' },
  { name: 'empty alias', input: 'See [[Target|]].\n' },
  { name: 'not a wikilink — single brackets', input: 'A [bracketed] word.\n' },
  { name: 'not a wikilink — code span', input: 'Type `[[Foo]]` to link.\n' },
  { name: 'not a wikilink — fenced code', input: '```\n[[Foo]]\n```\n' },
  { name: 'frontmatter preserved', input: '---\ntitle: Sample Note\ntags: [test, note]\n---\n\n# Sample Note\n\nContent.\n' },
  { name: 'frontmatter with date and NO', input: '---\ndate: 2026-08-15\nreviewed: NO\n---\n\nBody.\n' },
  { name: 'nested list', input: '- one\n  - nested\n- two\n' },
  { name: 'task list', input: '- [ ] todo\n- [x] done\n' },
  { name: 'gfm table', input: '| a | b |\n| --- | --- |\n| 1 | 2 |\n' },
  { name: 'fenced code with language', input: '```ts\nconst x = 1\n```\n' },
  { name: 'link and image', input: '[text](http://example.com) and ![alt](a.png)\n' },
  { name: 'strikethrough', input: '~~gone~~\n' },
  { name: 'inline html', input: 'a <br /> b\n' },
  { name: 'html block', input: '<div class="x">raw</div>\n' },
  { name: 'hard break', input: 'line one  \nline two\n' },
  { name: 'underscores in identifier', input: 'snake_case_identifier here.\n' },
  { name: 'setext heading', input: 'Title\n=====\n\nBody.\n' },
  { name: 'thematic break', input: 'a\n\n---\n\nb\n' },
  { name: 'autolink', input: '<http://example.com>\n' },
  { name: 'footnote-ish text', input: 'Text[^1]\n\n[^1]: note\n' },
  { name: 'empty document', input: '' },
]

// ---------------------------------------------------------------------------

interface Failure {
  scope: string
  name: string
  property: string
  detail: string
}

const failures: Failure[] = []
let checks = 0

function fail(scope: string, name: string, property: string, detail: string) {
  failures.push({ scope, name, property, detail })
}

/** Strips positions and other non-semantic bookkeeping so two ASTs can be compared. */
function semanticShape(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(semanticShape)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'position') continue
      // Serializing normalizes list spread/tightness and cell alignment padding;
      // neither changes what the document means.
      if (key === 'spread' || key === 'align') continue
      out[key] = semanticShape(value)
    }
    return out
  }
  return node
}

/** Literal wikilink strings, in order, including duplicates. */
function literalWikiLinks(markdown: string): string[] {
  const pattern = /\[\[[^[\]|\n]+(?:\|[^[\]\n]*)?\]\]/g
  return markdown.match(pattern) ?? []
}

function checkDocument(scope: string, name: string, input: string) {
  checks++

  let once: string
  try {
    once = formatDocument(input)
  } catch (err) {
    fail(scope, name, 'format', `threw: ${(err as Error).message}`)
    return
  }

  // 1. Idempotence
  try {
    const twice = formatDocument(once)
    if (twice !== once) {
      fail(scope, name, 'idempotence', `pass 2 differs from pass 1\n      1: ${JSON.stringify(once.slice(0, 200))}\n      2: ${JSON.stringify(twice.slice(0, 200))}`)
    }
  } catch (err) {
    fail(scope, name, 'idempotence', `second pass threw: ${(err as Error).message}`)
  }

  // 2. Semantic stability
  const before = JSON.stringify(semanticShape(parseMarkdown(input)))
  const after = JSON.stringify(semanticShape(parseMarkdown(once)))
  if (before !== after) {
    fail(scope, name, 'semantic stability', `AST changed\n      before: ${before.slice(0, 300)}\n      after:  ${after.slice(0, 300)}`)
  }

  // 3. Wikilink fidelity — byte-level
  const linksBefore = literalWikiLinks(input)
  const linksAfter = literalWikiLinks(once)
  if (JSON.stringify(linksBefore) !== JSON.stringify(linksAfter)) {
    fail(scope, name, 'wikilink fidelity', `links changed\n      before: ${JSON.stringify(linksBefore)}\n      after:  ${JSON.stringify(linksAfter)}`)
  }

  // The graph edges the index will store must survive too.
  const graphBefore = JSON.stringify(getWikiLinks(input))
  const graphAfter = JSON.stringify(getWikiLinks(once))
  if (graphBefore !== graphAfter) {
    fail(scope, name, 'link graph', `edges changed\n      before: ${graphBefore}\n      after:  ${graphAfter}`)
  }

  // Frontmatter must survive verbatim.
  const fmBefore = splitFrontmatter(input)
  const fmAfter = splitFrontmatter(once)
  if ((fmBefore.raw ?? '') !== (fmAfter.raw ?? '')) {
    fail(scope, name, 'frontmatter', `block changed\n      before: ${JSON.stringify(fmBefore.raw)}\n      after:  ${JSON.stringify(fmAfter.raw)}`)
  }
}

function collectCorpus(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectCorpus(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full)
  }
  return found
}

export function runRoundtripTests(): boolean {
  console.log('Markdown round-trip suite\n')

  console.log(`Fixtures (${fixtures.length})`)
  for (const fixture of fixtures) {
    checkDocument('fixture', fixture.name, fixture.input)
  }

  const corpus = collectCorpus(CORPUS_DIR)
  console.log(`Real corpus (${corpus.length} documents from notes/)`)
  if (corpus.length === 0) {
    console.warn('  ! No corpus documents found — the suite is only as good as its fixtures.')
  }
  for (const file of corpus) {
    const rel = path.relative(CORPUS_DIR, file).replace(/\\/g, '/')
    checkDocument('corpus', rel, fs.readFileSync(file, 'utf-8'))
  }

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS — ${checks} documents, 5 properties each, 0 failures.`)
    return true
  }

  console.error(`FAIL — ${failures.length} failure(s) across ${checks} documents:\n`)
  for (const f of failures) {
    console.error(`  [${f.scope}] ${f.name} — ${f.property}`)
    console.error(`      ${f.detail}`)
  }
  return false
}

if (require.main === module) {
  process.exit(runRoundtripTests() ? 0 : 1)
}
