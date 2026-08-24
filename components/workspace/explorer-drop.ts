/**
 * Turns an HTML5 drop event's DataTransfer into workspace-relative markdown files.
 *
 * Windows Explorer drops arrive as a filesystem tree via `webkitGetAsEntry`; the
 * plain-files fallback covers drops that carry no entries (some apps, tests). The
 * caller must invoke this synchronously inside the drop handler — the entry objects
 * die with the event, so `webkitGetAsEntry` runs before the first await.
 *
 * Only `.md` files are collected: images already have their own editor-level drop,
 * and everything else in a notes vault is app config, not corpus.
 */

export interface DroppedFile {
  /** Workspace path with forward slashes, relative to the drop root. */
  path: string
  file: File
}

const isFileEntry = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile
const isDirEntry = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry =>
  entry.isDirectory

const readFile = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject))

/** readEntries returns in batches and must be called repeatedly until it yields []. */
const readDirBatch = (entry: FileSystemDirectoryEntry) =>
  new Promise<FileSystemEntry[]>((resolve, reject) =>
    entry.createReader().readEntries(resolve, reject)
  )

async function walk(entry: FileSystemEntry, prefix: string, out: DroppedFile[]): Promise<void> {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name
  if (isFileEntry(entry)) {
    if (!rel.endsWith('.md')) return
    out.push({ path: rel, file: await readFile(entry) })
    return
  }
  if (isDirEntry(entry)) {
    let batch: FileSystemEntry[]
    do {
      batch = await readDirBatch(entry)
      for (const child of batch) await walk(child, rel, out)
    } while (batch.length > 0)
  }
}

export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const entries = Array.from(dataTransfer.items, (item) => item.webkitGetAsEntry()).filter(
    (entry): entry is FileSystemEntry => entry !== null
  )

  const out: DroppedFile[] = []
  if (entries.length === 0) {
    for (const file of Array.from(dataTransfer.files)) {
      if (file.name.endsWith('.md')) out.push({ path: file.name, file })
    }
    return out
  }

  for (const entry of entries) await walk(entry, '', out)
  return out
}
