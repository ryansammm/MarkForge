// Named imports: the ESM build of js-yaml has no default export.
import { load, CORE_SCHEMA } from 'js-yaml'
import { z } from 'zod'

export interface SplitDocument {
  /** Raw YAML block, without the `---` fences. Null when there is no frontmatter. */
  raw: string | null
  frontmatter: Record<string, unknown>
  body: string
  /** True when a frontmatter block was present but did not parse. */
  invalid: boolean
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Reads the YAML frontmatter block off the front of a document.
 *
 * CORE_SCHEMA on purpose: it does not resolve YAML 1.1 timestamps or the
 * `yes`/`no`/`on`/`off` boolean aliases, so `2026-08-15` stays the string
 * `"2026-08-15"` and `NO` stays `"NO"`. Both are things people actually write in
 * note frontmatter and neither should be silently retyped.
 *
 * Invalid YAML soft-fails to an empty object — a malformed block makes the metadata
 * unavailable, it does not make the document unopenable.
 */
export function splitFrontmatter(content: string): SplitDocument {
  const match = content.match(FRONTMATTER_BLOCK)
  if (!match) {
    return { raw: null, frontmatter: {}, body: content, invalid: false }
  }

  const raw = match[1]
  const body = content.slice(match[0].length)

  try {
    const parsed = load(raw, { schema: CORE_SCHEMA })
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { raw, frontmatter: parsed as Record<string, unknown>, body, invalid: false }
    }
    // Scalar or list frontmatter is not something we have a meaning for.
    return { raw, frontmatter: {}, body, invalid: parsed !== null && parsed !== undefined }
  } catch {
    return { raw, frontmatter: {}, body, invalid: true }
  }
}

/** Frontmatter `title`, when it is a usable string. */
export function frontmatterTitle(frontmatter: Record<string, unknown>): string | null {
  const title = frontmatter.title
  if (typeof title === 'string' && title.trim()) return title.trim()
  return null
}

// --- the contract (PRD R7) ---------------------------------------------------

/**
 * The keys the app understands. Everything else passes through untouched —
 * a notes corpus accumulates fields from other tools, and eating them would make
 * this app the reason someone's Dataview queries stopped working.
 *
 * Every field is optional. A document with no frontmatter at all is valid, because
 * on disk that is by far the most common kind of document.
 */
export const FrontmatterSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().optional(),
    tags: z.union([z.string(), z.array(z.string())]).optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    aliases: z.union([z.string(), z.array(z.string())]).optional(),
    /**
     * Reader-mode text size. `small` is the Notion-style "Small text" toggle
     * that drops the body to a smaller prose width. `full` is a synonym for
     * the default rendered at the wider reading width. The viewer reads this
     * via `frontmatterView`; the page menu (`⋯`) writes it.
     */
    view: z.enum(['small', 'full']).optional(),
    /**
     * Reader-mode width. `full` is the page-wide reading width (a wider
     * container than the default), `default` is the existing centred column.
     * The page menu writes this; the viewer reads it via `frontmatterWidth`.
     */
    width: z.enum(['full', 'default']).optional(),
  })
  .passthrough()

export type Frontmatter = z.infer<typeof FrontmatterSchema>

export interface FrontmatterValidation {
  data: Frontmatter
  /** Human-readable problems. Never thrown — R7 says soft-fail. */
  issues: string[]
}

/**
 * Validates frontmatter without ever rejecting the document.
 *
 * A note whose `tags:` is a number is a note with a slightly odd tags field. It is
 * not a corrupt file, and refusing to open it would make the app less trustworthy
 * than the plain text it is standing on.
 */
export function validateFrontmatter(frontmatter: Record<string, unknown>): FrontmatterValidation {
  const result = FrontmatterSchema.safeParse(frontmatter)
  if (result.success) return { data: result.data, issues: [] }

  const issues = result.error.issues.map(
    (issue) => `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`
  )

  // Drop only the keys that failed; keep everything that parsed.
  const salvaged: Record<string, unknown> = { ...frontmatter }
  for (const issue of result.error.issues) {
    const key = issue.path[0]
    if (typeof key === 'string') delete salvaged[key]
  }

  return { data: salvaged as Frontmatter, issues }
}

