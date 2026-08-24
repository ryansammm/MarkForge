# Image Viewer Plan — "Click the picture, see the picture"

**Dates:** 19 August 2026 (Wed) — 1 September 2026 (Tue) · **Team:** 1 engineer (solo)
**Branch:** `feat/20260819-image-viewer` (created, no commits yet)

**Goal:** Clicking an image in a document opens it in a pop-up over the workspace, at
the size the screen can actually give it, where it can be zoomed and panned and then
dismissed back to exactly where the reader was.

> **Tracker note.** Same as sprint 7: no project tracker is authorized in this session,
> so this document is the board. Points are relative sizes on a 1/2/3/5/8 scale.

This overlaps the tail of sprint 7, whose P0 and P1 work is all landed and whose only
remaining items (9 and 10) are blocked on decisions that are not mine to take quietly.
The slack goes here.

---

## What exists today

Sprint 7 put images in the vault and made them render. Three surfaces draw them, and no
two draw them the same way:

| Surface | Where | How the `src` is resolved |
|---|---|---|
| Reading view | [doc-viewer.tsx:198](../components/workspace/doc-viewer.tsx) — an `img` entry in react-markdown's `components` map | `resolveImageSrc` ([workspace-api.ts:131](../lib/workspace-api.ts)) → session-gated `/api/assets` |
| Editor | [live-preview.ts:266](../components/workspace/live-preview.ts) — `ImageWidget`, imperative DOM inside a CodeMirror `ViewPlugin` | the same `resolveImageSrc`, passed in through a facet so the module stays unaware of the app's URL shape |
| Public share | [app/share/\[token\]/page.tsx:281](../app/share/[token]/page.tsx) | `shareImageSrc` ([share.ts:110](../lib/share.ts)) → token-carrying `/api/share/<token>/asset` |

All three cap the picture at 60–70vh and stop there. A screenshot of a dashboard, a
photo of a whiteboard, a diagram with small type — the reader can see that something is
there and cannot read it. That is the whole of the problem.

---

## Why this is not a one-liner

**1. There are three call sites and two resolvers, and the two resolvers must never be
interchanged.** Sprint 7 states it plainly: `shareImageSrc` is a second function rather
than a parameter on `resolveImageSrc`, because one points at the session gate and the
other carries the reader's only credential. So the viewer takes a **resolved URL** and
knows nothing about how it was produced. It never sees a vault path, never sees a token,
and there is no branch inside it that could pick the wrong one. This is D1 below and it
is the load-bearing decision in the whole plan.

**2. In the editor, a click on an image already means something.** `ImageWidget`
returns `false` from `ignoreEvent` ([live-preview.ts:318](../components/workspace/live-preview.ts))
on purpose: the click falls through, the caret lands on the image's line, and the raw
`![alt](path)` is revealed. That *is* the alt-text editor — sprint 7 item 6 declined to
build a dedicated one specifically because this path exists. Making a plain click open a
pop-up takes away the only way to edit an image's alt text without breaking the rule
that every piece of syntax is edited as text. The editor needs a different gesture (D3).

**3. Nothing in this repo is a clickable image yet.** An `<img>` is not focusable and
not activatable from a keyboard, so "click the image" means introducing a control into
prose — inside a `<p>` produced by react-markdown, inside `prose` typography styles,
inside a container that scrolls and restores scroll position per document.

**4. Window-level key handlers run while a modal is open.** `workspace-app.tsx` listens
on `window` for Alt+Arrow (history, [workspace-app.tsx:657](../components/workspace/workspace-app.tsx))
and Alt+digit / Alt+W (tabs, [workspace-app.tsx:361](../components/workspace/workspace-app.tsx)).
Neither knows about dialogs. Alt+Left with the viewer open would navigate the tab
underneath the overlay, and the reader would dismiss the pop-up onto a different
document than the one they left.

