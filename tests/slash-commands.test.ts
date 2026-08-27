import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import {
  SLASH_ITEMS,
  slashCommands,
  slashContextBefore,
  snippetEdit,
} from '../components/workspace/slash-commands'

/**
 * Slash-menu contract.
 *
 * The trigger must be conservative (line start, after whitespace, or after
 * punctuation - but never inside a word like a/b or a URL like https://x/y),
 * filtering must respect the query, and the applied edit must replace exactly the
 * "/token" range with the cursor landing on the snippet's caret marker.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert failed: ${message}`)
}

function runSource(doc: string, pos: number) {
  const state = EditorState.create({ doc })
  const context = new CompletionContext(state as never, pos, false)
  const source = slashCommands()
  return source(context)
}

async function main() {
  // Trigger: line start
  assert(slashContextBefore('/he')?.query === 'he', 'line-start slash should trigger')
  // Trigger: after whitespace
  assert(slashContextBefore('todo /he')?.query === 'he', 'post-space slash should trigger')
  // Non-triggers
  assert(slashContextBefore('a/he') === null, 'mid-word slash must not trigger')
  assert(slashContextBefore('https://x/y') === null, 'URL must not trigger')
  assert(slashContextBefore('plain text') === null, 'no slash, no menu')

  // Full source run through a CompletionContext
  const doc = 'hello /he'
  const result = runSource(doc, doc.length)
  assert(result !== null, 'source should return options')
  if (!result || !('options' in result)) throw new Error('unexpected result shape')
  assert(
    result.options.some((o) => o.label === 'Heading 1'),
    'Heading 1 should match /he'
  )
  assert(!result.options.some((o) => o.label === 'Divider'), '/he must not match Divider')

  // No matches -> no menu at all
  assert(runSource('/zzz', 4) === null, 'unknown query returns null')

  // Every item is well-formed: detail non-empty, caret appears at most once
  for (const item of SLASH_ITEMS) {
    assert(item.detail.length > 0, `${item.label} missing detail`)
    assert(item.snippet.split('^').length <= 2, `${item.label} has multiple carets`)
  }
  assert(SLASH_ITEMS.length >= 8, 'menu grew thinner?')

  // Snippet edit replaces the token range; caret marker positions the cursor
  const plain = snippetEdit(100, 6, 9, '# ')
  assert(plain.from === 6 && plain.to === 9 && plain.insert === '# ', 'plain edit wrong')
  assert(plain.anchor === 8, 'plain cursor should sit after "# "')

  const block = snippetEdit(100, 6, 14, '```\n^\n```\n')
  assert(block.insert === '```\n\n```\n', 'caret stripped from block insert')
  assert(block.anchor === 6 + 4, 'block cursor inside the fences')

  console.log('slash-commands tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
