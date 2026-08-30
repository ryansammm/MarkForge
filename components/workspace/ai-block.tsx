'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Loader2, Play, Sparkles, Square, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useVault } from '@/lib/vault/use-vault'
import { getAiConfigs } from '@/lib/vault/ai-config'
import { AiClientError, streamCompletion } from '@/lib/client/ai-stream-client'
import { cn } from '@/lib/utils'

/**
 * Inline AI block.
 *
 * The body is a ` ```ai ` fenced code block with the prompt as its
 * content. After the model answers, the body is rewritten to
 * ` ```ai ` + the prompt + a closing fence and the model output
 * rendered as the visible answer. The whole block survives a save
 * and a reload because it is just Markdown, and the encryption
 * envelope does not need to learn about a new block kind.
 *
 * The block holds `{ configId, prompt, output? }` as a small JSON
 * header on the opening fence so a future reload knows which
 * provider to use, what to ask again, and what the last answer
 * was. The prompt is also the visible text inside the fence so the
 * user can see (and re-edit) it without opening a dialog.
 */
export interface AiBlockProps {
  /** Raw text between the opening ` ```ai ` and the closing ` ``` `. */
  body: string
  /** Optional override; when the fence header carries a configId, the block
   *  picks that one. The fallback is the first provider in the vault. */
  configId?: string
  /** Notified whenever the prompt or output changes, so the editor can
   *  write the new body back to the buffer. */
  onBodyChange?: (next: string) => void
}

export const FENCE_HEADER = /^(\s*```\s*ai\b)([^\n]*)?\n([\s\S]*?)\n?(\s*```\s*)?$/

interface ParsedBody {
  header: string
  configId: string | null
  body: string
}

export function parseBody(raw: string): ParsedBody {
  const m = FENCE_HEADER.exec(raw)
  if (!m) {
    return { header: '```ai', configId: null, body: raw }
  }
  const opening = m[1] ?? '```ai'
  const rest = m[2] ?? ''
  const content = m[3] ?? ''
  const configId = extractJsonField(rest, 'configId')
  return { header: opening, configId, body: content }
}

function extractJsonField(header: string, key: string): string | null {
  const json = header.trim()
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    const value = parsed[key]
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

export function formatHeader(configId: string | null): string {
  if (!configId) return '```ai'
  return '```ai ' + JSON.stringify({ configId })
}

export function AiBlock({ body, configId: initialConfigId, onBodyChange }: AiBlockProps) {
  const parsed = useMemo(() => parseBody(body), [body])
  const vault = useVault(true)
  const configs = useMemo(() => (vault.data ? getAiConfigs(vault.data) : []), [vault.data])
  const activeConfigId = initialConfigId ?? parsed.configId ?? configs[0]?.id ?? null
  const activeConfig = configs.find((entry) => entry.id === activeConfigId) ?? null

  // `lastSeenBody` remembers the last prop body we already mirrored
  // into local state. It is state, not a ref, so the comparison and
  // reset happen as part of the render phase — no effect, no
  // cascading render warning. The cost is a single string compare
  // and an occasional `setPrompt` on a real prop change.
  const [lastSeenBody, setLastSeenBody] = useState(parsed.body)
  const [prompt, setPrompt] = useState(parsed.body)
  const [output, setOutput] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  if (parsed.body !== lastSeenBody) {
    setLastSeenBody(parsed.body)
    setPrompt(parsed.body)
  }

  const persist = useCallback(
    (next: { prompt?: string; output?: string | null }) => {
      if (!onBodyChange) return
      const nextPrompt = next.prompt ?? prompt
      const nextOutput = next.output === undefined ? output : next.output
      const rebuilt = `${formatHeader(activeConfigId)}\n${nextPrompt}${nextOutput ? '\n\n' + nextOutput : ''}\n\`\`\``
      onBodyChange(rebuilt)
    },
    [onBodyChange, prompt, output, activeConfigId]
  )

  const run = useCallback(async () => {
    if (!prompt.trim()) {
      toast.error('Write a prompt first.')
      return
    }
    if (!activeConfig) {
      toast.error('No AI provider configured. Open Settings to add one.')
      return
    }
    if (vault.status !== 'unlocked') {
      toast.error('Unlock the vault to use AI.')
      return
    }

    setError(null)
    setOutput('')
    setStreaming(true)
    persist({ prompt, output: '' })

    const controller = new AbortController()
    controllerRef.current = controller

    try {
      let acc = ''
      for await (const delta of streamCompletion({
        provider: activeConfig.provider,
        baseUrl: activeConfig.baseUrl,
        model: activeConfig.model,
        apiKey: activeConfig.apiKey,
        prompt,
        system: 'to the point only',
        signal: controller.signal,
      })) {
        acc += delta
        setOutput(acc)
        // Don't re-persist on every token — the editor's onChange debounces
        // and a 1k-token response would flood the buffer. Persist once at
        // completion (and once on abort, below).
      }
      persist({ prompt, output: acc })
    } catch (err) {
      if (controller.signal.aborted) {
        // The user hit Stop. Keep whatever tokens arrived.
        if (output && output.length > 0) persist({ prompt, output })
        return
      }
      const message = err instanceof AiClientError ? err.message : (err as Error).message
      setError(message)
      persist({ prompt, output: null })
    } finally {
      setStreaming(false)
      controllerRef.current = null
    }
  }, [activeConfig, persist, prompt, output, vault.status])

  const stop = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  return (
    <div className="my-4 overflow-hidden rounded-lg border bg-card shadow-sm">
      <header className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
          <Sparkles className="size-3.5" />
          AI block
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {activeConfig
            ? `${providerLabel(activeConfig.provider)} · ${activeConfig.model}`
            : 'No provider configured'}
        </span>
      </header>

      <div className="space-y-2 px-3 py-3">
        <textarea
          value={prompt}
          onChange={(event) => {
            const next = event.target.value
            setPrompt(next)
            persist({ prompt: next })
          }}
          placeholder="Ask the model anything. Shift+Enter for a newline."
          rows={Math.max(2, Math.min(8, prompt.split('\n').length + 1))}
          className="w-full resize-y rounded-md border bg-background px-2 py-1.5 font-mono text-sm text-foreground outline-none ring-primary/20 placeholder:text-muted-foreground focus:border-primary focus:ring-2"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void run()
            }
          }}
        />

        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-muted-foreground">
            {!activeConfig
              ? 'Open Settings → AI providers to add one.'
              : streaming
                ? 'Streaming…'
                : output
                  ? 'Last answer is included in the block.'
                  : 'Press Run to start.'}
          </div>
          {streaming ? (
            <button
              type="button"
              onClick={stop}
              className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
            >
              <Square className="size-3" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={!prompt.trim() || !activeConfig}
              className={cn(
                'inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
              )}
            >
              <Play className="size-3" />
              Run
            </button>
          )}
        </div>

        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {output && streaming ? (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm leading-relaxed">
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              receiving
            </span>
            <p className="mt-1 whitespace-pre-wrap font-serif">{output}</p>
          </div>
        ) : output ? (
          <p className="whitespace-pre-wrap rounded-md border bg-muted/30 px-3 py-2 font-serif text-sm leading-relaxed">
            {output}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function providerLabel(provider: string): string {
  if (provider === 'openai-compatible') return 'OpenAI-compatible'
  if (provider === 'gemini') return 'Gemini'
  return provider
}
