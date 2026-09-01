import {
  splitFrontmatter,
  validateFrontmatter,
  ensureDocumentId,
  ensureDocumentMeta,
  frontmatterTags,
} from '../lib/markdown/frontmatter'

/**
 * Frontmatter contract suite (PRD R7).
 *
 * Two Sprint 4 DoD items live here:
 *   - a document created outside the app, with no frontmatter, is fully usable and
 *     gets an id on first save
 *   - `2026-08-15` stays a string; `NO` stays a string
 *
 * The second is not pedantry. YAML 1.1 resolves both of those to non-string types,
 * and a notes app that turns a date into a Date object and `NO` into `false` will
 * eventually write them back in a form the user did not write.
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
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
  }
}

export function runFrontmatterTests(): boolean {
  console.log('Frontmatter contract suite (R7)\n')

  console.log('type preservation')
  check('a date stays a string', () => {
    const { frontmatter } = splitFrontmatter('---\ndate: 2026-08-15\n---\n\nBody\n')
    equal(frontmatter.date, '2026-08-15', 'date was retyped')
    equal(typeof frontmatter.date, 'string', 'date is not a string')
  })

  check('NO stays a string', () => {
    const { frontmatter } = splitFrontmatter('---\nreviewed: NO\npublished: yes\noff: off\n---\n')
    equal(frontmatter.reviewed, 'NO', 'NO was retyped')
    equal(frontmatter.published, 'yes', 'yes was retyped')
    equal(frontmatter.off, 'off', 'off was retyped')
  })

  check('real booleans and numbers still parse', () => {
    const { frontmatter } = splitFrontmatter('---\ndraft: true\norder: 3\n---\n')
    equal(frontmatter.draft, true, 'true should be a boolean')
    equal(frontmatter.order, 3, '3 should be a number')
  })

  console.log('\nsoft failure')
  check('invalid YAML does not make the document unopenable', () => {
    const doc = '---\ntitle: [unclosed\n---\n\n# Still readable\n'
    const split = splitFrontmatter(doc)
    assert(split.invalid, 'should be flagged invalid')
    equal(split.frontmatter, {}, 'should soft-fail to empty metadata')
    assert(split.body.includes('# Still readable'), 'body was lost')
  })

  check('validation salvages the good keys and reports the bad', () => {
    const { data, issues } = validateFrontmatter({ title: 'Fine', id: 42, custom: 'kept' })
    equal(data.title, 'Fine', 'valid key was dropped')
    equal(data.custom, 'kept', 'unknown key was dropped')
    assert(!('id' in data), 'invalid key was kept')
    assert(issues.length === 1 && issues[0].startsWith('id:'), `unexpected issues: ${JSON.stringify(issues)}`)
  })

  check('unknown fields from other tools pass through', () => {
    const { data, issues } = validateFrontmatter({ cssclass: 'wide', publish: true })
    equal(issues, [], 'unknown fields should not be issues')
    equal(data.cssclass, 'wide', 'field from another tool was eaten')
  })

  check('tags read from either shape', () => {
    equal(frontmatterTags({ tags: ['a', 'b'] }), ['a', 'b'], 'list form')
    equal(frontmatterTags({ tags: 'a, b' }), ['a', 'b'], 'comma-string form')
    equal(frontmatterTags({}), [], 'absent')
  })

  console.log('\nid assignment')
  check('a document with no frontmatter resolves an id without touching content', () => {
    const result = ensureDocumentId('# External Note\n\nWritten in vim.\n', () => 'fixed-id')
    assert(result.changed, 'should report a change')
    equal(result.id, 'fixed-id', 'wrong id')
    equal(
      result.content,
      '# External Note\n\nWritten in vim.\n',
      'content was mutated'
    )
  })

  check('an existing block is read, not spliced into', () => {
    const before = '---\ntitle: Existing\ntags: [a]\n---\n\nBody\n'
    const result = ensureDocumentId(before, () => 'fixed-id')
    assert(result.changed, 'should report a change')
    equal(result.content, before, 'content was mutated')
    equal(result.id, 'fixed-id', 'id should still be the freshly assigned one')
  })

  check('an existing id is left completely alone', () => {
    const before = '---\nid: already-here\ntitle: X\n---\n\nBody\n'
    const result = ensureDocumentId(before, () => 'should-not-be-used')
    assert(!result.changed, 'should not report a change')
    equal(result.content, before, 'content was modified')
    equal(result.id, 'already-here', 'wrong id returned')
  })

  check('id assignment is idempotent', () => {
    const once = ensureDocumentId('# Note\n', () => 'id-1').content
    const twice = ensureDocumentId(once, () => 'id-2').content
    equal(twice, once, 'second pass changed the document')
  })

  check('unparseable frontmatter is never rewritten', () => {
    const broken = '---\ntitle: [unclosed\n---\n\nBody\n'
    const result = ensureDocumentId(broken, () => 'fixed-id')
    equal(result.content, broken, 'invalid YAML was rewritten')
    equal(result.id, 'fixed-id', 'an id should still be resolved')
  })

  check('CRLF documents stay CRLF', () => {
    const result = ensureDocumentId('---\r\ntitle: X\r\n---\r\n\r\nBody\r\n', () => 'fixed-id')
    assert(!/id: fixed-id/.test(result.content), 'an id line was spliced in')
    assert(!/[^\r]\n/.test(result.content), 'mixed line endings introduced')
  })

  check('quoting and comments in frontmatter survive', () => {
    const before = "---\n# a comment\ntitle: 'single quoted'\n---\n\nBody\n"
    const result = ensureDocumentId(before, () => 'fixed-id')
    assert(result.content.includes('# a comment'), 'comment was lost')
    assert(result.content.includes("title: 'single quoted'"), 'quoting was normalized')
  })

  console.log('\ncreation stamp')

  const FIXED = () => new Date('2026-08-18T09:30:00.000Z')

  check('the first save resolves both id and created without writing them', () => {
    const result = ensureDocumentMeta('# New Note\n', { idFactory: () => 'fixed-id', now: FIXED })
    assert(result.changed, 'should report a change')
    equal(result.content, '# New Note\n', 'content was mutated')
    equal(result.id, 'fixed-id', 'wrong id')
    equal(result.created, '2026-08-18T09:30:00.000Z', 'wrong created')
  })

  check("a created date the author wrote is never overwritten", () => {
    // The whole point of reading it from the document: if somebody says when they
    // wrote a note, that is the truth, and no save is allowed to move it.
    const before = '---\nid: x\ncreated: 2019-04-01\n---\n\nBody\n'
    const result = ensureDocumentMeta(before, { idFactory: () => 'no', now: FIXED })
    assert(!result.changed, 'should not report a change')
    equal(result.content, before, 'content was modified')
    equal(result.created, '2019-04-01', 'wrong created returned')
  })

  check('a document that already has an id still resolves a created date', () => {
    const before = '---\nid: already-here\n---\n\nBody\n'
    const result = ensureDocumentMeta(before, {
      idFactory: () => 'no',
      now: FIXED,
    })
    assert(result.changed, 'should report a change')
    equal(result.id, 'already-here', 'the existing id was replaced')
    equal(result.created, '2026-08-18T09:30:00.000Z', 'created was not resolved')
    equal(result.content, before, 'content was mutated')
  })

  check('stamping is idempotent', () => {
    const once = ensureDocumentMeta('# Note\n', { idFactory: () => 'id-1', now: FIXED }).content
    const twice = ensureDocumentMeta(once, { idFactory: () => 'id-2' }).content
    equal(twice, once, 'second pass changed the document')
  })

  check('unparseable frontmatter is still never rewritten', () => {
    const broken = '---\ntitle: [unclosed\n---\n\nBody\n'
    const result = ensureDocumentMeta(broken, { idFactory: () => 'fixed-id', now: FIXED })
    equal(result.content, broken, 'invalid YAML was rewritten')
    equal(result.id, 'fixed-id', 'an id should still be resolved')
    equal(result.created, '2026-08-18T09:30:00.000Z', 'a created should still be resolved')
  })

  check('CRLF documents stay CRLF', () => {
    const result = ensureDocumentMeta('---\r\ntitle: X\r\n---\r\n\r\nBody\r\n', {
      idFactory: () => 'fixed-id',
      now: FIXED,
    })
    assert(!/id: fixed-id/.test(result.content), 'an id line was spliced in')
    assert(!/created:/.test(result.content), 'a created line was spliced in')
    assert(!/[^\r]\n/.test(result.content), 'mixed line endings introduced')
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
  process.exit(runFrontmatterTests() ? 0 : 1)
}
