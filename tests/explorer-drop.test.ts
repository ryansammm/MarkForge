import { collectDroppedFiles } from '../components/workspace/explorer-drop'

/**
 * Explorer drop parsing contract.
 *
 * The parser is the risky half of drag-and-drop: directory traversal must batch
 * readEntries correctly (stop at the first empty batch) or it hangs forever, and
 * non-markdown files must never leak into the corpus.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert failed: ${message}`)
}

interface FakeInit {
  name: string
  kind: 'file' | 'directory'
  content?: string
  children?: FakeInit[]
}

interface FakeEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (cb: (f: File) => void) => void
  createReader?: () => {
    readEntries: (cb: (entries: FakeEntry[]) => void) => void
  }
}

/** Minimal stand-in for the webkit FileSystemEntry tree a real drop carries. */
function fakeEntry(init: FakeInit): FileSystemEntry {
  let entry: FakeEntry
  if (init.kind === 'file') {
    entry = {
      isFile: true,
      isDirectory: false,
      name: init.name,
      file: (cb) => cb(new File([init.content ?? ''], init.name)),
    }
  } else {
    const queue = [...(init.children ?? [])]
    entry = {
      isFile: false,
      isDirectory: true,
      name: init.name,
      // Hand entries one per batch, then an empty one — the batching behaviour
      // that breaks naive readers.
      createReader: () => ({
        readEntries: (cb) => cb(queue.splice(0, 1).map((child) => fakeEntry(child))),
      }),
    }
  }
  return entry as unknown as FileSystemEntry
}

function fakeTransfer(items: FileSystemEntry[], files: File[] = []): DataTransfer {
  return {
    items: items.map((entry) => ({
      kind: 'file',
      webkitGetAsEntry: () => entry,
    })),
    files,
  } as unknown as DataTransfer
}

async function main() {
  const tree = fakeTransfer([
    fakeEntry({
      name: 'vault',
      kind: 'directory',
      children: [
        { name: 'a.md', kind: 'file', content: '# A' },
        { name: 'img.png', kind: 'file', content: 'binary' },
        {
          name: 'sub',
          kind: 'directory',
          children: [{ name: 'b.md', kind: 'file', content: '# B' }],
        },
      ],
    }),
    fakeEntry({ name: 'loose.md', kind: 'file', content: '# Loose' }),
  ])

  const dropped = await collectDroppedFiles(tree)
  assert(dropped.length === 3, `expected 3 md files, got ${dropped.length}: ${JSON.stringify(dropped.map((d) => d.path))}`)
  assert(
    JSON.stringify(dropped.map((d) => d.path)) ===
      JSON.stringify(['vault/a.md', 'vault/sub/b.md', 'loose.md']),
    `unexpected paths: ${JSON.stringify(dropped.map((d) => d.path))}`
  )
  assert((await dropped[0].file.text()) === '# A', 'content lost')

  // No-entry drops fall back to plain files and still filter to markdown only.
  const plain = new File(['# P'], 'plain.md')
  const fallback = await collectDroppedFiles(fakeTransfer([], [plain, new File(['x'], 'skip.txt')]))
  assert(fallback.length === 1 && fallback[0].path === 'plain.md', 'fallback filtering broken')

  // Nothing usable → empty result, never a throw.
  assert((await collectDroppedFiles(fakeTransfer([]))).length === 0, 'empty drop should yield []')

  console.log('explorer-drop tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
