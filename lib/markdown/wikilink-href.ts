import { WIKILINK_PATTERN } from './wikilink'

/**
 * Carrying a `[[wikilink]]` through the Markdown renderer.
 *
 * `[[Target]]` is not CommonMark, so the reading view rewrites it into an ordinary
 * link with a private scheme before rendering, and recognises that scheme again when
 * the anchor comes back out. The alternative — a custom mdast node and a renderer for
 * it — is a lot of machinery for "turn this into a button".
 *
 * The part that is not obvious, and that this module exists to make impossible to get
 * wrong again: **react-markdown sanitizes every URL it renders**, and its default
 * transform blanks any scheme outside `http`, `https`, `irc`, `ircs`, `mailto` and
 * `xmpp`. `wikilink:` is not on that list, so every wikilink in the reading view
 * arrived at the renderer with `href=""`. The branch meant to turn it into a button
 * never matched, and the anchor fell through to the external-link case — which is why
 * clicking a wikilink opened a blank browser tab instead of the document.
 *
 * So the scheme has to be allowed through explicitly, by `workspaceUrlTransform`
 * below, and both halves — the rewrite and the recognition — live here together.
 */

export const WIKILINK_SCHEME = 'wikilink:'

export function toWikilinkHref(target: string): string {
  return `${WIKILINK_SCHEME}${encodeURIComponent(target)}`
}

/** The target behind a wikilink href, or null when this is an ordinary link. */
export function parseWikilinkHref(href: string | null | undefined): string | null {
  if (!href || !href.startsWith(WIKILINK_SCHEME)) return null
  const encoded = href.slice(WIKILINK_SCHEME.length)
  try {
    return decodeURIComponent(encoded)
  } catch {
    // A malformed escape should still resolve as far as it can rather than becoming
    // a link that goes nowhere.
    return encoded
  }
}

/**
 * Rewrites every `[[Target]]` and `[[Target|Label]]` into a link the renderer accepts.
 *
 * Uses the app's one definition of the syntax (`WIKILINK_PATTERN`) rather than a
 * second regex, so the links the reading view finds are exactly the ones the index,
 * the editor and a rename agree are links.
 */
export function linkifyWikilinks(body: string): string {
  WIKILINK_PATTERN.lastIndex = 0
  return body.replace(WIKILINK_PATTERN, (match, rawTarget: string, alias?: string) => {
    const target = rawTarget.trim()
    if (!target) return match
    const label = alias && alias.length > 0 ? alias : target
    return `[${label}](${toWikilinkHref(target)})`
  })
}

/**
 * Whether a URL is one of ours, and so must survive react-markdown's sanitizer.
 *
 * Deliberately narrow: this is an exemption from a security default, and it applies
 * to exactly one scheme that this app generates itself, a few lines above, out of
 * text it already parsed. Nothing a document author writes reaches it — an author's
 * own `wikilink:` link would have to be written by hand, and it would then be handled
 * by the same in-app navigation as any other, which is the safe outcome anyway.
 */
export function isWorkspaceHref(url: string): boolean {
  return url.startsWith(WIKILINK_SCHEME)
}
