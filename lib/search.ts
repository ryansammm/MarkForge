/**
 * Search result shape, shared by the route and the dialog.
 *
 * Client-safe and split from `lib/server/search.ts` for the same reason `share.ts` is
 * split from `share-store.ts`: the server module imports a search engine and the
 * storage layer, and none of that belongs in a browser bundle.
 */
export interface SearchHit {
  path: string
  title: string
  /** Text around the match, so a result shows why it matched. */
  snippet: string
  score: number
}
