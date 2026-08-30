/**
 * Browser-side AI stream client.
 *
 * Posts to `/api/ai/stream` and yields text deltas. Mirrors the `EventSource`
 * shape but on `fetch` + `ReadableStream`, because `EventSource` cannot set
 * request bodies and cannot send an `Authorization` header. Both matter here:
 * the API key is the auth, the body is the prompt.
 *
 * Abort is wired through `AbortController`; cancelling the controller aborts
 * the fetch, which aborts the upstream call on the server (the server route
 * passes `request.signal` to `fetch`).
 */
import type { AiProvider } from '@/lib/server/ai'

export interface StreamClientOptions {
  provider: AiProvider
  baseUrl: string
  model: string
  apiKey: string
  prompt: string
  system?: string
  signal?: AbortSignal
}

export class AiClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'AiClientError'
  }
}

/**
 * Streams the response as text deltas.
 *
 * Each yield is one SSE `data:` payload (already stripped of the prefix and
 * decoded). The terminator is `data: [DONE]`, which surfaces as a single
 * `[DONE]` string from this generator — callers can stop on that sentinel
 * or use the `complete()` helper below, which loops until the stream ends.
 */
export async function* streamCompletion(
  options: StreamClientOptions
): AsyncGenerator<string, void, void> {
  const response = await fetch('/api/ai/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: options.provider,
      baseUrl: options.baseUrl,
      model: options.model,
      apiKey: options.apiKey,
      prompt: options.prompt,
      ...(options.system ? { system: options.system } : {}),
    }),
    signal: options.signal,
    cache: 'no-store',
    credentials: 'same-origin',
  })

  if (!response.ok) {
    const text = await safeText(response)
    throw new AiClientError(
      `AI stream request failed (${response.status}): ${text || 'no body'}`,
      response.status
    )
  }

  if (!response.body) throw new AiClientError('AI stream returned no body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = extractSseData(event)
        if (data === null) continue
        if (data === '[DONE]') return
        yield data
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Aborted mid-read; the lock is already gone.
    }
  }
}

/**
 * Convenience: collect the full response.
 *
 * Slightly more than a `for await` loop because callers usually want both the
 * accumulated text and a way to know whether they were rate-limited. The
 * thrown `AiClientError` carries the status, which is the only signal that
 * distinguishes "the model is being slow" from "stop, you hit the limit".
 */
export async function complete(options: StreamClientOptions): Promise<string> {
  let out = ''
  for await (const delta of streamCompletion(options)) {
    out += delta
  }
  return out
}

function extractSseData(event: string): string | null {
  let data: string | null = null
  for (const line of event.split('\n')) {
    if (line.startsWith('data:')) {
      const chunk = line.slice(5).trimStart()
      data = data === null ? chunk : data + '\n' + chunk
    } else if (line.startsWith('event:') && line.slice(6).trim() === 'error') {
      // The server route uses a separate `event:` line for failures so the
      // text token after it is the error JSON, not a model output.
      return `__error__:${data ?? ''}`
    }
  }
  return data
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1_000)
  } catch {
    return ''
  }
}
