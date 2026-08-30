import type { MarkdownDocument } from './file-store'
import { normalizePath } from './file-store'
import { getWikiLinks, getFirstHeading } from './markdown/serializer'
import { splitFrontmatter, frontmatterTitle } from './markdown/frontmatter'

/** `aliases` in either of the two shapes people write it. */
function readAliases(frontmatter: Record<string, unknown>): string[] | undefined {
  const raw = frontmatter.aliases
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()]
  if (Array.isArray(raw)) {
    const list = raw.filter((a): a is string => typeof a === 'string' && a.trim() !== '')
    return list.length > 0 ? list : undefined
  }
  return undefined
}

/**
 * `parent` in frontmatter is the page-in-page parent id.
 *
 * Anything other than a non-empty string is treated as no parent. A typo'd
 * parent id is the caller's problem at navigation time — the index does not
 * try to validate that the referenced doc exists, because the referenced doc
 * may not have been reindexed yet.
 */
function readParentId(frontmatter: Record<string, unknown>): string | null | undefined {
  if (!('parent' in frontmatter)) return undefined
  const raw = frontmatter.parent
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return null
}

/**
 * Derives an index entry from raw file content.
 *
 * Split out from index-patch.ts so that the tree/backlink patching used by the
 * client does not drag the whole remark pipeline into the browser bundle. This
 * module is for whoever is holding the file text — the ingest CLI and the server
 * store. The client receives already-built documents in the write response.
 */

export function deriveTitle(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string
): string {
  const fromFrontmatter = frontmatterTitle(frontmatter)
  if (fromFrontmatter) return fromFrontmatter

  const heading = getFirstHeading(body)
  if (heading) return heading

  const base = normalizePath(filePath).split('/').pop() ?? filePath
  return base.replace(/\.md$/i, '')
}

/** Length of the excerpt kept in the index. Enough for context, not for reading. */
const EXCERPT_LENGTH = 160

/**
 * A first line of prose, for showing a document without shipping its body.
 *
 * Headings, fences and link syntax are stripped, because an excerpt reading
 * "## Overview" or "[[Some Link]]" tells a reader nothing about the document.
 */
export function deriveExcerpt(body: string): string {
  // Only the opening of the document can reach a 160-character excerpt, and running
  // eight regexes over a whole 25KB note to produce it cost 8 seconds across a
  // 2,000-document reindex. A generous window keeps the result identical in every
  // realistic case while making the work constant per document.
  const head = body.length > 2000 ? body.slice(0, 2000) : body

  const prose = head
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, ' ')
    .replace(/^\s{0,3}>\s?/gm, ' ')
    .replace(/!?\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g, (_m, target: string, alias?: string) =>
      alias && alias.length > 0 ? alias : target
    )
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return prose.length <= EXCERPT_LENGTH ? prose : `${prose.slice(0, EXCERPT_LENGTH).trimEnd()}…`
}

/**
 * Words as a person would count them: ignoring code, and not counting punctuation
 * that only exists to be Markdown. `# Title` is one word, not two.
 */
export function countWords(body: string): number {
  // One pass, not a chain of whole-document regexes: this runs on every write and on
  // every document of a reindex, and the multiline form was measurably expensive.
  let count = 0
  let inFence = false

  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    for (const token of line.split(/\s+/)) {
      // Skip Markdown that is punctuation rather than a word: `#`, `>`, `-`, `1.`
      if (!token || /^(?:#{1,6}|>+|[-*+]|\d+\.)$/.test(token)) continue
      count++
    }
  }

  return count
}

export function buildDocument(
  path: string,
  content: string,
  meta: { updatedAt?: string; etag?: string } = {}
): MarkdownDocument {
  const normalized = normalizePath(path)
  const { frontmatter, body } = splitFrontmatter(content)
  const id = typeof frontmatter.id === 'string' && frontmatter.id.trim() ? frontmatter.id.trim() : undefined

  return {
    path: normalized,
    title: deriveTitle(normalized, frontmatter, body),
    frontmatter,
    // Scanned over the whole file, so `related: "[[Other]]"` in frontmatter counts
    // as an edge — Obsidian treats it as one. Code spans and fences do not count.
    outboundLinks: getWikiLinks(content),
    content: body,
    // Derived here so the index can describe a document without carrying it.
    excerpt: deriveExcerpt(body),
    wordCount: countWords(body),
    updatedAt: meta.updatedAt,
    etag: meta.etag,
    id,
    aliases: readAliases(frontmatter),
    parent_id: readParentId(frontmatter) ?? null,
  }
}

// `toIndexEntry` lives in index-patch.ts, beside the code that maintains the index.
