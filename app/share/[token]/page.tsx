'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Calendar, FileText, Loader2, Lock } from 'lucide-react'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { codeBlockFromNode } from '@/components/workspace/code-block'
import { ImageLightbox, type ViewedImage } from '@/components/workspace/image-lightbox'
import { ViewableImage } from '@/components/workspace/viewable-image'
import { shareImageSrc, type SharedDocumentResponse } from '@/lib/share'

/**
 * Public read-only share page.
 *
 * Deliberately imports no editor and no workspace state — Sprint 6's P0 requires
 * that the editor bundle never reaches a public viewer.
 */

interface SharePageProps {
  params: Promise<{ token: string }>
}

/**
 * Three outcomes, and only three.
 *
 * `locked` is the one addition: it is returned only when a valid, live token was
 * presented, so it tells the holder of the link nothing they did not already know.
 * Everything else is `null` — unknown, revoked, expired, out of scope, deleted.
 */
type FetchResult =
  | { kind: 'ok'; document: SharedDocumentResponse }
  | { kind: 'locked' }
  | null

async function fetchShared(token: string, documentPath?: string): Promise<FetchResult> {
  try {
    const url = documentPath
      ? `/api/share/${encodeURIComponent(token)}?path=${encodeURIComponent(documentPath)}`
      : `/api/share/${encodeURIComponent(token)}`
    const res = await fetch(url, { cache: 'no-store' })

    if (res.status === 401) return { kind: 'locked' }
    if (!res.ok) return null
    return { kind: 'ok', document: (await res.json()) as SharedDocumentResponse }
  } catch {
    return null
  }
}

/**
 * The password prompt for a protected link.
 *
 * A wrong password and a token that does not exist both come back as 404, so the
 * message here cannot distinguish them and does not try. It says the attempt failed,
 * which is all this page is ever in a position to know.
 */
