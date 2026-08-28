import { it } from 'vitest'
import { defaultUrlTransform } from 'react-markdown'
import {
  isWorkspaceHref,
  linkifyWikilinks,
  parseWikilinkHref,
  toWikilinkHref,
} from '../lib/markdown/wikilink-href'

/**
 * Wikilink rendering suite.
 *
 * `[[Target]]` is not CommonMark, so the reading view rewrites it into an ordinary
 * link carrying a private `wikilink:` scheme, and recognises that scheme again when
 * the anchor comes back out of the renderer.
 *
 * The failure this suite exists to prevent is a silent one, and it was live: **the
 * renderer sanitizes every URL**, blanking any scheme outside http/https/irc/ircs/
 * mailto/xmpp. Every wikilink therefore reached the anchor renderer with `href=""`,
 * the branch that turns it into an in-app button never matched, and the link fell
 * through to the external case — so clicking a wikilink in the reading view opened a
 * blank browser tab instead of the document. Nothing threw, nothing logged, and the
 * link still looked like a link.
 *
 * So the load-bearing check here runs the real `defaultUrlTransform` over a real
 * generated href. It fails the moment that default changes or the scheme is renamed,
 * which is the only warning anyone would otherwise get.
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

/** What the reading view does: allow our own scheme, sanitize everything else. */
const transform = (url: string) => (isWorkspaceHref(url) ? url : defaultUrlTransform(url))

export function runWikilinkHrefTests(): boolean {
  console.log('Wikilink rendering suite\n')

  console.log('surviving the renderer’s URL sanitizer')

  check('the renderer would blank a wikilink href on its own', () => {
    // Not a test of our code — a test of the assumption our code is built on. If this
    // ever stops being true, the exemption below is dead weight and should go.
    equal(
      defaultUrlTransform(toWikilinkHref('Dev Notes')),
      '',
      'react-markdown no longer strips unknown schemes; the urlTransform can be removed'
    )
  })

  check('the exemption lets it through intact', () => {
    const href = toWikilinkHref('Dev Notes')
    equal(transform(href), href, 'the wikilink href did not survive the transform')
    equal(parseWikilinkHref(transform(href)), 'Dev Notes', 'the target did not come back out')
  })

  check('targets with punctuation survive the round trip', () => {
    // Real titles from this workspace. The em dash and the spaces are what make the
    // encoding necessary in the first place.
    for (const target of [
      'Password Manager — Rencana Fitur',
      'GH - Dev Notes',
      'a/b?c#d',
      'Título con acentos',
      '100% Done',
    ]) {
      const href = transform(toWikilinkHref(target))
      equal(parseWikilinkHref(href), target, `round trip failed for ${JSON.stringify(target)}`)
    }
  })

  check('the exemption does not widen the sanitizer for anything else', () => {
    // The one risk of overriding a security default. `javascript:` must still be
    // blanked, and ordinary links must still be untouched.
    equal(transform('javascript:alert(1)'), '', 'a javascript: URL was let through')
    equal(transform('vbscript:x'), '', 'an unknown scheme was let through')
    equal(transform('https://example.com'), 'https://example.com', 'https was altered')
    equal(transform('mailto:a@b.c'), 'mailto:a@b.c', 'mailto was altered')
    equal(transform('../Other Note.md'), '../Other Note.md', 'a relative link was altered')
    equal(transform('#heading'), '#heading', 'a fragment was altered')
  })

  console.log('')
  console.log('telling a wikilink from an ordinary link')

  check('an ordinary href is not mistaken for a wikilink', () => {
    for (const href of ['https://example.com', '../Other.md', '#top', '', undefined, null]) {
      equal(parseWikilinkHref(href), null, `${JSON.stringify(href)} was read as a wikilink`)
    }
  })

  check('a blanked href is not read as a wikilink either', () => {
    // The exact shape of the bug: an empty href must fall through to the ordinary
    // link path, never be treated as a wikilink to nowhere.
    equal(parseWikilinkHref(defaultUrlTransform('unknown:thing')), null, 'a blanked href matched')
  })

  console.log('')
  console.log('rewriting the document body')

  check('both wikilink forms become links', () => {
    equal(
      linkifyWikilinks('See [[Dev Notes]] and [[Task List|the list]].'),
      `See [Dev Notes](${toWikilinkHref('Dev Notes')}) and [the list](${toWikilinkHref('Task List')}).`,
      'wrong rewrite'
    )
  })

  check('a target with no name is left as written', () => {
    // `[[|label]]` names nothing. Inventing a link to '' would render a control that
    // cannot go anywhere and cannot be created either.
    equal(linkifyWikilinks('[[|label]]'), '[[|label]]', 'invented a link from an empty target')
  })

  check('surrounding text is untouched', () => {
    const body = '# Title\n\nProse with `[[code]]` style text and a [real](https://x.test) link.\n'
    // Note: the inline-code case is a known limit of a text-level rewrite — the
    // renderer is what ultimately decides, and it renders code spans literally.
    assert(linkifyWikilinks(body).includes('[real](https://x.test)'), 'an ordinary link was rewritten')
    assert(linkifyWikilinks(body).startsWith('# Title\n'), 'the heading was disturbed')
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

it('wikilink-href suite', async () => {
  if (!(await runWikilinkHrefTests())) throw new Error('wikilink-href suite FAILED')
}, 60000)
