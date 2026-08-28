import { it } from 'vitest'
import { EditorSelection, EditorState, type StateCommand, type Transaction } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { previewNodes, type PreviewNode } from '../components/workspace/live-preview'
import {
  cycleHeading,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
  toggleItalic,
  wrapWikilink,
} from '../components/workspace/editor-commands'

/**
 * Inline live preview suite.
 *
 * The property under test is narrow and load-bearing: which byte ranges get painted
 * away. Decorations are view-only, so the document itself cannot change — the risk is
 * hiding the wrong bytes, which would show the reader something the file does not say.
 *
 * No DOM here. `previewNodes` takes an EditorState and returns ranges, which is why it
 * was split out of the ViewPlugin in the first place.
 */

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures.push(`${name}\n      ${(err as Error).message}`)
    console.error(`  FAIL ${name}`)
    console.error(`       ${(err as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    )
  }
}

function stateFor(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  })
  // The parser is lazy and viewport-driven; force a full parse so iteration below
  // sees the whole document rather than the first few kilobytes.
  ensureSyntaxTree(state, state.doc.length, 10000)
  return state
}

function nodesOf(doc: string): PreviewNode[] {
  const state = stateFor(doc)
  return previewNodes(state, [{ from: 0, to: state.doc.length }])
}

/** What the reader sees: the document minus every hidden marker. */
function rendered(doc: string): string {
  const state = stateFor(doc)
  const cuts = previewNodes(state, [{ from: 0, to: state.doc.length }])
    .flatMap((n) => n.markers)
    .sort((a, b) => b.from - a.from)

  let out = doc
  for (const cut of cuts) out = out.slice(0, cut.from) + out.slice(cut.to)
  return out
}

/**
 * Runs a formatting command over a document with `|` marking the cursor, or a pair of
 * them marking a selection, and returns the result in the same notation.
 */
function format(command: StateCommand, marked: string): string {
  const first = marked.indexOf('|')
  const second = marked.indexOf('|', first + 1)
  const doc = marked.replace(/\|/g, '')
  const anchor = first
  const head = second === -1 ? first : second - 1

  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage })],
  })

  command({
    state,
    dispatch: (tr: Transaction) => {
      state = tr.state
    },
  })

  const { from, to } = state.selection.main
  const text = state.doc.toString()
  return from === to
    ? `${text.slice(0, from)}|${text.slice(from)}`
    : `${text.slice(0, from)}|${text.slice(from, to)}|${text.slice(to)}`
}

export function runLivePreviewTests(): boolean {
  console.log('Inline live preview suite\n')

  console.log('the four node types')

  check('an ATX heading hides its hashes and the space after them', () => {
    equal(rendered('## Start with what matters'), 'Start with what matters', 'heading marker survived')
  })

  check('all six heading levels are covered', () => {
    for (let level = 1; level <= 6; level++) {
      const doc = `${'#'.repeat(level)} Title`
      equal(rendered(doc), 'Title', `h${level} was not decorated`)
    }
  })

  check('emphasis, strong and strikethrough hide their markers', () => {
    equal(rendered('a **b** c *d* e _f_ g ~~h~~'), 'a b c d e f g h', 'inline markers survived')
  })

  check('inline code hides its backticks', () => {
    equal(rendered('press `Cmd+K` now'), 'press Cmd+K now', 'backticks survived')
  })

  check('a plain wikilink hides its brackets', () => {
    equal(rendered('See [[Principles]] for details.'), 'See Principles for details.', 'brackets survived')
  })

  check('an aliased wikilink shows only the alias', () => {
    equal(rendered('See [[Principles|the rules]].'), 'See the rules.', 'target or pipe leaked through')
  })

  check('a wikilink reports its target, not its label', () => {
    const [node] = nodesOf('[[Principles|the rules]]')
    equal(node.kind, 'wikilink', 'not recognised as a wikilink')
    equal(node.target, 'Principles', 'target should be what resolution uses')
  })

  console.log('\nimages (sprint 7 — the fifth node type)')

  /** The image node for a document, if `previewNodes` found one. */
  const imageIn = (doc: string) => nodesOf(doc).find((n) => n.kind === 'image')

  check('an image alone on its line becomes a picture', () => {
    const node = imageIn('# Title\n\n![Pastel sketch](assets/2026/ab12-pastel.png)\n')
    assert(node, 'the image was not detected')
    equal(
      { src: node!.image!.src, alt: node!.image!.alt },
      { src: 'assets/2026/ab12-pastel.png', alt: 'Pastel sketch' },
      'wrong src or alt'
    )
  })

  check('the reveal range is the line, the painted range is the node', () => {
    /**
     * The two must not be merged. Painting the whole line would make this a block
     * decoration, and CodeMirror refuses those from a ViewPlugin — which is what
     * live-preview is. Revealing on the node alone would leave a caret in the leading
     * whitespace unable to bring the link back.
     */
    const doc = '  ![x](a.png)\n\nafter'
    const node = imageIn(doc)!
    equal({ from: node.from, to: node.to }, { from: 0, to: 13 }, 'reveal range is not the line')
    equal(
      { from: node.image!.from, to: node.image!.to },
      { from: 2, to: 13 },
      'painted range is not the node'
    )
  })

  check('an image hides nothing — it replaces', () => {
    // `rendered()` cuts every marker range. An image contributes none: the whole line
    // is swapped for a widget instead, so nothing is "hidden" in the marker sense.
    const doc = '![x](a.png)'
    equal(rendered(doc), doc, 'an image should not report hidden markers')
  })

  check('an image with text beside it stays as text', () => {
    // Inline content. Replacing it with a block would reflow the paragraph around it.
    equal(imageIn('see ![x](a.png) here'), undefined, 'an inline image was made into a block')
    equal(imageIn('![x](a.png) trailing'), undefined, 'text after the image')
    equal(imageIn('leading ![x](a.png)'), undefined, 'text before the image')
  })

  check('an indented image is still on its own line', () => {
    const node = imageIn('  ![x](a.png)')
    assert(node, 'leading whitespace should not disqualify it')
    equal({ from: node!.from, to: node!.to }, { from: 0, to: 13 }, 'the range must still be the line')
  })

  check('an image with no source is left as text', () => {
    // There is nothing to draw, and replacing the line would erase the link from view.
    equal(imageIn('![alt]()'), undefined, 'an empty src was made into a widget')
  })

  check('an image with an empty alt is fine', () => {
    const node = imageIn('![](assets/2026/ab12-x.png)')
    assert(node, 'an image without alt text is still an image')
    equal(node!.image!.alt, '', 'alt should be empty, not missing')
  })

  check('a remote image is left addressable rather than rewritten', () => {
    const node = imageIn('![remote](https://example.com/a.png)')
    equal(node!.image!.src, 'https://example.com/a.png', 'the src must reach the resolver unchanged')
  })

  check('an image inside a code fence is a code sample', () => {
    const doc = ['```md', '![x](a.png)', '```'].join('\n')
    equal(imageIn(doc), undefined, 'a code sample was rendered as a picture')
    equal(rendered(doc), doc, 'the fence contents were altered')
  })

  console.log('\nwhat must stay visible')

  check('a wikilink inside a fenced code block is left alone', () => {
    const doc = ['```js', 'const x = "[[NotALink]]"', '```'].join('\n')
    equal(rendered(doc), doc, 'a code sample was decorated as a link')
  })

  check('a wikilink inside inline code is left alone', () => {
    equal(rendered('type `[[Target]]` to link'), 'type [[Target]] to link', 'inline code was decorated')
  })

  check('an empty alias stays raw rather than vanishing', () => {
    equal(rendered('[[Target|]]'), '[[Target|]]', 'the link would have rendered as nothing')
  })

  check('an empty heading stays raw rather than becoming a blank line', () => {
    equal(rendered('## '), '## ', 'an empty heading was hidden')
  })

  check('list bullets, blockquote marks and link URLs are out of scope', () => {
    const doc = '- item\n\n> quote\n\n[real](https://example.com)'
    equal(rendered(doc), doc, 'something outside the agreed four node types was decorated')
  })

  check('a bare [single] bracket is not treated as a wikilink', () => {
    equal(rendered('a [shortcut] ref'), 'a [shortcut] ref', 'a single-bracket link was decorated')
  })

  console.log('\nintegrity')

  check('hidden ranges never overlap each other', () => {
    const doc = '# Title\n\n**bold [[Link]] text** and `code` and [[A|b]].'
    const markers = nodesOf(doc)
      .flatMap((n) => n.markers)
      .sort((a, b) => a.from - b.from)
    for (let i = 1; i < markers.length; i++) {
      assert(
        markers[i].from >= markers[i - 1].to,
        `overlapping hidden ranges at ${markers[i - 1].from}-${markers[i - 1].to} and ${markers[i].from}-${markers[i].to}`
      )
    }
  })

  check('every marker sits inside the node that owns it', () => {
    const doc = '### Heading\n\n**bold** and [[Target|alias]] and `code`'
    for (const node of nodesOf(doc)) {
      for (const marker of node.markers) {
        assert(
          marker.from >= node.from && marker.to <= node.to,
          `${node.kind} marker ${marker.from}-${marker.to} escapes node ${node.from}-${node.to}`
        )
      }
    }
  })

  check('hiding markers only ever removes text — never adds or reorders it', () => {
    // The reader must be seeing a subsequence of the real file. If this fails, the
    // editor is displaying something the document does not contain.
    const doc = '# Welcome\n\nSome **bold** text with [[Principles|the rules]] and `code`.\n'
    const out = rendered(doc)
    let cursor = 0
    for (const ch of out) {
      cursor = doc.indexOf(ch, cursor)
      assert(cursor !== -1, 'rendered output is not a subsequence of the document')
      cursor++
    }
  })

  check('frontmatter is not decorated', () => {
    const doc = '---\ntitle: My Note\nid: abc123\n---\n\nBody\n'
    equal(rendered(doc), doc, 'frontmatter was touched')
  })

  check('a document with nothing to decorate yields no nodes', () => {
    equal(nodesOf('Just a plain sentence.').length, 0, 'decorated a plain paragraph')
  })

  check('ranges are honoured — nodes outside the viewport are not scanned', () => {
    const doc = '**one**\n\n**two**'
    const state = stateFor(doc)
    const firstLine = state.doc.line(1)
    const nodes = previewNodes(state, [{ from: firstLine.from, to: firstLine.to }])
    equal(nodes.length, 1, 'scanned outside the requested range')
    equal(nodes[0].from, 0, 'wrong node returned')
  })

  console.log('\nformatting commands')

  check('bold wraps a selection and keeps it selected', () => {
    equal(format(toggleBold, 'make |this| bold'), 'make **|this|** bold', 'wrong wrap')
  })

  check('bold unwraps a selection that is already bold', () => {
    equal(format(toggleBold, 'make **|this|** bold'), 'make |this| bold', 'markers survived')
  })

  check('bold unwraps when the markers are inside the selection', () => {
    equal(format(toggleBold, 'make |**this**| bold'), 'make |this| bold', 'markers survived')
  })

  check('bold with no selection leaves the cursor between the markers', () => {
    equal(format(toggleBold, 'type |here'), 'type **|**here', 'cursor is in the wrong place')
  })

  check('italic uses a single asterisk', () => {
    equal(format(toggleItalic, '|word|'), '*|word|*', 'wrong marker')
  })

  check('inline code uses backticks', () => {
    equal(format(toggleInlineCode, 'run |npm test| now'), 'run `|npm test|` now', 'wrong marker')
  })

  check('the link button wraps a selection in wikilink brackets', () => {
    equal(format(wrapWikilink, 'see |Principles| here'), 'see [[|Principles|]] here', 'wrong wrap')
  })

  check('heading cycles plain to H1 to H2 to H3 and back to plain', () => {
    equal(format(cycleHeading, '|Title'), '# |Title', 'plain should become H1')
    equal(format(cycleHeading, '# |Title'), '## |Title', 'H1 should become H2')
    equal(format(cycleHeading, '## |Title'), '### |Title', 'H2 should become H3')
    equal(format(cycleHeading, '### |Title'), '|Title', 'H3 should become plain')
  })

  check('a heading deeper than the cycle returns to plain, never promoted', () => {
    equal(format(cycleHeading, '##### |Title'), '|Title', 'an H5 was rewritten to a different level')
  })

  check('the caret stays with its text when a prefix is inserted', () => {
    equal(format(cycleHeading, '|Title'), '# |Title', 'the caret was stranded before the marker')
    equal(format(toggleBulletList, '|item'), '- |item', 'the caret was stranded before the bullet')
  })

  check('the bullet button adds a marker to every selected line', () => {
    equal(format(toggleBulletList, '|one\ntwo|'), '- |one\n- two|', 'not every line got a bullet')
  })

  check('the bullet button removes markers when every line already has one', () => {
    equal(format(toggleBulletList, '|- one\n- two|'), '|one\ntwo|', 'bullets survived')
  })

  check('a partly bulleted selection becomes fully bulleted, not unbulleted', () => {
    equal(format(toggleBulletList, '|- one\ntwo|'), '|- one\n- two|', 'the unbulleted line was skipped')
  })

  check('bullets preserve indentation', () => {
    equal(format(toggleBulletList, '|  nested'), '|  - nested', 'indentation was lost')
  })

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures.`)
    return true
  }
  console.error(`FAIL — ${failures.length} failure(s) of ${passed + failures.length} checks:\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  return false
}

it('live-preview suite', async () => {
  if (!(await runLivePreviewTests())) throw new Error('live-preview suite FAILED')
}, 60000)
