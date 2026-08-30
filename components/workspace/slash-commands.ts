import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'

/**
 * Notion-style `/` menu for inserting Markdown structures.
 *
 * The trigger is deliberately conservative: the slash must start a line or follow
 * whitespace, so URLs and code that happen to contain slashes never summon the
 * menu. Items are plain snippets - no nested parsing - because every structure
 * here is one the live-preview already renders.
 */

export interface SlashItem {
  label: string
  detail: string
  /**
   * Replacement for the "/query" token. A lone `^` marks where the cursor lands;
   * without it the cursor sits at the end of the inserted text.
   */
  snippet: string
}

export const SLASH_ITEMS: SlashItem[] = [
  { label: 'Heading 1', detail: '#', snippet: '# ' },
  { label: 'Heading 2', detail: '##', snippet: '## ' },
  { label: 'Heading 3', detail: '###', snippet: '### ' },
  { label: 'Bullet list', detail: '-', snippet: '- ' },
  { label: 'Numbered list', detail: '1.', snippet: '1. ' },
  { label: 'To-do', detail: '- [ ]', snippet: '- [ ] ' },
  { label: 'Quote', detail: '>', snippet: '> ' },
  { label: 'Code block', detail: '```', snippet: '```\n^\n```\n' },
  { label: 'Divider', detail: '---', snippet: '---\n' },
  {
    label: 'Table',
    detail: '3x3',
    snippet: '| Column | Column | Column |\n| --- | --- | --- |\n|^| | |\n',
  },
]

/**
 * Commands that need extra context from the editor (a callback into
 * the workspace) are passed via `slashCommands({...})`. The Page
 * command creates a new sub-document and replaces the token with a
 * `[[link]]` to it; the rest are pure snippets.
 */
export interface SlashOptions {
  /**
   * Called with the user-provided name from `/page "Name"`. Returns the
   * `[[wikilink]]` text to insert. Returning `null` aborts the apply
   * (the token stays in the buffer for the user to fix).
   */
  onCreatePage?: (name: string) => Promise<string | null> | string | null
}

/**
 * Finds an active slash query in the text between the line start and the cursor.
 * Returns where the "/token" begins and what has been typed after it.
 */
export function slashContextBefore(textBeforeCursor: string): { from: number; query: string } | null {
  const match = /(?:^|\s)\/([\w-]*)$/.exec(textBeforeCursor)
  if (!match) return null
  const tokenStart = textBeforeCursor.length - match[1].length - 1
  return { from: tokenStart, query: match[1] }
}

/** Pure transaction pieces for applying a snippet - testable without a DOM. */
export function snippetEdit(
  docLength: number,
  tokenFrom: number,
  tokenTo: number,
  snippet: string
): { from: number; to: number; insert: string; anchor: number } {
  void docLength
  const caret = snippet.indexOf('^')
  const insert = caret >= 0 ? snippet.slice(0, caret) + snippet.slice(caret + 1) : snippet
  return {
    from: Math.max(0, tokenFrom),
    to: tokenTo,
    insert,
    anchor: Math.max(0, tokenFrom) + (caret >= 0 ? caret : insert.length),
  }
}

/** The autocomplete source; register alongside wikilink completions. */
export function slashCommands(options: SlashOptions = {}) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const before = context.state.sliceDoc(line.from, context.pos)
    const hit = slashContextBefore(before)
    if (!hit) return null

    const query = hit.query.toLowerCase()
    const optionsList: Completion[] = SLASH_ITEMS.filter((item) =>
      item.label.toLowerCase().includes(query)
    ).map((item) => ({
      label: item.label,
      detail: item.detail,
      type: 'keyword',
      apply: (view, _completion, _from, to) => {
        const edit = snippetEdit(
          view.state.doc.length,
          hit.from,
          to,
          item.snippet
        )
        view.dispatch({
          changes: { from: edit.from, to: edit.to, insert: edit.insert },
          selection: { anchor: edit.anchor },
          scrollIntoView: true,
        })
      },
    }))

    // /page — create a sub-document. Snippet is empty because the apply
    // callback replaces the whole token with the returned wikilink.
    if ('page'.includes(query) && options.onCreatePage) {
      optionsList.push({
        label: 'New page',
        detail: '/page "Name"',
        type: 'keyword',
        apply: (view, _completion, _from, to) => {
          // Look at the text the user has actually typed after `/page`
          // for an inline argument. We accept either a quoted form
          // (`/page "My Note"`) or a bare token (`/page My-Note`).
          const typed = view.state.sliceDoc(hit.from, to)
          const name = extractPageName(typed)
          if (!name) {
            // No name provided — leave the token alone and bail. The
            // user can finish typing it.
            return
          }
          const result = options.onCreatePage!(name)
          void Promise.resolve(result).then((replacement) => {
            if (!replacement) return
            const edit = snippetEdit(
              view.state.doc.length,
              hit.from,
              to,
              replacement
            )
            view.dispatch({
              changes: { from: edit.from, to: edit.to, insert: edit.insert },
              selection: { anchor: edit.anchor },
              scrollIntoView: true,
            })
          })
        },
      })
    }

    if (optionsList.length === 0) return null

    return {
      // `to` bounds the replace range; `filter: false` because the menu was
      // already narrowed above - without it CodeMirror fuzzy-filters against
      // the raw token ("/he", slash included) and every option dies.
      from: hit.from,
      to: context.pos,
      options: optionsList,
      filter: false,
    }
  }
}

/**
 * Pulls the page name out of a `/page...` token. Accepts:
 *   /page "My Note"   -> "My Note"
 *   /page 'My Note'   -> "My Note"
 *   /page My-Note     -> "My-Note"
 */
function extractPageName(typed: string): string | null {
  // Strip the leading `/page` keyword (the trigger character is the
  // last char of `hit.from` per `slashContextBefore`).
  const after = typed.replace(/^\/page\s*/, '')
  if (!after) return null
  const quoted = /^["'](.+?)["']\s*$/.exec(after)
  if (quoted) return quoted[1].trim()
  return after.trim() || null
}
