import GithubSlugger from 'github-slugger'

/**
 * The outline of a document.
 *
 * Two things this has to get right, and the old inline version got neither:
 *
 * **Fenced code is not prose.** A line reading `# Restore. Refuses if the target
 * already holds documents` inside a ```bash block is a shell comment, and listing it
 * as a heading fills the outline with entries that are not sections and cannot be
 * jumped to.
 *
 * **The slugs must be the ones the renderer used.** The panel scrolls by element id,
 * so it computes ids with `github-slugger` — which is what `rehype-slug` uses on the
 * rendering side. Same input, same order, same algorithm, therefore same ids,
 * including the `-1`/`-2` suffixes that duplicate headings get.
 */

export interface DocumentHeading {
  text: string
  /** 1–6. */
  level: number
  /** Zero-based line in the body, kept for callers that want a position. */
  line: number
  /** DOM id of the rendered heading. */
  slug: string
}

const ATX = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/**
 * Strips inline syntax so the outline reads like the rendered heading.
 *
 * `## The **hard** part` is "The hard part" on the page, and an outline that says
 * `The **hard** part` looks like a rendering failure.
 */
function renderedText(raw: string): string {
  return raw
    .replace(/!?\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g, (_m, target: string, alias?: string) =>
      alias && alias.length > 0 ? alias : target
    )
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .trim()
}

export function extractHeadings(body: string): DocumentHeading[] {
  const slugger = new GithubSlugger()
  const headings: DocumentHeading[] = []

  let fence: string | null = null

  body.split('\n').forEach((line, index) => {
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      // A fence closes only with the same character, and only if it is at least as
      // long as the one that opened it — otherwise ```` inside a ``` block would end it.
      if (fence === null) fence = fenceMatch[1]
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
      return
    }
    if (fence !== null) return

    const match = ATX.exec(line)
    if (!match) return

    const text = renderedText(match[2])
    if (!text) return

    headings.push({
      text,
      level: match[1].length,
      line: index,
      // Slugged in document order, so duplicate-name suffixes match the renderer's.
      slug: slugger.slug(text),
    })
  })

  return headings
}
