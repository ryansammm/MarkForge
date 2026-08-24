import { randomBytes } from 'crypto'
import {
  emptyShareFile,
  isLive,
  isPathInScope,
  toSummary,
  type Share,
  type ShareFile,
  type ShareScope,
  type ShareSummary,
  type SharedDocumentResponse,
} from '../share'
import { hashSharePassword, verifySharePassword } from './share-password'
import { normalizePath, InvalidPathError } from '../file-store'
import { isAssetKey } from './assets'
import { findWikiLinks } from '../markdown/links'
import { resolveWikiLink } from '../resolve-link'
import { getStore } from './store'
import type { WorkspaceStore } from './workspace-store'

/**
 * Persistence for shares.
 *
 * A `shares.json` beside the index is sufficient at this scale, per the sprint plan.
 * It lives next to index.json rather than inside it because the index is explicitly
 * disposable — Sprint 5 wipes and rebuilds it from the bucket, and share tokens must
 * survive that. A rebuilt index must never invalidate a link someone already sent.
 */

export interface ShareLookup {
  share: Share
  response: SharedDocumentResponse
}

/**
 * The outcome of resolving a token.
 *
 * `locked` is a deliberate, narrow exception to the "every failure is an identical
 * 404" rule, and it is worth being explicit about why it is safe: it is only ever
 * returned to someone who **already presented a valid, live token**. They know the
 * share exists — they have the link. Telling them it needs a password reveals nothing
 * they did not already hold, and the alternative is a password-protected link that
 * looks broken.
 *
 * Everything else still collapses to `null`.
 */
export type ShareResolution =
  | { kind: 'ok'; lookup: ShareLookup }
  | { kind: 'locked'; label: string }

export interface CreateShareOptions {
  /** Days until the link stops working. Omit for a link with no expiry. */
  expiresInDays?: number
  /** Requires this password before the document is served. */
  password?: string
}

export const SHARES_FILE = 'shares.json'

