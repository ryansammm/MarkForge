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
  /** True when this call had to fabricate a missing id. */
  changed: boolean
}

/**
 * Resolves the document's `id` from the frontmatter, fabricating one when
 * the document has none.
 *
 * The value is returned to the caller; it is not written to the content.
 * `id` lives in the index, not in the markdown the user sees, so this is
 * the read path, not the write path. The store passes the value through
 * to `buildDocument`, which threads it into the `MarkdownDocument` that
 * ends up in `WorkspaceIndex`.
 */
export function ensureDocumentId(content: string, idFactory = generateDocumentId): EnsureIdResult {
  const split = splitFrontmatter(content)

  const existing = split.frontmatter.id
  if (typeof existing === 'string' && existing.trim()) {
    return { content, id: existing.trim(), changed: false }
  }

  return { content, id: idFactory(), changed: true }
}

export interface EnsureMetaResult {
  /** Content safe to write to disk. Internal fields are not spliced in. */
  content: string
  id: string
  /** ISO timestamp. The document's own, not the file's. */
  created: string
  /** True when this call had to fabricate a missing id or created value. */
  changed: boolean
}

/**
 * Resolves the document's `id` and `created` values without writing them to
 * the frontmatter.
 *
 * Both values are workspace bookkeeping, not user content, so they live in
 * the index and the store, not in the markdown the user reads and edits.
 * `id` is a stable identifier (used by `[[id:…]]` links, parent/child
 * relations, and trash entries) that survives renames. `created` is the
 * only field that can answer "when was this written" — file mtime is the
 * last *change*, and it does not survive a backend move or a trash restore.
 *
 * Anything the author already wrote by hand is kept as the source of truth;
 * this function only fabricates values for documents that have neither.
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

  return { content, id, created, changed: !hasId || !hasCreated }
}
