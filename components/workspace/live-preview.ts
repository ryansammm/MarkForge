import type { EditorState, Extension, Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { WIKILINK_PATTERN } from '@/lib/markdown/wikilink'
import { IN_PLACE, type OpenIntent } from '@/lib/tabs'

/**
 * Obsidian-style inline live preview.
 *
 * Markdown markers — `##`, `**`, backticks, `[[ ]]` — are hidden while the cursor is
 * elsewhere and revealed the moment the selection enters the node. The reveal is what
 * makes this editing rather than reading: the syntax is always one caret away.
 *
 * **Nothing here modifies the document.** Every decoration is view-only, so the
 * Sprint 3 guarantee stands untouched — the buffer is still the file, byte for byte
 * (docs/sprint-3-editor-decision.md). That is also why copying across a hidden marker
 * still yields raw Markdown: the text was never removed, only not painted.
 *
 * Scope was four node types in sprint 6 (docs/sprint-6-live-preview-spike.md), which
 * named image widgets as explicitly out. Sprint 7 adds the fifth and changes that:
 * an image on a line of its own is replaced by the picture. It is the first decoration
 * here that puts generated content on screen instead of merely hiding bytes, so it is
 * also the first place the reveal rule does real work — the raw `![alt](path)` has to
 * come back the moment the caret reaches that line, or the link becomes uneditable.
 *
 * Still out, and still worth naming so they cannot creep in: tables, task lists, list
 * bullets, blockquote marks, link URLs, frontmatter folding.
 */

export type PreviewKind =
  | 'heading'
  | 'emphasis'
  | 'strong'
  | 'strikethrough'
  | 'inlineCode'
  | 'wikilink'
  | 'image'

export interface PreviewNode {
  kind: PreviewKind
  /** Full extent of the node. The selection touching this range reveals the syntax. */
  from: number
  to: number
  /** Ranges painted away while the node is not revealed. */
  markers: Array<{ from: number; to: number }>
  /** Wikilinks only: the visible text, and the target it resolves against. */
  label?: { from: number; to: number }
  target?: string
  /**
   * Images only: what to draw, and the exact bytes to draw it over.
   *
   * The node's own range, which is narrower than the enclosing `from`/`to`. The two
   * differ on purpose — see `imageOnOwnLine`.
   */
  image?: { src: string; alt: string; from: number; to: number }
}

const HEADING_NODE = /^ATXHeading[1-6]$/

/** Marker child node names, by the parent that owns them. */
const INLINE_MARKERS: Record<string, string> = {
  Emphasis: 'EmphasisMark',
  StrongEmphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark',
  InlineCode: 'CodeMark',
}

const INLINE_KINDS: Record<string, PreviewKind> = {
  Emphasis: 'emphasis',
  StrongEmphasis: 'strong',
  Strikethrough: 'strikethrough',
  InlineCode: 'inlineCode',
}

/**
 * Node names whose contents are literal text.
 *
 * `[[NotALink]]` inside a fenced code block is a code sample, not a link, and
 * decorating it would be a lie about what the file says.
 */
const CODE_NODES = new Set([
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'InlineCode',
  'HTMLBlock',
  'HTMLTag',
  'Comment',
  'CommentBlock',
])

function isInCode(state: EditorState, pos: number): boolean {
  const node = syntaxTree(state).resolveInner(pos, 1)
  for (let cursor: typeof node | null = node; cursor; cursor = cursor.parent) {
    if (CODE_NODES.has(cursor.name)) return true
  }
  return false
}

/**
 * Every decoratable node overlapping `ranges`.
 *
 * Split out from the view layer with no DOM in it, because the interesting part — which
 * bytes get hidden — is then testable in Node. See tests/live-preview.test.ts.
 */
export function previewNodes(
  state: EditorState,
  ranges: readonly { from: number; to: number }[]
): PreviewNode[] {
  const out: PreviewNode[] = []
  const tree = syntaxTree(state)

  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        if (HEADING_NODE.test(node.name)) {
          const mark = node.node.getChild('HeaderMark')
          if (!mark) return
          // Swallow the space after the hashes too, or every heading keeps a stray
          // indent where the marker used to be.
          let end = mark.to
          while (end < node.to && state.doc.sliceString(end, end + 1) === ' ') end++
          // An empty heading would decorate down to a blank line. Leave it visible.
          if (end >= node.to) return
          out.push({
            kind: 'heading',
            from: node.from,
            to: node.to,
            markers: [{ from: mark.from, to: end }],
          })
          return
        }

        if (node.name === 'Image') {
          const image = imageOnOwnLine(state, node.from, node.to)
          if (image) out.push(image)
          return
        }

        const markName = INLINE_MARKERS[node.name]
        if (!markName) return

        const marks = node.node.getChildren(markName)
        if (marks.length === 0) return

        // Nothing between the markers means hiding them leaves nothing at all.
        const inner = state.doc.sliceString(marks[0].to, marks[marks.length - 1].from)
        if (!inner) return

        out.push({
          kind: INLINE_KINDS[node.name],
          from: node.from,
          to: node.to,
          markers: marks.map((m) => ({ from: m.from, to: m.to })),
        })
      },
    })

    // Wikilinks are not CommonMark, so the parser never sees them — `[[Target]]`
    // arrives as an ordinary `[Target]` Link wrapped in stray brackets. Scanning the
    // text with the app's own pattern keeps one definition of the syntax
    // (lib/markdown/wikilink.ts) rather than growing a second.
    const text = state.doc.sliceString(range.from, range.to)
    WIKILINK_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = WIKILINK_PATTERN.exec(text)) !== null) {
      const from = range.from + match.index
      const to = from + match[0].length
      const target = match[1].trim()
      if (!target) continue
      if (isInCode(state, from + 2)) continue

      const alias = match[2]
      const hasAlias = alias !== undefined
      // `[[Target|]]` has an empty label — hiding the markers would erase the link
      // from view entirely, so it stays raw.
      if (hasAlias && alias.length === 0) continue

      const openTo = hasAlias ? from + 2 + match[1].length + 1 : from + 2
      out.push({
        kind: 'wikilink',
        from,
        to,
        markers: [
          { from, to: openTo },
          { from: to - 2, to },
        ],
        label: { from: openTo, to: to - 2 },
        target,
      })
    }
  }

  return out
}

