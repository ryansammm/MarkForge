/**
 * Structured logging and error reporting.
 *
 * Routes used to `console.error(err)` and return an opaque 500. In production nobody
 * reads those, so a failure that mattered looked exactly like a failure that did not:
 * silence.
 *
 * **The redaction rule is the load-bearing part.** A log line is a copy of your data
 * in somebody else's system — a hosting dashboard, a log aggregator, a retention
 * bucket, a support ticket. For a private notes app, the document paths and titles
 * *are* the sensitive material: `Divorce/Lawyer questions.md` leaks the substance of
 * a note without leaking a single byte of its body. Share tokens are worse, because a
 * token is the credential itself.
 *
 * So nothing here logs a path, a title, or a token. What it logs is shape: which
 * route, which status, how long, how many. `tests/observability.test.ts` asserts it
 * against real-looking data, because this is the kind of rule that quietly stops
 * being true one convenient `console.log` at a time.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogContext {
  /** Route or subsystem, e.g. `api/files`. Never a document path. */
  scope: string
  /** What happened, in fixed vocabulary: `write`, `refused`, `conflict`. */
  event: string
  [key: string]: unknown
}

/**
 * Keys whose values are never safe to log, whatever they are called elsewhere.
 *
 * Matched case-insensitively as substrings, so `documentPath`, `sharePath` and
 * `to`/`from` path fields all get caught by `path`.
 */
const FORBIDDEN_KEYS = [
  'path',
  'title',
  'token',
  'password',
  'secret',
  'content',
  'body',
  'raw',
  'label',
  'cookie',
  'authorization',
  'key',
  'alias',
]

/** Values that look like a credential regardless of the key they arrived under. */
const SECRET_SHAPED = /^[A-Za-z0-9_-]{20,}$/

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase()
  return FORBIDDEN_KEYS.some((forbidden) => lower.includes(forbidden))
}

/**
 * Replaces anything identifying with a description of it.
 *
 * A count or a length is almost always what the log was actually for — "the rename
 * touched 12 documents" is the useful fact, and the twelve names are the leak.
 */
export function redact(value: unknown, key = ''): unknown {
  if (value === null || value === undefined) return value

  if (typeof value === 'string') {
    if (key && isForbiddenKey(key)) return `[redacted ${value.length} chars]`
    if (SECRET_SHAPED.test(value)) return '[redacted]'
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value

  if (Array.isArray(value)) {
    // Never the elements. A list of paths is the most tempting thing to log and the
    // most damaging: it is a map of somebody's private workspace.
    return key && isForbiddenKey(key) ? `[${value.length} items]` : value.map((item) => redact(item))
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = isForbiddenKey(childKey) ? redactValueForKey(childValue) : redact(childValue, childKey)
    }
    return out
  }

  return '[unloggable]'
}

function redactValueForKey(value: unknown): unknown {
  if (typeof value === 'string') return `[redacted ${value.length} chars]`
  if (Array.isArray(value)) return `[${value.length} items]`
  if (value === null || value === undefined) return value
  return '[redacted]'
}

/** One line of JSON per event, so a log aggregator can group and alert on it. */
export function log(level: LogLevel, context: LogContext): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...(redact(context) as Record<string, unknown>),
  })

  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/**
 * Reports an error, and tries to put it in front of a human.
 *
 * The launch criterion is "an error in production reaches a human within 5 minutes",
 * which a log line in a hosting dashboard does not satisfy on its own. `ERROR_WEBHOOK_URL`
 * — a Slack or Discord incoming webhook — is the cheapest thing that does.
 *
 * Deliberately no vendor SDK. Sentry belongs at exactly this function, and wiring it
 * is a few lines here rather than a dependency, an init file and a build plugin that
 * have to be carried whether or not anyone has configured them.
 *
 * Never throws. An observability failure must not become an application failure.
 */
export function captureError(error: unknown, context: LogContext): void {
  const err = error as Error & { code?: string; $metadata?: { httpStatusCode?: number } }

  const payload = {
    ...context,
    error: {
      name: err?.name ?? 'Error',
      // The message routinely names a path — `No such document: Private/Note.md` —
      // so it is scrubbed by shape rather than by key.
      message: scrubMessage(err?.message ?? String(error)),
      code: err?.code ?? null,
      httpStatus: err?.$metadata?.httpStatusCode ?? null,
    },
  }

  log('error', payload)
  void notify(payload)
}

/**
 * An error message cannot be dropped — an error with no message is not reportable —
 * so paths are stripped out of it by shape instead of by key: anything ending in
 * `.md`, and anything with slashes in it.
 */
// A path segment may contain spaces — `Getting started/Welcome.md` — but must not
// *begin* with one, or the match swallows the space in front of it and the scrubbed
// message reads `No such document:[path]`.
const PATH_LIKE = /[^\s"']*\.md\b|(?:[\w.-][\w .-]*\/)+[\w .-]+/g

export function scrubMessage(message: string): string {
  return message.replace(PATH_LIKE, '[path]')
}

async function notify(payload: Record<string, unknown>): Promise<void> {
  const url = process.env.ERROR_WEBHOOK_URL
  if (!url) return

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Slack and Discord both accept `text`, so one payload serves both.
      body: JSON.stringify({
        text: `Markdown Workspace error in ${payload.scope}: ${JSON.stringify(payload.error)}`,
      }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // A webhook that is down must not take a request with it.
  }
}

/** Security-relevant events, which are worth finding in a log even when nothing broke. */
export function logSecurityEvent(event: string, context: Omit<LogContext, 'scope' | 'event'> = {}): void {
  log('warn', { scope: 'security', event, ...context })
}
