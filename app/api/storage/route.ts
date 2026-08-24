import { NextResponse } from 'next/server'
import { backendHealth, createBucket, getStore } from '@/lib/server/store'
import { R2Bucket } from '@/lib/server/r2-bucket'
import { captureError } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Storage diagnostics. **Authenticated** — behind the password gate.
 *
 * Exists because the first real R2 misconfiguration surfaced as:
 *
 *   Error: write EPROTO … tls alert handshake failure … alert number 40
 *
 * on every route at once, with nothing to say which setting was wrong or even
 * which host was being dialled. This answers that: what backend is selected, what
 * endpoint and bucket it resolved to, and whether a live round trip succeeds —
 * with the underlying error verbatim when it does not.
 *
 * Credentials are never included. The endpoint and bucket are configuration, not
 * secrets, and withholding them is what made the original failure so slow to
 * diagnose.
 */
export async function GET() {
  const health = backendHealth()

  const report: Record<string, unknown> = {
    backend: health.kind,
    durable: health.durable,
    ...(health.warning ? { warning: health.warning } : {}),
  }

  try {
    const bucket = createBucket()

    if (bucket instanceof R2Bucket) {
      report.endpoint = bucket.endpoint
      report.bucket = process.env.R2_BUCKET?.trim()
      report.prefix = process.env.R2_PREFIX?.trim() ?? 'notes'
      report.jurisdiction = process.env.R2_JURISDICTION?.trim() ?? null
      report.pathStyle = true
    }

    // A real round trip. Listing is read-only and safe to run on demand.
    const started = Date.now()
    const keys = await bucket.listKeys()
    report.connection = 'ok'
    report.documentCount = keys.length
    report.latencyMs = Date.now() - started
  } catch (err) {
    const error = err as Error & { code?: string; $metadata?: { httpStatusCode?: number } }
    report.connection = 'failed'
    report.error = {
      name: error.name,
      message: error.message,
      code: error.code ?? null,
      httpStatus: error.$metadata?.httpStatusCode ?? null,
    }
    report.hint = hintFor(error)

    return NextResponse.json(report, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Rebuilds index.json from storage alone. **Authenticated.**
 *
 *   POST /api/storage?action=reindex
 *
 * The repair for an index that disagrees with the corpus, and the operation the
 * runbook needs. It is safe by construction rather than by care: nothing here reads
 * the existing index, so the worst case is that it recomputes what was already true.
 * That is the whole point of the index being derived — a wrong one is an
 * inconvenience, not a loss.
 *
 * It exists because an index *did* go wrong: the backend conformance suite, run with
 * real credentials, wrote its scenario over the live index because `_meta` was shared
 * across every prefix in the bucket. The suite is namespaced now; this is what puts a
 * deployment back afterwards.
 */
export async function POST(request: Request) {
  const action = new URL(request.url).searchParams.get('action')
  if (action !== 'reindex') {
    return NextResponse.json(
      { error: 'Unknown action. Use ?action=reindex', code: 'BAD_REQUEST' },
      { status: 400 }
    )
  }

  try {
    const started = Date.now()
    const index = await getStore().reindex()

    return NextResponse.json(
      {
        ok: true,
        documentCount: Object.keys(index.documents).length,
        folderCount: index.tree.filter((node) => node.isDir).length,
        durationMs: Date.now() - started,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    captureError(err, { scope: 'api/storage', event: 'reindex-failed' })
    return NextResponse.json({ error: 'Reindex failed', code: 'INTERNAL' }, { status: 500 })
  }
}

/** Turns the errors this has actually produced into the setting to go and check. */
function hintFor(error: Error & { code?: string; $metadata?: { httpStatusCode?: number } }): string {
  const message = error.message.toLowerCase()

  if (error.code === 'EPROTO' || message.includes('handshake')) {
    return (
      'TLS handshake failure. Usually the endpoint hostname is not one Cloudflare serves a ' +
      'certificate for: check R2_ACCOUNT_ID for typos or stray whitespace, and set ' +
      'R2_JURISDICTION=eu if the bucket was created in the EU jurisdiction.'
    )
  }
  if (error.code === 'ENOTFOUND' || message.includes('getaddrinfo')) {
    return 'DNS lookup failed for the endpoint host. Check R2_ACCOUNT_ID.'
  }
  if (error.$metadata?.httpStatusCode === 403 || error.name === 'InvalidAccessKeyId') {
    return 'Rejected by R2. Check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, and that the token has access to this bucket.'
  }
  if (error.name === 'NoSuchBucket' || error.$metadata?.httpStatusCode === 404) {
    return 'The bucket does not exist, or the token cannot see it. Check R2_BUCKET.'
  }
  return 'Check the storage environment variables against docs/storage-backends.md.'
}
