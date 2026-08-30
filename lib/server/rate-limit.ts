/**
 * In-process rate limiting.
 *
 * `POST /api/auth` had no limit of any kind: unlimited guesses against a single
 * human-chosen password, with no lockout, no log, and no alert. The write routes had
 * none either, so one authenticated client could fill the bucket.
 *
 * **This is per-instance, and that is a real limitation.** On serverless, N instances
 * mean N times the allowance, and a cold start resets the counter. It is not a
 * distributed limiter and must not be described as one. What it does buy is turning
 * "unlimited guesses from one connection" into "a handful per window", which is the
 * difference between an online password attack being practical and being useless —
 * and it costs no new infrastructure. A shared limiter belongs with the shared
 * session store, when accounts arrive.
 */

interface Bucket {
  /** Timestamps of requests still inside the window. */
  hits: number[]
}

const buckets = new Map<string, Bucket>()

/** Stops the map growing without bound in a long-lived process. */
const MAX_TRACKED_KEYS = 10_000

export interface RateLimitRule {
  /** Requests permitted per window. */
  limit: number
  windowMs: number
}

export interface RateLimitResult {
  ok: boolean
  remaining: number
  /** Seconds until the next request would be allowed. Zero when `ok`. */
  retryAfter: number
}

export const AUTH_LIMIT: RateLimitRule = { limit: 5, windowMs: 15 * 60 * 1000 }
export const WRITE_LIMIT: RateLimitRule = { limit: 120, windowMs: 60 * 1000 }
/** Per-client AI stream allowance. The server has no vault identity, so this
 *  is the closest the server gets to "per vault" without a shared store. */
export const AI_LIMIT: RateLimitRule = { limit: 10, windowMs: 60 * 1000 }

export function checkRateLimit(
  key: string,
  rule: RateLimitRule,
  now: number = Date.now()
): RateLimitResult {
  const cutoff = now - rule.windowMs

  let bucket = buckets.get(key)
  if (!bucket) {
    if (buckets.size >= MAX_TRACKED_KEYS) evictExpired(now)
    bucket = { hits: [] }
    buckets.set(key, bucket)
  }

  bucket.hits = bucket.hits.filter((at) => at > cutoff)

  if (bucket.hits.length >= rule.limit) {
    const oldest = bucket.hits[0]
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000)),
    }
  }

  bucket.hits.push(now)
  return { ok: true, remaining: rule.limit - bucket.hits.length, retryAfter: 0 }
}

/** Forgets a key — called after a successful login so one typo is not punished. */
export function clearRateLimit(key: string): void {
  buckets.delete(key)
}

function evictExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    // The widest window in use; anything older cannot matter to any rule.
    if (bucket.hits.every((at) => at <= now - AUTH_LIMIT.windowMs)) buckets.delete(key)
  }
  // Still full of live entries: drop the oldest half rather than grow forever. Under
  // that much pressure the limiter is already the wrong tool, and refusing to
  // allocate is better than an unbounded map.
  if (buckets.size >= MAX_TRACKED_KEYS) {
    const keys = [...buckets.keys()].slice(0, Math.floor(MAX_TRACKED_KEYS / 2))
    for (const key of keys) buckets.delete(key)
  }
}

/** Test seam. */
export function resetRateLimits(): void {
  buckets.clear()
}

/**
 * Best-effort client identity for limiting.
 *
 * Behind a proxy this is a header the client cannot set directly but the proxy can —
 * on Vercel `x-forwarded-for` is trustworthy. Anywhere else it is a hint, which is
 * why this is a rate limiter and not an access control.
 */
export function clientKey(request: Request, prefix: string): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const real = request.headers.get('x-real-ip')?.trim()
  return `${prefix}:${forwarded || real || 'unknown'}`
}