/** Tags as a list, whichever of the two shapes the document used. */
export function frontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const tags = frontmatter.tags
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }
  if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === 'string')
  return []
}

/** `view: small | full` from the page menu. Defaults to `full`. */
export function frontmatterView(frontmatter: Record<string, unknown>): 'small' | 'full' {
  return frontmatter.view === 'small' ? 'small' : 'full'
}

/** `width: full | default` from the page menu. Defaults to `default`. */
export function frontmatterWidth(frontmatter: Record<string, unknown>): 'full' | 'default' {
  return frontmatter.width === 'full' ? 'full' : 'default'
}

// --- id assignment -----------------------------------------------------------

/** Stable, sortable, and short enough to not dominate a 3-line frontmatter block. */
export function generateDocumentId(): string {
  const time = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 10)
  return `${time}${random}`
}

export interface EnsureIdResult {
  content: string
  id: string
  /** False when the document already had an id and the content is untouched. */
  changed: boolean
}

/**
 * Guarantees the document carries an `id`, assigning one if it has none.
 *
 * The insertion is deliberately surgical — one line spliced into the existing YAML
 * block, or a new three-line block prepended. The alternative, parsing the YAML and
 * dumping it back, would reformat quoting, key order and comments across every
 * document the app ever saves. That is exactly the invasive reformatting PRD Q5
 * promises not to do.
 *
 * Line endings are matched to whatever the file already uses, so a CRLF document
 * does not come back as a mixed-ending one.
 */
export function ensureDocumentId(content: string, idFactory = generateDocumentId): EnsureIdResult {
  const split = splitFrontmatter(content)

  const existing = split.frontmatter.id
  if (typeof existing === 'string' && existing.trim()) {
    return { content, id: existing.trim(), changed: false }
  }

  const id = idFactory()
  const spliced = spliceFrontmatterLines(content, split, [`id: ${id}`])

  return { content: spliced.content, id, changed: spliced.changed }
}

/**
 * Splices `lines` into the document's frontmatter, creating the block if there is none.
 *
 * The surgical insert described above, factored out so that everything the app adds to
 * frontmatter is added the same way — one line at the top of the existing block, or a
 * new block prepended. Line endings follow whatever the file already uses.
 *
 * A block that failed to parse is left completely alone. Rewriting YAML we could not
 * read is how a syntax error becomes data loss.
 */
function spliceFrontmatterLines(
  content: string,
  split: SplitDocument,
  lines: string[]
): { content: string; changed: boolean } {
  if (split.invalid || lines.length === 0) return { content, changed: false }

  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const block = lines.map((line) => `${line}${eol}`).join('')

  if (split.raw === null) {
    const separator = content.startsWith(eol) || content === '' ? '' : eol
    return { content: `---${eol}${block}---${eol}${separator}${content}`, changed: true }
  }

  if (!FRONTMATTER_BLOCK.test(content)) return { content, changed: false }

  const blockStart = content.indexOf(split.raw)
  return {
    content: content.slice(0, blockStart) + block + content.slice(blockStart),
    changed: true,
  }
}

export interface EnsureMetaResult {
  content: string
  id: string
  /** ISO timestamp. The document's own, not the file's. */
  created: string
  /** False when the document already carried both and the content is untouched. */
  changed: boolean
}

/**
 * Guarantees the document carries an `id` and a `created` timestamp.
 *
 * `created` is here for a reason worth stating, because it looks like decoration and
 * is not. Nothing else in this system can answer "when was this written". A file's
 * mtime is when it was last *changed*, and it does not survive a move between
 * backends, a restore from the trash, or a `git clone`. So the moment a document is
 * first saved by this app is recorded in the document, where it travels with the
 * bytes — which is the same argument `id` is here on.
 *
 * It is stamped in the same write that assigns the id, so an in-app save costs no
 * extra round trip and a document authored elsewhere adopts both the first time it is
 * edited here. Anything already present is kept: a `created:` the author wrote by hand
 * is the truth, and this must never overwrite it.
 */
