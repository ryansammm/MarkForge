/**
 * Syntax highlighting for the reading view.
 *
 * The same parsers the editor uses. `@codemirror/lang-*` is already a dependency —
 * the editor loads them through `codeLanguages` — so a fenced ` ```sql ` block is
 * highlighted by exactly the grammar that highlights it while you are typing, rather
 * than by a second highlighter with its own idea of what a keyword is. No new
 * dependency, and no drift between the two views of one document.
 *
 * Everything here is dynamically imported. A document with no fenced code fetches
 * none of it, and the public share page — which must never pull in the editor bundle
 * (docs/sprint-6-share-model.md) — pays for a grammar only when a shared document
 * actually contains code in that language.
 *
 * Classes come from `classHighlighter`, which emits stable `tok-*` names. The
 * alternative, CodeMirror's own `HighlightStyle`, generates class names and expects a
 * live editor to have mounted its stylesheet — there is no editor here. The `tok-*`
 * classes are styled in app/globals.css against the same `--cm-*` variables the
 * editor theme uses, which is what keeps the two looking alike.
 */

export interface CodeToken {
  text: string
  /** Space-separated `tok-*` classes, or '' for text the grammar gave no meaning. */
  className: string
}

export interface HighlightedCode {
  /** The grammar's display name — "SQL", "TypeScript" — for the block's header. */
  label: string
  tokens: CodeToken[]
}

/**
 * Above this, the block is shown as plain text.
 *
 * Parsing runs on the main thread. A pasted 200 KB log is not something anyone reads
 * for its syntax, and colouring it is not worth a frozen tab.
 */
export const MAX_HIGHLIGHT_BYTES = 100_000

/**
 * Highlights `code` as `language`, or returns null when it cannot.
 *
 * Null covers every "no highlighting" case on purpose — an unknown language, a block
 * too large, a grammar that failed to load — because the caller's answer to all of
 * them is the same: show the code as it was written. A code block that renders as
 * plain text is a small loss; one that fails to render is a lost document.
 */
export async function highlightCode(
  code: string,
  language: string
): Promise<HighlightedCode | null> {
  if (!language.trim() || code.length > MAX_HIGHLIGHT_BYTES) return null

  try {
    const [{ languages }, { LanguageDescription }, { classHighlighter, highlightTree }] =
      await Promise.all([
        import('@codemirror/language-data'),
        import('@codemirror/language'),
        import('@lezer/highlight'),
      ])

    // Non-fuzzy: `LanguageDescription` will otherwise match a language whose name
    // merely occurs inside the tag, which turns a typo into confidently wrong colours.
    const description = LanguageDescription.matchLanguageName(languages, language.trim(), false)
    if (!description) return null

    const support = await description.load()
    const tree = support.language.parser.parse(code)

    const tokens: CodeToken[] = []
    let at = 0

    highlightTree(tree, classHighlighter, (from, to, classes) => {
      // The callback only fires for ranges the grammar has something to say about.
      // Everything between them is ordinary text and has to be carried across, or the
      // rendered block would silently drop the characters in the gaps.
      if (from > at) tokens.push({ text: code.slice(at, from), className: '' })
      tokens.push({ text: code.slice(from, to), className: classes })
      at = to
    })

    if (at < code.length) tokens.push({ text: code.slice(at), className: '' })

    return { label: description.name, tokens }
  } catch {
    // A grammar that fails to load is a chunk that failed to arrive, not a reason to
    // lose the code.
    return null
  }
}

/**
 * The language name to show before anything has been parsed.
 *
 * The header appears immediately with the tag as written; `highlightCode` replaces it
 * with the grammar's proper name once the parser is there, so ` ```ts ` settles into
 * "TypeScript". Uppercasing short tags is what makes `sql` and `css` look deliberate
 * rather than unstyled.
 */
export function languageLabel(language: string): string {
  const tag = language.trim()
  if (!tag) return 'Code'
  return tag.length <= 4 ? tag.toUpperCase() : tag
}
