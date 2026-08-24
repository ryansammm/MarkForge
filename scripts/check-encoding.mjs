#!/usr/bin/env node
/**
 * Encoding gate: fails when a source file carries mojibake or a BOM.
 *
 * This repository has been bitten repeatedly by PowerShell 5.1 round-trips -
 * Get-Content/Set-Content decode UTF-8 as the system ANSI codepage, so em-dashes,
 * ellipses and âŒ˜ turn into garbage that then ships to users. The fix
 * is to never round-trip source through PowerShell (edit via node fs APIs), and
 * this gate, so that even if it happens again the commit is rejected.
 *
 * Detected patterns:
 *   - U+FFFD replacement character (something was already lost)
 *   - UTF-8 byte pairs misdecoded as single Latin-1 chars (C3/A2/E2 lead bytes followed
 *     by punctuation-range code points) - the signature of an ANSI re-decode
 *   - UTF-8/UTF-16 BOM at file start (breaks Turbopack and JSON.parse)
 *
 * Scans every text source in the repo except vendored/build directories. Notes
 * content (*.md under notes/) is user data and deliberately excluded - writers
 * may type whatever they like.
 */

import fs from 'node:fs'
import path from 'node:path'

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.json'])
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'out', 'build'])

const MOJIBAKE =
  /[\u00c3][\u0080-\u00bf]|[\u00e2][\u0080-\u009f\u00c2\u20ac\u201a]|[\u00c2][\u0080-\u00bf]|\uFFFD/

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (EXTENSIONS.has(path.extname(entry.name))) files.push(full)
  }
  return files
}

const failures = []
for (const file of walk('.', [])) {
  const raw = fs.readFileSync(file)
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    failures.push(`${file}: starts with a UTF-8 BOM`)
    continue
  }
  if ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff)) {
    failures.push(`${file}: UTF-16 encoding detected - rewrite as UTF-8 without BOM`)
    continue
  }
  const text = raw.toString('utf8')
  const match = text.match(MOJIBAKE)
  if (match) {
    const at = match.index
    failures.push(
      `${file}: mojibake near "${text.slice(Math.max(0, at - 25), at + 30).replace(/\r?\n/g, ' ')}"`
    )
  }
}

if (failures.length > 0) {
  console.error(`Encoding check FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  console.error(
    '\nFix by rewriting the file as clean UTF-8 without BOM, e.g. via node:\n' +
      "  [System.IO.File]::WriteAllText(path, text, new System.Text.UTF8Encoding($false))\n" +
      'Never read/write sources with PowerShell Get-Content/Set-Content.'
  )
  process.exit(1)
}
console.log(`encoding check passed (${walk('.', []).length} files scanned)`)
