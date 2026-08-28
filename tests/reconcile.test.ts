import { it } from 'vitest'
import { minimalEdit, reconcileEdit } from '../components/workspace/reconcile'

/**
 * Buffer reconciliation suite.
 *
 * The bug this exists to keep fixed lost work, silently, in the one place the app
 * promises it will not: switching to the reading view and back reverted the document
 * to whenever the server last spliced frontmatter into it, and then autosaved that
 * revert over the real file.
 *
 * The cause was not the splice. It was that the server's version is held in a state
 * slot belonging to the *workspace*, while the thing that applies it is the *editor* —
 * which unmounts when you press Read and mounts fresh when you press Edit, running
 * every effect again. A one-time event stored as a value gets replayed every time
 * something re-reads it.
 *
 * So the property under test is: an editor only ever adopts a version it has not
 * already dealt with, and a freshly built one has by definition dealt with whatever
 * the workspace is holding, because its buffer was built from the same source.
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

function equal(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n      expected: ${b}\n      actual:   ${a}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Applies an edit the way CodeMirror would, so a returned edit can be checked. */
function apply(text: string, edit: { from: number; to: number; insert: string } | null): string {
  if (!edit) return text
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
}

const STAMPED = '---\nid: abc\ncreated: 2026-08-18T13:46:16.943Z\n---\n\n# Welcome\n\n[[]]\n'

export function runReconcileTests(): boolean {
  console.log('Buffer reconciliation suite\n')

  console.log('the minimal edit')

  check('an insertion is expressed as an insertion, not a whole-document replace', () => {
    const from = '# Note\n\nbody\n'
    const to = '---\nid: abc\n---\n\n# Note\n\nbody\n'
    const edit = minimalEdit(from, to)
    assert(edit, 'no edit produced')
    equal(edit.from, 0, 'wrong start')
    equal(edit.to, 0, 'a pure insertion should replace nothing')
    equal(apply(from, edit), to, 'the edit does not produce the target text')
  })

  check('a line spliced into existing frontmatter touches only that point', () => {
    const from = '---\nid: abc\n---\n\nBody\n'
    const to = '---\nid: abc\ncreated: 2026-08-18\n---\n\nBody\n'
    const edit = minimalEdit(from, to)
    assert(edit, 'no edit produced')
    // The document is 22 characters; the edit must not span it.
    assert(edit.to - edit.from < from.length, 'the edit replaced the whole document')
    equal(apply(from, edit), to, 'the edit does not produce the target text')
  })

  check('identical text produces no edit at all', () => {
    equal(minimalEdit('same\n', 'same\n'), null, 'invented an edit')
  })

  check('a deletion round-trips', () => {
    const from = 'one\ntwo\nthree\n'
    const to = 'one\nthree\n'
    equal(apply(from, minimalEdit(from, to)), to, 'the edit does not produce the target text')
  })

  console.log('')
  console.log('what an editor adopts')

  check('a version that arrives while mounted is adopted', () => {
    const buffer = '# Welcome\n\n[[]]\n'
    const result = reconcileEdit(buffer, STAMPED, null)
    assert(result.edit, 'the frontmatter splice was not applied')
    equal(apply(buffer, result.edit), STAMPED, 'the buffer did not end up matching the server')
    equal(result.applied, STAMPED, 'the adopted version was not recorded')
  })

  check('the same version is never adopted twice', () => {
    // The remount. `applied` is seeded from what the workspace is holding, and the
    // buffer has since moved a long way past it.
    const newer = STAMPED.replace('[[]]\n', '[[Password Manager]]\n\n```sql\nSELECT 1;\n```\n')
    const result = reconcileEdit(newer, STAMPED, STAMPED)
    equal(result.edit, null, 'replayed an old version over newer typing')
    equal(result.applied, STAMPED, 'the record was disturbed')
  })

  check('the exact reported failure: read, edit, and the newest text survives', () => {
    /*
      Step by step, as it happened:
        1. the document is opened and typed into, ending at `[[]]`
        2. the first autosave lands and the server returns the text plus `created:`
        3. more typing — a wikilink and a fenced SQL block
        4. Read, then Edit: the editor is rebuilt from the workspace's latest bytes
        5. the workspace is *still* holding the version from step 2
    */
    const afterSplice = STAMPED
    const afterMoreTyping = STAMPED.replace(
      '[[]]\n',
      '[[Password Manager — Rencana Fitur]]\n\n```sql\nSELECT * FROM dbo.[PERMIT]\n```\n'
    )

    // Step 4: a fresh editor seeds its record with whatever is being held.
    const seeded = afterSplice
    const result = reconcileEdit(afterMoreTyping, afterSplice, seeded)

    equal(result.edit, null, 'the editor reverted the document on re-entry')
    equal(
      apply(afterMoreTyping, result.edit),
      afterMoreTyping,
      'the wikilink and the code block did not survive'
    )
  })

  check('nothing held means nothing to do', () => {
    equal(reconcileEdit('# Note\n', null, null), { edit: null, applied: null }, 'acted on null')
    equal(
      reconcileEdit('# Note\n', undefined, 'earlier'),
      { edit: null, applied: 'earlier' },
      'acted on undefined, or forgot the record'
    )
  })

  check('a new version after an adopted one is still adopted', () => {
    // Two splices in one editing session — an id, then something else later. The
    // guard must not turn into "reconcile once and never again".
    const first = '---\nid: abc\n---\n\nBody\n'
    const second = '---\nid: abc\ncreated: 2026-08-18\n---\n\nBody\n'
    const result = reconcileEdit(first, second, first)
    assert(result.edit, 'the second version was refused')
    equal(apply(first, result.edit), second, 'wrong result')
    equal(result.applied, second, 'the record did not move on')
  })

  check('a version the buffer already matches is recorded anyway', () => {
    // No edit to make, but it has been dealt with — and leaving it unrecorded would
    // mean re-testing it on every later render of the editor.
    const result = reconcileEdit(STAMPED, STAMPED, null)
    equal(result.edit, null, 'produced an edit for identical text')
    equal(result.applied, STAMPED, 'a no-op reconcile was not recorded')
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

it('reconcile suite', async () => {
  if (!(await runReconcileTests())) throw new Error('reconcile suite FAILED')
}, 60000)
