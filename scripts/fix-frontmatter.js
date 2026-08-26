/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs')
const path = require('path')

const NOTES_DIR = path.join(process.env.APPDATA, 'MarkForge', 'notes')

function walk(dir) {
  const entries = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) entries.push(...walk(full))
    else if (e.name.endsWith('.md')) entries.push(full)
  }
  return entries
}

function cleanFrontmatter(content) {
  const lines = content.split('\n')
  
  // Find all valid frontmatter delimiters (exactly "---", possibly with leading slash)
  const delimiters = [] // line indices
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const t = lines[i].trim()
    if (t === '---' || t === '/---' || t === '/he---') {
      delimiters.push(i)
    }
  }
  
  if (delimiters.length < 2) return content
  
  // Find pairs: first delimiter must be line 0 or line 1 (allow blank line before)
  let firstOpen = -1
  for (const idx of delimiters) {
    if (idx <= 1) { firstOpen = idx; break }
  }
  if (firstOpen < 0) return content
  
  // Find the LAST closing delimiter (the real one) — it's the last "---" before actual content
  // Actual content starts when we hit a line that's not a delimiter, not empty, and not a key: value
  let lastClose = -1
  for (let i = delimiters.length - 1; i >= 0; i--) {
    const idx = delimiters[i]
    if (idx > firstOpen) {
      // Check if there's real content after this delimiter
      for (let j = idx + 1; j < lines.length; j++) {
        const t = lines[j].trim()
        if (t === '' || t.match(/^[\w-]+\s*:/) || t.match(/^\/?(he)?---$/)) continue
        // Found real content — this delimiter is the closing one
        lastClose = idx
        break
      }
      if (lastClose >= 0) break
    }
  }
  
  if (lastClose < 0) return content
  
  // Collect all frontmatter keys from between firstOpen and lastClose
  const meta = {}
  for (let i = firstOpen + 1; i < lastClose; i++) {
    const m = lines[i].match(/^([\w][\w-]*)\s*:\s*(.+)/)
    if (m) meta[m[1]] = m[2].trim()
  }
  
  // Content starts after the last closing delimiter
  let body = lines.slice(lastClose + 1).join('\n')
  
  // Build clean frontmatter
  const fmLines = ['---']
  const keyOrder = ['id', 'created', 'title', 'tags', 'type', 'status', 'repo', 'section']
  const seen = new Set()
  for (const k of keyOrder) {
    if (meta[k]) { fmLines.push(`${k}: ${meta[k]}`); seen.add(k) }
  }
  for (const [k, v] of Object.entries(meta)) {
    if (!seen.has(k)) fmLines.push(`${k}: ${v}`)
  }
  fmLines.push('---')
  
  // Ensure body starts with newline
  if (body.length > 0 && !body.startsWith('\n')) {
    body = '\n' + body
  }
  
  return fmLines.join('\n') + body
}

const files = walk(NOTES_DIR)
let fixed = 0
let skipped = 0

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8')
  const cleaned = cleanFrontmatter(raw)
  
  if (cleaned !== raw) {
    fs.writeFileSync(f, cleaned, 'utf8')
    console.log(`FIXED: ${path.relative(NOTES_DIR, f)}`)
    fixed++
  } else {
    skipped++
  }
}

console.log(`\nDone. ${fixed} fixed, ${skipped} unchanged.`)