/**
 * An `![alt](src)` that is the only thing on its line, as a preview node.
 *
 * Only that shape. An image sitting mid-sentence is inline content, and replacing it
 * with a block would reflow the paragraph around it — so those stay as text. It is
 * also exactly the shape the drop handler writes, so the common path is covered and
 * the awkward one is left alone rather than guessed at.
 *
 * Two ranges, deliberately:
 *
 * - `from`/`to` cover the **line**, and that is what the reveal rule reads. A caret
 *   anywhere on the line brings the raw link back, including in the leading whitespace
 *   where there is no image node to touch. That is the only way back to editing it.
 * - `image.from`/`image.to` cover the **node**, and that is what gets painted over.
 *
 * The painted range cannot be the line, because a decoration spanning a line boundary
 * is a *block* decoration and CodeMirror refuses those from a ViewPlugin — which is
 * what this module is. The widget is an inline-block instead, which grows the line to
 * fit and looks identical for an image that is alone on its line anyway.
 */
function imageOnOwnLine(state: EditorState, from: number, to: number): PreviewNode | null {
  const line = state.doc.lineAt(from)
  if (line.number !== state.doc.lineAt(to).number) return null
  if (line.text.trim() !== state.doc.sliceString(from, to).trim()) return null

  // `![alt](src)` — parsed off the node text rather than off the tree, because the
  // URL child is absent for an empty target and present-but-empty for `![](…)`, and
  // one regex over eleven characters is easier to be sure about than that.
  const match = /^!\[([^\]]*)\]\(\s*<?([^)>\s]*)>?[^)]*\)$/.exec(state.doc.sliceString(from, to))
  if (!match) return null

  const src = match[2]
  if (!src) return null

  return {
    kind: 'image',
    from: line.from,
    to: line.to,
    // Nothing is hidden: the link is replaced outright.
    markers: [],
    image: { src, alt: match[1], from, to },
  }
}

