import { it } from 'vitest'
import {
  createTabsReducer,
  EMPTY_TABS,
  IN_PLACE,
  MAX_HISTORY,
  activePath,
  activeTab,
  canGoBack,
  canGoForward,
  deserializeTabs,
  openIntent,
  serializeTabs,
  tabPath,
  type TabAction,
  type TabsState,
} from '../lib/tabs'

/**
 * Navigation session suite.
 *
 * Phase 0 of docs/tabs-plan.md moves `activePath` into a session that can hold more
 * than one document. Nothing renders it yet, which is the point: the dangerous part
 * of this feature is not the tab strip, it is that rename, move and delete each have
 * to leave the session pointing only at paths that still exist. A tab — or a history
 * entry behind it — left pointing at a deleted file is a Back button that 404s.
 *
 * So the reconciliation actions are tested hardest, and the cursor arithmetic under
 * them hardest of all.
 */

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures.push(`${name}\n      ${(err as Error).message}`)
    console.error(`  FAIL ${name}`)
    console.error(`       ${(err as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n      expected: ${b}\n      actual:   ${a}`)
}

/** Ids are sequential so every expectation below can name the tab it means. */
function reducer() {
  let n = 0
  return createTabsReducer(() => `t${++n}`)
}

/** Applies a script of actions to an empty session. */
function session(...actions: TabAction[]): TabsState {
  const reduce = reducer()
  return actions.reduce(reduce, EMPTY_TABS)
}

const open = (path: string): TabAction => ({ type: 'open', path })
const openInTab = (path: string, background = false): TabAction => ({
  type: 'open',
  path,
  newTab: true,
  background,
})

/** Every tab's current path, in strip order. */
const paths = (state: TabsState) => state.tabs.map(tabPath)

