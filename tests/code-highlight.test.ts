import { highlightCode, languageLabel, MAX_HIGHLIGHT_BYTES } from '../components/workspace/code-highlight'

/**
 * Reading-view code highlighting suite.
 *
 * The reason this is worth testing rather than eyeballing: the tokens are spliced
 * back into a rendered block, and `highlightTree` only reports the ranges the grammar
 * has something to say about. Everything between those ranges is ordinary text that
 * the caller has to carry across itself — and a bug there does not look like a bug,
 * it looks like a code block that quietly lost its whitespace, its punctuation, or a
 * word in the middle of a line.
 *
 * So the load-bearing property is reassembly: **concatenating the tokens must give
 * back the input, byte for byte**, whatever the language. Everything else here is
 * about failing softly — an unknown language must degrade to plain text, never throw,
 * because a code block that fails to render takes the document with it.
 */

let passed = 0
const failures: string[] = []

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
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
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n      expected: ${b}\n      actual:   ${a}`)
}

const SQL = `-- monthly totals
SELECT c.name, SUM(o.total) AS revenue
FROM orders o
  JOIN customers c ON c.id = o.customer_id
WHERE o.created_at >= '2026-01-01'
GROUP BY c.name
ORDER BY revenue DESC;
`

export async function runCodeHighlightTests(): Promise<boolean> {
  console.log('Code highlighting suite\n')

  console.log('reassembly')

  await check('the tokens put the code back together exactly', async () => {
    const result = await highlightCode(SQL, 'sql')
    assert(result, 'sql did not highlight at all')
    equal(result.tokens.map((t) => t.text).join(''), SQL, 'the rendered block would not match the source')
  })

  await check('reassembly holds across languages', async () => {
    const samples: Array<[string, string]> = [
      ['javascript', 'const x = {a: 1}\n\nfunction go() {\n  return `hi ${x.a}`\n}\n'],
      ['python', 'def go(n):\n    """docstring"""\n    return [i * 2 for i in range(n)]\n'],
      ['json', '{\n  "a": [1, 2.5, true, null],\n  "b": "text"\n}\n'],
      ['yaml', 'id: abc\ncreated: 2026-08-18\ntags:\n  - one\n  - two\n'],
      ['css', '.tok-keyword { color: var(--cm-keyword); }\n'],
      ['html', '<p class="x">hi &amp; bye</p>\n'],
    ]

    for (const [language, code] of samples) {
      const result = await highlightCode(code, language)
      assert(result, `${language} did not highlight`)
      equal(result.tokens.map((t) => t.text).join(''), code, `${language} lost or duplicated text`)
    }
  })

  await check('tokens never overlap, and arrive in order', async () => {
    // Concatenation alone would not catch a token emitted twice at different offsets,
    // so the walk is checked directly.
    const result = await highlightCode(SQL, 'sql')
    assert(result, 'sql did not highlight')
    let at = 0
    for (const token of result.tokens) {
      assert(token.text.length > 0, `an empty token at offset ${at}`)
      equal(SQL.slice(at, at + token.text.length), token.text, `token at ${at} is not where it claims`)
      at += token.text.length
    }
    equal(at, SQL.length, 'the walk did not cover the whole block')
  })

  console.log('')
  console.log('what actually gets coloured')

  await check('sql keywords and strings are classified', async () => {
    const result = await highlightCode(SQL, 'sql')
    assert(result, 'sql did not highlight')

    const classOf = (text: string) =>
      result.tokens.find((token) => token.text === text)?.className ?? ''

    assert(classOf('SELECT').includes('tok-keyword'), 'SELECT was not a keyword')
    assert(
      result.tokens.some((t) => t.text.includes('2026-01-01') && t.className.includes('tok-string')),
      'the quoted date was not a string'
    )
    assert(
      result.tokens.some((t) => t.className.includes('tok-') && t.text.startsWith('--')),
      'the SQL comment was not classified'
    )
  })

  await check('the label is the grammar name, not the tag as typed', async () => {
    // ```ts settles into "TypeScript" once the grammar is loaded, which is what the
    // block's header shows.
    const result = await highlightCode('const a: number = 1\n', 'ts')
    assert(result, 'ts did not resolve through its alias')
    equal(result.label, 'TypeScript', 'wrong display name')
  })

  console.log('')
  console.log('failing softly')

  await check('an unknown language is plain text, not an error', async () => {
    equal(await highlightCode('some words\n', 'not-a-language'), null, 'invented a grammar')
  })

  await check('an untagged fence is plain text', async () => {
    equal(await highlightCode('plain\n', ''), null, 'highlighted an untagged fence')
    equal(await highlightCode('plain\n', '   '), null, 'highlighted a whitespace tag')
  })

  await check('a near-miss tag is refused rather than guessed at', async () => {
    // Fuzzy matching is off: it resolves any tag that merely *contains* a language
    // name, so `notsql` would come back confidently coloured as SQL.
    equal(await highlightCode('SELECT 1;\n', 'notsql'), null, 'fuzzy-matched a wrong tag')
  })

  await check('an oversized block is left alone', async () => {
    const huge = 'SELECT 1;\n'.repeat(Math.ceil(MAX_HIGHLIGHT_BYTES / 10) + 1)
    assert(huge.length > MAX_HIGHLIGHT_BYTES, 'the fixture is not actually oversized')
    equal(await highlightCode(huge, 'sql'), null, 'parsed a block past the size cap')
  })

  await check('an empty block does not break the walk', async () => {
    const result = await highlightCode('', 'sql')
    assert(result, 'an empty sql block should still resolve its grammar')
    equal(result.tokens.map((t) => t.text).join(''), '', 'invented content')
  })

  console.log('')
  console.log('the header label before the grammar arrives')

  await check('short tags are uppercased, longer ones are left as written', () => {
    equal(languageLabel('sql'), 'SQL', 'short tag not uppercased')
    equal(languageLabel('css'), 'CSS', 'short tag not uppercased')
    equal(languageLabel('typescript'), 'typescript', 'a long tag was shouted at')
    equal(languageLabel(''), 'Code', 'an untagged fence had no label')
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

if (require.main === module) {
  runCodeHighlightTests().then((ok) => process.exit(ok ? 0 : 1))
}
