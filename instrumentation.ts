import { captureError } from '@/lib/server/observability'

/**
 * The framework's error seam.
 *
 * `onRequestError` fires for every uncaught server error in every route, which makes
 * it the one place that cannot be forgotten when a new route is added. Routes still
 * catch what they can meaningfully answer for — a conflict, a missing document — and
 * anything that reaches here is by definition something nobody anticipated.
 *
 * This is where Sentry goes, if it ever goes anywhere: one call, inside a function
 * that already has the error and the request context.
 */
export function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context: { routerKind?: string; routePath?: string; routeType?: string }
): void {
  captureError(error, {
    scope: 'unhandled',
    event: 'request-error',
    method: request.method ?? 'unknown',
    // `routePath` is the *pattern* — `/api/share/[token]` — not the URL, so it names
    // the code without naming the document or the token.
    route: context.routePath ?? 'unknown',
    routeType: context.routeType ?? 'unknown',
  })
}

export async function register(): Promise<void> {
  // Nothing to initialise yet. Present because `onRequestError` is only picked up
  // from a module the framework already loads for instrumentation.
}
