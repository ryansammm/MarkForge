import { NextRequest, NextResponse } from 'next/server'
import { getSearchIndex } from '@/lib/server/search'
import { resolveStore } from '@/lib/server/resolve-store'
import { captureError } from '@/lib/server/observability'
import { WRITE_LIMIT, checkRateLimit, clientKey } from '@/lib/server/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Full-text search. **Authenticated** — it reads every document in the workspace.
 *
 *   GET /api/search?q=term&limit=10
 *
 * This used to happen in the browser, which is why the index shipped every document's
 * body to it. Now the client sends a query string and receives ten results.
 *
 * Rate-limited on the write budget rather than a separate one: a search is cheap for
 * the caller and, on a cold instance, expensive for the server.
 */
export async function GET(request: NextRequest) {
  try {
    const limited = checkRateLimit(clientKey(request, 'search'), WRITE_LIMIT)
    if (!limited.ok) {
      return NextResponse.json(
        { error: 'Too many searches. Slow down.', code: 'RATE_LIMITED' },
        { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } }
      )
    }

    const term = request.nextUrl.searchParams.get('q') ?? ''
    const requested = Number(request.nextUrl.searchParams.get('limit') ?? 10)
    const limit = Number.isFinite(requested) ? Math.min(50, Math.max(1, requested)) : 10

    // An empty query is not an error — it is what the dialog sends before typing.
    if (!term.trim()) {
      return NextResponse.json({ hits: [] }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // Single workspace; resolveStore kept for grep-ability.
    const store = await resolveStore(request)
    const hits = await getSearchIndex(store).query(term, limit)
    return NextResponse.json({ hits }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    captureError(err, { scope: 'api/search', event: 'query-failed' })
    return NextResponse.json({ error: 'Search failed', code: 'INTERNAL' }, { status: 500 })
  }
}