/** Whether any cursor or selection touches the node, which is what reveals it. */
function isRevealed(state: EditorState, node: PreviewNode): boolean {
  return state.selection.ranges.some((r) => r.from <= node.to && r.to >= node.from)
}

const hidden = Decoration.replace({})
const resolvedLink = Decoration.mark({ class: 'cm-wikilink' })
const ghostLink = Decoration.mark({ class: 'cm-wikilink cm-wikilink-ghost' })

/**
 * The picture itself.
 *
 * `eq` compares src and alt, so a repaint caused by anything else — a keystroke three
 * lines up — reuses the existing DOM instead of building a new `<img>`, which would
 * make the image visibly reload on every edit.
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly resolve: (src: string) => string,
    readonly onExpand?: (src: string, alt: string) => void
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  toDOM(view: EditorView): HTMLElement {
    // A span, not a div: this replaces a range inside a line, so it has to be inline
    // content. `display: inline-block` in the theme is what lets it take a block's
    // worth of height.
    const container = document.createElement('span')
    container.className = 'cm-image-block'

    const image = document.createElement('img')
    image.src = this.resolve(this.src)
    image.alt = this.alt
    image.loading = 'lazy'

    /**
     * The editor measures line heights to place the caret and size the scrollbar, and
     * it does that before an image has loaded — when this element is still zero-high.
     * Without telling it to measure again on load, every line below the image sits at
     * the wrong offset until something else happens to trigger a remeasure.
     */
    const remeasure = () => view.requestMeasure()
    image.addEventListener('load', remeasure)

    image.addEventListener('error', () => {
      // A picture that cannot load is shown as a broken link rather than as nothing.
      // Silently rendering empty space would leave the reader unable to tell an image
      // they cannot see from one that was never there.
      container.classList.add('cm-image-broken')
      container.textContent = `Missing image: ${this.src}`
      remeasure()
    })

    container.appendChild(image)

    if (this.onExpand) {
      /**
       * The way into the viewer from the editor.
       *
       * **Deliberately not a plain click.** A click on the picture already means
       * something here: it places the caret on the image's line, and a caret on the
       * line is what reveals the raw `![alt](path)`. That is the alt-text editor —
       * sprint 7 item 6 declined to build a dedicated one *because* this path exists,
       * so taking it away to open a pop-up would make alt text uneditable.
       *
       * A visible control instead of only a hidden chord, because mod-click is
       * undiscoverable; the chord is kept as an alias for anyone who already expects
       * it, matching how a wikilink is followed from the editor.
       */
      const expand = document.createElement('button')
      expand.type = 'button'
      expand.className = 'cm-image-expand'
      expand.title = 'View full size (or Ctrl/Cmd-click the image)'
      expand.setAttribute('aria-label', 'View full size')
      // ⤢ rather than an icon component: this is imperative DOM inside a CodeMirror
      // widget, with no React to render into it.
      expand.textContent = '⤢'
      expand.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.onExpand?.(this.src, this.alt)
      })
      container.appendChild(expand)

      image.addEventListener('click', (event) => {
        if (!event.metaKey && !event.ctrlKey) return
        event.preventDefault()
        this.onExpand?.(this.src, this.alt)
      })
    }

    return container
  }

  /**
   * Clicks fall through to the editor, which is what makes the raw link reachable:
   * clicking the picture places the caret on its line, and a caret on the line reveals
   * the syntax. Swallowing every event would make the image impossible to edit.
   *
   * The one exception is the expand button, whose own handler has already dealt with
   * the click. Letting that one through as well would open the viewer *and* move the
   * caret onto the line, so the raw link would be showing underneath the moment the
   * viewer was dismissed.
   */
  ignoreEvent(event: Event): boolean {
    const target = event.target
    return target instanceof HTMLElement && target.closest('.cm-image-expand') !== null
  }
}