**5. Wheel-zoom cannot be done with `onWheel`.** React registers the root `wheel`
listener as passive, so `preventDefault()` from a React handler does not stop the page
from zooming or scrolling underneath. The listener has to be attached natively with
`{ passive: false }`. (Assumed from React's documented root-listener behaviour —
**verify in the browser before building on it**; it changes only where the listener is
attached, not the design.)

---

## Decisions (take these before item 2)

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Does the viewer resolve `src`? | **No.** It takes an already-resolved URL plus `alt`. Each surface resolves with the function it already uses. The viewer cannot be handed a token by accident because it has no idea what one is. |
| **D2** | Own overlay or the project's `Dialog`? | **The project's** `Dialog` ([ui/dialog.tsx](../components/ui/dialog.tsx), Base UI). Focus trap, Esc, scroll lock, portal and the exit animation are already solved and already themed; a bespoke overlay re-solves all of it worse. *Built as:* the lightbox composes `Dialog`/`DialogPortal`/`DialogOverlay` itself rather than overriding `DialogContent` — that one is a centred small card, and the six dialogs using it should stay cards. |
| **D3** | The gesture in the editor | **Not a plain click.** An "expand" button that appears on hover or focus in the widget's corner, with mod-click as an alias — mod-click is already the editor's navigate gesture for wikilinks. Plain click keeps placing the caret, so alt text is still editable. |
| **D4** | Zoom range and default | Opens at **fit**, never upscaled past 1× on open — a 200px icon should not arrive blown up and blurry. Zoom out floor is fit; ceiling is **8×**. Below fit there is nothing to see and a lot of empty overlay. |
| **D5** | New server surface | **None.** The pop-up renders the same URL that is already in the page, so the bytes come from the browser's cache. No new route, no new caching rule, nothing added to the service worker (which is asserted not to cache user data — `tests/service-worker.test.ts:305`). |
| **D6** | Prev/next between images | **Yes, but P2.** Within the current document only, in document order. A viewer that traps you on the image you clicked is fine; one that silently walks into another document is not. |
| **D7** | Download / open-original button | **P2, and "open in a new tab" rather than a download.** On a share page the URL carries the token, and a copied link is a copied credential — that deserves its own thinking, not a button added in passing. |

---

## Backlog

**Planned capacity: 24 pts · Committed (P0+P1): 19 pts (79%) · Stretch (P2): 5 pts**

| Pri | # | Item | Est | Depends on | Status |
|-----|---|------|-----|------------|--------|
| P0 | 1 | `image-zoom.ts` — the zoom/pan model, as pure functions | 3 | — | **done** |
| P0 | 2 | `image-lightbox.tsx` — the pop-up shell, a11y, toolbar | 4 | 1, D2 | **done** |
| P0 | 3 | Gestures: wheel, drag, double-click, pinch, keyboard | 4 | 2 | **done** |
| P0 | 4 | Reading view: images become openable | 3 | 2 | **done** |
| P1 | 5 | Public share page | 2 | 4 | **done** |
| P1 | 6 | Editor widget: expand affordance (D3) | 3 | 2 | **done** — not cut |
| P2 | 7 | Prev/next within the document (D6) | 3 | 4 | not started |
| P2 | 8 | Open original in a new tab (D7) | 2 | 2 | not started |

Cut line, named in advance: **item 6 was the designated cut**, and it was not needed —
all 19 committed points landed. Item 4 is what makes the feature real; items 1–3 are
what make item 4 worth having.

### What shipped

| File | What it is |
|---|---|
| [components/workspace/image-zoom.ts](../components/workspace/image-zoom.ts) | The model. No DOM, no React. |
| [tests/image-zoom.test.ts](../tests/image-zoom.test.ts) | 27 checks, wired into `npm test` as `test:zoom`. |
| [components/workspace/image-lightbox.tsx](../components/workspace/image-lightbox.tsx) | The pop-up and every gesture. |
| [components/workspace/viewable-image.tsx](../components/workspace/viewable-image.tsx) | The prose image and the button that opens it — shared by the reading view and the share page. |
| [lib/modal-keys.ts](../lib/modal-keys.ts) | Who owns the keyboard while something modal is up. |
| [doc-viewer.tsx](../components/workspace/doc-viewer.tsx) · [share page](../app/share/) · [live-preview.ts](../components/workspace/live-preview.ts) · [markdown-editor.tsx](../components/workspace/markdown-editor.tsx) | The four call sites. |

