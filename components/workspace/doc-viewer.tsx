'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeSlug from 'rehype-slug'
import { FileText, Calendar, Hash } from 'lucide-react'
import { MarkdownDocument, type FileTreeNode } from '@/lib/file-store'
import { classifyHref, isResolvable } from '@/lib/resolve-link'
import { documentDates } from '@/lib/document-dates'
import { isWorkspaceHref, linkifyWikilinks, parseWikilinkHref } from '@/lib/markdown/wikilink-href'
import { stripBlockComments } from '@/lib/markdown/strip-block-comments'
import { remarkBlockColor } from '@/lib/markdown/annotate-block-color'
import { frontmatterView, frontmatterWidth } from '@/lib/markdown/frontmatter'
import { resolveImageSrc } from '@/lib/workspace-api'
import type { OpenIntent } from '@/lib/tabs'
import { cn } from '@/lib/utils'
import { openHandlers } from './tab-gestures'
import { codeBlockFromNode } from './code-block'
import { ImageLightbox, type ViewedImage } from './image-lightbox'
import { ViewableImage } from './viewable-image'
import { ChildPagesSection } from './child-pages-section'
import { Breadcrumb } from './breadcrumb'
import { PageMenu } from './page-menu'

/** One look for every link that goes somewhere, whether inside the vault or out. */
const LINK = 'text-primary underline underline-offset-4 hover:opacity-80'

interface DocViewerProps {
  document: MarkdownDocument | null
  allDocs: Record<string, MarkdownDocument>
  onNavigateWikilink: (target: string, intent: OpenIntent) => void
  /**
   * Opens a document by path — for ordinary `[text](Other.md)` links, which resolve to
   * a path rather than to a wikilink target.
   *
   * Separate from `onNavigateWikilink` because that one creates the document when the
   * target does not exist, and a path is not a name to create anything from.
   */
  onNavigatePath: (path: string, intent: OpenIntent) => void
  /**
   * The document's body.
   *
   * Passed in rather than read from `document.content`, which the index no longer
   * carries: bodies were 81% of a 4.68 MB index at 2,000 documents
   * (docs/phase-4-scale.md). Null while it is being fetched.
   */
  body: string | null
  loading?: boolean
  error?: string | null
  /**
   * Where this document was left, and where to report it going.
   *
   * A getter rather than a value so the offset can live in a ref in the parent:
   * scrolling must not re-render the workspace, and reading a ref during render is
   * exactly what it is not for.
   */
  scrollFor?: (path: string) => number
  onScroll?: (path: string, top: number) => void
  /** Folder tree of the active grimoire; feeds the page menu's Move-to picker. */
  tree: FileTreeNode[]
  /** Page-level actions exposed via the `⋯` menu. */
  pageMenu?: {
    onCopy: () => void
    onDuplicate: () => void
    onMoveTo: (destDir: string) => void
    onTrash: () => void
    onSetView: (view: 'small' | 'full') => void
    onSetWidth: (width: 'full' | 'default') => void
    isLocked: boolean
    onLock?: (passphrase: string) => void
    onUnlock?: () => void
    onImport?: (files: File[]) => void
    onExport?: () => void
  } | null
}

