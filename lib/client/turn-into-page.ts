import type { MarkdownDocument } from '../file-store'
import { normalizePath } from '../file-store'

/**
 * Pure planning for the "Turn into page" block action.
 *
 * Given a parent path, a parent body, a selected range, and the index it lives
 * in, compute:
 *
 *   - the new document's path and body (heading + the selection as prose)
 *   - the parent's rewritten body (selection replaced with a wikilink)
 *
 * The caller is responsible for actually writing the bytes — the action lives
 * next to the server round-trip in the block menu, not behind a black box.
 *
 * The new document is placed in the same folder as the parent, with a slug
 * derived from the selection's first line. If that path is already taken, the
 * caller must decide what to do (the spec chooses "disambiguate" — append a
 * counter, the same way the in-app "New document" button does).
 */

export interface TurnSelectionInput {
  parentPath: string
  parentBody: string
  /** `[from, to)` offsets into the parent body, CodeMirror-style. */
  selection: { from: number; to: number }
  /**
   * The full index, so a colliding name can be detected and disambiguated.
   * Optional — when missing, no disambiguation is attempted.
   */
  allDocs?: Record<string, MarkdownDocument>
}

export interface TurnSelectionPlan {
  /** Path of the new page, e.g. `Notes/Sub Note.md`. */
  newDocPath: string
  /** Body the new page should be written with, including frontmatter. */
  newDocBody: string
  /** The parent body with the selection replaced by a wikilink. */
  newParentBody: string
  /**
   * The wikilink inserted into the parent body. Exposed so the caller can
   * place the caret on it after the rewrite.
   */
  wikilink: string
  /** Slug used for both the file basename and the wikilink text. */
  slug: string
}

const SLUG_FALLBACK = 'Untitled-page'

/** Slugify a title for use as a filename. Lowercase, dashes, no extension. */
export function slugifyTitle(title: string): string {
  const cleaned = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || SLUG_FALLBACK
}

/**
 * First non-empty line of the selection, with surrounding whitespace and any
 * leading `#` marks stripped. Empty selection → "Untitled page".
 */
function titleFromSelection(parentBody: string, selection: { from: number; to: number }): string {
  const slice = parentBody.slice(selection.from, selection.to)
  for (const raw of slice.split('\n')) {
    const line = raw.replace(/^\s{0,6}#{1,6}\s+/, '').trim()
    if (line) return line
  }
  return SLUG_FALLBACK
}

/** Disambiguate a path by appending `-2`, `-3`, … until it is unused. */
function unusedPath(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  const ext = base.endsWith('.md') ? '.md' : ''
  const stem = ext ? base.slice(0, -ext.length) : base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!taken.has(candidate)) return candidate
  }
  // 1000 collisions is the universe collapsing; let the server error out.
  return base
}

export function planTurnSelectionIntoPage(input: TurnSelectionInput): TurnSelectionPlan {
  const parentPath = normalizePath(input.parentPath)
  const title = titleFromSelection(input.parentBody, input.selection)
  const slug = slugifyTitle(title)

  const lastSlash = parentPath.lastIndexOf('/')
  const parentDir = lastSlash === -1 ? '' : parentPath.slice(0, lastSlash)
  const base = parentDir ? `${parentDir}/${slug}.md` : `${slug}.md`

  const taken = new Set(
    input.allDocs ? Object.keys(input.allDocs).map(normalizePath) : []
  )
  const newDocPath = unusedPath(base, taken)

  // If we disambiguated, the wikilink uses the original slug so the parent
  // body reads naturally; the disambiguated basename only matters on disk.
  const wikilinkSlug = newDocPath.endsWith(`${slug}.md`)
    ? slug
    : newDocPath.replace(/\.md$/i, '').split('/').pop() ?? slug
  const wikilink = `[[${wikilinkSlug}]]`

  const newDocBody = `## ${title}\n\n${input.parentBody.slice(input.selection.from, input.selection.to).trim()}\n`

  const newParentBody =
    input.parentBody.slice(0, input.selection.from) +
    wikilink +
    input.parentBody.slice(input.selection.to)

  return { newDocPath, newDocBody, newParentBody, wikilink, slug }
}
