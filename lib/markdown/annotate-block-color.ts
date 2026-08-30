import type { Root, Paragraph, Heading, Blockquote, ListItem } from 'mdast'
import type { Plugin } from 'unified'
import { visit } from 'unist-util-visit'

/**
 * Remark plugin that paints block colors and backgrounds in the reading view.
 *
 * The editor stores the color and background of a block as keys on the
 * `<!-- mkf:b:... -->` comment at the end of the paragraph:
 *
 *     prose line
 *     <!-- mkf:b:a3f2kq18 color:red bg:yellow -->
 *
 * The `stripBlockComments` pass (lib/markdown/strip-block-comments.ts)
 * removes those comments before parsing, so by the time the AST is
 * built the color and background are gone. This plugin walks the AST
 * alongside the *raw* body, finds the trailing comment for each
 * paragraph, and stamps the node with `data.hProperties` so the
 * renderer can attach a class.
 *
 * The plugin does not own rendering — it only annotates. The class
 * names are `mkf-color-<name>` and `mkf-bg-<name>`, defined globally
 * in app/globals.css.
 */
const COMMENT_LINE = /^\s*<!--\s*mkf:b:[a-z0-9]+(?:\s+([^>]*?))?\s*-->\s*$/

interface BlockStyle {
  color?: string
  bg?: string
}

function parseCommentLine(line: string): BlockStyle | null {
  const match = COMMENT_LINE.exec(line)
  if (!match) return null
  const attrs = match[1] ?? ''
  const out: BlockStyle = {}
  for (const part of attrs.split(/\s+/)) {
    const [k, v] = part.split(':')
    if (!k || !v) continue
    if (k === 'color') out.color = v
    else if (k === 'bg') out.bg = v
  }
  return out.color || out.bg ? out : null
}

/**
 * Given the raw body, returns a map keyed by the 1-based line of a
 * comment, with the style that comment declares. The MDAST visitor
 * below checks whether each block node ends just before a comment
 * line; if so, the style is applied.
 */
function buildCommentMap(raw: string): Map<number, BlockStyle> {
  const lines = raw.split('\n')
  const map = new Map<number, BlockStyle>()
  for (let i = 0; i < lines.length; i++) {
    const style = parseCommentLine(lines[i])
    if (style) map.set(i + 1, style)
  }
  return map
}

type BlockNode = Paragraph | Heading | Blockquote | ListItem

function isBlockNode(node: { type: string }): node is BlockNode {
  return (
    node.type === 'paragraph' ||
    node.type === 'heading' ||
    node.type === 'blockquote' ||
    node.type === 'listItem'
  )
}

/**
 * Returns a remark plugin that annotates each block-level node with
 * the color and background from the original body.
 *
 * The plugin is a factory because it needs the raw body — `body` is
 * captured in a closure, then handed to the remark pipeline by the
 * caller.
 */
export function remarkBlockColor(rawBody: string): Plugin<[], Root> {
  const comments = buildCommentMap(rawBody)
  return () => (tree) => {
    if (comments.size === 0) return
    visit(tree, (node) => {
      if (!isBlockNode(node)) return
      const end = node.position?.end.line
      if (!end) return
      // The block's last source line is followed by a blank line and
      // then a comment. After the comment-strip pass the blank line
      // is still present, so the comment is at end+2 in the raw
      // body. Look one and two lines past the block end; the comment
      // may be at either, depending on whether the block ends on a
      // blank line.
      const style = comments.get(end + 1) ?? comments.get(end + 2)
      if (!style) return
      const props: Record<string, string> = {}
      if (style.color) props['data-color'] = style.color
      if (style.bg) props['data-bg'] = style.bg
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (node.data ?? (node.data = {} as any)) as { hProperties?: Record<string, unknown> }
      data.hProperties = { ...(data.hProperties ?? {}), ...props }
    })
  }
}
