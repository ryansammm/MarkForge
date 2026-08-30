import { NextRequest } from 'next/server'
import { AI_LIMIT, checkRateLimit, clientKey } from '@/lib/server/rate-limit'
import { captureError, logSecurityEvent } from '@/lib/server/observability'
import { AiStreamError, dispatchStream, type AiProvider } from '@/lib/server/ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Inline AI streaming.
 *
 *   POST /api/ai/stream
 *   body: { provider, baseUrl, model, apiKey, prompt, system? }
 *   → text/event-stream   (each event: `data: <token>` or `data: [DONE]`,
 *                          plus an `event: error` on failure)
 *
 * The API key travels from the browser to the server on every request, so the
 * server is a *relay*, not a credential store. That is the explicit trade:
 * keys never leave the user's vault except as a request body, and the server
 * forwards them to the provider without logging. The route rate-limits per
 * client — the closest thing to "per vault" the server can do without a
 * shared store — and rejects 429 on overflow.
 *
 * No retry, no caching. The provider answers once, the client renders the
 * stream, and a reconnect is a fresh request. A flaky connection is the
 * client's problem to handle.
 */

const MAX_REQUEST_BYTES = 256 * 1024

export async function POST(request: NextRequest) {
  const limit = checkRateLimit(clientKey(request, 'ai'), AI_LIMIT)
  if (!limit.ok) {
    return new Response('Too many AI requests. Slow down and try again.', {
      status: 429,
      headers: { 'Retry-After': String(limit.retryAfter) },
    })
  }

  let body: AiStreamRequest
  try {
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) {
      return new Response('Request body too large', { status: 413 })
    }
    body = JSON.parse(text) as AiStreamRequest
  } catch {
    return new Response('Body is not valid JSON', { status: 400 })
  }

  const validation = validate(body)
  if (validation) return validation

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`${event}: ${data}\n\n`))
      }
      try {
        for await (const delta of dispatchStream(body.provider, {
          apiKey: body.apiKey,
          baseUrl: body.baseUrl,
          model: body.model,
          prompt: body.prompt,
          ...(body.system ? { system: body.system } : {}),
          signal: request.signal,
        })) {
          enqueue('data', delta)
        }
        enqueue('data', '[DONE]')
        controller.close()
      } catch (err) {
        const message = err instanceof AiStreamError ? err.message : (err as Error).message
        captureError(err, { scope: 'api/ai/stream', event: 'stream-failed' })
        logSecurityEvent('ai-stream-failed', { provider: body.provider, message })
        enqueue('event', 'error')
        enqueue('data', JSON.stringify({ error: message }))
        controller.close()
      }
    },
    cancel() {
      // The reader is already gone; the AbortSignal on `request` will tell the
      // upstream fetch to stop, which is the only thing left to do.
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

interface AiStreamRequest {
  provider: AiProvider
  baseUrl: string
  model: string
  apiKey: string
  prompt: string
  system?: string
}

function validate(body: AiStreamRequest): Response | null {
  if (!body || typeof body !== 'object') {
    return new Response('Body must be an object', { status: 400 })
  }
  if (body.provider !== 'openai-compatible' && body.provider !== 'gemini') {
    return new Response('Unknown provider', { status: 400 })
  }
  if (typeof body.baseUrl !== 'string' || !body.baseUrl.startsWith('http')) {
    return new Response('baseUrl must be an http(s) URL', { status: 400 })
  }
  if (typeof body.model !== 'string' || !body.model) {
    return new Response('model is required', { status: 400 })
  }
  if (typeof body.apiKey !== 'string' || !body.apiKey) {
    return new Response('apiKey is required', { status: 400 })
  }
  if (typeof body.prompt !== 'string' || !body.prompt) {
    return new Response('prompt is required', { status: 400 })
  }
  if (body.system !== undefined && typeof body.system !== 'string') {
    return new Response('system must be a string when present', { status: 400 })
  }
  return null
}