function runTabTests(): boolean {
  console.log('\nNavigation session\n')

  // --- opening and navigating -------------------------------------------------

  check('opening into an empty session creates one focused tab', () => {
    const state = session(open('a.md'))
    equal(paths(state), ['a.md'], 'wrong tabs')
    equal(state.activeId, 't1', 'the new tab was not focused')
    equal(activePath(state), 'a.md', 'wrong active path')
  })

  check('opening without newTab navigates the active tab rather than adding one', () => {
    const state = session(open('a.md'), open('b.md'), open('c.md'))
    equal(state.tabs.length, 1, 'navigation grew the session')
    equal(activeTab(state)!.history, ['a.md', 'b.md', 'c.md'], 'wrong history')
    equal(activeTab(state)!.cursor, 2, 'cursor is not on the newest entry')
  })

  check('opening the document already on screen does not grow the history', () => {
    const state = session(open('a.md'), open('a.md'))
    equal(activeTab(state)!.history, ['a.md'], 'the same path was pushed twice')
  })

  check('navigating after going back discards the forward entries', () => {
    const state = session(open('a.md'), open('b.md'), { type: 'back' }, open('c.md'))
    equal(activeTab(state)!.history, ['a.md', 'c.md'], 'the abandoned branch survived')
    equal(activePath(state), 'c.md', 'wrong active path')
  })

  check('history is capped, keeping the newest entries', () => {
    const script: TabAction[] = []
    for (let i = 0; i < MAX_HISTORY + 10; i++) script.push(open(`p${i}.md`))
    const tab = activeTab(session(...script))!

    equal(tab.history.length, MAX_HISTORY, 'history is not capped')
    equal(tab.history[0], 'p10.md', 'trimmed from the wrong end')
    equal(tab.cursor, MAX_HISTORY - 1, 'cursor left behind by the trim')
    equal(tabPath(tab), `p${MAX_HISTORY + 9}.md`, 'the newest document is not on screen')
  })

  // --- back and forward -------------------------------------------------------

  check('back and forward walk the history without changing it', () => {
    const state = session(open('a.md'), open('b.md'), open('c.md'), { type: 'back' })
    equal(activePath(state), 'b.md', 'back went to the wrong place')
    equal(activeTab(state)!.history.length, 3, 'back rewrote the history')

    const reduce = reducer()
    equal(activePath(reduce(state, { type: 'forward' })), 'c.md', 'forward went to the wrong place')
  })

  check('back and forward stop at the ends instead of wrapping', () => {
    const reduce = reducer()
    const one = session(open('a.md'))
    equal(activePath(reduce(one, { type: 'back' })), 'a.md', 'back walked off the start')
    equal(activePath(reduce(one, { type: 'forward' })), 'a.md', 'forward walked off the end')
    assert(!canGoBack(activeTab(one)), 'canGoBack is true with nowhere to go')
    assert(!canGoForward(activeTab(one)), 'canGoForward is true with nowhere to go')
  })

  // --- more than one tab ------------------------------------------------------

  check('a new tab lands beside its opener, not at the end', () => {
    const reduce = reducer()
    // a, then b beside it, then back to a and open c from there.
    let state = EMPTY_TABS
    state = reduce(state, open('a.md'))
    state = reduce(state, openInTab('b.md'))
    state = reduce(state, { type: 'activate', id: 't1' })
    state = reduce(state, openInTab('c.md'))
    equal(paths(state), ['a.md', 'c.md', 'b.md'], 'the new tab was not opened beside its opener')
  })

  check('a background tab does not steal focus', () => {
    const state = session(open('a.md'), openInTab('b.md', true))
    equal(paths(state), ['a.md', 'b.md'], 'the tab was not opened')
    equal(activePath(state), 'a.md', 'a background open moved the focus')
  })

  check('opening a document that is already open focuses it instead of duplicating it', () => {
    const state = session(open('a.md'), openInTab('b.md'), openInTab('a.md'))
    equal(paths(state), ['a.md', 'b.md'], 'the document was opened twice')
    equal(state.activeId, 't1', 'the existing tab was not focused')
  })

  check('a background open of an already-open document leaves the focus alone', () => {
    const state = session(open('a.md'), openInTab('b.md'), openInTab('a.md', true))
    equal(paths(state), ['a.md', 'b.md'], 'the document was opened twice')
    equal(state.activeId, 't2', 'a background open moved the focus')
  })

  check('each tab keeps its own mode', () => {
    const reduce = reducer()
    let state = session(open('a.md'), openInTab('b.md'))
    state = reduce(state, { type: 'setMode', mode: 'edit' })
    equal(
      state.tabs.map((t) => t.mode),
      ['read', 'edit'],
      'the mode leaked to another tab'
    )

    state = reduce(state, { type: 'toggleMode' })
    equal(state.tabs.map((t) => t.mode), ['read', 'read'], 'toggle did not return to reading')
  })

  // --- closing ----------------------------------------------------------------

  check('closing the active tab focuses the one to its right', () => {
    const reduce = reducer()
    let state = session(open('a.md'), openInTab('b.md'), openInTab('c.md'))
    state = reduce(state, { type: 'activate', id: 't2' })
    state = reduce(state, { type: 'close', id: 't2' })
    equal(paths(state), ['a.md', 'c.md'], 'wrong tab closed')
    equal(activePath(state), 'c.md', 'focus did not move to the right')
  })

  check('closing the rightmost tab falls back to the left', () => {
    const reduce = reducer()
    let state = session(open('a.md'), openInTab('b.md'))
    state = reduce(state, { type: 'activate', id: 't2' })
    state = reduce(state, { type: 'close', id: 't2' })
    equal(activePath(state), 'a.md', 'focus did not fall back to the left')
  })

  check('closing a background tab leaves the focus where it was', () => {
    const state = session(open('a.md'), openInTab('b.md'), openInTab('c.md'))
    const closed = reducer()(state, { type: 'close', id: 't1' })
    equal(activePath(closed), 'c.md', 'closing an inactive tab moved the focus')
  })

  check('closing the last tab empties the session', () => {
    const state = session(open('a.md'))
    const closed = reducer()(state, { type: 'close', id: 't1' })
    equal(closed.tabs, [], 'a tab survived')
    equal(closed.activeId, null, 'an id survived with no tab behind it')
    equal(activePath(closed), null, 'an empty session still reports a path')
  })

  check('closing others keeps the one named and focuses it', () => {
    const reduce = reducer()
    let state = session(open('a.md'), openInTab('b.md'), openInTab('c.md'))
    state = reduce(state, { type: 'closeOthers', id: 't1' })
    equal(paths(state), ['a.md'], 'the wrong tabs survived')
    equal(activePath(state), 'a.md', 'focus was left on a closed tab')
  })

  check('closing to the right leaves everything to the left alone', () => {
    const reduce = reducer()
    let state = session(open('a.md'), openInTab('b.md'), openInTab('c.md'))
    state = reduce(state, { type: 'activate', id: 't1' })
    state = reduce(state, { type: 'closeToRight', id: 't2' })
    equal(paths(state), ['a.md', 'b.md'], 'closed the wrong side')
    equal(activePath(state), 'a.md', 'focus moved when it did not have to')
  })

  check('closing to the right of the last tab does nothing', () => {
    const state = session(open('a.md'), openInTab('b.md'))
    equal(reducer()(state, { type: 'closeToRight', id: 't2' }), state, 'something was closed')
  })

  check('reordering moves the tab and leaves the focus on it', () => {
    const reduce = reducer()
    let state = session(open('a.md'), openInTab('b.md'), openInTab('c.md'))
    state = reduce(state, { type: 'activate', id: 't1' })
    state = reduce(state, { type: 'reorder', from: 0, to: 2 })
    equal(paths(state), ['b.md', 'c.md', 'a.md'], 'the tab landed in the wrong place')
    // Dragging the tab you are reading must not land you on a different document.
    equal(activePath(state), 'a.md', 'focus followed the position instead of the tab')
  })

  check('an out-of-range reorder is ignored', () => {
    const state = session(open('a.md'), openInTab('b.md'))
    const reduce = reducer()
    equal(reduce(state, { type: 'reorder', from: 0, to: 9 }), state, 'accepted a bad target')
    equal(reduce(state, { type: 'reorder', from: -1, to: 0 }), state, 'accepted a bad source')
    equal(reduce(state, { type: 'reorder', from: 1, to: 1 }), state, 'a no-op rebuilt the state')
  })

  // --- reconciliation against file operations ---------------------------------

  check('a rename rewrites the path in every tab and every history entry', () => {
    const reduce = reducer()
    let state = session(open('a.md'), open('b.md'), openInTab('a.md'))
    state = reduce(state, { type: 'pathRenamed', from: 'a.md', to: 'renamed.md' })

    equal(paths(state), ['b.md', 'renamed.md'], 'the open document was not renamed')
    equal(state.tabs[0].history, ['renamed.md', 'b.md'], 'a history entry was left behind')
  })

  check('a folder move rewrites the prefix, including nested paths', () => {
    const reduce = reducer()
    let state = session(open('Notes/deep/a.md'), openInTab('Notes/b.md'))
    state = reduce(state, { type: 'prefixMoved', from: 'Notes', to: 'Archive/Notes' })
    equal(
      paths(state),
      ['Archive/Notes/deep/a.md', 'Archive/Notes/b.md'],
      'the folder move missed a path'
    )
  })

  check('a folder move leaves a sibling whose name merely starts the same', () => {
    const reduce = reducer()
    let state = session(open('Notes-old/a.md'), openInTab('Notes/b.md'))
    state = reduce(state, { type: 'prefixMoved', from: 'Notes', to: 'Archive' })
    equal(paths(state), ['Notes-old/a.md', 'Archive/b.md'], 'a sibling folder was dragged along')
  })

  check('deleting a document closes the tabs showing it', () => {
    const reduce = reducer()
    let state = session(open('a.md'), openInTab('b.md'), openInTab('c.md'))
    state = reduce(state, { type: 'activate', id: 't1' })
    state = reduce(state, { type: 'pathRemoved', path: 'a.md' })

    equal(paths(state), ['b.md', 'c.md'], 'the deleted document is still open')
    equal(activePath(state), 'b.md', 'focus did not move off the deleted document')
  })

  check('deleting a document scrubs it from the history of the tabs that survive', () => {
    const reduce = reducer()
    // One tab that walked a.md -> b.md -> c.md, so the deleted path is behind it.
    let state = session(open('a.md'), open('b.md'), open('c.md'))
    state = reduce(state, { type: 'pathRemoved', path: 'a.md' })

    const tab = activeTab(state)!
    equal(tab.history, ['b.md', 'c.md'], 'Back would have landed on a deleted document')
    equal(tabPath(tab), 'c.md', 'the scrub moved the document on screen')
    equal(tab.cursor, 1, 'the cursor was not corrected for the removed entry')
  })

  check('scrubbing a history entry ahead of the cursor leaves the cursor alone', () => {
    const reduce = reducer()
    let state = session(open('a.md'), open('b.md'), open('c.md'), { type: 'back' })
    state = reduce(state, { type: 'pathRemoved', path: 'c.md' })

    const tab = activeTab(state)!
    equal(tab.history, ['a.md', 'b.md'], 'the deleted entry stayed in the history')
    equal(tabPath(tab), 'b.md', 'the document on screen changed')
    equal(tab.cursor, 1, 'the cursor moved when it should not have')
  })

  check('deleting a folder closes everything under it and nothing beside it', () => {
    const reduce = reducer()
    let state = session(open('Notes/a.md'), openInTab('Notes/deep/b.md'), openInTab('Notes-old/c.md'))
    state = reduce(state, { type: 'prefixRemoved', prefix: 'Notes' })

    equal(paths(state), ['Notes-old/c.md'], 'the folder delete took the wrong tabs')
    equal(activePath(state), 'Notes-old/c.md', 'focus was left on a closed tab')
  })

  check('deleting every open document empties the session', () => {
    const reduce = reducer()
    let state = session(open('Notes/a.md'), openInTab('Notes/b.md'))
    state = reduce(state, { type: 'prefixRemoved', prefix: 'Notes' })
    equal(state, EMPTY_TABS, 'the session did not empty')
  })

  // --- reading the click ------------------------------------------------------

  check('a plain click replaces what is on screen', () => {
    equal(openIntent({ button: 0 }), IN_PLACE, 'a plain click opened a tab')
  })

  check('a modified click opens behind, and with shift opens in front', () => {
    equal(openIntent({ ctrlKey: true }), { newTab: true, background: true }, 'wrong for ctrl')
    equal(openIntent({ metaKey: true }), { newTab: true, background: true }, 'wrong for cmd')
    equal(
      openIntent({ ctrlKey: true, shiftKey: true }),
      { newTab: true, background: false },
      'ctrl+shift did not open in front'
    )
  })

  check('middle click opens behind, modifiers or not', () => {
    equal(openIntent({ button: 1 }), { newTab: true, background: true }, 'wrong for middle click')
    equal(
      openIntent({ button: 1, shiftKey: true }),
      { newTab: true, background: true },
      'shift changed what middle click means'
    )
  })

  check('shift on its own is not a tab gesture', () => {
    // Shift-click is text selection. Treating it as "open in a new tab" would make
    // selecting a link's label open a document instead.
    equal(openIntent({ shiftKey: true }), IN_PLACE, 'shift alone opened a tab')
  })

  // --- storage ----------------------------------------------------------------

  /** Restore with a fresh id supply, so restored ids are predictable and distinct. */
  function restore(raw: string | null, present: string[] | ((path: string) => boolean)) {
    let n = 0
    const exists = typeof present === 'function' ? present : (path: string) => present.includes(path)
    return deserializeTabs(raw, exists, () => `r${++n}`)
  }

  check('a session round-trips through storage', () => {
    const before = session(open('a.md'), open('b.md'), openInTab('c.md'), { type: 'back' })
    const after = restore(serializeTabs(before), ['a.md', 'b.md', 'c.md'])!

    equal(paths(after), paths(before), 'the documents on screen changed')
    equal(
      after.tabs.map((t) => [t.history, t.cursor, t.mode]),
      before.tabs.map((t) => [t.history, t.cursor, t.mode]),
      'a tab came back different'
    )
    equal(activePath(after), activePath(before), 'the wrong tab was focused')
  })

  check('restored tabs get new ids', () => {
    const before = session(open('a.md'), openInTab('b.md'))
    const after = restore(serializeTabs(before), ['a.md', 'b.md'])!
    // Ids mean nothing outside the session that made them. Reissuing is what stops a
    // restored tab colliding with one opened a moment later.
    equal(after.tabs.map((t) => t.id), ['r1', 'r2'], 'stored ids were carried over')
    equal(after.activeId, 'r2', 'focus did not follow the reissued id')
  })

  check('documents deleted since the last session are dropped', () => {
    const before = session(open('gone.md'), openInTab('kept.md'))
    const after = restore(serializeTabs(before), ['kept.md'])!
    equal(paths(after), ['kept.md'], 'a tab came back on a document that no longer exists')
  })

  check('a deleted document is dropped from history too, cursor and all', () => {
    const before = session(open('gone.md'), open('kept.md'), open('also.md'), { type: 'back' })
    const tab = restore(serializeTabs(before), ['kept.md', 'also.md'])!.tabs[0]
    equal(tab.history, ['kept.md', 'also.md'], 'a dead path survived in the history')
    equal(tabPath(tab), 'kept.md', 'the document on screen changed')
    equal(tab.cursor, 0, 'the cursor was not corrected')
  })

  check('focus falls to the first tab when the focused one did not survive', () => {
    const before = session(open('kept.md'), openInTab('gone.md'))
    const after = restore(serializeTabs(before), ['kept.md'])!
    equal(activePath(after), 'kept.md', 'focus was left on a tab that no longer exists')
  })

  check('nothing left to restore returns null rather than an empty session', () => {
    const before = session(open('gone.md'))
    equal(restore(serializeTabs(before), []), null, 'an empty session was restored')
    // Null is the signal for "open the first document as usual". An empty session
    // would instead leave the workspace blank on every boot after a delete.
  })

  check('a payload that is not a session is refused', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '{}',
      '[]',
      'null',
      '{"v":1}',
      '{"v":999,"active":0,"tabs":[{"history":["a.md"],"cursor":0,"mode":"read"}]}',
      '{"v":1,"active":0,"tabs":"nope"}',
      '{"v":1,"active":0,"tabs":[{"history":"a.md","cursor":0,"mode":"read"}]}',
      '{"v":1,"active":0,"tabs":[{"history":[1,2],"cursor":0,"mode":"read"}]}',
      '{"v":1,"active":0,"tabs":[{"history":["a.md"],"cursor":"x","mode":"read"}]}',
    ]) {
      equal(restore(raw, ['a.md']), null, `accepted a bad payload: ${String(raw)}`)
    }
  })

  check('a cursor out of range is clamped rather than trusted', () => {
    const tab = restore('{"v":1,"active":0,"tabs":[{"history":["a.md","b.md"],"cursor":99,"mode":"read"}]}', [
      'a.md',
      'b.md',
    ])!.tabs[0]
    equal(tab.cursor, 1, 'an out-of-range cursor survived')
    equal(tabPath(tab), 'b.md', 'the clamp landed on nothing')
  })

  check('an unknown mode falls back to reading', () => {
    const tab = restore('{"v":1,"active":0,"tabs":[{"history":["a.md"],"cursor":0,"mode":"wat"}]}', ['a.md'])!.tabs[0]
    equal(tab.mode, 'read', 'an unknown mode was trusted')
  })

  check('an oversized history is trimmed to the cap, keeping the newest', () => {
    const history = Array.from({ length: MAX_HISTORY * 3 }, (_, i) => `p${i}.md`)
    const raw = JSON.stringify({
      v: 1,
      active: 0,
      tabs: [{ history, cursor: history.length - 1, mode: 'read' }],
    })
    const tab = restore(raw, () => true)!.tabs[0]
    equal(tab.history.length, MAX_HISTORY, 'the cap was not applied on the way in')
    equal(tabPath(tab), `p${history.length - 1}.md`, 'the newest document was trimmed away')
  })

  // --- purity -----------------------------------------------------------------

  check('the reducer never mutates the state it is given', () => {
    const before = session(open('a.md'), open('b.md'), openInTab('c.md'))
    const snapshot = JSON.stringify(before)
    const reduce = reducer()

    for (const action of [
      open('d.md'),
      openInTab('e.md'),
      { type: 'back' } as TabAction,
      { type: 'setMode', mode: 'edit' } as TabAction,
      { type: 'close', id: 't1' } as TabAction,
      { type: 'pathRenamed', from: 'a.md', to: 'z.md' } as TabAction,
      { type: 'prefixRemoved', prefix: '' } as TabAction,
    ]) {
      reduce(before, action)
    }

    equal(JSON.parse(snapshot), before, 'an action mutated the state it was given')
  })

  check('an unknown tab id is ignored rather than emptying the session', () => {
    const reduce = reducer()
    const state = session(open('a.md'))
    equal(reduce(state, { type: 'activate', id: 'nope' }), state, 'activate accepted a dead id')
    equal(reduce(state, { type: 'close', id: 'nope' }).tabs.length, 1, 'close took the wrong tab')
  })

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures.`)
    return true
  }
  console.error(`FAIL — ${failures.length} failure(s) of ${passed + failures.length} checks:\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  return false
}

it('tabs suite', async () => {
  if (!(await runTabTests())) throw new Error('tabs suite FAILED')
}, 60000)

export { runTabTests }
