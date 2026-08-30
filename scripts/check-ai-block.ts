/**
 * Task 8.5 self-check: AI block.
 *
 * Two surfaces to cover:
 *   1. The pure body parser/serializer (FENCE_HEADER, formatHeader).
 *      These decide what the renderer shows on reload — a regression
 *      here means the user's prompt and the model's answer are lost.
 *   2. The `codeBlockFromNode` integration. When react-markdown hands
 *      us a `<pre>` whose child has `language-ai`, the function must
 *      return an `<AiBlock>` element instead of a `<CodeBlock>`.
 *      A small render-to-string is enough to assert the right shell
 *      comes out the other side.
 *
 * Run with `pnpm tsx scripts/check-ai-block.ts`. Exit 0 = pass.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import { codeBlockFromNode } from '../components/workspace/code-block'
import { parseBody, formatHeader, FENCE_HEADER } from '../components/workspace/ai-block'

const ok: string[] = []
const fail: string[] = []

function assert(name: string, condition: unknown, detail?: string): void {
  ;(condition ? ok : fail).push(detail ? `${name} (${detail})` : name)
}

function buildHastNode(body: string, language: string): unknown {
  return {
    type: 'element',
    tagName: 'pre',
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: language ? [`language-${language}`] : [] },
        children: [{ type: 'text', value: body + '\n' }],
      },
    ],
  }
}

function main(): void {
  // ---- 1. pure parser/serializer ---------------------------------------

  // Empty fence: header has no JSON, body is whatever the user wrote.
  {
    const parsed = parseBody('hello world')
    assert(
      'parseBody: plain text yields no configId',
      parsed.configId === null && parsed.body === 'hello world',
      `got ${JSON.stringify(parsed)}`
    )
  }

  // Fence with `{"configId":"abc"}` header.
  {
    const parsed = parseBody('```ai {"configId":"abc"}\nsummarize this\n```\n')
    assert(
      'parseBody: configId parsed from header',
      parsed.configId === 'abc' && parsed.body === 'summarize this',
      `got ${JSON.stringify(parsed)}`
    )
  }

  // Malformed JSON: parser returns null configId, keeps body intact.
  {
    const parsed = parseBody('```ai {not json}\nanything\n```\n')
    assert(
      'parseBody: bad header JSON falls back to null configId',
      parsed.configId === null && parsed.body === 'anything',
      `got ${JSON.stringify(parsed)}`
    )
  }

  // FENCE_HEADER accepts language-ai fences only.
  {
    const m = FENCE_HEADER.exec('```ai\nbody\n```\n')
    assert('FENCE_HEADER: matches ```ai', Boolean(m), 'regex returned null')
  }
  {
    const m = FENCE_HEADER.exec('```ts\nbody\n```\n')
    assert('FENCE_HEADER: rejects ```ts', m === null, 'regex matched non-ai')
  }

  // formatHeader is the canonical header the editor writes back.
  assert('formatHeader: no configId -> bare ```ai', formatHeader(null) === '```ai')
  assert(
    'formatHeader: configId serialises as JSON object',
    formatHeader('cfg-1') === '```ai ' + JSON.stringify({ configId: 'cfg-1' })
  )

  // Round-trip: parse -> format -> parse keeps the configId.
  {
    const first = parseBody('```ai {"configId":"x"}\ndo it\n```\n')
    const second = parseBody(`${formatHeader(first.configId)}\n${first.body}\n\`\`\`\n`)
    assert(
      'round-trip: configId survives a write+read',
      second.configId === 'x' && second.body === 'do it',
      `second=${JSON.stringify(second)}`
    )
  }

  // ---- 2. code-block integration ---------------------------------------

  // language-ai -> <AiBlock>. The block renders the textarea, the Run
  // button, and the provider label. We don't bind to a vault here, so
  // the block shows "No provider configured" — that's still enough
  // to prove the integration went through the right path.
  {
    const node = buildHastNode('```ai\n{"configId":""}\nhello', 'ai')
    const out = codeBlockFromNode(node, null)
    const html = renderToStaticMarkup(out as ReturnType<typeof createElement>)
    assert('integration: language-ai renders AiBlock shell', html.includes('AI block'))
    assert(
      'integration: language-ai renders prompt textarea',
      html.includes('hello') && html.includes('textarea'),
      'expected prompt + textarea in output'
    )
  }

  // Other languages still go through CodeBlock (the highlight path).
  // The mocked hast node has no actual classes, but `language-ts`
  // should NOT take the ai branch.
  {
    const node = buildHastNode('console.log(1)', 'ts')
    const out = codeBlockFromNode(node, null)
    const html = renderToStaticMarkup(out as ReturnType<typeof createElement>)
    assert(
      'integration: language-ts keeps CodeBlock path',
      !html.includes('AI block'),
      'CodeBlock must not render the AI shell'
    )
  }

  console.log(`ai-block: Task 8.5 check`)
  ok.forEach((name) => console.log(`  ok  ${name}`))
  fail.forEach((name) => console.log(`  FAIL ${name}`))
  console.log('')
  console.log(`${ok.length}/${ok.length + fail.length} pass`)
  if (fail.length > 0) process.exit(1)
}

main()
