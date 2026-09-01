/**
 * Page-level Markdown import.
 *
 * The workspace accepts a small set of file extensions (`.md`,
 * `.markdown`, `.txt`) and reads each as UTF-8 text. The body is
 * the file's text after a leading YAML frontmatter block has been
 * removed; the title is taken from the first usable signal in
 * `title: …`, the first H1, or the filename.
 *
 * The function is browser-only: it reads `File` objects, which the
 * DOM hands back from `<input type="file">`. Tests feed it a
 * minimal `File`-shaped object (`{ name, text(): Promise<string> }`)
 * and skip the size/MIME check, so the same code is the real
 * import path and the test target.
 */

import { splitFrontmatter } from '../markdown/frontmatter'

const ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt'] as const

export interface ParsedMarkdownFile {
  /** Title the import should use when creating the new document. */
  title: string
  /** Body — frontmatter stripped. Stored as the new document's content. */
  body: string
  /** The filename the user picked, minus the extension. Used to disambiguate a title. */
  suggestedName: string
}

interface FileLike {
  name: string
  text(): Promise<string>
}

/** True when the file's name carries a Markdown extension we accept. */
export function isImportableFile(file: FileLike): boolean {
  const lower = file.name.toLowerCase()
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Extracts a leading H1 from the body. Skips ATX-style headers only. */
function firstHeading(body: string): string | null {
  const match = /^#\s+(.+?)\s*$/m.exec(body)
  return match ? match[1].trim() : null
}

/** Strips a trailing extension (case-insensitive) from a filename. */
function stripExtension(name: string): string {
  const lower = name.toLowerCase()
  for (const ext of ALLOWED_EXTENSIONS) {
    if (lower.endsWith(ext)) return name.slice(0, -ext.length)
  }
  return name
}

/**
 * Reads a file and pulls out the bits the workspace needs to
 * create a new document.
 *
 * Pick order for the title:
 *
 *   1. `title:` in the frontmatter (the document already has a name).
 *   2. The first H1 in the body (a hand-written heading).
 *   3. The filename minus the extension (last-resort default).
 *
 * The body is the file's text with the frontmatter block removed,
 * so the workspace's `createDocumentAt` writes the same content
 * the user uploaded, byte for byte, with no app-injected
 * frontmatter of its own. The workspace's `id` and `created`
 * bookkeeping now lives in the index, not in the document.
 */
export async function readMarkdownFile(file: FileLike): Promise<ParsedMarkdownFile> {
  const text = await file.text()
  const split = splitFrontmatter(text)
  const fromFm = typeof split.frontmatter.title === 'string' ? split.frontmatter.title.trim() : ''
  const fromBody = firstHeading(split.body)
  const suggestedName = stripExtension(file.name)
  const title = fromFm || fromBody || suggestedName
  return { title, body: split.body, suggestedName }
}

export { ALLOWED_EXTENSIONS }
