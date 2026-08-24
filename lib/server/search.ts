import { create, insert, search, type AnyOrama } from '@orama/orama'
import type { WorkspaceStore } from './workspace-store'
import { getStore } from './store'
import { log } from './observability'
import type { SearchHit } from '../search'

/**
 * Server-side full-text search.
 *
 * Search used to run in the browser over the whole index, which is why the index
 * carried every document's body: 4.68 MB at 2,000 documents, parsed on every boot
 * before anything could render (docs/phase-4-scale.md). Moving the bodies out of the
 * index means moving search to where the bodies already are.
 *
 * The hard part is not the search, it is the **cold start**. A serverless instance
 * that has to read 2,000 objects before answering its first query is unusable, so:
 *
 *   - the corpus is persisted as one object, `search.json`, holding path, title and
 *     text per document, plus the etag each text was read at;
 *   - on load, that snapshot is reconciled against the index by etag, and only the
 *     documents that actually drifted are re-read — normally none, occasionally a
 *     handful;
 *   - the snapshot is only rewritten when drift is large enough to make the next cold
 *     start slow, because rewriting it is the same multi-megabyte write this whole
 *     change exists to avoid.
 *
 * Within a process, writes patch the corpus directly and cost nothing.
 */

export const SEARCH_FILE = 'search.json'

/** Rewrite the snapshot once this many documents have drifted from it. */
const PERSIST_AFTER_DRIFT = 25

/** How long a process trusts its corpus before reconciling against the index again. */
const STALE_AFTER_MS = 5_000

/**
 * Documents read in parallel while catching up.
 *
 * High enough that a cold start with no snapshot is not serialised over the network,
 * low enough not to open hundreds of sockets to R2 at once.
 */
const READ_CONCURRENCY = 24

interface CorpusEntry {
  path: string
  title: string
  text: string
  /** The document etag this text was read at. */
  etag?: string
}

interface CorpusFile {
  version: 1
  documents: CorpusEntry[]
}

export type { SearchHit } from '../search'

export class SearchIndex {
  private corpus = new Map<string, CorpusEntry>()
  private db: AnyOrama | null = null
  private loaded = false
  private checkedAt = 0
  private drift = 0
  private inFlight: Promise<void> | null = null

  constructor(private readonly store: WorkspaceStore) {}

  /** Records a write immediately, so a document is findable the moment it is saved. */
  noteWritten(path: string, body: string, title: string, etag?: string): void {
    if (!this.loaded) return
    this.corpus.set(path, { path, title, text: body, etag })
    this.drift++
    // Cheaper to rebuild the Orama instance lazily than to keep it in sync here;
    // rebuilding 2,000 documents is ~200ms and only happens on the next query.
    this.db = null
  }

  noteRemoved(path: string): void {
    if (!this.loaded) return
    if (this.corpus.delete(path)) {
      this.drift++
      this.db = null
    }
  }

  async query(term: string, limit = 10): Promise<SearchHit[]> {
    const trimmed = term.trim()
    if (!trimmed) return []

    await this.ready()
    const db = await this.instance()

    const result = await search(db, { term: trimmed, limit, properties: ['title', 'text'] })

    return result.hits.map((hit) => {
      const document = hit.document as unknown as CorpusEntry
      return {
        path: document.path,
        title: document.title,
        snippet: snippetFor(document.text, trimmed),
        score: hit.score,
      }
    })
  }

  /** Loads the snapshot and reconciles it with the index, at most every few seconds. */
  private async ready(): Promise<void> {
    if (this.loaded && Date.now() - this.checkedAt < STALE_AFTER_MS) return
    // Concurrent queries during a cold start must not each rebuild the corpus.
    if (this.inFlight) return this.inFlight

    this.inFlight = this.reconcile().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async reconcile(): Promise<void> {
    const started = Date.now()

    if (!this.loaded) {
      const raw = await this.store.bucket.readMeta(SEARCH_FILE)
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as CorpusFile
          for (const entry of parsed.documents ?? []) this.corpus.set(entry.path, entry)
        } catch {
          // A corrupt snapshot is derived data, like the index. Rebuild from storage.
          this.corpus.clear()
        }
      }
      this.loaded = true
    }

    const index = await this.store.getIndex()
    const indexed = Object.values(index.documents)
    const live = new Set(indexed.map((doc) => doc.path))

