import type { MarkdownDocument, WriteResult } from './file-store'
import type { RenamePlan, RenameReport } from './server/rename'
import type { TrashEntry } from './trash'
import type { ShareScope, ShareSummary } from './share'
import { grimoireHeaders } from './grimoire-client'

/**
 * Typed client for the workspace routes.
 *
 * One place that knows how errors come back, so every caller reports the server's
 * own message rather than inventing one. A file operation that fails silently, or
 * fails with "something went wrong", is how a corpus drifts out of shape without
 * anyone noticing.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: { ...grimoireHeaders(), ...init?.headers },
    })
  } catch (err) {
    throw new ApiError(`Could not reach the server: ${(err as Error).message}`, 0, 'NETWORK')
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string }
    const message =
      response.status === 401
        ? 'Your session expired — sign in again.'
        : body.error ?? `Request failed (${response.status})`
    throw new ApiError(message, response.status, body.code)
  }

  return (await response.json()) as T
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

// --- documents ---------------------------------------------------------------

export function readDocument(path: string) {
  return request<{ document: MarkdownDocument; raw: string }>(
    `/api/files?path=${encodeURIComponent(path)}`
  )
}

export function writeDocument(path: string, content: string, ifMatch?: string) {
  return request<WriteResult>(`/api/files?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(ifMatch ? { 'If-Match': `"${ifMatch}"` } : {}),
    },
    body: JSON.stringify({ content }),
  })
}

/** Creates a document, failing rather than overwriting if the path is taken. */
export function createDocument(path: string, content: string) {
  return request<WriteResult>(`/api/files?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': '"*none*"' },
    body: JSON.stringify({ content }),
  })
}

export function deleteDocument(path: string) {
  return request<{ ok: true; path: string; trashId: string | null }>(
    `/api/files?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' }
  )
}

// --- assets ------------------------------------------------------------------

export interface AssetUpload {
  /** Vault-relative key. This is what goes in the document, verbatim. */
  path: string
  bytes: number
  contentType: string
}

/**
 * Uploads an image and returns where it landed.
 *
 * No `Content-Type` header: `fetch` sets it from the FormData, including the
 * multipart boundary, and a hand-written one omits the boundary and makes the body
 * unparseable on arrival.
 */
export function uploadAsset(file: File) {
  const form = new FormData()
  form.append('file', file)
  return request<AssetUpload>('/api/assets', { method: 'POST', body: form })
}

/**
 * Where to fetch a stored image from.
 *
 * The document holds a vault-relative path — `assets/2026/…png`, exactly what
 * Obsidian or a git checkout would resolve — so every renderer has to map it through
 * here to get something a browser can load. That mapping is the only place the app's
 * URL shape is allowed to leak into a view.
 */
export function assetUrl(path: string): string {
  return `/api/assets?path=${encodeURIComponent(path)}`
}

/**
 * The `src` of a Markdown image, as something a browser can load.
 *
 * A vault-relative path goes through the asset route. Anything already addressable —
 * `https://…`, a `data:` URI, a rooted path into `public/` — is left exactly as it is,
 * because rewriting it would break images that worked before this feature existed.
 *
 * Used by the editor and the reading view both. Two copies of this rule would drift,
 * and the symptom would be an image that renders in one view and not the other.
 */
export function resolveImageSrc(src: string): string {
  const trimmed = src.trim()
  if (!trimmed) return trimmed

  // A scheme (http:, https:, data:, mailto:), a protocol-relative URL, or a rooted path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//') || trimmed.startsWith('/')) {
    return trimmed
  }

  return assetUrl(trimmed.replace(/^\.\//, ''))
}

// --- rename ------------------------------------------------------------------

/** Computes the changeset without writing, so the UI can say what will happen. */
export function planRename(from: string, to: string) {
  return request<{ plan: RenamePlan }>('/api/rename?dryRun=1', json({ from, to }))
}

export function renameDocument(from: string, to: string) {
  return request<{ report: RenameReport; summary: string }>('/api/rename', json({ from, to }))
}

// --- folders -----------------------------------------------------------------

export function createFolder(path: string) {
  return request<{ path: string }>(`/api/folders?path=${encodeURIComponent(path)}`, { method: 'PUT' })
}

export function deleteFolder(path: string) {
  return request<{ path: string; removed: string[]; trashId: string | null }>(
    `/api/folders?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' }
  )
}

export function moveFolder(from: string, to: string) {
  return request<{ path: string; moved: string[] }>('/api/folders', json({ from, to }))
}

// --- trash -------------------------------------------------------------------

export function listTrash() {
  return request<{ entries: TrashEntry[] }>('/api/trash')
}

export function restoreFromTrash(id: string) {
  return request<{ entry: TrashEntry; restored: string[]; skipped: string[] }>(
    '/api/trash',
    json({ id })
  )
}

export function purgeTrash() {
  return request<{ purged: string[] }>('/api/trash', { method: 'DELETE' })
}

// --- shares ------------------------------------------------------------------

export function listShares() {
  return request<{ shares: ShareSummary[] }>('/api/shares')
}

export interface ShareOptions {
  /** Days until the link stops working. Omit for no expiry. */
  expiresInDays?: number
  /** Requires this password before the document is served. */
  password?: string
}

export function createShare(path: string, scope: ShareScope, options: ShareOptions = {}) {
  return request<{ share: ShareSummary }>('/api/shares', json({ path, scope, ...options }))
}

export function revokeShare(token: string) {
  return request<{ ok: true; token: string }>(
    `/api/shares?token=${encodeURIComponent(token)}`,
    { method: 'DELETE' }
  )
}

// --- session -----------------------------------------------------------------

/**
 * Ends the session on this device.
 *
 * Only this device: session tokens are stateless, so a token already copied
 * elsewhere stays valid until it expires. Rotating APP_PIN is what signs
 * everyone out — lib/session.ts explains why that is the honest control here.
 */
export function signOut() {
  return request<{ success: true }>('/api/auth', { method: 'DELETE' })
}

// --- helpers -----------------------------------------------------------------

/**
 * Strips the characters Windows refuses in a filename, plus path separators.
 *
 * Spaces and hyphens survive on purpose: `My Project Notes.md` is what people
 * actually name things, and wikilinks resolve by exactly that title.
 */
export function sanitizeName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Joins a parent directory and a name into a workspace path. */
export function joinPath(parentDir: string, name: string): string {
  const parent = parentDir.replace(/\/+$/, '')
  return parent ? `${parent}/${name}` : name
}

/**
 * The starting content for a brand-new file. Empty.
 *
 * The H1-derives-title path (`buildDocument.deriveTitle` → first H1) and the
 * editor's body-first philosophy would, given `# ${title}\n\n`, pre-fill the
 * editor with the title as a heading plus two blank lines, repeating the
 * filename in the breadcrumb and producing a stutter between the chrome and
 * the document. The reading view's `<h1>` and the breadcrumb already show the
 * title; the body should start where the user starts typing.
 */
export function newDocumentTemplate(_title: string): string {
  return ''
}