export class ShareStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly files: WorkspaceStore = getStore()) {}

  /**
   * Shares go through the same bucket as everything else, so they follow the
   * storage backend. Writing them to the local filesystem would mean tokens
   * created on one serverless instance were invisible to the next — every link
   * would work intermittently, which is worse than not working.
   */
  private async read(): Promise<ShareFile> {
    const raw = await this.files.bucket.readMeta(SHARES_FILE)
    if (!raw) return emptyShareFile()
    try {
      const parsed = JSON.parse(raw) as Partial<ShareFile>
      return { shares: Array.isArray(parsed.shares) ? parsed.shares : [] }
    } catch {
      // A corrupt shares file must not take the app down, but it must also not
      // silently grant access, so it reads as "no shares exist".
      return emptyShareFile()
    }
  }

  private async write(file: ShareFile): Promise<void> {
    await this.files.bucket.writeMeta(SHARES_FILE, JSON.stringify(file, null, 2))
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => undefined)
    return result
  }

  // --- management (authenticated callers only) ------------------------------

  /**
   * Every share, newest first, **without password hashes**.
   *
   * The management UI needs to know a share is protected, never what protects it.
   * Returning the raw records would put a scrypt hash into a browser and into any
   * log that captured the response.
   */
  async list(): Promise<ShareSummary[]> {
    const { shares } = await this.read()
    return [...shares].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toSummary)
  }

  /**
   * Creates a share.
   *
   * 128 bits from `randomBytes`, base64url — not `Math.random`, and not derived from
   * the path. The token is the only thing standing between a public URL and the
   * document, so it has to be unguessable in the cryptographic sense.
   */
  async create(
    targetPath: string,
    scope: ShareScope,
    options: CreateShareOptions = {}
  ): Promise<ShareSummary> {
    const normalized = normalizePath(targetPath.trim()).replace(/\/+$/, '')
    if (!normalized) throw new InvalidPathError(targetPath, 'empty')
    if (normalized.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      throw new InvalidPathError(targetPath, 'contains a relative segment')
    }

    let label: string
    if (scope === 'document') {
      const doc = await this.files.getFile(normalized)
      if (!doc) throw new InvalidPathError(targetPath, 'no such document')
      label = doc.title
    } else {
      const index = await this.files.getIndex()
      const hasContents = Object.keys(index.documents).some(
        (p) => p === normalized || p.startsWith(`${normalized}/`)
      )
      if (!hasContents) throw new InvalidPathError(targetPath, 'no such folder, or it is empty')
      label = normalized.split('/').pop() ?? normalized
    }

    const expiresInDays = options.expiresInDays
    if (expiresInDays !== undefined && (!Number.isFinite(expiresInDays) || expiresInDays <= 0)) {
      throw new InvalidPathError(targetPath, 'expiry must be a positive number of days')
    }

    const share: Share = {
      token: randomBytes(16).toString('base64url'),
      path: normalized,
      scope,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      label,
      expiresAt: expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : null,
      passwordHash: options.password ? await hashSharePassword(options.password) : null,
    }

    return this.run(async () => {
      const file = await this.read()
      file.shares.push(share)
      await this.write(file)
      return toSummary(share)
    })
  }

  /**
   * Checks a password against a share.
   *
   * Returns false for an unknown, revoked, expired or unprotected share, so a caller
   * cannot use this to probe which tokens exist or which are protected.
   */
  async checkPassword(token: string, password: string): Promise<boolean> {
    if (!token || !password) return false

    const { shares } = await this.read()
    const share = shares.find((s) => s.token === token)
    if (!share || !isLive(share) || !share.passwordHash) return false

    return verifySharePassword(password, share.passwordHash)
  }

  /** Revokes a share. Idempotent — revoking an already-revoked share is fine. */
  async revoke(token: string): Promise<boolean> {
    return this.run(async () => {
      const file = await this.read()
      const share = file.shares.find((s) => s.token === token)
      if (!share) return false
      if (share.revokedAt === null) {
        share.revokedAt = new Date().toISOString()
        await this.write(file)
      }
      return true
    })
  }

  // --- public resolution ----------------------------------------------------

  /**
   * Resolves a token to a readable document, or null.
   *
   * **Null covers every failure**: unknown token, revoked token, requested path
   * outside the share's scope, missing file. Callers must turn all of them into an
   * identical 404. PRD R8: a 403 confirms the resource exists, which tells an
   * attacker their guess was structurally right, and tells anyone holding a revoked
   * link that the document is still there.
   */
  async resolve(
    token: string,
    requestedPath?: string,
    options: { unlocked?: boolean } = {}
  ): Promise<ShareResolution | null> {
    if (!token) return null

    const { shares } = await this.read()
    const share = shares.find((s) => s.token === token)
    // isLive now covers expiry as well as revocation, so an expired link is
    // indistinguishable from one that never existed.
    if (!share || !isLive(share)) return null

    // Checked before anything is read from storage: a locked share must not even
    // reveal, through timing or through an error, whether its document still exists.
    if (share.passwordHash && !options.unlocked) {
      return { kind: 'locked', label: share.label }
    }

    const targetPath = requestedPath
      ? normalizePath(requestedPath)
      : share.scope === 'subtree'
        ? await this.landingDocument(share)
        : share.path

    if (!targetPath) return null
    if (share.scope === 'document' && requestedPath && targetPath !== share.path) return null
    if (!isPathInScope(share, targetPath)) return null

    const result = await this.files.readDocument(targetPath).catch(() => null)
    if (!result) return null

    // `document.content` is the body with frontmatter already stripped. Links are
    // scanned from the same text, so a wikilink sitting in frontmatter cannot make
    // a private document's name appear in the public response.
    //
    // Always present here: `readDocument` builds the document from the file it just
    // read. It is only absent on index entries, which no longer carry bodies.
    const body = result.document.content ?? ''

    return {
      kind: 'ok',
      lookup: {
        share,
        response: {
          token: share.token,
          scope: share.scope,
          path: result.document.path,
          title: result.document.title,
          body,
          updatedAt: result.document.updatedAt,
          inScopeLinks: await this.inScopeLinks(share, body),
        },
      },
    }
  }

  /**
   * Resolves a token and an image path to bytes, or null.
   *
   * **Null covers every failure**, exactly as `resolve` does, and for the same reason:
   * unknown token, revoked, expired, still locked, a path that is not an image, an
   * image no in-scope document mentions, an image that is not there. An asset route
   * that answered 403 for "out of scope" and 404 for "missing" would tell a holder of
   * one link which images exist elsewhere in the vault — a private document's pictures
   * are private, and the shape of the answer must not say otherwise.
   *
   * Scope is "some document inside this share references it". Serving any asset to any
   * live token would make a share a read capability over the whole asset namespace,
   * gated only by guessing a hash — and unguessability is not the security model this
   * project uses anywhere else.
   *
   * Cost, stated rather than hidden: one document read for a `document` share, and up
   * to one per in-scope document for a `subtree` share, stopping at the first match.
   * The index cannot answer this — it stopped carrying bodies in phase 4. If large
   * subtree shares ever make that hurt, the fix is an asset-reference manifest built
   * alongside the index, not a weaker check.
   */
  async resolveAsset(
    token: string,
    assetPath: string,
    options: { unlocked?: boolean } = {}
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!token || !assetPath) return null

    const { shares } = await this.read()
    const share = shares.find((s) => s.token === token)
    if (!share || !isLive(share)) return null

    // A locked share serves nothing until it is unlocked. Unlike the document route
    // there is no 401 counterpart here: an image is never the thing that tells a
    // reader a password is needed — the page they came from already did.
    if (share.passwordHash && !options.unlocked) return null

    const wanted = normalizePath(assetPath)

    // Cheap rejection before any document is read: if it is not an image key, no
    // document can legitimately reference it, and `readAsset` would throw anyway.
    if (!isAssetKey(wanted)) return null

    const index = await this.files.getIndex()
    const inScope = Object.keys(index.documents)
      .filter((docPath) => isPathInScope(share, docPath))
      .sort((a, b) => a.localeCompare(b))

    let referenced = false
    for (const docPath of inScope) {
      const result = await this.files.readDocument(docPath).catch(() => null)
      if (result?.raw.includes(wanted)) {
        referenced = true
        break
      }
    }
    if (!referenced) return null

    return this.files.readAsset(wanted).catch(() => null)
  }

  /**
   * Which document a subtree share opens on.
   *
   * A folder is not a document, so a subtree share needs a landing page. Prefers the
   * conventional index names at the folder root, then falls back to the first
   * document in path order so the link always leads somewhere rather than 404ing on
   * a folder that plainly exists.
   */
  private async landingDocument(share: Share): Promise<string | null> {
    const index = await this.files.getIndex()
    const contents = Object.keys(index.documents)
      .filter((p) => isPathInScope(share, p))
      .sort((a, b) => a.localeCompare(b))

    if (contents.length === 0) return null

    const base = share.path.replace(/\/+$/, '')
    for (const name of ['index.md', 'readme.md', 'home.md']) {
      const match = contents.find((p) => p.toLowerCase() === `${base.toLowerCase()}/${name}`)
      if (match) return match
    }

    return contents[0]
  }

  /**
   * Wikilink targets that resolve to a document inside the share's scope.
   *
   * Resolution runs against the in-scope documents only. Resolving against the whole
   * index and filtering afterwards would let a link inside a shared note reveal that
   * a private document exists — the absence of a link is information too.
   */
  private async inScopeLinks(share: Share, raw: string): Promise<Record<string, string>> {
    const targets = Array.from(new Set(findWikiLinks(raw).map((o) => o.target)))
    if (targets.length === 0) return {}

    const index = await this.files.getIndex()
    const inScope = Object.fromEntries(
      Object.entries(index.documents).filter(([docPath]) => isPathInScope(share, docPath))
    )

    const map: Record<string, string> = {}
    for (const target of targets) {
      const doc = resolveWikiLink(target, inScope)
      if (doc) map[target] = doc.path
    }
    return map
  }
}

let shared: ShareStore | null = null

export function getShareStore(): ShareStore {
  if (!shared) shared = new ShareStore()
  return shared
}

/** Test seam — lets a suite point the store at a temp workspace. */
export function resetShareStore(store: ShareStore | null = null): void {
  shared = store
}