    // Documents the snapshot has and the workspace no longer does.
    for (const path of [...this.corpus.keys()]) {
      if (!live.has(path)) {
        this.corpus.delete(path)
        this.drift++
        this.db = null
      }
    }

    // Documents whose text is missing or was read at a different etag.
    const stale = indexed.filter((doc) => {
      const entry = this.corpus.get(doc.path)
      return !entry || entry.etag !== doc.etag
    })

    // In batches, not one at a time. The usual case is a handful of documents, but
    // the case that matters is a cold start with no snapshot, where sequential reads
    // meant fifteen seconds before the first search could answer.
    for (let i = 0; i < stale.length; i += READ_CONCURRENCY) {
      const batch = stale.slice(i, i + READ_CONCURRENCY)
      const results = await Promise.all(
        batch.map((doc) => this.store.readDocument(doc.path).catch(() => null))
      )

      for (const result of results) {
        if (!result) continue
        this.corpus.set(result.document.path, {
          path: result.document.path,
          title: result.document.title,
          text: result.document.content ?? '',
          etag: result.document.etag,
        })
        this.drift++
        this.db = null
      }
    }

    this.checkedAt = Date.now()

    if (stale.length > 0) {
      log('info', {
        scope: 'search',
        event: 'reconciled',
        documents: this.corpus.size,
        refreshed: stale.length,
        ms: Date.now() - started,
      })
    }

    if (this.drift >= PERSIST_AFTER_DRIFT) {
      // A snapshot is an optimisation for the *next* cold start. Failing to write one
      // must never fail the search the user is waiting on.
      await this.persist().catch((err: Error) => {
        log('warn', { scope: 'search', event: 'snapshot-failed', reason: err.name })
      })
    }
  }

  /** Writes the snapshot so the next cold start does not have to re-read the corpus. */
  async persist(): Promise<void> {
    const file: CorpusFile = { version: 1, documents: [...this.corpus.values()] }
    await this.store.bucket.writeMeta(SEARCH_FILE, JSON.stringify(file))
    this.drift = 0
    log('info', { scope: 'search', event: 'snapshot-written', documents: this.corpus.size })
  }

  private async instance(): Promise<AnyOrama> {
    if (this.db) return this.db

    const db = await create({
      schema: { title: 'string', text: 'string', path: 'string' },
    })
    for (const entry of this.corpus.values()) {
      await insert(db, { title: entry.title, text: entry.text, path: entry.path })
    }

    this.db = db
    return db
  }

  /** Test seam — drops everything so the next query rebuilds from storage. */
  reset(): void {
    this.corpus.clear()
    this.db = null
    this.loaded = false
    this.checkedAt = 0
    this.drift = 0
  }
}

/**
 * The first line containing the term, trimmed around it.
 *
 * Deliberately not the first line of the document: a result list is only useful if it
 * shows why the document matched.
 */
export function snippetFor(text: string, term: string, width = 160): string {
  const needle = term.toLowerCase().split(/\s+/)[0]
  const at = text.toLowerCase().indexOf(needle)

  const source = text.replace(/\s+/g, ' ').trim()
  if (at === -1) return source.slice(0, width) + (source.length > width ? '…' : '')

  // Recompute the offset against the collapsed text so the window is centred on the
  // match rather than on wherever the original whitespace happened to put it.
  const collapsedAt = source.toLowerCase().indexOf(needle)
  let start = Math.max(0, collapsedAt - Math.floor(width / 3))
  let end = Math.min(source.length, start + width)

  // Snap to word boundaries. Cutting mid-word gives "…tning-fast, privacy-focused",
  // which reads as a rendering bug rather than as an excerpt.
  if (start > 0) {
    const space = source.indexOf(' ', start)
    if (space !== -1 && space < collapsedAt) start = space + 1
  }
  if (end < source.length) {
    const space = source.lastIndexOf(' ', end)
    if (space > collapsedAt + needle.length) end = space
  }

  return `${start > 0 ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`
}

let shared: SearchIndex | null = null

export function getSearchIndex(): SearchIndex {
  if (!shared) shared = new SearchIndex(getStore())
  return shared
}

/** Test seam. */
export function resetSearchIndex(): void {
  shared?.reset()
  shared = null
}
