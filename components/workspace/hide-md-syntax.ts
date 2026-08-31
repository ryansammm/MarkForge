import { EditorView, Decoration, ViewPlugin, type DecorationSet } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

/**
 * Hides inline markdown syntax markers (`*`, `**`, `~~`, `>`, `-`,
 * `[`, `]`, `(`, `)`) when their line is not the active line.
 *
 * We regex the visible source text for marker characters and add
 * `cm-md-syntax` mark decorations at those ranges. `app/globals.css`
 * hides that class everywhere except inside `.cm-activeLine`.
 *
 * ponytail: heading marks are not handled. The grammar does not emit
 * a node for the leading `#`, masking the prefix needs a CSS hack
 * (pseudo-element overlay) that costs more lines than it saves. Add
 * when a user actually complains about visible `#`.
 */
const MARKER_PATTERNS: RegExp[] = [
  // strong `**...**` and emphasis `*...*`
  /\*+/g,
  // strikethrough `~~...~~`
  /~~/g,
  // links `[text](url)`
  /[\[\]()]/g,
  // blockquote `> ` — the leading `>` is decorative and clutters prose.
  /^(\s*)>\s/gm,
  // block-id comments `<!-- mkf:b:... -->` — hidden in the editor;
  // the comment stays in the markdown source for support/debug
  // (see `lib/blocks.ts`). Active-line override in `globals.css`
  // reveals the comment when the user is on that line.
  /<!--\s*mkf:b:[\w-]+\s*-->/g,
]

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    const ranges: { from: number; to: number }[] = []
    for (const pattern of MARKER_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const start = from + match.index
        const end = start + match[0].length
        if (end > to) break
        ranges.push({ from: start, to: end })
      }
    }
    // RangeSetBuilder requires ascending `from`. Multiple patterns can
    // find overlapping or interleaved matches (e.g. a `>` from the
    // list regex and a `*` from the emphasis regex on the same line);
    // sort once and add in order.
    ranges.sort((a, b) => a.from - b.from)
    for (const r of ranges) {
      builder.add(r.from, r.to, Decoration.mark({ class: 'cm-md-syntax' }))
    }
  }
  return builder.finish()
}

export function hideMarkdownSyntax() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(update: {
        docChanged: boolean
        viewportChanged: boolean
        view: EditorView
      }) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = build(update.view)
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  )
}
