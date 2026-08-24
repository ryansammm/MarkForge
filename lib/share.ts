/**
 * Share model (PRD R8, Sprint 6 P0).
 *
 * The security property this file exists to establish: **a share is resolvable by
 * its token and by nothing else.** Not by title, not by path, not by document id.
 * Possession of the token is the authorization, which is what makes it safe to
 * exempt the public share route from the password gate.
 *
 * The previous implementation resolved a URL segment against every document in the
 * index by title, alias or filename, which meant the whole corpus was readable by
 * anyone who could guess a note's name. Nothing here should ever grow a lookup that
 * takes a human-readable name as input.
 */

/** A single document, or a folder and everything beneath it. */
export type ShareScope = 'document' | 'subtree'

export interface Share {
  /** URL-safe random token. The only key a share can be resolved by. */
  token: string
  /** Document path for `document` scope; folder path for `subtree`. */
  path: string
  scope: ShareScope
  createdAt: string
  /** ISO timestamp when revoked, or null while live. */
  revokedAt: string | null
  /** Title at creation time. For the manage list only — never used to resolve. */
  label: string
  /**
   * ISO timestamp after which the link stops working, or null for no expiry.
   *
   * Revocation is manual, so without this every link ever sent stays live until
   * somebody remembers it exists. An expiry is the version of that decision made
   * once, at the moment the sharer still remembers why they shared it.
   */
  expiresAt?: string | null
  /**
   * Password hash, or null when the link alone is enough.
   *
   * Never the password. See `lib/server/share-password.ts` for the format; nothing
   * client-side ever receives this field.
   */
  passwordHash?: string | null
}

/** A share as the management UI sees it — no hash, ever. */
export type ShareSummary = Omit<Share, 'passwordHash'> & { hasPassword: boolean }

export interface ShareFile {
  shares: Share[]
}

export function emptyShareFile(): ShareFile {
  return { shares: [] }
}

export function isExpired(share: Share, now: number = Date.now()): boolean {
  if (!share.expiresAt) return false
  const at = Date.parse(share.expiresAt)
  // An unparseable expiry counts as expired. The alternative is a link that was
  // meant to stop working and never does.
  return Number.isNaN(at) || at <= now
}

export function isLive(share: Share, now: number = Date.now()): boolean {
  return share.revokedAt === null && !isExpired(share, now)
}

/** Strips the hash and says only whether one exists. */
export function toSummary(share: Share): ShareSummary {
  const { passwordHash, ...rest } = share
  return { ...rest, hasPassword: Boolean(passwordHash) }
}

/**
 * Whether `documentPath` is readable through `share`.
 *
 * A subtree share covers the folder and everything under it. A document share
 * covers exactly one file. The `/` suffix matters: without it, a share of `Notes`
 * would also expose `Notes-Private/secret.md`.
 */
export function isPathInScope(share: Share, documentPath: string): boolean {
  const target = documentPath.replace(/^\/+/, '')
  const base = share.path.replace(/^\/+/, '').replace(/\/+$/, '')

  if (share.scope === 'document') return target === base
  return target === base || target.startsWith(`${base}/`)
}

/** Public URL for a share. */
export function shareUrl(origin: string, token: string, documentPath?: string): string {
  const base = `${origin}/share/${token}`
  return documentPath ? `${base}?path=${encodeURIComponent(documentPath)}` : base
}

/**
 * The `src` of an image inside a shared document, as a URL a reader can fetch.
 *
 * The token travels in the path, because it is the only credential the reader has —
 * there is no session on this surface. A vault-relative path is the only thing
 * rewritten; anything already addressable is passed through, so a shared note that
 * embeds a remote image keeps working exactly as it did.
 *
 * Deliberately not `resolveImageSrc` from workspace-api: that one points at the
 * authenticated route, which answers 401 to a public reader. The two look similar and
 * must not be interchanged — which is why this one lives here, next to the share
 * model, and takes the token as its first argument rather than reading it from
 * anywhere ambient.
 */
export function shareImageSrc(token: string, src: string): string {
  const trimmed = src.trim()
  if (!trimmed) return trimmed

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//') || trimmed.startsWith('/')) {
    return trimmed
  }

  const path = trimmed.replace(/^\.\//, '')
  return `/api/share/${encodeURIComponent(token)}/asset?path=${encodeURIComponent(path)}`
}

/** What the public route returns. Deliberately minimal — no index, no neighbours. */
export interface SharedDocumentResponse {
  token: string
  scope: ShareScope
  /** Path of the document being viewed. */
  path: string
  title: string
  /**
   * Document body with the YAML frontmatter stripped.
   *
   * Deliberately not the raw file. Frontmatter is where people keep private
   * metadata — review status, salary bands, client names — and a public reader has
   * no business receiving it. It also keeps js-yaml and zod off the public bundle.
   */
  body: string
  updatedAt?: string
  /**
   * Wikilink targets that resolve to a document inside this share's scope, mapped
   * to that document's path. Anything absent renders as plain text.
   *
   * Computed server-side on purpose: the client must never receive the index, or
   * the share would leak the existence of every document in the workspace.
   */
  inScopeLinks: Record<string, string>
}
