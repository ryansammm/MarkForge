/**
 * AI provider streams.
 *
 * Two providers today. Each returns an `AsyncIterable<string>` of text deltas —
 * the caller assembles the SSE stream, not the providers. The split is deliberate:
 * the providers know their wire protocol, the route knows the server boundary, and
 * neither has to care about the other.
 *
 * Both providers are best-effort token streams. The first error in the upstream
 * fetch (DNS, 4xx, 5xx) is thrown synchronously through the async iterator so the
 * caller can render it; a mid-stream error is signalled by the iterator returning
 * — the next `next()` call is the one that throws, which is the moment the route
 * has already written something, so there is no body to drop.
 *
 * `system` is the only system instruction; the prompt goes through as a `user`
 * turn. The task-8 system prompt "to the point only" lives in the client, not
 * here, because the editor is the only one that knows what a "point" is.
 */

export type AiProvider = 'openai-compatible' | 'gemini'

export interface StreamOptions {
  apiKey: string
  baseUrl: string
  model: string
  prompt: string
  system?: string
  /** Temperature; providers default to 0.2 if not set. */
  temperature?: number
  signal?: AbortSignal
}

export class AiStreamError extends Error {
  constructor(
    message: string,
    readonly provider: AiProvider,
    readonly upstream?: { status?: number; body?: string }
  ) {
    super(message)
    this.name = 'AiStreamError'
  }
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

/**
 * OpenAI-compatible chat/completions streaming.
 *
 * Works against any endpoint that speaks the protocol — the OpenAI one, the
 * vLLM one, the LM Studio one, the `?alt=sse` shimmed Gemini one, etc. The base
 * URL is what the caller hands us, and the caller is the one who decided it.
 */
export async function* streamOpenAI(options: StreamOptions): AsyncGenerator<string, void, void> {
  if (!options.apiKey) throw new AiStreamError('Missing API key', 'openai-compatible')
  if (!options.model) throw new AiStreamError('Missing model', 'openai-compatible')
  if (!options.prompt) throw new AiStreamError('Missing prompt', 'openai-compatible')

  const url = joinUrl(options.baseUrl, '/chat/completions')
  const body = {
    model: options.model,
    stream: true,
    temperature: options.temperature ?? 0.2,
    messages: [
      ...(options.system ? [{ role: 'system', content: clamp(options.system, 32_000) }] : []),
      { role: 'user', content: clamp(options.prompt, 64_000) },
    ],
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })

  if (!response.ok) {
    const text = await safeText(response)
    throw new AiStreamError(
      `OpenAI-compatible request failed (${response.status})`,
      'openai-compatible',
      { status: response.status, body: text }
    )
  }

  yield* parseSse(response, (data) => extractOpenAiDelta(data))
}

/**
 * Gemini streaming.
 *
 * Gemini's streaming endpoint lives at
 * `{baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse&key={key}`.
 * The API key is a query parameter, not a header, because that's the shape
 * Google's REST surface decided on. The body shape is Gemini's own, with
 * `contents` and a `systemInstruction` block.
 */
export async function* streamGemini(options: StreamOptions): AsyncGenerator<string, void, void> {
  if (!options.apiKey) throw new AiStreamError('Missing API key', 'gemini')
  if (!options.model) throw new AiStreamError('Missing model', 'gemini')
  if (!options.prompt) throw new AiStreamError('Missing prompt', 'gemini')

  const url = new URL(joinUrl(options.baseUrl, `/v1beta/models/${encodeURIComponent(options.model)}:streamGenerateContent`))
  url.searchParams.set('alt', 'sse')
  url.searchParams.set('key', options.apiKey)

  const body = {
    contents: [{ role: 'user', parts: [{ text: clamp(options.prompt, 64_000) }] }],
    ...(options.system
      ? { systemInstruction: { role: 'system', parts: [{ text: clamp(options.system, 32_000) }] } }
      : {}),
    generationConfig: { temperature: options.temperature ?? 0.2 },
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: options.signal,
  })

  if (!response.ok) {
    const text = await safeText(response)
    throw new AiStreamError(`Gemini request failed (${response.status})`, 'gemini', {
      status: response.status,
      body: text,
    })
  }

  yield* parseSse(response, (data) => extractGeminiDelta(data))
}

export function dispatchStream(
  provider: AiProvider,
  options: StreamOptions
): AsyncGenerator<string, void, void> {
  if (provider === 'gemini') return streamGemini(options)
  return streamOpenAI(options)
}

/** Joins a base URL and a path, tolerating a trailing slash on the base. */
function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return `${trimmed}${path}`
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2_000)
  } catch {
    return ''
  }
}

/**
 * Reads an `text/event-stream` response and yields parsed `data:` lines.
 *
 * `extract` is given the raw data line (the JSON payload, or `[DONE]`) and
 * returns the text delta to forward, or `null` to skip. The format is the
 * standard one: lines prefixed with `data:`, separated from the next event
 * by a blank line, with a `data: [DONE]` terminator.
 */
async function* parseSse(
  response: Response,
  extract: (data: string) => string | null
): AsyncGenerator<string, void, void> {
  if (!response.body) throw new AiStreamError('Upstream returned no body', 'openai-compatible')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Split on the SSE event boundary (a blank line).
      let boundary: number
      // ponytail: O(n^2) string search. Fine — SSE chunks are KB at most and a
      // production user gets a few hundred events per response.
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const delta = parseSseEvent(event, extract)
        if (delta !== null) yield delta
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Already released; the abort path closes the stream and the lock with it.
    }
  }
}

function parseSseEvent(event: string, extract: (data: string) => string | null): string | null {
  let data: string | null = null
  for (const line of event.split('\n')) {
    if (line.startsWith('data:')) {
      const chunk = line.slice(5).trimStart()
      data = data === null ? chunk : data + '\n' + chunk
    }
  }
  if (data === null) return null
  if (data === '[DONE]') return null
  return extract(data)
}

function extractOpenAiDelta(data: string): string | null {
  let parsed: { choices?: Array<{ delta?: { content?: unknown } }> }
  try {
    parsed = JSON.parse(data) as typeof parsed
  } catch {
    return null
  }
  const content = parsed.choices?.[0]?.delta?.content
  return typeof content === 'string' ? content : null
}

function extractGeminiDelta(data: string): string | null {
  let parsed: { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }
  try {
    parsed = JSON.parse(data) as typeof parsed
  } catch {
    return null
  }
  const parts = parsed.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return null
  let combined = ''
  for (const part of parts) {
    if (typeof part?.text === 'string') combined += part.text
  }
  return combined || null
}
