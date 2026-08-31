import { EditorSelection, type ChangeSpec, type StateCommand } from '@codemirror/state'
import { selectionInFrontmatter } from './frontmatter-region'

/**
 * Formatting commands for the toolbar and the keymap.
 *
 * Every one of these writes plain Markdown — the same bytes a person typing by hand
 * would produce. There is no editor-specific syntax and no document model: a file
 * formatted here is indistinguishable from one formatted in vim, which is the whole
 * premise (docs/sprint-3-editor-decision.md).
 *
 * They are `StateCommand`s rather than functions over an `EditorView` so that they run
 * against a bare `EditorState` in tests, with no DOM involved.
 */

/** Levels the heading button cycles through before returning to a plain line. */
const HEADING_CYCLE = [1, 2, 3]

function wrapCommand(marker: string, userEvent: string): StateCommand {
  const len = marker.length

  return ({ state, dispatch }) => {
    // Toolbar commands must not mutate hidden frontmatter — the prefix would
    // be invisible, the line would no longer match the frontmatter regex, and
    // the whole block would suddenly become visible. See frontmatter-region.
    if (selectionInFrontmatter(state)) return false
    const spec = state.changeByRange((range) => {
      const before = state.sliceDoc(Math.max(0, range.from - len), range.from)
      const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + len))
      const inner = state.sliceDoc(range.from, range.to)

      // The selection sits between existing markers — `**|bold|**`. Unwrap.
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - len, to: range.from },
            { from: range.to, to: range.to + len },
          ],
          range: EditorSelection.range(range.from - len, range.to - len),
        }
      }

      // The selection contains the markers — `|**bold**|`. Unwrap.
      if (inner.length >= len * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
        return {
          changes: [
            { from: range.from, to: range.from + len },
            { from: range.to - len, to: range.to },
          ],
          range: EditorSelection.range(range.from, range.to - len * 2),
        }
      }

      // An empty selection leaves the cursor between the two new markers, ready to type.
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + len, range.to + len),
      }
    })

    dispatch(state.update(spec, { scrollIntoView: true, userEvent }))
    return true
  }
}

export const toggleBold = wrapCommand('**', 'input.format.bold')
export const toggleItalic = wrapCommand('*', 'input.format.italic')
export const toggleInlineCode = wrapCommand('`', 'input.format.code')
export const toggleStrikethrough = wrapCommand('~~', 'input.format.strike')

/**
 * Wraps the selection in a wikilink.
 *
 * With nothing selected this leaves the cursor inside `[[]]`, which is where the
 * caller opens the completion list — the same in-memory index the `[[` trigger uses.
 */
export const wrapWikilink: StateCommand = ({ state, dispatch }) => {
  if (selectionInFrontmatter(state)) return false
  const spec = state.changeByRange((range) => ({
    changes: [
      { from: range.from, insert: '[[' },
      { from: range.to, insert: ']]' },
    ],
    range: EditorSelection.range(range.from + 2, range.to + 2),
  }))

  dispatch(state.update(spec, { scrollIntoView: true, userEvent: 'input.wikilink' }))
  return true
}

/** Every line the selection touches, deduplicated and in document order. */
function selectedLines(state: Parameters<StateCommand>[0]['state']) {
  const lines = new Map<number, { from: number; to: number; text: string }>()
  for (const range of state.selection.ranges) {
    let pos = range.from
    while (pos <= range.to) {
      const line = state.doc.lineAt(pos)
      lines.set(line.number, { from: line.from, to: line.to, text: line.text })
      if (line.to >= state.doc.length) break
      pos = line.to + 1
    }
  }
  return [...lines.values()]
}

/**
 * Maps the selection through line-prefix edits so the caret stays with the text.
 *
 * The association matters: a cursor sitting exactly where a prefix is inserted should
 * end up after it, still touching the word it was in front of, rather than being left
 * stranded before the new `- ` or `## `.
 */
function mapSelection(state: Parameters<StateCommand>[0]['state'], changes: ChangeSpec[]) {
  return state.selection.map(state.changes(changes), 1)
}

/**
 * Cycles the heading level of every touched line: plain → H1 → H2 → H3 → plain.
 *
 * A line already deeper than H3 returns to plain on the next press rather than
 * continuing to H4 — deep headings are rare enough that a toolbar button walking
 * through six states is worse than typing the hashes.
 */
export const cycleHeading: StateCommand = ({ state, dispatch }) => {
  if (selectionInFrontmatter(state)) return false
  const changes: ChangeSpec[] = []

  for (const line of selectedLines(state)) {
    const match = /^(#{1,6})[ \t]+/.exec(line.text)
    const current = match ? match[1].length : 0
    const index = HEADING_CYCLE.indexOf(current)
    // A line deeper than the cycle leaves it — promoting an H5 to an H1 because a
    // toolbar button did not recognise it would be a surprising thing to do to
    // someone's document.
    const next = current === 0 ? HEADING_CYCLE[0] : index === -1 ? 0 : (HEADING_CYCLE[index + 1] ?? 0)

    const prefix = next === 0 ? '' : `${'#'.repeat(next)} `
    changes.push({ from: line.from, to: line.from + (match ? match[0].length : 0), insert: prefix })
  }

  if (changes.length === 0) return false
  dispatch(state.update({ changes, selection: mapSelection(state, changes), userEvent: 'input.format.heading' }))
  return true
}

/** Adds `- ` to every touched line, or removes it if every line already has it. */
export const toggleBulletList: StateCommand = ({ state, dispatch }) => {
  if (selectionInFrontmatter(state)) return false
  const lines = selectedLines(state)
  if (lines.length === 0) return false

  const bullet = /^([ \t]*)([-*+])[ \t]+/
  // Blank lines are ignored when deciding, so a list with a trailing empty line still
  // reads as "already a list" and toggles off rather than gaining a stray bullet.
  const meaningful = lines.filter((line) => line.text.trim().length > 0)
  const allBulleted = meaningful.length > 0 && meaningful.every((line) => bullet.test(line.text))

  const changes: ChangeSpec[] = []
  for (const line of lines) {
    const match = bullet.exec(line.text)
    if (allBulleted) {
      if (match) changes.push({ from: line.from, to: line.from + match[0].length, insert: match[1] })
    } else if (!match) {
      const indent = /^[ \t]*/.exec(line.text)![0]
      changes.push({ from: line.from + indent.length, insert: '- ' })
    }
  }

  if (changes.length === 0) return false
  dispatch(state.update({ changes, selection: mapSelection(state, changes), userEvent: 'input.format.list' }))
  return true
}
