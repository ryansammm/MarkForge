/**
 * Task 10 self-check: page-level import / export.
 *
 * Two surfaces:
 *
 *   1. `readMarkdownFile` extracts a title and body from a
 *      `File`-shaped object. Title pick order is `title: …` in
 *      frontmatter, then the first H1, then the filename. The
 *      frontmatter block is stripped from the body so the
 *      workspace's index is the only thing that ever carries
 *      `id` and `created`.
 *   2. `buildExportName` derives a clean filename from the
 *      workspace path. A `notes/2026/ideas.md` path becomes
 *      `ideas.md`; a path without a `.md` extension gets one
 *      appended so the user's file picker always opens the right
 *      filter.
 *
 * `downloadMarkdown` is the one piece not exercised here: it
 * touches the DOM, and the only thing it could do wrong is
 * forget `URL.revokeObjectURL`, which the user would not notice
 * until the tab runs out of memory. Left as a manual smoke.
 *
 * Run with `pnpm tsx scripts/check-page-import-export.ts`. Exit 0 = pass.
 */

import { readMarkdownFile, isImportableFile, ALLOWED_EXTENSIONS } from '../lib/import/page-import'
import { buildExportName } from '../lib/export/page-export'
import type { MarkdownDocument } from '../lib/file-store'

const ok: string[] = []
const fail: string[] = []

function assert(name: string, condition: unknown, detail?: string): void {
  ;(condition ? ok : fail).push(detail ? `${name} (${detail})` : name)
}

interface FileLike {
  name: string
  text(): Promise<string>
}

function file(name: string, text: string): FileLike {
  return { name, text: async () => text }
}

function doc(path: string): MarkdownDocument {
  return { path, title: 'placeholder', frontmatter: {}, outboundLinks: [] }
}

async function main(): Promise<void> {
  // ---- 1. isImportableFile --------------------------------------------

  assert('isImportableFile: .md is allowed', isImportableFile(file('a.md', '')))
  assert('isImportableFile: .markdown is allowed', isImportableFile(file('a.markdown', '')))
  assert('isImportableFile: .txt is allowed', isImportableFile(file('a.txt', '')))
  assert('isImportableFile: .MD is allowed (case-insensitive)', isImportableFile(file('a.MD', '')))
  assert('isImportableFile: .pdf is rejected', !isImportableFile(file('a.pdf', '')))
  assert('isImportableFile: file without extension is rejected', !isImportableFile(file('README', '')))
  // Sanity: the allowlist exported from the module matches what we test.
  assert('isImportableFile: allowlist is .md/.markdown/.txt', ALLOWED_EXTENSIONS.length === 3)

  // ---- 2. readMarkdownFile --------------------------------------------

  // Title from frontmatter beats title from H1.
  {
    const parsed = await readMarkdownFile(
      file('note.md', '---\ntitle: From FM\n---\n\n# From Body\n\nbody\n')
    )
    assert('readMarkdownFile: frontmatter title wins', parsed.title === 'From FM', `got "${parsed.title}"`)
    assert('readMarkdownFile: body has frontmatter stripped', !parsed.body.includes('title:'), parsed.body)
  }

  // Title falls back to the first H1 when no frontmatter title.
  {
    const parsed = await readMarkdownFile(file('note.md', '# Heading wins\n\nbody\n'))
    assert('readMarkdownFile: H1 is the fallback title', parsed.title === 'Heading wins', `got "${parsed.title}"`)
  }

  // Title falls back to the filename (minus extension) when nothing else is present.
  {
    const parsed = await readMarkdownFile(file('plain.txt', 'no heading here\n'))
    assert('readMarkdownFile: filename is the last-resort title', parsed.title === 'plain', `got "${parsed.title}"`)
    assert('readMarkdownFile: body is preserved verbatim', parsed.body === 'no heading here\n')
  }

  // The first H1 is the body, not a heading on a later line.
  {
    const parsed = await readMarkdownFile(file('note.md', '\n\n#  Real heading\n\nbody\n'))
    assert('readMarkdownFile: H1 picked even when not the first line', parsed.title === 'Real heading')
  }

  // H2 is not enough — only H1.
  {
    const parsed = await readMarkdownFile(file('note.md', '## not a heading\n\nbody\n'))
    assert('readMarkdownFile: H2 is ignored, filename wins', parsed.title === 'note')
  }

  // Frontmatter with no `title:` falls through to the H1.
  {
    const parsed = await readMarkdownFile(
      file('note.md', '---\ntags: [private]\n---\n\n# H1 here\n\nbody\n')
    )
    assert('readMarkdownFile: empty frontmatter title falls through', parsed.title === 'H1 here')
  }

  // Invalid frontmatter: treat the whole file as body, pick the H1.
  {
    const parsed = await readMarkdownFile(
      file('note.md', '---\nthis: is: not: yaml: : :\n---\n\n# Real Title\n\nbody\n')
    )
    assert('readMarkdownFile: invalid YAML falls through to the H1', parsed.title === 'Real Title')
  }

  // Extension variants all strip correctly.
  {
    const a = await readMarkdownFile(file('with-markdown.markdown', 'body'))
    const b = await readMarkdownFile(file('with-txt.txt', 'body'))
    assert('readMarkdownFile: .markdown extension is stripped', a.suggestedName === 'with-markdown')
    assert('readMarkdownFile: .txt extension is stripped', b.suggestedName === 'with-txt')
  }

  // ---- 3. buildExportName ---------------------------------------------

  assert('buildExportName: drops folder, keeps .md', buildExportName(doc('notes/2026/ideas.md')) === 'ideas.md')
  assert('buildExportName: root-level .md passes through', buildExportName(doc('ideas.md')) === 'ideas.md')
  assert('buildExportName: file without .md gets one appended', buildExportName(doc('ideas')) === 'ideas.md')
  assert('buildExportName: nested path with no extension gets .md', buildExportName(doc('folder/ideas')) === 'ideas.md')
  assert('buildExportName: case preserved on the basename', buildExportName(doc('Folder/IDEA.md')) === 'IDEA.md')

  console.log(`page-import-export: Task 10 check`)
  ok.forEach((name) => console.log(`  ok  ${name}`))
  fail.forEach((name) => console.log(`  FAIL ${name}`))
  console.log('')
  console.log(`${ok.length}/${ok.length + fail.length} pass`)
  if (fail.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
