/**
 * One runnable self-check for the notion-parity Task 1 wiring:
 *   - `Enter` keymap entry that splits a non-empty block and
 *     falls through on an empty block.
 *   - `Shift-Enter` keymap entry that inserts a markdown hard break
 *     (`  \n`).
 *   - `<!-- mkf:b:... -->` block-id comments hidden in the editor
 *     via `hide-md-syntax.ts`.
 *   - `empty-block-placeholder` extension renders `.mkf-empty-hint`
 *     only on the focused active line.
 *
 *     npx tsx scripts/check-empty-block.ts
 *
 * Source-grep based: the keymap handlers are inside a closure and not
 * exported, so we verify the wiring by reading the file. Catches
 * regressions where the handler gets dropped, the key changes, or the
 * empty-line no-op disappears.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const editorPath = join(root, 'components/workspace/markdown-editor.tsx')
const hidePath = join(root, 'components/workspace/hide-md-syntax.ts')
const placeholderPath = join(
  root,
  'components/workspace/empty-block-placeholder.ts'
)
const cssPath = join(root, 'app/globals.css')

const editor = readFileSync(editorPath, 'utf8')
const hide = readFileSync(hidePath, 'utf8')
const placeholder = readFileSync(placeholderPath, 'utf8')
const css = readFileSync(cssPath, 'utf8')

/** Return the substring that follows the first occurrence of `needle`
 *  up to (and not including) the next top-level `},` that closes a
 *  keymap entry. `limit` chars max so a runaway regex doesn't span
 *  half the file. */
function handlerBody(source: string, keyNeedle: string, limit = 30): string {
  const idx = source.indexOf(keyNeedle)
  if (idx < 0) return ''
  const tail = source.slice(idx, idx + limit * 80)
  return tail
}

// 1. `Enter` keymap entry exists, returns `false` on empty lines and
//    calls `insertNewBlockBelow` otherwise.
const enterBody = handlerBody(editor, "key: 'Enter'")
assert.ok(enterBody.includes("key: 'Enter'"), 'Enter keymap entry exists')
assert.ok(
  enterBody.includes('return false'),
  'Enter handler must return false on empty line'
)
assert.ok(
  enterBody.includes('insertNewBlockBelow'),
  'Enter handler must call insertNewBlockBelow on non-empty line'
)

// 2. `Shift-Enter` keymap entry inserts `  \n` (markdown hard break).
const shiftBody = handlerBody(editor, "key: 'Shift-Enter'")
assert.ok(shiftBody.includes("key: 'Shift-Enter'"), 'Shift-Enter keymap entry exists')
assert.ok(
  shiftBody.includes("insert: '  \\n'"),
  'Shift-Enter handler must insert "  \\n"'
)

// 3. Old `Mod-Enter` binding is gone.
assert.ok(
  !/\bkey:\s*['"]Mod-Enter['"]/.test(editor),
  'Mod-Enter binding should be removed'
)

// 4. `<!-- mkf:b:... -->` is in MARKER_PATTERNS. The file holds the
//    regex source as a literal string, so we match the source
//    substring directly — building a regex to match a regex is an
//    escape-fest.
assert.ok(
  hide.includes('<!--\\s*mkf:b:[\\w-]+\\s*-->'),
  'mkf:b: comment must be in MARKER_PATTERNS'
)

// 5. `empty-block-placeholder` extension exists, renders the hint text,
//    and is wired into the editor's extensions list.
assert.ok(
  placeholder.includes("Press 'space' for AI or '/' for commands"),
  'empty-block-placeholder must render the hint text'
)
assert.ok(
  /import\s*\{\s*emptyBlockPlaceholder\s*\}\s*from\s*['"]\.\/empty-block-placeholder['"]/.test(
    editor
  ),
  'editor must import emptyBlockPlaceholder'
)
assert.ok(
  /emptyBlockPlaceholder\(\),?/.test(editor),
  'editor extensions must include emptyBlockPlaceholder()'
)

// 6. CSS hides the hint except on the focused active line.
assert.ok(
  /\.mkf-empty-hint\s*\{[^}]*display:\s*none/.test(css),
  'CSS must hide .mkf-empty-hint by default'
)
assert.ok(
  /\.cm-focused\s+\.cm-activeLine\s+\.mkf-empty-hint\s*\{[^}]*display:\s*inline/.test(
    css
  ),
  'CSS must show .mkf-empty-hint on focused active line'
)

console.log('notion-parity Task 1 (empty block + Enter semantics): ok')
