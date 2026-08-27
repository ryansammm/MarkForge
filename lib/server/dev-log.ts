/**
 * Dev-only file logger.
 *
 * Writes to `.next/dev.log` in dev mode so you can tail it and see what's
 * happening without polluting production logs. Disabled in production.
 */

import * as fs from 'fs'
import * as path from 'path'

const LOG_FILE = path.join(process.cwd(), '.next', 'dev.log')
let stream: fs.WriteStream | null = null

function getStream(): fs.WriteStream {
  if (!stream) {
    try {
      const dir = path.dirname(LOG_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      stream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
    } catch {
      // Fallback to console if file logging fails
      stream = null
      return null!
    }
  }
  return stream
}

function write(level: string, scope: string, event: string, data?: Record<string, unknown>) {
  if (process.env.NODE_ENV !== 'development') return

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    event,
    ...data,
  })

  // Console output with color
  const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m'
  console.log(`${color}[DEV LOG]\x1b[0m ${line}`)

  // File output
  const s = getStream()
  if (s) s.write(line + '\n')
}

export const devLog = {
  info: (scope: string, event: string, data?: Record<string, unknown>) =>
    write('info', scope, event, data),
  warn: (scope: string, event: string, data?: Record<string, unknown>) =>
    write('warn', scope, event, data),
  error: (scope: string, event: string, data?: Record<string, unknown>) =>
    write('error', scope, event, data),
  /** Flush and close the log file (call on process exit). */
  close: () => {
    if (stream) {
      stream.end()
      stream = null
    }
  },
}