**One thing the plan did not have: `ViewableImage` is a shared component.** The plan had
the reading view and the share page each keeping their own `<img>`. They were already
near-identical, and both now needed a button, an error state and a hover affordance —
three more chances to drift, with the symptom being a picture that opens on one surface
and not the other. Resolution still happens at each call site, so D1 is untouched: the
shared component takes a URL somebody else produced.

---

### 1 — The zoom model, as pure functions (3 pts)

`components/workspace/image-zoom.ts`. No DOM, no React: numbers in, numbers out.

```ts
export interface Viewport { scale: number; x: number; y: number }
export interface Size { width: number; height: number }

/** Scale that fits `image` inside `stage`, never above 1 (see D4). */
export function fitScale(image: Size, stage: Size): number

/** Zoom by `factor` about a point in stage coordinates, keeping that point fixed. */
export function zoomAbout(view: Viewport, factor: number, anchor: Point, ...): Viewport

/** Centres the image when it is smaller than the stage; otherwise stops an edge
 *  being dragged past the middle, so it can never be lost off-screen. */
export function clampPan(view: Viewport, image: Size, stage: Size): Viewport

/** The button ladder: 1, 1.5, 2, 3, 4, 6, 8 — clamped to [fit, MAX]. */
export function stepZoom(view: Viewport, direction: 1 | -1, ...): Viewport
```

Split out for exactly the reason `previewNodes` was split out of the `ViewPlugin` in
sprint 6: the interesting part is arithmetic, and arithmetic is testable headless. This
repo's suites run under `tsx` with no DOM, so a model tangled into a component is a
model that gets verified by clicking around and hoping.

The anchor rule is the one piece of real maths, and it is the difference between a
viewer that feels direct and one that feels like it is fighting you: after a zoom, the
image point that was under the cursor must still be under the cursor —
`x' = ax - (ax - x) · (s'/s)`.

**Tests** (`tests/image-zoom.test.ts`, wired into `npm test` as `test:zoom`): fit never
upscales; fit of a huge image is < 1; the anchor point survives a zoom to within a
pixel; zooming in and back out returns to the starting offset; a smaller-than-stage
image is centred whatever pan is requested; the ladder is monotonic and clamps at both
ends; reset returns to fit exactly.

### 2 — The pop-up shell (4 pts)

`components/workspace/image-lightbox.tsx`.

```tsx
interface ImageLightboxProps {
  /** Already resolved. See D1 — this component never maps a vault path. */
  src: string | null
  alt: string
  /** For the title bar and for the dialog's accessible name when alt is empty. */
  label?: string
  onClose: () => void
}
```

- Built on `Dialog` with a `className` that overrides the `sm:max-w-sm` centred card
  into a full-viewport stage. The backdrop is opaque enough to read against — today's
  `bg-black/10` is a card backdrop, not a viewer's, so this needs its own.
- **Accessible name.** `alt` when there is one; the filename when there is not.
  A decorative image is still openable — the reader does not know it was marked
  decorative — but a dialog with no name is a dead end for a screen reader.
- **Focus return.** Base UI restores focus to the trigger. In the editor the trigger
  lives inside a CodeMirror widget that any keystroke may have rebuilt, so focus would
  return to a detached node; item 6 hands the editor view back explicitly instead.
  (Confirm the exact final-focus prop against the installed `@base-ui/react`.)