export function ensureDocumentMeta(
  content: string,
  options: { idFactory?: () => string; now?: () => Date } = {}
): EnsureMetaResult {
  const split = splitFrontmatter(content)
  const idFactory = options.idFactory ?? generateDocumentId
  const now = options.now ?? (() => new Date())

  const existingId = split.frontmatter.id
  const hasId = typeof existingId === 'string' && existingId.trim() !== ''
  const id = hasId ? (existingId as string).trim() : idFactory()

  const existingCreated = split.frontmatter.created
  const hasCreated = typeof existingCreated === 'string' && existingCreated.trim() !== ''
  const created = hasCreated ? (existingCreated as string).trim() : now().toISOString()

  const lines: string[] = []
  if (!hasId) lines.push(`id: ${id}`)
  if (!hasCreated) lines.push(`created: ${created}`)

  const spliced = spliceFrontmatterLines(content, split, lines)
  return { content: spliced.content, id, created, changed: spliced.changed }
}

// --- per-field setters used by the page menu --------------------------------

/**
 * Replaces a single top-level frontmatter key with a string value, or adds it.
 *
 * Surgical on purpose: the document is round-tripped by the editor on every
 * keystroke, and a YAML reformat would move every quote and every key the
 * user ever typed. So this just rewrites the matching line in place (or
 * appends one to the frontmatter block) and leaves the rest alone.
 *
 * The value is written as a plain scalar — no quoting, no flow-style. The
 * page menu only writes the closed enums `view: small | full` and
 * `width: full | default`; both are safe scalars.
 *
 * A document whose frontmatter is invalid is left alone: rewriting YAML we
 * could not read is how a syntax error becomes data loss.
 */
export function setFrontmatterField(
  content: string,
  key: string,
  value: string
): { content: string; changed: boolean } {
  const split = splitFrontmatter(content)
  if (split.invalid) return { content, changed: false }
  if (split.raw === null) {
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const head = content.startsWith(eol) || content === '' ? '' : eol
    return {
      content: `---${eol}${key}: ${value}${eol}---${eol}${head}${content}`,
      changed: true,
    }
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const blockStart = content.indexOf(split.raw)
  const blockEnd = blockStart + split.raw.length

  // Match a top-level `key: …` line. Anchored at line start; stops before an
  // indented continuation. YAML allows a key to be quoted or to use flow
  // syntax, but the page menu only writes plain scalars, so a single
  // `^key:[ \t].*$` line covers the cases we ever need to touch.
  const lineRe = new RegExp(`^${escapeRegExp(key)}:[ \\t].*$`, 'm')
  const blockText = content.slice(blockStart, blockEnd)
  const m = lineRe.exec(blockText)
  if (m) {
    const before = content.slice(0, blockStart + m.index)
    const after = content.slice(blockStart + m.index + m[0].length)
    return { content: `${before}${key}: ${value}${after}`, changed: true }
  }
  // Key not present: append the new line at the end of the block, before
  // the closing `---` we already split off.
  return {
    content: `${content.slice(0, blockEnd)}${eol}${key}: ${value}${content.slice(blockEnd)}`,
    changed: true,
  }
}

/**
 * Removes a single top-level frontmatter key, if present.
 *
 * Mirrors `setFrontmatterField`: a single regex line replacement. Returns
 * `changed: false` when the key was not set or the block was invalid.
 */
export function removeFrontmatterField(
  content: string,
  key: string
): { content: string; changed: boolean } {
  const split = splitFrontmatter(content)
  if (split.invalid || split.raw === null) return { content, changed: false }

  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const blockStart = content.indexOf(split.raw)
  const blockEnd = blockStart + split.raw.length
  const blockText = content.slice(blockStart, blockEnd)

  // Strip the whole line (key + value + the line ending after it).
  const lineRe = new RegExp(`^${escapeRegExp(key)}:[ \\t].*${eol === '\r\n' ? '\\r\\n' : '\\n'}?`, 'm')
  const m = lineRe.exec(blockText)
  if (!m) return { content, changed: false }
  const cut = blockStart + m.index
  return {
    content: `${content.slice(0, cut)}${content.slice(cut + m[0].length)}`,
    changed: true,
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
