'use client'

import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { highlightCode, languageLabel, type HighlightedCode } from './code-highlight'
import { AiBlock } from './ai-block'

/**
 * A fenced code block, the way a reader expects one.
 *
 * Three things the plain `<pre><code>` it replaces did not do: say what language the
 * block is in, colour it, and let you take it. The last is the one people actually
 * come for — a command in a runbook is there to be run, and selecting it by hand out
 * of a scrolling block is the step where the trailing newline goes missing.
 *
 * Used by the workspace's reading view and by the public share page, so a shared
 * document reads the same way it does inside the app.
 */

interface CodeBlockProps {
  code: string
  /** The fence's info string — `sql` in ` ```sql `. Empty for an untagged fence. */
  language: string
}

/** How long the button stays confirmed before going back to offering the copy. */
const COPIED_MS = 2000

/** A parse, remembered together with the code it was a parse *of*. */
interface Parsed {
  code: string
  language: string
  result: HighlightedCode | null
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  /*
    A stale parse is discarded here rather than cleared in the effect below. Clearing
    it there would be a setState in an effect body — a second render for every block
    on every document — and this says the same thing without one: a parse belongs to
    the text it came from, and text it did not come from simply renders plain.
  */
  const highlighted =
    parsed && parsed.code === code && parsed.language === language ? parsed.result : null

  /*
    Parsed after the block is already on screen, never before it. The grammar is a
    dynamic import, so waiting for it would mean a document with code in it renders
    later than one without — for a decoration. The plain text is correct in the
    meantime and the colours arrive over the top of it.
  */
  useEffect(() => {
    let cancelled = false

    void highlightCode(code, language).then((result) => {
      if (!cancelled) setParsed({ code, language, result })
    })

    return () => {
      cancelled = true
    }
  }, [code, language])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopyFailed(false)
      setCopied(true)
    } catch {
      // No clipboard permission, or an insecure origin. Saying so beats a button that
      // silently does nothing — the reader can still select the text themselves.
      setCopyFailed(true)
    }
  }

  const label = highlighted?.label ?? languageLabel(language)

  return (
    <figure className="not-prose my-5 overflow-hidden rounded-lg border bg-muted/40">
      <figcaption className="flex items-center justify-between gap-2 border-b bg-muted/60 px-3 py-1.5">
        <span className="truncate font-mono text-[11px] font-medium tracking-wide text-muted-foreground">
          {label}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          // The label carries the state as well as the action, because the icon alone
          // does not reach anyone using a screen reader.
          aria-label={copied ? 'Copied to the clipboard' : `Copy this ${label} snippet`}
          title={copyFailed ? 'This browser would not give access to the clipboard' : 'Copy'}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors',
            copied
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-muted-foreground hover:bg-background hover:text-foreground',
            copyFailed && 'text-destructive'
          )}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          <span>{copied ? 'Copied' : copyFailed ? 'Blocked' : 'Copy'}</span>
        </button>
      </figcaption>

      {/*
        `overflow-x-auto` on the scroller and `whitespace-pre` inside it: a long line
        scrolls within the block rather than widening the page. A document that scrolls
        sideways because of one code sample is the failure this guards against.
      */}
      <div className="overflow-x-auto">
        <pre className="px-3 py-3 text-[13px] leading-relaxed">
          <code className="font-mono whitespace-pre">
            {highlighted
              ? highlighted.tokens.map((token, index) => (
                  <span key={index} className={token.className || undefined}>
                    {token.text}
                  </span>
                ))
              : code}
          </code>
        </pre>
      </div>
    </figure>
  )
}

/**
 * The `pre` renderer for react-markdown.
 *
 * Replaces the whole `<pre>` rather than the `<code>` inside it, for two reasons: an
 * untagged fence produces a `<code>` with no className and would otherwise be
 * indistinguishable from inline code, and returning a `<figure>` from the `code`
 * renderer would nest it inside a `<pre>` that is still there.
 *
 * The hast node is read rather than the React children: it carries the fence's text
 * verbatim, which is what the copy button has to put on the clipboard. Reconstructing
 * it from rendered children would mean reassembling a string the renderer has already
 * split up.
 */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

export function codeBlockFromNode(node: unknown, fallback: React.ReactNode): React.ReactNode {
  const pre = node as HastNode | undefined
  const code = pre?.children?.find((child) => child.type === 'element' && child.tagName === 'code')
  if (!code) return <pre>{fallback}</pre>

  const text = (code.children ?? [])
    .filter((child) => child.type === 'text')
    .map((child) => child.value ?? '')
    .join('')

  // `language-sql`, as rehype writes a fence's info string.
  const classes = Array.isArray(code.properties?.className)
    ? (code.properties.className as unknown[]).filter((c): c is string => typeof c === 'string')
    : []
  const language = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? ''

  // The trailing newline every fence carries is the renderer's, not the author's.
  // Copying it would paste an extra blank line into a terminal.
  const cleanText = text.replace(/\n$/, '')

  if (language === 'ai') {
    return <AiBlock body={cleanText} />
  }

  return <CodeBlock code={cleanText} language={language} />
}