export interface LivePreviewConfig {
  /** Whether a wikilink target exists, so resolved and ghost links look different. */
  isResolved: (target: string) => boolean
  /**
   * Turns an image's `src` into something a browser can fetch.
   *
   * The document holds a vault-relative path, so somebody has to map it; passing the
   * mapping in keeps this module unaware of the app's URL shape, and keeps the editor
   * and the reading view resolving through the same function rather than two.
   *
   * Omit to leave images as plain text.
   */
  resolveImage?: (src: string) => string
  /**
   * Opening a rendered image in the viewer, from its expand button or a mod-click.
   *
   * Takes the `src` as the document writes it, not a resolved URL: this module is
   * given `resolveImage` precisely so it does not have to know the app's URL shape,
   * and handing a resolved URL back out would undo that.
   *
   * Omit to leave images inert, which is what they were before the viewer existed.
   */
  onExpandImage?: (src: string, alt: string) => void
  /**
   * Mod-click on a rendered wikilink. Omit to leave links inert.
   *
   * Mod-click is the navigate gesture here — plain clicking has to place the caret —
   * so it cannot also mean "new tab" the way it does in the reading view. Adding
   * Shift is what opens a tab instead, and the editor's own tooltip says so.
   */
  onNavigate?: (target: string, intent: OpenIntent) => void
}

function buildDecorations(view: EditorView, config: LivePreviewConfig): DecorationSet {
  const ranges: Range<Decoration>[] = []

  for (const node of previewNodes(view.state, view.visibleRanges)) {
    if (isRevealed(view.state, node)) continue

    if (node.kind === 'image') {
      if (!config.resolveImage || !node.image) continue
      ranges.push(
        Decoration.replace({
          widget: new ImageWidget(
            node.image.src,
            node.image.alt,
            config.resolveImage,
            config.onExpandImage
          ),
        }).range(node.image.from, node.image.to)
      )
      continue
    }

    for (const marker of node.markers) {
      if (marker.to > marker.from) ranges.push(hidden.range(marker.from, marker.to))
    }

    if (node.kind === 'wikilink' && node.label && node.label.to > node.label.from) {
      const deco = config.isResolved(node.target!) ? resolvedLink : ghostLink
      ranges.push(deco.range(node.label.from, node.label.to))
    }
  }

  return Decoration.set(ranges, true)
}

/** The wikilink under a document position, if the position sits inside one. */
function wikilinkAt(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos)
  WIKILINK_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WIKILINK_PATTERN.exec(line.text)) !== null) {
    const from = line.from + match.index
    if (pos >= from && pos <= from + match[0].length) {
      const target = match[1].trim()
      return target || null
    }
  }
  return null
}

export function livePreview(config: LivePreviewConfig): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, config)
      }

      update(update: ViewUpdate) {
        // Selection changes matter as much as document changes here: moving the caret
        // into a node is what reveals it. Any transaction also refreshes, which is how
        // a changed document index repaints resolved-versus-ghost links.
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.transactions.length > 0
        ) {
          this.decorations = buildDecorations(update.view, config)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )

  return [
    plugin,
    // Without this, arrowing along a line steps into hidden markers and the caret
    // appears to stall. Atomic ranges make the hidden text a single step.
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!config.onNavigate) return false
        if (!(event.metaKey || event.ctrlKey)) return false

        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null) return false

        const target = wikilinkAt(view.state, pos)
        if (!target) return false

        event.preventDefault()
        config.onNavigate(
          target,
          event.shiftKey ? { newTab: true, background: false } : IN_PLACE
        )
        return true
      },
    }),
  ]
}