function UnlockForm({
  token,
  onUnlocked,
}: {
  token: string
  onUnlocked: (result: FetchResult) => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')

    try {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      if (res.ok) {
        onUnlocked(await fetchShared(token))
        return
      }

      setError(
        res.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : 'That password did not work.'
      )
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex flex-col items-center text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Lock className="size-6" />
          </div>
          <h1 className="mt-4 text-base font-semibold">This link is password protected</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Ask whoever shared it for the password.
          </p>
        </div>

        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          required
          autoFocus
          autoComplete="current-password"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none ring-primary/20 focus:border-primary focus:ring-2"
        />

        {error && <p className="text-center text-xs font-medium text-destructive">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Open'}
        </button>
      </form>
    </div>
  )
}

export default function SharePage({ params }: SharePageProps) {
  const { token } = use(params)

  const [doc, setDoc] = useState<SharedDocumentResponse | null>(null)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [locked, setLocked] = useState(false)
  /** The picture the viewer is showing, if any. */
  const [viewing, setViewing] = useState<ViewedImage | null>(null)

  const apply = useCallback((result: FetchResult) => {
    if (result?.kind === 'ok') {
      setNotFound(false)
      setLocked(false)
      setDoc(result.document)
      setCurrentPath(result.document.path)
    } else if (result?.kind === 'locked') {
      setLocked(true)
      setNotFound(false)
      setDoc(null)
    } else {
      setNotFound(true)
      setLocked(false)
      setDoc(null)
    }
    setLoading(false)
  }, [])

  /** Called from link clicks, where a synchronous state update is fine. */
  const load = useCallback(
    async (documentPath?: string) => {
      setLoading(true)
      apply(await fetchShared(token, documentPath))
    },
    [token, apply]
  )

  // Inlined rather than calling load(): every state update has to sit visibly inside
  // a promise callback, or the effect counts as updating state synchronously.
  useEffect(() => {
    let cancelled = false
    fetchShared(token).then((data) => {
      if (!cancelled) apply(data)
    })
    return () => {
      cancelled = true
    }
  }, [token, apply])

  /**
   * Rewrites wikilinks for the public view.
   *
   * In-scope links become real links; everything else becomes plain text. Never a
   * dead link — a reader who cannot follow a link should not be able to tell
   * whether the target exists, because that would leak the shape of a workspace
   * they were not given.
   */
  const rendered = useMemo(() => {
    if (!doc) return ''

    return doc.body.replace(
      /\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g,
      (_match, rawTarget: string, alias?: string) => {
        const target = rawTarget.trim()
        const label = alias && alias.length > 0 ? alias : target
        const targetPath = doc.inScopeLinks[target]
        return targetPath ? `[${label}](#share:${encodeURIComponent(targetPath)})` : label
      }
    )
  }, [doc])

  if (loading && !doc) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-background text-foreground">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (locked) {
    return <UnlockForm token={token} onUnlocked={(result) => apply(result)} />
  }

  // One page for every failure: unknown token, revoked token, out-of-scope path.
  // The wording must not distinguish them.
  if (notFound || !doc) {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center bg-background px-4 text-foreground">
        <div className="w-full max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
          <FileText className="mx-auto size-10 text-muted-foreground/50" />
          <h1 className="mt-4 text-base font-semibold">Not found</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            This link is not valid. It may have been mistyped, or the person who shared it may
            have turned it off.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b bg-background/80 px-4 backdrop-blur-md md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-sm font-semibold tracking-tight">Markdown Workspace</span>
          <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-medium text-primary">
            Shared
          </span>
        </div>
        <ThemeSwitcher />
      </header>

      <main className="flex-1 px-4 py-10 md:px-8">
        <article className="mx-auto max-w-3xl space-y-6">
          <div className="border-b pb-6">
            <h1 className="font-serif text-3xl font-bold tracking-tight md:text-4xl">{doc.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              {doc.updatedAt && (
                <span className="flex items-center gap-1">
                  <Calendar className="size-3.5" />
                  {new Date(doc.updatedAt).toLocaleDateString()}
                </span>
              )}
              {doc.scope === 'subtree' && currentPath && (
                <span className="font-mono">{currentPath}</span>
              )}
            </div>
          </div>

          <div className="prose prose-neutral dark:prose-invert max-w-none prose-headings:font-serif">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                /*
                  The same code blocks the workspace renders — language, colours and a
                  copy button — so a shared runbook is as usable to whoever was sent it
                  as it is to its author. The grammars are dynamically imported, so a
                  shared document with no code in it still downloads none of them.
                */
                pre: ({ node, children }) => codeBlockFromNode(node, children),
                /*
                  Images resolve through the share's own token route, never through
                  /api/assets — that one is behind the session gate, so every picture
                  on this page would come back 401. A plain <img> for the reason
                  doc-viewer.tsx gives: next/image would proxy these through the
                  optimizer, which has no token and would cache a private vault's
                  pictures publicly.
                */
                img: ({ src, alt }) => (
                  <ViewableImage
                    src={typeof src === 'string' ? shareImageSrc(token, src) : undefined}
                    source={typeof src === 'string' ? src : undefined}
                    alt={alt ?? ''}
                    onOpen={setViewing}
                  />
                ),
                a: ({ href, children }) => {
                  if (href?.startsWith('#share:')) {
                    const targetPath = decodeURIComponent(href.slice('#share:'.length))
                    return (
                      <button
                        type="button"
                        onClick={() => void load(targetPath)}
                        className="font-medium text-primary underline underline-offset-4 hover:opacity-80"
                      >
                        {children}
                      </button>
                    )
                  }
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                      {children}
                    </a>
                  )
                },
              }}
            >
              {rendered}
            </ReactMarkdown>
          </div>
        </article>
      </main>

      <footer className="border-t py-4 text-center text-xs text-muted-foreground">
        Shared from Markdown Workspace
      </footer>

      {/*
        The same viewer the workspace uses. It is handed a URL that already carries the
        token, and has no idea that it does — see D1 in docs/image-viewer-plan.md.
      */}
      <ImageLightbox image={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}
