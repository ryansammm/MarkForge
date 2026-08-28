import { it } from 'vitest'
import { captureError, log, logSecurityEvent, redact, scrubMessage } from '../lib/server/observability'

/**
 * Observability suite (production-readiness plan, Phase 3).
 *
 * One property, tested from several directions: **nothing identifying reaches a log
 * line.** For a private notes app the document paths and titles are the sensitive
 * material — `Divorce/Lawyer questions.md` leaks the substance of a note without
 * leaking a byte of its body — and a share token is the credential itself.
 *
 * A log line is a copy of that in somebody else's system: a hosting dashboard, an
 * aggregator, a retention bucket, a support ticket. This is the kind of rule that
 * stops being true one convenient console.log at a time, so it is asserted rather
 * than documented.
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
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n      expected: ${b}\n      actual:   ${a}`)
}

/** Captures everything written to the console during `fn`. */
function captureOutput(fn: () => void): string {
  const written: string[] = []
  const original = { log: console.log, warn: console.warn, error: console.error }

  console.log = (...args: unknown[]) => written.push(args.join(' '))
  console.warn = (...args: unknown[]) => written.push(args.join(' '))
  console.error = (...args: unknown[]) => written.push(args.join(' '))

  try {
    fn()
  } finally {
    Object.assign(console, original)
  }
  return written.join('\n')
}

/** Strings that must never survive into a log line, whatever route they take. */
const SECRETS = [
  'Divorce/Lawyer questions.md',
  'Salary Review 2026',
  '3xK9pQvT7mZr2Nw8LbYc4A',
  'hunter2',
]

function assertClean(output: string, context: string) {
  for (const secret of SECRETS) {
    assert(!output.includes(secret), `${context} leaked ${JSON.stringify(secret)}\n      in: ${output}`)
  }
}

export function runObservabilityTests(): boolean {
  console.log('Observability suite (Phase 3)\n')

  console.log('redaction')

  check('a document path is replaced by its shape', () => {
    const out = redact({ path: 'Divorce/Lawyer questions.md' }) as Record<string, string>
    assert(!JSON.stringify(out).includes('Divorce'), 'the path survived redaction')
    assert(out.path.startsWith('[redacted'), 'the path was not marked as redacted')
  })

  check('a title, a token and a password are all redacted', () => {
    const out = JSON.stringify(
      redact({ title: 'Salary Review 2026', token: '3xK9pQvT7mZr2Nw8LbYc4A', password: 'hunter2' })
    )
    assertClean(out, 'redact')
  })

  check('a list of paths becomes a count, never its elements', () => {
    // The most tempting thing to log after a rename, and the most damaging: a list of
    // paths is a map of somebody's private workspace.
    const out = redact({ paths: ['a/One.md', 'b/Two.md', 'c/Three.md'] }) as Record<string, string>
    equal(out.paths, '[3 items]', 'the paths were logged individually')
  })

  check('a nested path is caught as well as a top-level one', () => {
    const out = JSON.stringify(redact({ result: { document: { path: 'Divorce/Lawyer questions.md' } } }))
    assertClean(out, 'nested redact')
  })

  check('a secret-shaped value is redacted whatever it is called', () => {
    // Keys are a naming convention; a credential is a credential.
    const out = JSON.stringify(redact({ innocuous: '3xK9pQvT7mZr2Nw8LbYc4A' }))
    assertClean(out, 'shape-based redaction')
  })

  check('counts, durations and statuses survive — they are the point', () => {
    const out = redact({ scope: 'api/rename', event: 'done', updated: 12, ms: 84, ok: true })
    equal(out, { scope: 'api/rename', event: 'done', updated: 12, ms: 84, ok: true }, 'useful fields were lost')
  })

  console.log('\nmessage scrubbing')

  check('a path inside an error message is scrubbed', () => {
    equal(
      scrubMessage('No such document: Divorce/Lawyer questions.md'),
      'No such document: [path]',
      'the message kept the path'
    )
  })

  check('a bare filename is scrubbed', () => {
    equal(scrubMessage('Note.md changed since it was loaded'), '[path] changed since it was loaded', 'kept the filename')
  })

  check('a message with nothing identifying is left alone', () => {
    const message = 'Could not update the index after 5 attempts'
    equal(scrubMessage(message), message, 'a harmless message was mangled')
  })

  console.log('\nwhat actually reaches the console')

  check('log() emits one line of JSON', () => {
    const output = captureOutput(() => log('info', { scope: 'api/files', event: 'write', bytes: 42 }))
    const parsed = JSON.parse(output) as Record<string, unknown>
    equal(parsed.scope, 'api/files', 'scope missing')
    equal(parsed.event, 'write', 'event missing')
    equal(parsed.level, 'info', 'level missing')
    assert(typeof parsed.ts === 'string', 'no timestamp')
  })

  check('a captured error leaks nothing, even when the error names a path', () => {
    const output = captureOutput(() =>
      captureError(new Error('No such document: Divorce/Lawyer questions.md'), {
        scope: 'api/files',
        event: 'unhandled',
        path: 'Divorce/Lawyer questions.md',
        token: '3xK9pQvT7mZr2Nw8LbYc4A',
      })
    )
    assertClean(output, 'captureError')
    assert(output.includes('api/files'), 'the scope was lost, so the log is useless')
  })

  check('a security event records the attempt and not the credential', () => {
    const output = captureOutput(() => logSecurityEvent('auth-failed', { remaining: 3 }))
    assertClean(output, 'logSecurityEvent')
    assert(output.includes('auth-failed'), 'the event name was lost')
    assert(output.includes('security'), 'the scope was lost')
  })

  check('an error object with no message still reports', () => {
    // Reporting has to survive whatever it is handed, or an unusual failure becomes
    // an invisible one.
    const output = captureOutput(() => captureError('a string, not an Error', { scope: 'x', event: 'y' }))
    assert(output.includes('"scope":"x"'), 'a non-Error was not reported')
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

it('observability suite', async () => {
  if (!(await runObservabilityTests())) throw new Error('observability suite FAILED')
}, 60000)
