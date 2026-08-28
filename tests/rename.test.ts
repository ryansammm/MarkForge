import { it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WorkspaceStore } from '../lib/server/workspace-store'
import { FsBucket } from '../lib/server/fs-bucket'
import { executeRename, planRename, renameDocument, summarizeRename } from '../lib/server/rename'
import { findWikiLinks, retargetWikiLinks } from '../lib/markdown/links'
import { resolveWikiLink } from '../lib/resolve-link'
import type { MarkdownDocument, WorkspaceIndex } from '../lib/file-store'
import { ingestDirectory } from '../scripts/ingest'

/**
 * Rename and restructuring suite — Sprint 4's core.
 *
 * Two DoD items are the reason this file exists:
 *   - rename a document with >=5 inbound links; every link resolves afterward
 *   - simulate a mid-rename failure; the report names exactly which files did not
 *     update
 *
 * The mid-rename failure is simulated honestly: the plan captures etags, then a file
 * is changed on disk behind the app's back, so its If-Match precondition genuinely
 * fails during execution. No mocks, no injected faults — the same thing that would
 * happen if a second tab saved that document while the rename was running.
 */

let passed = 0
const failures: string[] = []

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures.push(`${name}\n      ${(err as Error).message}`)
    console.error(`  FAIL ${name}`)
    console.error(`       ${(err as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
  }
}

interface Workspace {
  dir: string
  notes: string
  indexPath: string
  store: WorkspaceStore
}

function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-rename-'))
  const notes = path.join(dir, 'notes')
  const indexPath = path.join(dir, 'index.json')
  fs.mkdirSync(notes, { recursive: true })
  // metaDir keeps the trash inside the temp workspace. Defaulted, it is cwd, and a
  // test that deletes a document leaves .trash/ in the repository.
  return {
    dir,
    notes,
    indexPath,
    store: new WorkspaceStore(new FsBucket({ notesDir: notes, metaDir: dir, indexPath })),
  }
}

const cleanup = (ws: Workspace) => fs.rmSync(ws.dir, { recursive: true, force: true })
const readIndex = (ws: Workspace) => JSON.parse(fs.readFileSync(ws.indexPath, 'utf-8')) as WorkspaceIndex
const readFile = (ws: Workspace, p: string) => fs.readFileSync(path.join(ws.notes, p), 'utf-8')

/** Does any link in `content` still point at `target`? */
const linksTo = (content: string, target: string) =>
  findWikiLinks(content).some((o) => o.target.toLowerCase() === target.toLowerCase())

async function run() {
  console.log('Rename and restructuring suite\n')

  console.log('byte-preserving link rewriting')
  await check('only the link changes; the rest of the file is untouched', () => {
    const before = [
      '---',
      'title: Kept',
      '---',
      '',
      'Setext Heading',
      '==============',
      '',
      '* asterisk bullet with snake_case_word',
      '* see [[Old Name]] here',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      'trailing spaces line  ',
      '',
    ].join('\n')

    const { content, changed } = retargetWikiLinks(before, 'Old Name', 'New Name')
    equal(changed, 1, 'wrong number of rewrites')
    equal(content, before.replace('[[Old Name]]', '[[New Name]]'), 'something other than the link moved')
  })

  await check('aliases are preserved through a rewrite', () => {
    const { content } = retargetWikiLinks('See [[Old Name|the old one]].\n', 'Old Name', 'New Name')
    equal(content, 'See [[New Name|the old one]].\n', 'alias was not preserved')
  })

  await check('links inside code are not rewritten', () => {
    const before = 'Real [[Old]].\n\n```\n[[Old]]\n```\n\nInline `[[Old]]` too.\n'
    const { content, changed } = retargetWikiLinks(before, 'Old', 'New')
    equal(changed, 1, 'should rewrite only the prose link')
    assert(content.includes('```\n[[Old]]\n```'), 'fenced code was rewritten')
    assert(content.includes('`[[Old]]`'), 'inline code was rewritten')
    assert(content.includes('Real [[New]].'), 'prose link was not rewritten')
  })

  await check('matching is case-insensitive', () => {
    const { changed, content } = retargetWikiLinks('See [[old name]].\n', 'Old Name', 'New Name')
    equal(changed, 1, 'case-different link was missed')
    equal(content, 'See [[New Name]].\n', 'unexpected result')
  })

  console.log('\nrename with inbound links')
  {
    const ws = makeWorkspace()
    try {
      await check('a document with 6 inbound links: every link resolves afterward', async () => {
        await ws.store.write('Target.md', '# Target\n\nThe destination.\n')

        const linkers = ['One', 'Two', 'Three', 'Four', 'Five', 'Six']
        for (const name of linkers) {
          await ws.store.write(`refs/${name}.md`, `# ${name}\n\nPoints at [[Target]] deliberately.\n`)
        }

        const report = await renameDocument(ws.store, 'Target.md', 'Renamed Target.md')

        assert(report.renamed, `rename did not happen: ${report.renameError}`)
        equal(report.failedCount, 0, 'unexpected failures')
        equal(report.totalLinkFiles, 6, 'wrong number of linking documents found')
        equal(report.updatedCount, 6, 'wrong number of documents updated')

        for (const name of linkers) {
          const content = readFile(ws, `refs/${name}.md`)
          assert(content.includes('[[Renamed Target]]'), `${name} was not rewritten`)
          assert(!linksTo(content, 'Target'), `${name} still links to the old name`)
        }

        // And the graph in the index agrees.
        const index = readIndex(ws)
        equal(index.backlinks['Renamed Target']?.length, 6, 'backlinks not repointed')
        assert(!index.backlinks['Target'], 'stale backlink entry left behind')
        assert(index.documents['Renamed Target.md'], 'renamed document missing from index')
        assert(!index.documents['Target.md'], 'old document still in index')
      })

      await check('the summary reads the way the plan asked', async () => {
        const report = await renameDocument(ws.store, 'Renamed Target.md', 'Final Target.md')
        equal(
          summarizeRename(report),
          // The second sentence is the heading rewrite reporting itself. It is the one
          // part of a rename that edits the file's contents rather than moving it, so
          // it is never allowed to happen silently.
          'Renamed. 6 of 6 linking documents updated. The heading now reads the new name.',
          'unexpected summary'
        )
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nmid-rename failure')
  {
    const ws = makeWorkspace()
    try {
      await check('the report names exactly the files that did not update', async () => {
        await ws.store.write('Subject.md', '# Subject\n')
        for (const name of ['a', 'b', 'c', 'd']) {
          await ws.store.write(`${name}.md`, `# ${name}\n\nSee [[Subject]].\n`)
        }

        // Plan captures the etags...
        const plan = await planRename(ws.store, 'Subject.md', 'Subject Renamed.md')
        equal(plan.edits.length, 4, 'plan should cover 4 documents')

        // ...then two of those documents change behind the app's back, exactly as a
        // second tab saving them would. Their If-Match preconditions now fail.
        fs.writeFileSync(path.join(ws.notes, 'b.md'), '# b\n\nSee [[Subject]]. Edited elsewhere.\n', 'utf-8')
        fs.writeFileSync(path.join(ws.notes, 'd.md'), '# d\n\nSee [[Subject]]. Also edited.\n', 'utf-8')

        const report = await executeRename(ws.store, plan)

        equal(report.failedCount, 2, 'wrong number of failures')
        equal(report.updatedCount, 2, 'wrong number of successes')

        const failedPaths = report.linkUpdates.filter((u) => !u.ok).map((u) => u.path).sort()
        equal(failedPaths, ['b.md', 'd.md'], 'the report names the wrong files')

        const okPaths = report.linkUpdates.filter((u) => u.ok).map((u) => u.path).sort()
        equal(okPaths, ['a.md', 'c.md'], 'the report credits the wrong files')

        // The successes really did land and the failures really did not.
        assert(readFile(ws, 'a.md').includes('[[Subject Renamed]]'), 'a.md was reported ok but not written')
        assert(readFile(ws, 'b.md').includes('[[Subject]]'), 'b.md was written despite the conflict')
        assert(readFile(ws, 'b.md').includes('Edited elsewhere'), 'the concurrent edit to b.md was clobbered')

        assert(report.renamed, 'the document itself should still have been renamed')

        const summary = summarizeRename(report)
        assert(summary.includes('2 failed'), `summary should count failures: ${summary}`)
        assert(summary.includes('b.md') && summary.includes('d.md'), `summary should name them: ${summary}`)
      })

      await check('the failed links still resolve, via an alias on the renamed document', async () => {
        const renamed = readFile(ws, 'Subject Renamed.md')
        assert(
          renamed.includes('aliases: ["Subject"]'),
          `old title was not recorded as an alias:\n${renamed}`
        )

        const doc = await ws.store.getFile('Subject Renamed.md')
        equal(doc?.aliases, ['Subject'], 'alias not exposed on the document')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nrename edge cases')
  {
    const ws = makeWorkspace()
    try {
      await check('a title pinned in frontmatter means no links need rewriting', async () => {
        await ws.store.write('Pinned.md', '---\ntitle: Stable Title\n---\n\n# Stable Title\n')
        await ws.store.write('linker.md', '# linker\n\nSee [[Stable Title]].\n')

        // Baseline is read after creation, since the first save assigns an id (R7).
        const before = readFile(ws, 'linker.md')

        const report = await renameDocument(ws.store, 'Pinned.md', 'Different Filename.md')

        assert(report.renamed, 'rename failed')
        equal(report.totalLinkFiles, 0, 'should not have planned any link edits')
        equal(readFile(ws, 'linker.md'), before, 'linker was touched by the rename')
      })

      await check('links by filename are rewritten too, not just links by title', async () => {
        await ws.store.write('notes/File Name.md', '---\ntitle: Display Title\n---\n\nBody\n')
        await ws.store.write('by-file.md', '# by-file\n\nSee [[File Name]].\n')

        const plan = await planRename(ws.store, 'notes/File Name.md', 'notes/New File Name.md')
        // Title is pinned, so the title does not change — but the filename does, and
        // links written against the filename still have to follow.
        assert(
          plan.oldTargets.includes('File Name'),
          `filename should be a rename target: ${JSON.stringify(plan.oldTargets)}`
        )
      })

      await check('the heading follows the filename, so the rename is visible', async () => {
        /*
          The bug: `deriveTitle` prefers the first H1 over the filename, so renaming
          the file left the sidebar, the tab strip, the breadcrumb and the reading
          view all still showing the old name. The rename looked as though it had not
          happened — while it had already rewritten every inbound link to the new one.
        */
        await ws.store.write('GH - Dev Notes.md', '# GH - Dev Notes\n\nBody stays.\n')

        const report = await renameDocument(ws.store, 'GH - Dev Notes.md', 'Dev Notes.md')

        assert(report.renamed, 'rename failed')
        equal(report.headingUpdated, 'Dev Notes', 'the heading rewrite was not reported')

        const after = readFile(ws, 'Dev Notes.md')
        assert(after.includes('# Dev Notes\n'), `heading was not rewritten:\n${after}`)
        assert(after.includes('Body stays.'), 'the body was disturbed')

        const document = (await ws.store.getFile('Dev Notes.md'))!
        equal(document.title, 'Dev Notes', 'the document still reports the old title')
      })

      await check('a heading that is not the title is left alone', async () => {
        // Only the heading the document is *titled by* follows the filename. The
        // frontmatter pins the title here, so the H1 is ordinary prose.
        const before = '---\ntitle: Pinned Name\n---\n\n# Something Else Entirely\n\nBody\n'
        await ws.store.write('loose.md', before)

        const report = await renameDocument(ws.store, 'loose.md', 'renamed.md')

        assert(report.renamed, 'rename failed')
        equal(report.headingUpdated, undefined, 'rewrote a heading it had no business touching')
        assert(
          readFile(ws, 'renamed.md').includes('# Something Else Entirely'),
          'the prose heading was rewritten'
        )
      })

      await check('a hash inside a code fence is not mistaken for the title', async () => {
        const body = '# Real Title\n\n```bash\n# Real Title\necho hi\n```\n'
        await ws.store.write('Real Title.md', body)

        await renameDocument(ws.store, 'Real Title.md', 'New Title.md')

        const after = readFile(ws, 'New Title.md')
        assert(after.includes('# New Title\n'), 'the real heading was not rewritten')
        assert(after.includes('```bash\n# Real Title\n'), `the shell comment was rewritten:\n${after}`)
      })

      await check('inbound links and the heading agree after a rename', async () => {
        // The two halves of the same fix: links are retargeted to the new name, and
        // the document now actually answers to that name.
        await ws.store.write('Old Name.md', '# Old Name\n')
        await ws.store.write('refers.md', '# refers\n\nSee [[Old Name]].\n')

        const report = await renameDocument(ws.store, 'Old Name.md', 'New Name.md')
        assert(report.renamed, 'rename failed')

        const index = await ws.store.getIndex()
        assert(
          readFile(ws, 'refers.md').includes('[[New Name]]'),
          'the inbound link was not retargeted'
        )
        const resolved = resolveWikiLink('New Name', index.documents)
        equal(resolved?.path, 'New Name.md', 'the retargeted link does not resolve by title')
      })

      await check('moving a document into a folder does not disturb its links', async () => {
        await ws.store.write('Mover.md', '# Mover\n')
        await ws.store.write('points.md', '# points\n\nSee [[Mover]].\n')

        const report = await renameDocument(ws.store, 'Mover.md', 'archive/Mover.md')

        assert(report.renamed, 'move failed')
        equal(report.totalLinkFiles, 0, 'a plain move should not rewrite links')
        assert(readFile(ws, 'points.md').includes('[[Mover]]'), 'link was disturbed by a move')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nfolders')
  {
    const ws = makeWorkspace()
    try {
      await check('an empty folder can be created and survives in the index', async () => {
        await ws.store.createDirectory('Projects/Active')

        const index = readIndex(ws)
        const projects = index.tree.find((n) => n.path === 'Projects')
        assert(projects?.isDir, 'Projects missing from the tree')
        assert(projects.children?.some((n) => n.path === 'Projects/Active'), 'nested folder missing')
        assert(fs.existsSync(path.join(ws.notes, 'Projects', 'Active')), 'folder not created on disk')
      })

      await check('a folder outlives its last document', async () => {
        await ws.store.write('Projects/Active/Note.md', '# Note\n')
        await ws.store.remove('Projects/Active/Note.md')

        const index = readIndex(ws)
        const projects = index.tree.find((n) => n.path === 'Projects')
        assert(
          projects?.children?.some((n) => n.path === 'Projects/Active'),
          'folder was pruned when its last document was deleted'
        )
        assert(fs.existsSync(path.join(ws.notes, 'Projects', 'Active')), 'folder removed from disk')
      })

      await check('deleting a folder removes it and everything under it', async () => {
        await ws.store.write('Doomed/a.md', '# a\n')
        await ws.store.write('Doomed/nested/b.md', '# b\n\n[[Ghost]]\n')

        const result = await ws.store.removeDirectory('Doomed')
        equal(result.removed.sort(), ['Doomed/a.md', 'Doomed/nested/b.md'], 'wrong documents reported')

        const index = readIndex(ws)
        assert(!index.documents['Doomed/a.md'], 'document still indexed')
        assert(!index.documents['Doomed/nested/b.md'], 'nested document still indexed')
        assert(!index.backlinks['Ghost'], 'backlinks not cleaned up')
        assert(!index.tree.some((n) => n.path === 'Doomed'), 'folder still in tree')
        assert(!fs.existsSync(path.join(ws.notes, 'Doomed')), 'folder still on disk')
      })

      await check('moving a folder re-keys every document beneath it', async () => {
        await ws.store.write('From/one.md', '# one\n')
        await ws.store.write('From/deep/two.md', '# two\n')

        const result = await ws.store.moveDirectory('From', 'To')
        equal(result.moved.sort(), ['From/deep/two.md', 'From/one.md'], 'wrong documents moved')

        const index = readIndex(ws)
        assert(index.documents['To/one.md'], 'document not re-keyed')
        assert(index.documents['To/deep/two.md'], 'nested document not re-keyed')
        assert(!index.documents['From/one.md'], 'old key left behind')
        assert(fs.existsSync(path.join(ws.notes, 'To', 'deep', 'two.md')), 'not moved on disk')
      })

      await check('a folder cannot be moved inside itself', async () => {
        await ws.store.createDirectory('Self')
        let threw = false
        try {
          await ws.store.moveDirectory('Self', 'Self/inner')
        } catch {
          threw = true
        }
        assert(threw, 'should have refused')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nlink resolution order')
  {
    const docs: Record<string, MarkdownDocument> = {
      'a/Principles.md': {
        path: 'a/Principles.md',
        title: 'Principles',
        frontmatter: {},
        outboundLinks: [],
        content: '',
        id: 'doc-principles',
        aliases: ['House Rules'],
      },
      'b/Notebook.md': {
        path: 'b/Notebook.md',
        title: 'Notebook',
        frontmatter: {},
        outboundLinks: [],
        content: '',
        id: 'doc-notebook',
      },
    }

    await check('resolves by id ahead of anything else', () => {
      equal(resolveWikiLink('doc-notebook', docs)?.path, 'b/Notebook.md', 'id lookup failed')
    })

    await check('resolves by title, case-insensitively', () => {
      equal(resolveWikiLink('principles', docs)?.path, 'a/Principles.md', 'title lookup failed')
    })

    await check('resolves by alias — the rename fallback', () => {
      equal(resolveWikiLink('House Rules', docs)?.path, 'a/Principles.md', 'alias lookup failed')
    })

    await check('resolves by filename', () => {
      equal(resolveWikiLink('Notebook', docs)?.path, 'b/Notebook.md', 'filename lookup failed')
    })

    await check('does not resolve a substring to an unrelated document', () => {
      // The old resolver used `path.includes(target)`, so `[[Note]]` silently
      // resolved to Notebook.md. A link that appears to work while pointing
      // somewhere nobody intended is worse than a visible ghost.
      equal(resolveWikiLink('Note', docs), null, 'substring match resurfaced')
    })

    await check('an unknown target stays unresolved', () => {
      equal(resolveWikiLink('Nothing Here', docs), null, 'should not resolve')
    })
  }

  console.log('\nindex stays rebuildable')
  {
    const ws = makeWorkspace()
    try {
      await check('after renames, moves and deletes the index equals a full reindex', async () => {
        await ws.store.write('Alpha.md', '# Alpha\n\n[[Beta]] and [[Gamma]]\n')
        await ws.store.write('Beta.md', '# Beta\n\n[[Alpha]]\n')
        await ws.store.write('Gamma.md', '# Gamma\n\n[[Alpha]] [[Beta]]\n')
        await ws.store.createDirectory('Archive')

        await renameDocument(ws.store, 'Beta.md', 'Beta Renamed.md')
        await ws.store.moveDirectory('Archive', 'Archive Moved')
        await ws.store.write('Archive Moved/Delta.md', '# Delta\n\n[[Alpha]]\n')
        await renameDocument(ws.store, 'Gamma.md', 'Archive Moved/Gamma.md')
        await ws.store.remove('Alpha.md')

        const rebuiltPath = path.join(ws.dir, 'rebuilt.json')
        await ingestDirectory(ws.notes, rebuiltPath)
        const rebuilt = JSON.parse(fs.readFileSync(rebuiltPath, 'utf-8')) as WorkspaceIndex
        const incremental = readIndex(ws)

        equal(
          Object.keys(incremental.documents).sort(),
          Object.keys(rebuilt.documents).sort(),
          'document sets diverged'
        )
        equal(incremental.tree, rebuilt.tree, 'trees diverged')

        const normalize = (b: Record<string, string[]>) =>
          Object.fromEntries(Object.entries(b).map(([k, v]) => [k, [...v].sort()]).sort())
        equal(normalize(incremental.backlinks), normalize(rebuilt.backlinks), 'backlinks diverged')

        for (const key of Object.keys(rebuilt.documents)) {
          equal(incremental.documents[key].etag, rebuilt.documents[key].etag, `etag diverged for ${key}`)
          equal(
            incremental.documents[key].outboundLinks,
            rebuilt.documents[key].outboundLinks,
            `links diverged for ${key}`
          )
        }
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures.`)
    return true
  }
  console.error(`FAIL — ${failures.length} failure(s) of ${passed + failures.length} checks:\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  return false
}

it('rename suite', async () => {
  if (!(await run())) throw new Error('rename suite FAILED')
}, 60000)

export { run as runRenameTests }
