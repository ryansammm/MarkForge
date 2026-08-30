/**
 * Strips hidden block-id comments from markdown before it is rendered.
 *
 * The buffer-side block model (lib/blocks.ts) writes a comment at the
 * end of every block that has an id:
 *
 *     prose line
 *     <!-- mkf:b:a3f2kq18 color:red bg:yellow -->
 *
 * The reading view must show neither the comment nor the empty line it
 * sits on; otherwise a paragraph looks like it has trailing whitespace
 * and an HTML literal.
 *
 * The strip is line-based so the regex stays simple. A comment is
 * recognised as a single line that matches the comment format, with
 * optional leading whitespace.
 */
const BLOCK_COMMENT_LINE = /^\s*<!--\s*mkf:b:[a-z0-9]+(?:\s+.*?)?\s*-->\s*$/

export function stripBlockComments(markdown: string): string {
  if (!markdown) return markdown
  const lines = markdown.split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (BLOCK_COMMENT_LINE.test(line)) continue
    out.push(line)
  }
  // Collapse runs of >2 blank lines that the strip might have left
  // behind, so the rendered prose does not pick up awkward vertical gaps.
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}