- **Loading and failure.** A full-size original takes a moment to decode. Show the
  stage with a spinner until `load`, and on `error` say *which* file is missing rather
  than showing the browser's broken-image glyph — the stance the editor already takes
  (`Missing image: …`) and the "known gap" sprint 7 item 4 left open in the reading
  view. Closing that gap here is why item 4 costs 3 points and not 1.
- Toolbar: zoom out / percentage / zoom in / reset / close. The percentage is a label,
  not decoration — at 340% you want to know why nothing is where you left it.
- `prefers-reduced-motion` turns the zoom transition off. A viewer that animates every
  wheel notch is a viewer that makes some people ill.

### 3 — Gestures (4 pts)

| Gesture | Behaviour |
|---|---|
| Wheel | Zoom about the pointer. Native listener, `{ passive: false }` (see point 5 above). |
| Ctrl+wheel / trackpad pinch | Same path — macOS delivers a pinch as a `ctrlKey` wheel event. Must be prevented, or the *browser* zooms the whole app. |
| Drag | Pan, via Pointer Events with capture, so a drag that leaves the window still ends cleanly. Only when zoomed past fit; at fit there is nothing to pan. |
| Double-click / double-tap | Toggle fit ⇄ 2× about the point clicked. |
| Two-finger pinch | Scale by the distance ratio, anchored at the midpoint. `touch-action: none` on the stage, or the browser eats the second pointer. |
| `+` `-` `0` | Step in, step out, reset. |
| `Esc` | Close. |
| Arrows | Pan when zoomed; item 7 makes them prev/next at fit. |

**The window-level handlers have to be made inert while this is open** (point 4). The
honest fix is a single "a modal owns the keyboard" flag the two `workspace-app`
listeners consult, rather than `stopPropagation` sprinkled at the dialog — the listeners
are on `window` in the capture-less default phase, and a modal in a portal is not an
ancestor of them anyway.

### 4 — Reading view (3 pts)

The `img` component in [doc-viewer.tsx:198](../components/workspace/doc-viewer.tsx)
becomes a `<button>` wrapping the same `<img>`, with `onClick` opening the viewer.

- A real button, not `onClick` on the `<img>`: keyboard reach and `Enter`/`Space` come
  free, and a control that only works with a mouse is the same mistake the toolbar's
  file picker was added to fix in sprint 7 item 6.
- The button must not disturb typography. It sits inside a `<p>` under `prose`, so it
  needs `display: block`, no button chrome, and the existing image classes moved onto
  the inner `<img>` unchanged. A hover affordance — a faint zoom cursor and a corner
  hint — because an image that is silently clickable is an image nobody clicks.
- **Do not open on an image that failed to load.** Track `error` per image; a failed
  one renders the named-missing-file treatment from item 2 and is not a control.
- Scroll position is restored per document from a ref
  ([doc-viewer.tsx:77](../components/workspace/doc-viewer.tsx)) and the article is what
  scrolls, not the window. Opening a dialog must not touch `article.scrollTop`, and the
  `placedFor` guard must not be tripped. Worth an explicit browser check: open the
  viewer half way down a long note, close it, confirm nothing moved.

### 5 — Public share page (2 pts)

The same component, the same props, `shareImageSrc(token, src)` for the URL. This item
is small precisely because D1 held.

Two things to confirm rather than assume:

- The share asset route sends `no-store` — deliberately, so a cached copy cannot
  outlive a revocation. So the pop-up may cost a **second request** for the same bytes
  where `/api/assets` (`immutable`) will not. Measure it; if it is real, it is
  acceptable and gets written down, not "fixed" by weakening the cache header.
- Nothing about the viewer changes what a token can reach. It renders a URL the page
  had already rendered; there is no new way to name a path.

### 6 — Editor (3 pts) — the designated cut

Per D3: an expand button in the widget's corner on hover or focus, plus mod-click.

