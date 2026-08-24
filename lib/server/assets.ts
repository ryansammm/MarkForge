/**
 * The asset namespace.
 *
 * Images live *inside* the vault, under `assets/`, next to the documents that
 * reference them. A note that says `![](assets/2026/a1b2c3d4-diagram.png)` therefore
 * opens correctly in Obsidian, in a git checkout, and in anything else that can read
 * a directory. The alternative — a private blob store keyed by an opaque id — would
 * have made the images the one part of a vault this app owns exclusively, which is
 * the thing this project exists not to do.
 *
 * Two consequences follow, and neither is left to convention:
 *
 * 1. **`assets/` is reserved.** WorkspaceStore refuses to write a document or create
 *    a folder inside it. Without that, deleting a folder called `assets` in the file
 *    tree would take every image in the vault with it, and the trash only knows how
 *    to stash and restore Markdown — the images would be gone with no undo.
 *
 * 2. **Assets are not the corpus.** Both real backends already filter `listKeys` to
 *    `.md`, so images are invisible to the index, to search and to share-scope
 *    resolution for free. What is *not* free is the folder listing: `listFolders`
 *    reports every directory it finds, so `assets/` would otherwise appear in the
 *    file tree as a permanently empty folder and be re-created by every reindex.
 *    The store filters it out at that one point, so all three backends agree.
 *
 * tests/assets.test.ts asserts both, per backend, rather than trusting them.
 */

import { createHash } from 'crypto'

/** Vault-root-relative prefix holding every uploaded image. */
export const ASSET_PREFIX = 'assets'

/**
 * What may be stored, and what it is served as.
 *
 * SVG is deliberately absent. An SVG is a script host, and the share route serves
 * assets same-origin to unauthenticated readers — accepting one would be a stored
 * XSS on a public page, which is a much larger hole than "the editor cannot embed
 * vector art". See docs/sprint-7-plan.md, decision D3.
 */
export const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * Served when the extension says nothing.
 *
 * Not a guess at the real type: a browser will download an `application/octet-stream`
 * rather than run it, which is the right outcome for a byte sequence this app did not
 * expect to be holding.
 */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/**
 * Whether a key is inside the asset namespace.
 *
 * Case-insensitive, because the reservation has to hold on a case-insensitive
 * filesystem too: on Windows a document written to `Assets/note.md` would land in the
 * same directory as the images while looking like a different key everywhere else.
 */
export function isAssetKey(key: string): boolean {
  const clean = key.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
  return clean === ASSET_PREFIX || clean.startsWith(`${ASSET_PREFIX}/`)
}

/** Lowercased extension including the dot, or '' when there is none. */
export function extensionOf(key: string): string {
  const name = key.slice(key.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** The content type a stored key should be served as, derived from its extension. */
export function contentTypeForKey(key: string): string {
  return IMAGE_CONTENT_TYPES[extensionOf(key)] ?? DEFAULT_CONTENT_TYPE
}

/**
 * The image type a byte sequence actually is, or null if it is not one we accept.
 *
 * Sniffed from the leading bytes, never taken from the request. A `Content-Type` on
 * an upload is a claim made by whoever is uploading, and the browser derives its own
 * from the file extension — so "it says image/png" means only that something,
 * somewhere, saw `.png` at the end of a filename. The bytes are the only thing that
 * cannot be renamed into a lie.
 *
 * This is also what keeps SVG out. An SVG declared as `image/png` sails past an
 * allowlist that trusts the header, and the share route serves assets same-origin to
 * unauthenticated readers — which would make it a stored XSS on a public page.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  // FF D8 FF opens every JPEG variant; the fourth byte says which, and we do not care.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  // "GIF8" — covers both GIF87a and GIF89a.
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  // RIFF....WEBP: a four-byte size sits between the two markers.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp'
  }
  return null
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((byte, i) => bytes[i] === byte)
}

/**
 * The key an uploaded image is stored under:
 * `assets/<year>/<first 8 of sha256>-<slugged original name>.<ext>`
 *
 * Content-addressed, so the same file dropped twice is written to the same key and
 * costs one object — and so the serve route can mark the bytes immutable and cache
 * them forever, because a key can never come to mean different bytes.
 *
 * The original name is kept in the key rather than only in the alt text. It costs the
 * strict form of deduplication — the same bytes under two different names are two
 * objects — and buys a vault whose `assets/` directory is legible to a person browsing
 * it in Finder, in git, or in Obsidian. For a product whose whole claim is that the
 * files stay yours, a folder of `a1b2c3d4.png` would be the wrong trade.
 *
 * The year segment keeps any single directory from growing without bound; nothing
 * reads it back, and it is deliberately not a claim about when the image was taken.
 */
export function assetKeyFor(input: {
  bytes: Uint8Array
  contentType: string
  filename?: string
  now?: Date
}): string {
  const extension = extensionForContentType(input.contentType)
  if (!extension) {
    throw new Error(`Refusing to store an asset of type ${JSON.stringify(input.contentType)}`)
  }

  const digest = createHash('sha256').update(input.bytes).digest('hex').slice(0, 8)
  const year = (input.now ?? new Date()).getUTCFullYear()

  return `${ASSET_PREFIX}/${year}/${digest}-${slugifyFilename(input.filename)}${extension}`
}

/**
 * The readable half of an asset key.
 *
 * Reduced to lowercase ASCII words. A key ends up in Markdown that people read and
 * hand-edit, in URLs, and in a filesystem — the intersection of what all three handle
 * without escaping is small, and this is it. Something with no ASCII in its name at
 * all still gets a key; it is the hash that makes it unique, not the slug.
 */
export function slugifyFilename(filename?: string): string {
  // Some browsers hand over a path rather than a bare name; the extension is dropped
  // because the sniffed type decides it.
  const name = filename ?? ''
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)

  const slug = base
    // `(?!^)` so a dotfile is not stripped to nothing before it is even slugged.
    .replace(/(?!^)\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')

  return slug || 'image'
}

/** The canonical extension for an accepted image type, or null if not accepted. */
export function extensionForContentType(contentType: string): string | null {
  const normalized = contentType.split(';')[0]!.trim().toLowerCase()
  switch (normalized) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    default:
      return null
  }
}