export function DocViewer({
  document,
  allDocs,
  onNavigateWikilink,
  onNavigatePath,
  body,
  loading,
  error,
  scrollFor,
  onScroll,
  tree,
  pageMenu,
}: DocViewerProps) {
  const articleRef = useRef<HTMLElement>(null)
  /** The document this mount has already placed. Restoring twice would fight the reader. */
  const placedFor = useRef<string | null>(null)
  const path = document?.path ?? null
  /** The picture the viewer is showing, if any. Declared with the other hooks so the
      early returns below cannot change the hook order. */
  const [viewing, setViewing] = useState<ViewedImage | null>(null)

  /**
   * Puts the reader back where they were, once there is something to scroll.
   *
   * Guarded by `placedFor` because `body` also changes when a document is re-read
   * underneath — focusing a tab revalidates it — and applying the stored offset again
   * on that would yank the page out from under whoever is reading it.
   */
  useEffect(() => {
    const article = articleRef.current
    if (!article || !path || body === null) return
    if (placedFor.current === path) return
    placedFor.current = path
    article.scrollTop = scrollFor?.(path) ?? 0
  }, [path, body, scrollFor])
  // Rewrites [[wikilinks]] into links the Markdown renderer understands.
  // Runs before the empty-state return so the hook order never changes.
  // `stripBlockComments` runs first so a hidden `<!-- mkf:b:... -->` at
  // the end of a paragraph does not leak into the rendered output.
  const processedContent = useMemo(
    () => (body ? linkifyWikilinks(stripBlockComments(body)) : ''),
    [body]
  )

  if (!document) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-8 text-muted-foreground">
        <div className="text-center">
          <FileText className="mx-auto size-12 stroke-[1.5] text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">Select a document from the sidebar to view</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-8">
        <div className="max-w-md rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Could not load this document.</p>
          <p className="mt-1 text-xs opacity-80">{error}</p>
        </div>
      </div>
    )
  }

  const dates = documentDates(document)
  // `view: small` narrows the reading column. `width: full` widens it.
  // Both come from the page menu via frontmatter; the viewer only
  // changes the layout container, never the prose styling, so the
  // editor is unaffected.
  const view = frontmatterView(document.frontmatter)
  const width = frontmatterWidth(document.frontmatter)
  const maxWidth = width === 'full'
    ? 'max-w-5xl'
    : view === 'small'
      ? 'max-w-2xl'
      : 'max-w-3xl'

  return (
    <article
      ref={articleRef}
      onScroll={(event) => path && onScroll?.(path, event.currentTarget.scrollTop)}
      className="relative flex-1 overflow-y-auto px-8 py-10"
    >
      <div className={cn('mx-auto space-y-6', maxWidth)}>
        {pageMenu ? (
          <div className="flex justify-end">
            <PageMenu
              document={document}
              body={body}
              tree={tree}
              onCopy={pageMenu.onCopy}
              onDuplicate={pageMenu.onDuplicate}
              onMoveTo={pageMenu.onMoveTo}
              onTrash={pageMenu.onTrash}
              onSetView={pageMenu.onSetView}
              onSetWidth={pageMenu.onSetWidth}
              isLocked={pageMenu.isLocked}
              onLock={pageMenu.onLock}
              onUnlock={pageMenu.onUnlock}
              onImport={pageMenu.onImport}
              onExport={pageMenu.onExport}
            />
          </div>
        ) : null}
        <Breadcrumb current={document} allDocs={allDocs} onNavigate={onNavigatePath} />

        {/* Header Metadata */}
        <div className="border-b pb-6">
          <h1 className="font-serif text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            {document.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            {/*
              The creation date when the document carries one, and only then the last
              edit. This line used to be `updatedAt` unconditionally, which was both
              the least stable date available and — until the store stopped restamping
              it on every read — one that changed simply because the document had been
              opened. The tooltip still carries both.
            */}
            {dates && (
              <span className="flex items-center gap-1" title={dates.detail}>
                <Calendar className="size-3.5" />
                {dates.label}
              </span>
            )}
            {Boolean(document.frontmatter.tags) && (
              <span className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono">
                <Hash className="size-3" />
                {String(document.frontmatter.tags)}
              </span>
            )}
          </div>
        </div>

        {/*
          The body is fetched, so there is a moment where the title is on screen and
          the prose is not. A skeleton rather than a spinner: the heading and metadata
          above are already real, and swapping a spinner for text moves the page.
        */}
        {loading && body === null && (
          <div className="space-y-3" aria-busy="true" aria-label="Loading document">
            {[
              'w-full', 'w-11/12', 'w-4/5', 'w-full', 'w-3/5',
            ].map((width, i) => (
              <div key={i} className={cn('h-4 animate-pulse rounded bg-muted', width)} />
            ))}
          </div>
        )}

        {/* Markdown Body Content */}
        <div className="prose prose-neutral dark:prose-invert max-w-none prose-headings:font-serif prose-a:no-underline">
          <ReactMarkdown
            /*
              Notion-style lines: a single newline inside a paragraph becomes a
              visible break, instead of being folded into a space like strict
              CommonMark does.
            */
            remarkPlugins={[remarkGfm, remarkBreaks, remarkBlockColor(body ?? '')]}
            /*
              Gives every heading an id, which is what the outline scrolls to. It uses
              github-slugger, the same thing lib/markdown/headings.ts uses to work out
              where a click should land — one algorithm, so the two cannot disagree.
            */
            rehypePlugins={[rehypeSlug]}
            /*
              Lets the app's own `wikilink:` scheme through the URL sanitizer, and
              defers to react-markdown's default for everything else.

              This is the whole reason wikilinks in the reading view opened a blank
              browser tab instead of the document: `defaultUrlTransform` blanks any
              scheme outside http/https/irc/ircs/mailto/xmpp, so every wikilink
              arrived here with `href=""`, the branch below never matched it, and the
              anchor fell through to the external-link case. The exemption is narrow
              on purpose — see lib/markdown/wikilink-href.ts.
            */
            urlTransform={(url) => (isWorkspaceHref(url) ? url : defaultUrlTransform(url))}
            components={{
              /*
                Fenced code, with its language named, coloured by the same grammars the
                editor uses, and copyable. See code-block.tsx.
              */
              pre: ({ node, children }) => codeBlockFromNode(node, children),
              /*
                A document holds a vault-relative path — `assets/2026/…png`, exactly
                what Obsidian or a git checkout resolves — so it has to be mapped to
                something a browser can fetch. `resolveImageSrc` is the same function
                the editor uses; a second copy of the rule would drift, and the symptom
                would be an image that renders in one view and not the other.
              */
              img: ({ src, alt }) => (
                <ViewableImage
                  src={typeof src === 'string' ? resolveImageSrc(src) : undefined}
                  source={typeof src === 'string' ? src : undefined}
                  alt={alt ?? ''}
                  onOpen={setViewing}
                />
              ),
              a: ({ href, children }) => {
                const rawTarget = parseWikilinkHref(href)
                if (rawTarget !== null) {
                  // The same resolver navigation uses, so a link that looks resolved
                  // always goes somewhere and a ghost is always really a ghost.
                  const isResolved = isResolvable(rawTarget, allDocs)

                  return (
                    <button
                      type="button"
                      {...openHandlers((intent) => onNavigateWikilink(rawTarget, intent))}
                      className={cn(
                        'inline-flex items-center font-medium transition-colors border-b px-0.5',
                        isResolved
                          ? 'border-primary text-primary hover:bg-primary/10'
                          : 'border-dashed border-muted-foreground/60 text-muted-foreground/80 hover:text-foreground hover:border-foreground'
                      )}
                      title={
                        isResolved
                          ? `Jump to ${rawTarget} — Ctrl/Cmd-click to open in a new tab`
                          : `Create "${rawTarget}" — this link has no document yet`
                      }
                    >
                      {children}
                      {!isResolved && <span className="ml-0.5 text-[10px] opacity-60">👻</span>}
                    </button>
                  )
                }

                /*
                  Everything that is not a wikilink. A vault is full of ordinary
                  CommonMark links between its own documents — that is what a note
                  written in Obsidian or edited in vim looks like — and every one of
                  them used to be handed to `target="_blank"`. The browser then tried
                  to open `Other Note.md` as a URL: a new browser tab, outside the
                  workspace, showing nothing. Only links that really do point at the
                  web leave the app now.
                */
                const destination = classifyHref(href ?? '', path, allDocs)

                if (destination.kind === 'anchor') {
                  return (
                    <a
                      href={href}
                      onClick={(event) => {
                        // The article scrolls, not the window, so the default jump
                        // does nothing useful here — and it would put a fragment in
                        // the address bar of an app that has no per-document URL.
                        event.preventDefault()
                        const heading = articleRef.current?.querySelector<HTMLElement>(
                          `#${CSS.escape(destination.hash)}`
                        )
                        heading?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }}
                      className={LINK}
                    >
                      {children}
                    </a>
                  )
                }

                if (destination.kind === 'document') {
                  const { path: target } = destination
                  return (
                    <button
                      type="button"
                      {...openHandlers((intent) => onNavigatePath(target, intent))}
                      className={cn(LINK, 'cursor-pointer')}
                      title={`Open ${target} — Ctrl/Cmd-click to open in a new tab`}
                    >
                      {children}
                    </button>
                  )
                }

                if (destination.kind === 'missing') {
                  // A relative link with nothing behind it is the same thing an
                  // unresolved `[[…]]` is, and is offered the same way out.
                  const { target } = destination
                  return (
                    <button
                      type="button"
                      {...openHandlers((intent) => onNavigateWikilink(target, intent))}
                      className="inline-flex cursor-pointer items-center border-b border-dashed border-muted-foreground/60 px-0.5 font-medium text-muted-foreground/80 transition-colors hover:border-foreground hover:text-foreground"
                      title={`Create "${target}" — this link has no document yet`}
                    >
                      {children}
                      <span className="ml-0.5 text-[10px] opacity-60">👻</span>
                    </button>
                  )
                }

                /*
                  An href the sanitizer blanked — a `javascript:` URL, or any other
                  scheme it refuses. Rendered as text rather than as an anchor:
                  `<a href="" target="_blank">` is a control that opens a new browser
                  tab onto this very page, which is the most confusing thing it could
                  possibly do with a link that was rejected for being unsafe.
                */
                if (!destination.href) return <>{children}</>

                return (
                  <a href={destination.href} target="_blank" rel="noopener noreferrer" className={LINK}>
                    {children}
                  </a>
                )
              },
            }}
          >
            {processedContent}
          </ReactMarkdown>
        </div>

        {/*
          Child pages section. Renderer-generated, not part of the body — adding
          a child later would otherwise require rewriting the parent. The
          section itself only renders when the document has at least one child,
          so an empty "Child pages" heading never trains the eye to ignore it.
        */}
        <ChildPagesSection parent={document} allDocs={allDocs} onNavigate={onNavigatePath} />
      </div>

      {/*
        Inside the article, but it renders through a portal, so it adds nothing to this
        scroll container and cannot disturb the offset restored above.
      */}
      <ImageLightbox image={viewing} onClose={() => setViewing(null)} />
    </article>
  )
}