The precise change is to `ImageWidget.ignoreEvent`, which today returns `false` for
everything so that clicks reach the editor and reveal the raw link. It becomes
**selective**: `true` when the event originated in the expand button, `false` otherwise.
Blanket `true` would take the caret path away and make alt text uneditable — the exact
thing D3 exists to protect.

Closing must return focus to the `EditorView`, not to the button: `eq()` only preserves
the widget across repaints with the same src and alt, so a keystroke while the viewer
was open can have replaced the node the button lived in.

### 7 — Prev/next within the document (3 pts, P2)

The reading view already walks the Markdown to render it, so the ordered list of images
is available at the same point the `img` component is called. Arrows and on-screen
chevrons at fit; position shown as "3 of 7". Stops at both ends — no wrap. Scope is the
open document; a share page's list is that document's images and no further.

### 8 — Open the original in a new tab (2 pts, P2)

A button that opens the resolved URL. Not a download button: the browser's own "save
image as" already exists, and on a share page the URL is the reader's credential, so
handing it to them as a shareable link is a decision with consequences (D7).

---

## Risks

| Risk | Impact | Outcome |
|---|---|---|
| Plain click in the editor swallows the alt-text path | An image's alt text becomes uneditable — a regression against a documented sprint 7 decision | **Closed.** D3 built: ⤲ button plus Mod-click, `ignoreEvent` made selective. Verified both ways — a plain click opened no viewer and brought back `![Big screenshot](assets/2026/big-screenshot.png)` |
| Wheel zoom fights the browser | Ctrl+wheel zooms the whole app; the page scrolls behind the overlay | **Closed.** The passive-root assumption held. Verified in the browser: the dispatched wheel came back `defaultPrevented: true` |
| Global Alt+Arrow / Alt+digit run under the modal | Reader dismisses the viewer onto a different document | **Closed** by [lib/modal-keys.ts](../lib/modal-keys.ts). Verified: Ctrl+K opened nothing while the viewer was up, and worked again once it closed |
| A `<button>` inside `prose` breaks typography | Every image in every note gets button chrome, spacing, or a focus ring in the wrong place | **Closed.** The button is stripped to a cursor; the existing classes stayed on the `<img>` |
| Base UI `Dialog` is styled as a small card | Overrides fight the base component; the backdrop is too faint to read against | **Closed.** `ui/dialog.tsx` is untouched — the lightbox composes `Dialog`/`DialogPortal`/`DialogOverlay` itself and darkens only its own backdrop |
| Pinch-zoom on touch is the least testable path | Ships broken on phones, where most photos are looked at | **Open.** The model is covered headless and the two-pointer plumbing is written, but no touch device was available. The one thing still needing a human with a phone |
| Very large originals | Multi-megabyte decode blocks the first paint of the pop-up | **Closed.** Spinner until `load`; the 4 MB upload cap bounds vault assets |
| Scroll restoration disturbed | Closing the viewer moves the reader in a long note | **Closed by construction** — the viewer renders through a portal, so it adds nothing to the article's scroll container, and `placedFor` is never re-entered |
| A share page refetches its images | The viewer costs a second request per picture, because the share asset route is `no-store` | **Did not materialise.** Measured on a real share: one request per image, not two — the browser's memory cache serves the viewer's copy. Nothing was weakened to get this |

---

## Non-goals

Named so they cannot creep in:

- **Editing of any kind** — no crop, rotate, annotate, or replace. This is a viewer.
- **Width syntax `![alt|400](…)`** — still blocked on the same decision that stopped
  sprint 7 item 9. It contradicts D2 of that plan ("plain CommonMark, non-negotiable").
- **Service-worker caching of images** — still contradicts a tested rule
  (`tests/service-worker.test.ts:305`). D5 keeps this feature clear of it entirely.
- **Server-side thumbnails or an image optimizer** — sprint 7 gave the reason
  `next/image` is refused here, and it has not changed: the optimizer fetches
  server-side with no session and would put a private vault's pictures in a public
  cache.
- **A gallery across the vault.** Item 7 stops at the open document (D6).

