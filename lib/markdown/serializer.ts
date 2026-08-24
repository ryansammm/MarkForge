import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import type { Root, RootContent, Parent, Heading } from 'mdast'
import type { Options as StringifyOptions } from 'mdast-util-to-markdown'
import { remarkWikiLink, wikiLinkToMarkdown, type WikiLink } from './wikilink'

/**
 * The canonical shape of a document this app has formatted.
 *
 * These are deliberately the conventions already in the corpus (Obsidian-flavoured
 * Markdown), so that formatting an existing note is as close to a no-op as the
 * serializer can make it.
 */
export const CANONICAL_STRINGIFY_OPTIONS: StringifyOptions = {
  bullet: '-',
  listItemIndent: 'one',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
  rule: '-',
  ruleSpaces: false,
  ruleRepetition: 3,
  setext: false,
  tightDefinitions: true,
  resourceLink: false,
  incrementListMarker: true,
  handlers: {
    wikiLink: wikiLinkToMarkdown,
  },
}

function basePipeline() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkWikiLink)
}

const readPipeline = basePipeline()
const writePipeline = basePipeline().use(remarkStringify, CANONICAL_STRINGIFY_OPTIONS)

/** Markdown text -> mdast, with wikilinks lifted into real nodes. */
export function parseMarkdown(markdown: string): Root {
  const tree = readPipeline.parse(markdown)
  return readPipeline.runSync(tree) as Root
}

/** mdast -> canonical Markdown text. */
export function serializeMarkdown(tree: Root): string {
  return writePipeline.stringify(tree)
}

/**
 * Rewrites a document into canonical form.
 *
 * NOTE: this is never on the save path. The editor writes its buffer verbatim —
 * see docs/sprint-3-editor-decision.md. This runs only when the user explicitly
 * asks to format a document, and is the serializer Sprint 4's link rewriting will
 * run through.
 */
export function formatDocument(markdown: string): string {
  return serializeMarkdown(parseMarkdown(markdown))
}

function walk(node: Root | Parent, visit: (node: RootContent) => void): void {
  if (!('children' in node) || !Array.isArray(node.children)) return
  for (const child of node.children) {
    visit(child as RootContent)
    if ('children' in child) walk(child as Parent, visit)
  }
}

/**
 * Wikilink targets for a document, in document order, deduplicated.
 *
 * Delegates to the offset-based scanner so that the links the index records and the
 * links a rename rewrites are found by one implementation. Two implementations of
 * "what counts as a link" would eventually disagree, and the symptom would be a
 * rename that misses an edge the backlinks panel is still showing.
 */
export { extractLinkTargets as getWikiLinks } from './links'

/** The visible text of a heading, wikilinks counted by their target. */
function headingText(node: Heading): string {
  return node.children
    .map((c) => ('value' in c ? String(c.value) : c.type === 'wikiLink' ? (c as WikiLink).target : ''))
    .join('')
    .trim()
}

/**
 * The H1 a document's title comes from, as a node.
 *
 * Deliberately the parsed tree rather than a scan for `^# `: a `# ` inside a fenced
 * code block is a shell comment, and treating it as the document's title — or worse,
 * rewriting it during a rename — would be a lie about what the file says.
 */
function firstHeadingNode(tree: Root): Heading | null {
  let found: Heading | null = null
  walk(tree, (node) => {
    if (found === null && node.type === 'heading' && node.depth === 1 && headingText(node)) {
      found = node
    }
  })
  return found
}

/** First H1 in the body, if there is one. Used for title derivation. */
export function getFirstHeading(markdown: string): string | null {
  const node = firstHeadingNode(parseMarkdown(markdown))
  return node ? headingText(node) : null
}

/**
 * Rewrites the H1 a document is titled by, when it still says `expected`.
 *
 * Renaming a file does not, on its own, change what the app calls the document:
 * `deriveTitle` prefers the first H1 over the filename, so `GH - Dev Notes.md`
 * renamed to `Dev Notes.md` kept showing "GH - Dev Notes" in the sidebar, the tab
 * strip, the breadcrumb and the reading view. The rename looked like it had not
 * happened — while it *had* rewritten every inbound `[[GH - Dev Notes]]` to point at
 * the new name.
 *
 * So the heading moves with the file. Narrowly:
 *
 *   - Only when the heading still reads exactly what the document was titled. A
 *     heading that says something else is prose, and prose is not ours to edit.
 *   - Only the heading. The rest of the file, including a `# ` in a code fence and
 *     any later H1, is untouched.
 *   - Never when `title:` is in frontmatter — the caller does not ask in that case,
 *     because a pinned title survives a rename by design.
 *
 * A setext heading keeps its underline; an ATX one keeps its level. This is a
 * splice at the heading's own byte offsets, not a re-serialization of the document.
 */
export function retitleFirstHeading(
  content: string,
  expected: string,
  next: string
): { content: string; changed: boolean } {
  if (expected === next) return { content, changed: false }

  const node = firstHeadingNode(parseMarkdown(content))
  if (!node || headingText(node) !== expected) return { content, changed: false }

  const from = node.position?.start.offset
  const to = node.position?.end.offset
  if (from === undefined || to === undefined) return { content, changed: false }

  const raw = content.slice(from, to)
  const replacement = raw.trimStart().startsWith('#')
    ? `# ${next}`
    : // Setext: the text is the first line and the `===` underneath stays as it is.
      raw.replace(/^[^\n]*/, next)

  return { content: content.slice(0, from) + replacement + content.slice(to), changed: true }
}
