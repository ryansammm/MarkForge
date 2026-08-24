import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { BinaryObject, Bucket } from './bucket'
import { contentTypeForKey } from './assets'

/**
 * Filesystem bucket — local development and self-hosted deployments.
 *
 * Real directories, so empty folders need no marker objects. Metadata lives
 * outside the notes tree so `listKeys` returns the corpus and nothing else.
 */

export interface FsBucketOptions {
  /** Root directory holding the Markdown corpus. */
  notesDir?: string
  /** Directory for index.json and shares.json. Defaults to the project root. */
  metaDir?: string
  /** Explicit location for index.json, overriding metaDir. Used by the CLI. */
  indexPath?: string
}

export class FsBucket implements Bucket {
  readonly kind = 'filesystem'

  private readonly notesDir: string
  private readonly metaDir: string
  private readonly indexPath?: string

  constructor(options: FsBucketOptions = {}) {
    this.indexPath = options.indexPath
    this.notesDir = path.resolve(
      /* turbopackIgnore: true */
      options.notesDir ?? process.env.NOTES_DIR ?? path.join(process.cwd(), 'notes')
    )
    this.metaDir = path.resolve(
      /* turbopackIgnore: true */
      options.metaDir ?? process.env.META_DIR ?? process.cwd()
    )
  }

  private full(key: string): string {
    return path.resolve(this.notesDir, key)
  }

  async readText(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.full(key), 'utf-8')
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  async writeText(key: string, body: string): Promise<void> {
    const target = this.full(key)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await writeFileAtomic(target, body)
  }

  /**
   * Reads bytes.
   *
   * The content type is derived from the extension rather than stored. A filesystem
   * has nowhere to put it, and inventing a sidecar file to hold it would put
   * something in the user's vault that is not their content — for a value that
   * `assets.ts` can compute from the name.
   */
  async readBinary(key: string): Promise<BinaryObject | null> {
    try {
      const buffer = await fs.readFile(this.full(key))
      return { bytes: new Uint8Array(buffer), contentType: contentTypeForKey(key) }
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  async writeBinary(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.full(key)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await writeFileAtomic(target, bytes)
  }

  async listBinaryKeys(prefix?: string): Promise<string[]> {
    return this.walkFiles(prefix, (name) => !name.endsWith('.md'))
  }

  async statObject(key: string): Promise<{ size: number; modifiedAt: string } | null> {
    const found = await stat(this.full(key))
    if (!found?.isFile()) return null
    return { size: found.size, modifiedAt: found.mtime.toISOString() }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await fs.unlink(this.full(key))
    } catch (err) {
      if (!isMissing(err)) throw err
    }
  }

  async objectExists(key: string): Promise<boolean> {
    return (await stat(this.full(key)))?.isFile() ?? false
  }

  async listKeys(prefix?: string): Promise<string[]> {
    return this.walkFiles(prefix, (name) => name.endsWith('.md'))
  }

  /** Every file under `prefix` whose name the predicate accepts, sorted. */
  private async walkFiles(
    prefix: string | undefined,
    accept: (name: string) => boolean
  ): Promise<string[]> {
    const root = prefix ? this.full(prefix) : this.notesDir
    const found: string[] = []

    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (isMissing(err)) return
        throw err
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile() && accept(entry.name)) {
          found.push(path.relative(this.notesDir, full).replace(/\\/g, '/'))
        }
      }
    }

    await walk(root)
    return found.sort()
  }

  async createFolder(prefix: string): Promise<void> {
    await fs.mkdir(this.full(prefix), { recursive: true })
  }

  async deleteFolder(prefix: string): Promise<void> {
    await fs.rm(this.full(prefix), { recursive: true, force: true })
  }

  async folderExists(prefix: string): Promise<boolean> {
    return (await stat(this.full(prefix)))?.isDirectory() ?? false
  }

  async listFolders(): Promise<string[]> {
    const found: string[] = []

    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (isMissing(err)) return
        throw err
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name) || !entry.isDirectory()) continue
        const full = path.join(dir, entry.name)
        found.push(path.relative(this.notesDir, full).replace(/\\/g, '/'))
        await walk(full)
      }
    }

    await walk(this.notesDir)
    return found.sort()
  }

  async readMeta(name: string): Promise<string | null> {
    try {
      return await fs.readFile(this.metaPath(name), 'utf-8')
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  async writeMeta(name: string, body: string): Promise<void> {
    const target = this.metaPath(name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await writeFileAtomic(target, body)
  }

  async listMeta(prefix: string): Promise<string[]> {
    const root = path.join(this.metaDir, prefix)
    const found: string[] = []

    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (isMissing(err)) return
        throw err
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) {
          found.push(path.relative(this.metaDir, full).replace(/\\/g, '/'))
        }
      }
    }

    await walk(root)
    return found.sort()
  }

  async deleteMeta(name: string): Promise<void> {
    const target = this.metaPath(name)
    try {
      await fs.unlink(target)
    } catch (err) {
      if (!isMissing(err)) throw err
    }
    // Purging a trash entry should not leave its directory behind. rmdir refuses
    // on a non-empty directory, which is exactly the guard wanted here.
    await fs.rmdir(path.dirname(target)).catch(() => undefined)
  }

  /**
   * Compare-and-set.
   *
   * Real atomicity here would need file locking, and this backend is the
   * single-process case — one local dev server, or one self-hosted node — where
   * the store's own queue already serializes writes. The comparison closes the
   * window that queue leaves rather than pretending to be a distributed lock.
   */
  async writeMetaIfUnchanged(name: string, body: string, expected: string | null): Promise<boolean> {
    const current = await this.readMeta(name)
    if (current !== expected) return false
    await this.writeMeta(name, body)
    return true
  }

  private metaPath(name: string): string {
    if (name === 'index.json') {
      // index.json keeps its historical home under public/ so the statically served
      // asset and the store agree during local development.
      if (this.indexPath) return path.resolve(this.indexPath)
      if (process.env.INDEX_PATH) {
        return path.resolve(/* turbopackIgnore: true */ process.env.INDEX_PATH)
      }
      return path.join(this.metaDir, 'public', 'index.json')
    }
    if (name === 'shares.json' && process.env.SHARES_PATH) {
      return path.resolve(/* turbopackIgnore: true */ process.env.SHARES_PATH)
    }
    return path.join(this.metaDir, name)
  }
}

/**
 * Directories that are never part of a Markdown corpus.
 *
 * Without this, pointing the ingest CLI at a project root silently pulls in every
 * README under node_modules — thousands of documents that then have to be deleted
 * out of the index by hand.
 */
const EXCLUDED_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out'])

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

async function stat(target: string) {
  try {
    return await fs.stat(target)
  } catch (err) {
    if (isMissing(err)) return undefined
    throw err
  }
}

/**
 * Write to a sibling temp file, then rename over the target.
 *
 * A torn index.json is worse than a stale one: the app would fail to parse it on
 * next load and the corpus would look empty. Rename is atomic on NTFS and ext4.
 *
 * Bytes are written as they are; only a string is encoded, and only as UTF-8. An
 * image that went through a utf-8 round trip would come back corrupted and still
 * have a plausible-looking file size, so the two cases stay explicitly separate.
 */
async function writeFileAtomic(target: string, content: string | Uint8Array): Promise<void> {
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    if (typeof content === 'string') await fs.writeFile(temp, content, 'utf-8')
    else await fs.writeFile(temp, content)
    await fs.rename(temp, target)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}