---

## Definition of done

- [x] `npm run verify` green — deps, typecheck, lint, the full test chain (24 suites),
      production build
- [x] `tests/image-zoom.test.ts` written and wired into the `test` script — 27 checks
- [x] Browser pass on the **filesystem** backend, `/api/health` checked for
      `backend: filesystem` first, as in sprint 7 items 3–5. The sandbox was a
      temporary `.env.development.local`: Next loads it ahead of `.env.local`, and a
      dotenv `KEY=` parses as an empty string, which is what selects the filesystem
      backend and — with no `APP_PASSWORD` — turns the gate off. Removed afterwards.
      **No R2 bucket was reachable from that server, live or sandbox, and nothing was
      uploaded anywhere.**
- [x] Reading view · editor · a real share link · a deliberately missing image on all
      three surfaces
- [x] No console errors beyond the deliberate 404s
- [x] `README.md` gains the viewer and its keys
- [ ] **A real phone.** Pinch and double-tap are written and the model is tested, but
      the gesture itself is unverified — see Risks
- [ ] Light/dark and keyboard-only passes by eye
- [ ] PR to `main` from `feat/20260819-image-viewer`

### What the browser pass actually showed

Numbers rather than impressions, on a 1280×720 stage:

- A 2400×1600 screenshot opens at **45%** — `min(1, 1280/2400, 720/1600)` — at offset
  `(100, 0)`, centred to the pixel.
- A 120×80 icon opens at **100%**, centred at `(580, 320)`, **not** blown up to fill
  the stage. Zoom-out and reset are disabled there; zoom-in is not.
- Wheel zoom about `(300, 200)`: the image point under the cursor came back projected
  to `(299.9998, 199.9996)` — **0.00px drift**.
- A drag of `+120,+120` moved exactly that. A flick to `(9000, 9000)` clamped to
  `(0, 0)` with no gap on any of the four edges.
- `+` from fit lands on exactly 1:1; `0` returns to exactly 45%; double-click goes to
  1:1 on the screenshot and to 200% on the icon.
- Ending a drag on the backdrop does **not** dismiss; a click that never moved does.
- The editor's ⤲ opened `/api/assets?path=assets%2F2026%2Fbig-screenshot.png` with its
  alt intact, and closing returned focus to `.cm-content` rather than to the widget
  button that no longer existed.
- The share page resolved every image through `/api/share/<token>/asset` and never
  through `/api/assets`.

**Two things the browser was wrong about, and one it was right about.** The pane was not
displayed, so `document.visibilityState` was `hidden`: animations freeze, `rAF` stops,
and lazy images never load. That made (a) every dialog in the app — not just this one —
stay mounted after closing, because Base UI waits for an `animationend` that cannot
arrive, and (b) the expand button's computed opacity read `1` where its rule says `0`.
Both were chased down rather than assumed: the first reproduced identically on the
pre-existing password-vault dialog, and the second was settled by inserting a fresh
element with the same class, which computed to `0` — the cascade is right, and the
existing button's opacity transition was simply frozen mid-flight. Neither is a defect,
and neither was "fixed".

What it *was* right about: `setPointerCapture` throws for a pointer the browser no
longer considers active, and it was being called *before* the pointer was recorded — so
a throw there would have aborted the entire drag. Capture is now taken after the pointer
is tracked and allowed to fail, since it only makes a drag that leaves the window more
robust and is not a precondition for one.

## Key dates

| Date | Event |
|---|---|
| Wed 19 Aug | Start · D1–D7 settled · React passive-wheel assumption verified |
| Fri 21 Aug | Items 1–2 landed (model + shell, not yet reachable from anywhere) |
| Mon 25 Aug | Items 3–4 demoable — the feature is real from here |
| Thu 28 Aug | Item 5 (share) · cut decision on item 6 taken here |
| Tue 1 Sep | Done / demo · stretch items 7–8 only if 1–6 are finished and verified |
