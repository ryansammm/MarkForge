import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { MarkdownDocument } from '@/lib/file-store'

/**
 * `[[` autocomplete: pick the document to link to from the workspace itself.
 *
 * Backed by the in-memory index the app already loaded on boot — no request, no
 * second source of truth for what documents exist.
 *
 * The thing this file exists to get right is *what CodeMirror is asked to match
 * against*. A completion result names the range it replaces, and that range is also
 * the text the list is filtered by. Anchoring it at the `[[` meant the filter compared
 * `[[dev` against the label `Dev Notes` — a comparison that fails on the first typed
 * character, so the list appeared on `[[` and then emptied itself the moment anyone
 * started narrowing it. The range starts *after* the brackets here, and the ranking is
 * done in this file rather than by the default filter, so a document can be found by
 * its filename and its folder as well as by its title.
 *
 * The ranking is pure and lives apart from the CodeMirror plumbing so it can be tested
 * in Node — see tests/wikilink-complete.test.ts.
 */

export interface LinkCandidate {
  /** What a wikilink written from this completion will say. */
  title: string
  /** The filename without `.md`, which resolves too — see lib/resolve-link.ts. */
  filename: string
  /** Parent folder, or '' at the workspace root. */
  folder: string
  path: string
}

export function toCandidate(doc: MarkdownDocument): LinkCandidate {
  const file = doc.path.split('/').pop() ?? doc.path
  return {
    title: doc.title,
    filename: file.replace(/\.md$/i, ''),
    folder: doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : '',
    path: doc.path,
  }
}

/**
 * How well a candidate answers a query. Lower is better; null is no match.
 *
 * The tiers are ordered by how confident the match is that this is the document
 * somebody meant, not by where the characters happen to sit. A title that starts with
 * what was typed beats a filename that merely contains it, and a scattered
 * subsequence — the fuzzy match that makes `dn` find `Dev Notes` — comes last, because
 * it is the one that produces surprises.
 */
export function scoreCandidate(candidate: LinkCandidate, query: string): number | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return 0

  const title = candidate.title.toLowerCase()
  const filename = candidate.filename.toLowerCase()
  const path = candidate.path.toLowerCase()

  if (title === needle || filename === needle) return 0
  if (title.startsWith(needle)) return 1
  if (filename.startsWith(needle)) return 2
  if (title.includes(needle)) return 3
  if (filename.includes(needle) || path.includes(needle)) return 4
  if (isSubsequence(needle, title)) return 5

  return null
}

/** Whether every character of `needle` appears in `haystack`, in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0
  for (const char of haystack) {
    if (char === needle[at]) at++
    if (at === needle.length) return true
  }
  return at === needle.length
}

/**
 * How many documents the list offers at once.
 *
 * A cap rather than the whole workspace: the popup is a few visible rows over a
 * scrollbar, and scoring is redone on every keystroke. Ranked first, so the cap only
 * ever removes candidates nobody was going to scroll to.
 */
export const MAX_SUGGESTIONS = 50

export function rankCandidates(
  candidates: readonly LinkCandidate[],
  query: string,
  limit = MAX_SUGGESTIONS
): LinkCandidate[] {
  const scored: Array<{ candidate: LinkCandidate; score: number }> = []

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query)
    if (score !== null) scored.push({ candidate, score })
  }

  scored.sort(
    (a, b) => a.score - b.score || a.candidate.title.localeCompare(b.candidate.title)
  )

  return scored.slice(0, limit).map((entry) => entry.candidate)
}

/**
 * Writes the chosen document into the buffer as `[[Title]]`.
 *
 * `from` is already past the opening brackets, so only the target and the closing pair
 * are inserted — and the closing pair only when `closeBrackets` has not already put one
 * there, which is what used to produce `[[Title]]]]`.
 */
function applyCandidate(title: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const after = view.state.sliceDoc(to, Math.min(to + 2, view.state.doc.length))
    const alreadyClosed = after === ']]'
    const insert = alreadyClosed ? title : `${title}]]`

    view.dispatch({
      changes: { from, to, insert },
      // Past the closing brackets either way, so typing continues after the link
      // rather than inside it.
      selection: { anchor: from + insert.length + (alreadyClosed ? 2 : 0) },
    })
  }
}

/** Everything typed since the nearest `[[`, as long as it has not been closed. */
const OPEN_WIKILINK = /\[\[[^\]\n]*/

export function wikilinkCompletions(getDocs: () => Record<string, MarkdownDocument>) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(OPEN_WIKILINK)
    if (!match) return null

    const query = match.text.slice(2)
    const ranked = rankCandidates(Object.values(getDocs()).map(toCandidate), query)
    if (ranked.length === 0) return null

    const options: Completion[] = ranked.map((candidate, index) => ({
      label: candidate.title,
      // The folder, and the filename when it is not simply the title — between them
      // they answer "which of these two identically named notes is this?".
      detail:
        [candidate.folder, candidate.filename === candidate.title ? '' : `${candidate.filename}.md`]
          .filter(Boolean)
          .join(' · ') || undefined,
      type: 'text',
      // The order above is the ranking, and boost is what makes CodeMirror keep it
      // rather than imposing an order of its own.
      boost: Math.max(-99, -index),
      apply: applyCandidate(candidate.title),
    }))

    return {
      // After the `[[`. See the note at the top of this file — this one line is the
      // difference between a list that narrows as you type and one that empties.
      from: match.from + 2,
      to: match.to,
      options,
      // Ranked here, so the default fuzzy filter must not re-order or re-cut it.
      // Without `validFor` the source simply re-runs per keystroke, which is a scan
      // of an in-memory array.
      filter: false,
    }
  }
}
