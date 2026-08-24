import type { MarkdownDocument } from './file-store'

/**
 * Resolves a wikilink target to a document.
 *
 * Order matters, and it is the sprint plan's mitigation 1 — resolve by id first,
 * title second:
 *
 *   1. `id`      — exact, and survives any rename
 *   2. `title`   — what people actually write
 *   3. `aliases` — including the old title recorded when a rename could not rewrite
 *                  every inbound link, which is what turns that failure from a
 *                  correctness bug into a cosmetic one
 *   4. filename  — a document is linkable by its filename as well as its title
 *   5. path      — full path, for links written against the file layout
 *
 * Only exact matches at each level. The previous behaviour included a substring
 * test on the path, which meant `[[Note]]` could silently resolve to
 * `Archive/2019/Notebook.md` — a link appearing to work while pointing somewhere
 * nobody intended is worse than one that visibly does not resolve.
 */
export function resolveWikiLink(
  target: string,
  documents: Record<string, MarkdownDocument>
): MarkdownDocument | null {
  const raw = target.trim()
  if (!raw) return null
  const needle = raw.toLowerCase()

  const all = Object.values(documents)

  const byId = all.find((doc) => doc.id === raw)
  if (byId) return byId

  const byTitle = all.find((doc) => doc.title.toLowerCase() === needle)
  if (byTitle) return byTitle

  const byAlias = all.find((doc) => doc.aliases?.some((alias) => alias.toLowerCase() === needle))
  if (byAlias) return byAlias

  const byFilename = all.find((doc) => {
    const file = doc.path.split('/').pop() ?? ''
    return file.replace(/\.md$/i, '').toLowerCase() === needle
  })
  if (byFilename) return byFilename

  const byPath =
    documents[raw] ??
    documents[`${raw}.md`] ??
    all.find((doc) => doc.path.toLowerCase() === needle || doc.path.toLowerCase() === `${needle}.md`)

  return byPath ?? null
}

/** Whether a wikilink target points at a document that exists. */
export function isResolvable(
  target: string,
  documents: Record<string, MarkdownDocument>
): boolean {
  return resolveWikiLink(target, documents) !== null
}

// --- ordinary Markdown links --------------------------------------------------

/**
 * What an `[text](href)` in a document actually points at.
 *
 * A vault is full of plain CommonMark links between its own documents — that is how
 * a note written in another editor, or checked out of git, refers to its neighbours.
 * The reading view used to hand every one of them to `target="_blank"`, which asked
 * the *browser* to open `Other Note.md` as a URL: a new tab, leaving the workspace,
 * landing on nothing. Deciding where a link goes has to happen before it is rendered,
 * and it has to happen in one place, because the editor and the reading view must
 * agree about which links are internal.
 */
export type LinkDestination =
  /** Somewhere else on the web. The browser is right to handle it. */
  | { kind: 'external'; href: string }
  /** A heading in the document already on screen. */
  | { kind: 'anchor'; hash: string }
  /** A document in this workspace. */
  | { kind: 'document'; path: string }
  /** A vault-relative link with nothing behind it — a ghost, exactly as `[[…]]` is. */
  | { kind: 'missing'; target: string }

/** A scheme (`https:`, `mailto:`, `data:`), a protocol-relative URL, or a rooted path. */
function isAbsoluteHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/')
}

/**
 * Resolves `href` against the folder holding `fromPath`, honouring `./` and `../`.
 *
 * Hand-walked rather than routed through `new URL(href, base)`: that would require
 * inventing an origin, and it percent-encodes the spaces that are in almost every
 * filename in this corpus.
 */
export function resolveRelativePath(fromPath: string, href: string): string {
  const segments = fromPath.split('/').slice(0, -1)

  for (const segment of href.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // A `..` that would climb past the workspace root is dropped, not honoured.
      // There is nothing above the root to reach, and pretending otherwise would
      // produce a path no lookup can match.
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  return segments.join('/')
}

/**
 * Where a Markdown link should take the reader.
 *
 * A relative href is looked up as a path first — `Folder/Note.md`, with or without the
 * extension — and then, failing that, as a wikilink target, so `[the notes](Dev Notes)`
 * finds the same document `[[Dev Notes]]` does.
 */
export function classifyHref(
  href: string,
  fromPath: string | null,
  documents: Record<string, MarkdownDocument>
): LinkDestination {
  const trimmed = href.trim()
  if (!trimmed) return { kind: 'external', href }
  if (trimmed.startsWith('#')) return { kind: 'anchor', hash: trimmed.slice(1) }
  if (isAbsoluteHref(trimmed)) return { kind: 'external', href: trimmed }

  // The fragment and query are not part of the path. A link into another document's
  // heading still opens that document; scrolling to the heading inside it is a
  // separate feature and this deliberately does not pretend to have it.
  const withoutFragment = trimmed.split('#')[0].split('?')[0]
  if (!withoutFragment) return { kind: 'external', href: trimmed }

  // `%20` is what an editor writes for a space, and every filename here has spaces.
  let decoded = withoutFragment
  try {
    decoded = decodeURIComponent(withoutFragment)
  } catch {
    // A malformed escape is not worth failing over; the raw text still matches for
    // the names that have no escapes in them at all.
  }

  const resolved = resolveRelativePath(fromPath ?? '', decoded)
  const byPath = documents[resolved] ?? documents[`${resolved}.md`]
  if (byPath) return { kind: 'document', path: byPath.path }

  // Not a path in this workspace. It may still be a name — links between notes are
  // routinely written as `[label](Note Name)` by hand.
  const name = decoded.replace(/\.md$/i, '')
  const byName = resolveWikiLink(name, documents) ?? resolveWikiLink(decoded, documents)
  if (byName) return { kind: 'document', path: byName.path }

  return { kind: 'missing', target: name.split('/').pop() || name }
}
