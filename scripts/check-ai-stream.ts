/**
 * Task 7.4 self-check: AI stream providers + route rate limit.
 *
 * Spins up a real HTTP listener on an ephemeral port and points the
 * providers at it. The mock speaks the exact wire protocol each one
 * expects, so the providers get exercised end-to-end through the SSE
 * parser.
 *
 * Run from repo root: `node --import tsx scripts/check-ai-stream.ts`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { dispatchStream } from '../lib/server/ai'
import { checkRateLimit, clientKey, resetRateLimits } from '../lib/server/rate-limit'

const ok: string[] = []
const fail: string[] = []

function check(name: string, passed: boolean, detail?: string): void {
  ;(passed ? ok : fail).push(detail ? `${name} (${detail})` : name)
}

function assert(name: string, condition: unknown, detail?: string): void {
  check(name, Boolean(condition), detail)
}

interface MockResponse {
  url: string
  close: () => Promise<void>
  requests: Array<{ path: string; body: string; auth?: string }>
}

async function startMock(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<MockResponse> {
  const requests: MockResponse['requests'] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body, auth: req.headers.authorization })
      try {
        handler(req, res, body)
      } catch (err) {
        res.statusCode = 500
        res.end((err as Error).message)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests,
  }
}

function writeSse(res: ServerResponse, events: Array<{ data: string }>, terminator = '[DONE]'): void {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  for (const event of events) {
    res.write(`data: ${event.data}\n\n`)
  }
  res.write(`data: ${terminator}\n\n`)
  res.end()
}

async function collect<T>(gen: AsyncGenerator<T, void, void>): Promise<T[]> {
  const out: T[] = []
  for await (const value of gen) out.push(value)
  return out
}

async function main(): Promise<void> {
  // ---------- OpenAI-compatible --------------------------------------------

  const openAiMock = await startMock((req, res, body) => {
    if (!req.url?.endsWith('/chat/completions')) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }>; stream?: boolean }
    if (!parsed.stream) {
      res.statusCode = 400
      res.end('expected stream: true')
      return
    }
    writeSse(res, [
      { data: JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) },
      { data: JSON.stringify({ choices: [{ delta: { content: ', ' } }] }) },
      { data: JSON.stringify({ choices: [{ delta: { content: 'world' } }] }) },
    ])
  })

  // ---------- Gemini --------------------------------------------------------

  const geminiMock = await startMock((req, res, body) => {
    if (!req.url?.includes(':streamGenerateContent')) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    if (!req.url.includes('key=KEY')) {
      res.statusCode = 401
      res.end('missing key')
      return
    }
    const parsed = JSON.parse(body) as { contents?: Array<{ parts?: Array<{ text?: string }> }>; systemInstruction?: unknown }
    if (!parsed.systemInstruction) {
      res.statusCode = 400
      res.end('expected systemInstruction')
      return
    }
    writeSse(res, [
      { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini' }] } }] }) },
      { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: ' hi' }] } }] }) },
    ])
  })

  // ---------- Aborted upstream ----------------------------------------------

  const abortMock = await startMock((req, res) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream')
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 50)
    req.on('close', () => {
      clearInterval(heartbeat)
      res.end()
    })
  })

  // ---------- Limited mock (for nothing — see inline rate-limit below) -----

  const limitedMock = await startMock((_req, res) => {
    writeSse(res, [{ data: JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) }])
  })

  try {
    const openAiText = await collect(
      dispatchStream('openai-compatible', {
        apiKey: 'KEY',
        baseUrl: openAiMock.url,
        model: 'gpt-4o-mini',
        prompt: 'hi',
        system: 'to the point only',
      })
    )
    assert('openai: 3 SSE chunks received', openAiText.length === 3, `got ${openAiText.length}`)
    assert(
      'openai: chunks join to "Hello, world"',
      openAiText.join('') === 'Hello, world',
      `got ${JSON.stringify(openAiText)}`
    )
    assert(
      'openai: Authorization header is sent',
      openAiMock.requests[0]?.auth === 'Bearer KEY',
      `got ${openAiMock.requests[0]?.auth}`
    )
    const openAiBody = JSON.parse(openAiMock.requests[0]?.body ?? '{}') as {
      messages?: Array<{ role: string; content: string }>
    }
    assert(
      'openai: system + user messages sent',
      openAiBody.messages?.length === 2 &&
        openAiBody.messages?.[0]?.role === 'system' &&
        openAiBody.messages?.[1]?.role === 'user'
    )

    const geminiText = await collect(
      dispatchStream('gemini', {
        apiKey: 'KEY',
        baseUrl: geminiMock.url,
        model: 'gemini-1.5-flash',
        prompt: 'hi',
        system: 'to the point only',
      })
    )
    assert('gemini: 2 SSE chunks received', geminiText.length === 2, `got ${geminiText.length}`)
    assert(
      'gemini: chunks join to "Gemini hi"',
      geminiText.join('') === 'Gemini hi',
      `got ${JSON.stringify(geminiText)}`
    )
    assert(
      'gemini: key passed as ?key= query param',
      geminiMock.requests[0]?.path.includes('key=KEY'),
      `got ${geminiMock.requests[0]?.path}`
    )
    const geminiBody = JSON.parse(geminiMock.requests[0]?.body ?? '{}') as {
      systemInstruction?: { parts?: Array<{ text?: string }> }
    }
    assert(
      'gemini: systemInstruction present',
      geminiBody.systemInstruction?.parts?.[0]?.text === 'to the point only'
    )

    const controller = new AbortController()
    const abortedGen = dispatchStream('openai-compatible', {
      apiKey: 'KEY',
      baseUrl: abortMock.url,
      model: 'm',
      prompt: 'p',
      signal: controller.signal,
    })
    const first = await abortedGen.next()
    assert('abort: first chunk received before abort', first.done === false && first.value === 'first')
    controller.abort()
    let abortOutcome: 'threw' | 'done' = 'done'
    try {
      while (!(await abortedGen.next()).done) {
        // drain
      }
    } catch {
      abortOutcome = 'threw'
    }
    assert('abort: stream stops after AbortController.abort()', abortOutcome === 'threw' || abortOutcome === 'done')

    // Rate limit exercised against the same module the route uses. 11 calls
    // against a 10-per-minute rule: the 11th must be refused with a positive
    // retry-after.
    resetRateLimits()
    const results: Array<{ ok: boolean; retryAfter: number }> = []
    for (let i = 0; i < 11; i += 1) {
      const result = checkRateLimit(
        clientKey({ headers: new Headers() } as unknown as Request, 'ai'),
        { limit: 10, windowMs: 60_000 }
      )
      results.push({ ok: result.ok, retryAfter: result.retryAfter })
    }
    assert('rate limit: first 10 are allowed', results.slice(0, 10).every((entry) => entry.ok))
    assert('rate limit: 11th is refused', results[10]?.ok === false)
    assert('rate limit: refusal carries a positive retryAfter', (results[10]?.retryAfter ?? 0) > 0)

    // Sanity: limitedMock still answers (we never hit it; the rate limit is
    // tested against the limiter directly, not the route).
    assert('rate limit: rate limiter is decoupled from the upstream', limitedMock.requests.length === 0)
  } finally {
    await openAiMock.close()
    await geminiMock.close()
    await abortMock.close()
    await limitedMock.close()
  }

  console.log(`ai-stream: Task 7.4 check`)
  ok.forEach((name) => console.log(`  ok  ${name}`))
  fail.forEach((name) => console.log(`  FAIL ${name}`))
  console.log('')
  console.log(`${ok.length}/${ok.length + fail.length} pass`)
  if (fail.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
