import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import type { Root, Parent, RootContent } from 'mdast'
import { WIKILINK_PATTERN, formatWikiLink } from './wikilink'

/**
 * Locating and rewriting wikilinks *in the source text*, by byte offset.
 *
 * Sprint 4's rename has to rewrite links inside documents the user may never have
 * opened in this app. Doing that by parse -> modify -> serialize would reformat the
 * entire file as a side effect: bullets, emphasis markers, table padding, escapes.
 * For a rename touching a dozen notes that is a dozen documents silently
 * reformatted, which is precisely the invasive normalization PRD Q5 promises not to
 * do — and the fastest way to stop trusting the tool.
 *
 * So links are found by offset and spliced. Every byte that is not part of a
 * rewritten link is preserved exactly, including the ones remark would have
 * "corrected".
 */

export interface WikiLinkOccurrence {
  /** Offset of the opening `[` in the source. */
  start: number
  /** Offset just past the closing `]`. */
  end: number
  target: string
  alias: string | null
  /** The exact source text, e.g. `[[Target|alias]]`. */
  raw: string
}

const scanner = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml'])

interface Range {
  start: number
  end: number
}

/**
 * Source ranges covered by code, where `[[x]]` is a code sample rather than a link.
 *
 * Frontmatter is deliberately *not* excluded: `related: "[[Other]]"` is a real edge
 * in the graph and Obsidian treats it as one.
 */
function codeRanges(markdown: string): Range[] {
  const ranges: Range[] = []

  function walk(node: Root | Parent): void {
    if (!('children' in node) || !Array.isArray(node.children)) return
    for (const child of node.children as RootContent[]) {
      if ((child.type === 'code' || child.type === 'inlineCode') && child.position) {
        ranges.push({
          start: child.position.start.offset ?? 0,
          end: child.position.end.offset ?? 0,
        })
      }
      if ('children' in child) walk(child as Parent)
    }
  }

  try {
    walk(scanner.parse(markdown) as Root)
  } catch {
    // A document remark cannot parse still gets its links found; it just does not
    // get code exclusion. Better than refusing to rename.
  }

  return ranges
}

function isInside(ranges: Range[], start: number, end: number): boolean {
  return ranges.some((range) => start >= range.start && end <= range.end)
}

/** Every wikilink in the document, in source order, with offsets. */
export function findWikiLinks(markdown: string): WikiLinkOccurrence[] {
  const excluded = codeRanges(markdown)
  const found: WikiLinkOccurrence[] = []

  WIKILINK_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WIKILINK_PATTERN.exec(markdown)) !== null) {
    const target = match[1].trim()
    if (!target) continue

    const start = match.index
    const end = start + match[0].length
    if (isInside(excluded, start, end)) continue

    found.push({
      start,
      end,
      target,
      alias: match[2] === undefined ? null : match[2],
      raw: match[0],
    })
  }

  return found
}

/** Distinct wikilink targets, in document order. The graph edges for one document. */
export function extractLinkTargets(markdown: string): string[] {
  const seen = new Set<string>()
  for (const occurrence of findWikiLinks(markdown)) seen.add(occurrence.target)
  return Array.from(seen)
}

export interface RewriteResult {
  content: string
  /** How many links were actually changed. */
  changed: number
}

/**
 * Rewrites wikilinks through `map`, splicing the source in place.
 *
 * `map` returns the replacement target, or null to leave the link alone. The alias
 * is always preserved — renaming a document must not silently change the words a
 * reader sees in a sentence.
 *
 * Splices run right-to-left so earlier offsets stay valid.
 */
export function rewriteWikiLinks(
  markdown: string,
  map: (occurrence: WikiLinkOccurrence) => string | null
): RewriteResult {
  const occurrences = findWikiLinks(markdown)
  let content = markdown
  let changed = 0

  for (let i = occurrences.length - 1; i >= 0; i--) {
    const occurrence = occurrences[i]
    const replacementTarget = map(occurrence)
    if (replacementTarget === null || replacementTarget === occurrence.target) continue

    const replacement = formatWikiLink(replacementTarget, occurrence.alias)
    content = content.slice(0, occurrence.start) + replacement + content.slice(occurrence.end)
    changed++
  }

  return { content, changed }
}

function needles(targets: string | string[]): Set<string> {
  const list = Array.isArray(targets) ? targets : [targets]
  return new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))
}

/**
 * Retargets every link pointing at any of `fromTargets` to `toTarget`.
 *
 * Takes a set because a document can be linked by more than one name: its title and
 * its filename are both valid wikilink targets, and a rename has to catch both or it
 * leaves half the graph behind.
 *
 * Matching is case-insensitive because resolution is: someone who wrote
 * `[[principles]]` meant the document titled `Principles`, and a rename that left
 * their link behind would be a bug they would rightly blame on the app.
 */
export function retargetWikiLinks(
  markdown: string,
  fromTargets: string | string[],
  toTarget: string
): RewriteResult {
  const from = needles(fromTargets)
  return rewriteWikiLinks(markdown, (occurrence) =>
    from.has(occurrence.target.toLowerCase()) ? toTarget : null
  )
}

/** How many links in this document point at any of `targets`. */
export function countLinksTo(markdown: string, targets: string | string[]): number {
  const from = needles(targets)
  return findWikiLinks(markdown).filter((o) => from.has(o.target.toLowerCase())).length
}
