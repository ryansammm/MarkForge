'use client'

import { useEffect, useState } from 'react'
import { FileText, Loader2, Search as SearchIcon, X } from 'lucide-react'
import type { SearchHit } from '@/lib/search'
import type { OpenIntent } from '@/lib/tabs'
import { grimoireHeaders } from '@/lib/grimoire-client'
import { openHandlers } from './tab-gestures'

/**
 * Full-text search.
 *
 * This used to build an Orama index in the browser over every document's body, which
 * is the reason the workspace index carried them: 4.68 MB at 2,000 documents, parsed
 * before anything could render (docs/phase-4-scale.md). Now it sends a query string
 * and receives ten results — and the search engine leaves the client bundle with it.
 *
 * The debounce is what makes that affordable: one request per pause in typing rather
 * than one per keystroke.
 */

const DEBOUNCE_MS = 180

interface SearchDialogProps {
  open: boolean
  onClose: () => void
  onSelectDoc: (path: string, intent: OpenIntent) => void
}

export function SearchDialog({ open, onClose, onSelectDoc }: SearchDialogProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return

    const term = query.trim()
    if (!term) {
      // Cleared inside a promise callback, like every other state update reached from
      // an effect in this codebase, so the effect never updates state synchronously.
      Promise.resolve().then(() => {
        setResults([])
        setError(null)
        setSearching(false)
      })
      return
    }

    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)

      fetch(`/api/search?q=${encodeURIComponent(term)}`, { cache: 'no-store', headers: grimoireHeaders() })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Search failed (${response.status})`)
          return (await response.json()) as { hits: SearchHit[] }
        })
        .then(({ hits }) => {
          if (cancelled) return
          setResults(hits)
          setError(null)
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message)
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, open])

  // Escape closes, which is what every other overlay in the app does.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 px-4 pt-20 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-xl border bg-card shadow-2xl">
        <div className="flex items-center border-b px-4 py-3">
          {searching ? (
            <Loader2 className="mr-3 size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <SearchIcon className="mr-3 size-4 shrink-0 text-muted-foreground" />
          )}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles and full text…"
            autoFocus
            aria-label="Search documents"
            className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto p-2">
          {error && (
            <div className="py-8 text-center text-xs text-destructive">{error}</div>
          )}

          {!error && query.trim() && !searching && results.length === 0 && (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No matching documents found.
            </div>
          )}

          {!query.trim() && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              Type to search every document by title and content.
            </div>
          )}

          {results.map((hit) => (
            <button
              key={hit.path}
              type="button"
              {...openHandlers((intent) => {
                onSelectDoc(hit.path, intent)
                // Closed even for a background open: the dialog is modal, so leaving
                // it up would hide the tab it just made.
                onClose()
              })}
              className="flex w-full flex-col items-start rounded-lg p-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <FileText className="size-4 shrink-0 text-primary" />
                <span className="truncate">{hit.title}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                  {hit.path}
                </span>
              </div>
              {/* The text around the match, not the top of the document: a result
                  list is only useful if it shows why the document matched. */}
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
