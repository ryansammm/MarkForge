import type { Root, Text, Parent, PhrasingContent } from 'mdast'
import type { Handle } from 'mdast-util-to-markdown'

/**
 * Wikilinks are not part of CommonMark, so remark leaves `[[Target]]` sitting in a
 * plain text node. Left alone, the default serializer escapes the brackets and the
 * link stops being a link. We lift them into a real node on the way in and emit them
 * verbatim on the way out.
 */
export interface WikiLink extends Parent {
  type: 'wikiLink'
  target: string
  alias: string | null
  children: []
}

declare module 'mdast' {
  interface PhrasingContentMap {
    wikiLink: WikiLink
  }
  interface RootContentMap {
    wikiLink: WikiLink
  }
}

/** `[[Target]]` or `[[Target|Alias]]` — no nested brackets, no newlines. */
export const WIKILINK_PATTERN = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g

export function formatWikiLink(target: string, alias?: string | null): string {
  // Deliberately not a truthiness check: `[[Target|]]` carries an empty alias and
  // must come back out with its pipe. Absence is null/undefined, not empty string.
  return alias === null || alias === undefined ? `[[${target}]]` : `[[${target}|${alias}]]`
}

function splitTextNode(node: Text): PhrasingContent[] | null {
  const value = node.value
  WIKILINK_PATTERN.lastIndex = 0
  if (!WIKILINK_PATTERN.test(value)) return null

  const out: PhrasingContent[] = []
  let cursor = 0
  WIKILINK_PATTERN.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = WIKILINK_PATTERN.exec(value)) !== null) {
    const target = match[1].trim()
    // `[[|alias]]` has no target — leave it as literal text rather than inventing a link.
    if (!target) continue

    if (match.index > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, match.index) })
    }

    const rawAlias = match[2]
    out.push({
      type: 'wikiLink',
      target,
      alias: rawAlias === undefined ? null : rawAlias,
      children: [],
    })

    cursor = match.index + match[0].length
  }

  if (out.length === 0) return null
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) })
  }
  return out
}

/** Walks the tree replacing wikilink text runs with `wikiLink` nodes. */
export function remarkWikiLink() {
  return (tree: Root) => {
    visitParents(tree)
  }
}

function visitParents(node: Parent): void {
  if (!Array.isArray(node.children)) return

  const next: typeof node.children = []
  let changed = false

  for (const child of node.children) {
    if (child.type === 'text') {
      const parts = splitTextNode(child as Text)
      if (parts) {
        next.push(...(parts as typeof node.children))
        changed = true
        continue
      }
    } else if ('children' in child) {
      visitParents(child as Parent)
    }
    next.push(child)
  }

  if (changed) node.children = next
}

/**
 * Emits the wikilink raw. Returning an unescaped string here is the whole point —
 * routing it through `safe()` is what produced `\[\[Target]]` in the first place.
 */
export const wikiLinkToMarkdown: Handle = (node) => {
  const link = node as unknown as WikiLink
  return formatWikiLink(link.target, link.alias)
}

/** Extracts wikilink targets in document order, deduplicated. */
export function extractWikiLinks(markdown: string): string[] {
  const seen = new Set<string>()
  WIKILINK_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WIKILINK_PATTERN.exec(markdown)) !== null) {
    const target = match[1].trim()
    if (target) seen.add(target)
  }
  return Array.from(seen)
}
