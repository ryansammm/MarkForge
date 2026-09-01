/**
 * Page-level Markdown export.
 *
 * Two surfaces:
 *
 *   - `buildExportName(document)` turns a workspace-relative path
 *     into a clean filename for the user's filesystem (`notes/ideas.md`
 *     → `ideas.md`).
 *   - `downloadMarkdown(filename, content)` triggers a browser
 *     download via a transient anchor + `URL.createObjectURL`.
 *
 * The Electron desktop build re-uses the same name + content but
 * writes through `window.markforge.saveFile(...)` (a native
 * `dialog.showSaveDialog`) instead, because `<a download>` in
 * Electron lands in a default Downloads folder without the same
 * "save where?" affordance a native dialog gives the user. The
 * `downloadMarkdown` helper still works in Electron as a
 * fallback; the page menu's `Export` action picks one.
 */

import type { MarkdownDocument } from '../file-store'

/**
 * Filename for the export. The workspace stores everything as
 * `*.md`, so a path like `notes/2026/ideas.md` becomes `ideas.md`.
 * The directory tree is the workspace's concern, not the user's
 * filesystem when they pick `Save As…`.
 */
export function buildExportName(document: MarkdownDocument): string {
  const lastSlash = document.path.lastIndexOf('/')
  const basename = lastSlash >= 0 ? document.path.slice(lastSlash + 1) : document.path
  if (basename.toLowerCase().endsWith('.md')) return basename
  return `${basename}.md`
}

/**
 * Frontmatter keys the workspace owns for its own bookkeeping, that a
 * user exporting a note should never see leaked into a plain `.md`
 * file on disk: stable `id`, `created`, and the layout toggles
 * `width` / `view` that have no meaning outside this app.
 *
 * ponytail: explicit allow-list, not a regex. Keys are case-folded on
 * the frontmatter block; YAML keys are case-sensitive by spec, but
 * `gray-matter` writes them lowercase by convention and the workspace
 * never emits anything else. Add new internal keys here when they
 * appear in `lib/markdown/frontmatter.ts`.
 */
const INTERNAL_FRONTMATTER_KEYS = new Set(['id', 'created', 'width', 'view'])

/**
 * Drop workspace-internal frontmatter fields from a raw markdown
 * document before it leaves the app. Leaves everything outside the
 * frontmatter block untouched (including wikilinks, code blocks that
 * happen to contain a `---` line, etc.).
 *
 * Files without a leading `---`-delimited frontmatter block return
 * the input unchanged.
 */
export function stripInternalFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const closing = raw.indexOf('\n---', 3)
  if (closing < 0) return raw
  const bodyStart = raw.indexOf('\n', closing + 4)
  if (bodyStart < 0) return raw
  const block = raw.slice(3, closing)
  const lines = block.split('\n').filter((line) => {
    const m = /^([A-Za-z_][\w-]*)\s*:/.exec(line)
    if (!m) return true
    return !INTERNAL_FRONTMATTER_KEYS.has(m[1].toLowerCase())
  })
  const stripped = ['---', ...lines, '---'].join('\n')
  return stripped + raw.slice(bodyStart)
}

/**
 * Triggers a browser download of `content` as `filename`.
 *
 * The anchor is appended to the DOM, clicked, then removed: a
 * detached `<a>` works in Firefox but not in Safari, where the
 * `download` attribute is ignored on a node that has never been
 * in the document. `URL.revokeObjectURL` runs on the next tick so
 * the browser has the URL in hand when the download starts.
 */
export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
