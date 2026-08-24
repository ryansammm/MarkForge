/**
 * The arithmetic behind the image viewer: scale, offset, and the rules that keep a
 * picture reachable inside its stage.
 *
 * No DOM and no React on purpose, for the same reason `previewNodes` was split out of
 * the live-preview `ViewPlugin` in sprint 6: the interesting part of a zoomable viewer
 * is arithmetic, and arithmetic is testable headless. This repo's suites run under
 * `tsx` with no DOM, so a model tangled into a component is a model that gets verified
 * by clicking around and hoping. See tests/image-zoom.test.ts.
 *
 * **The coordinate model**, which every function here assumes:
 *
 * - The *stage* is the visible box the picture is shown in. Its origin is its own
 *   top-left corner.
 * - `scale` multiplies the image's **natural** pixel size. `scale === 1` is one image
 *   pixel per CSS pixel.
 * - `x`/`y` are where the image's top-left corner sits, in stage coordinates. They are
 *   usually negative once zoomed in, because the corner has been pushed off the top
 *   left of the stage.
 *
 * That is exactly `translate(x, y) scale(s)` with a `top left` transform origin, so the
 * component can hand these three numbers straight to CSS without converting anything.
 */

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface Viewport {
  scale: number
  x: number
  y: number
}

/**
 * The ceiling.
 *
 * Eight times natural size is past the point where any real image has more to give —
 * beyond this the reader is looking at interpolation, not at their picture.
 */
export const MAX_SCALE = 8

/** What the toolbar buttons walk between, on top of whatever `fitScale` works out. */
const LADDER = [1, 1.5, 2, 3, 4, 6, 8]

/** Floating-point slack. Scales are compared, never matched exactly. */
const EPSILON = 1e-4

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

/** A size that can be divided by. Guards the first frame, before anything is measured. */
function usable(size: Size): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  )
}

/**
 * The scale that fits `image` inside `stage`.
 *
 * **Never above 1** (D4 in docs/image-viewer-plan.md). A 200px icon opened in a
 * full-screen viewer should arrive at 200px, not blown up to fill the window and
 * blurry — "fit" means *fits*, not "fills". Growing it is a thing the reader can ask
 * for; doing it unasked makes small images look broken.
 */
export function fitScale(image: Size, stage: Size): number {
  if (!usable(image) || !usable(stage)) return 1
  return Math.min(1, stage.width / image.width, stage.height / image.height)
}

/**
 * The image centred in the stage at its fit scale — the state the viewer opens in, and
 * the one `0` and double-click return to.
 */
export function fitViewport(image: Size, stage: Size): Viewport {
  const scale = fitScale(image, stage)
  return centre({ scale, x: 0, y: 0 }, image, stage)
}

/** The offsets that centre the image at the viewport's current scale. */
function centre(view: Viewport, image: Size, stage: Size): Viewport {
  return {
    scale: view.scale,
    x: (stage.width - image.width * view.scale) / 2,
    y: (stage.height - image.height * view.scale) / 2,
  }
}

/**
 * Pulls an offset back into the range where the image is still worth looking at.
 *
 * Two rules, one per axis, and they differ by which is bigger:
 *
 * - **Image smaller than the stage on this axis** — it is centred, and no pan can move
 *   it. There is nothing off-screen to go and find, so dragging it into a corner would
 *   only lose it.
 * - **Image bigger** — the offset is bounded so that an edge of the image can never be
 *   dragged past the matching edge of the stage. The stage is therefore always full of
 *   picture, and a fast drag cannot fling the image out of sight and leave the reader
 *   staring at an empty overlay with no way back except the reset button.
 */
export function clampPan(view: Viewport, image: Size, stage: Size): Viewport {
  if (!usable(image) || !usable(stage)) return view

  const scaledWidth = image.width * view.scale
  const scaledHeight = image.height * view.scale

  return {
    scale: view.scale,
    x:
      scaledWidth <= stage.width
        ? (stage.width - scaledWidth) / 2
        : clamp(view.x, stage.width - scaledWidth, 0),
    y:
      scaledHeight <= stage.height
        ? (stage.height - scaledHeight) / 2
        : clamp(view.y, stage.height - scaledHeight, 0),
  }
}

/**
 * Zoom by `factor` about a point in stage coordinates, keeping whatever is under that
 * point where it is.
 *
 * This is the one piece of real maths here, and it is the difference between a viewer
 * that feels direct and one that feels like it is fighting you. The image point under
 * the cursor before the zoom must still be under the cursor after it:
 *
 *     x' = a - (a - x) · (s' / s)
 *
 * Zooming about the stage's centre instead — which is what a naive implementation
 * does — walks the thing you were trying to look at off the edge after two notches.
 *
 * The floor is the fit scale rather than some fixed minimum: below fit the picture is
 * an island in a sea of backdrop, and shrinking it further reveals nothing.
 */
export function zoomAbout(
  view: Viewport,
  factor: number,
  anchor: Point,
  image: Size,
  stage: Size
): Viewport {
  if (!usable(image) || !usable(stage) || !(view.scale > 0)) return view

  const next = clamp(view.scale * factor, fitScale(image, stage), MAX_SCALE)
  const ratio = next / view.scale
  if (Math.abs(ratio - 1) < EPSILON) return view

  return clampPan(
    {
      scale: next,
      x: anchor.x - (anchor.x - view.x) * ratio,
      y: anchor.y - (anchor.y - view.y) * ratio,
    },
    image,
    stage
  )
}

/** Zoom to an absolute scale about a point. `zoomAbout` expressed the other way round. */
export function zoomTo(
  view: Viewport,
  scale: number,
  anchor: Point,
  image: Size,
  stage: Size
): Viewport {
  if (!(view.scale > 0)) return view
  return zoomAbout(view, scale / view.scale, anchor, image, stage)
}

/**
 * The next rung up or down, for the toolbar buttons and the `+` / `-` keys.
 *
 * The fit scale is spliced into the ladder rather than replaced by it, so a photo that
 * fits at 0.3 steps 0.3 → 1 → 1.5 → … and can always get back to exactly the view it
 * opened in. Stepping is anchored at the stage centre, because a keystroke has no
 * pointer to anchor to and the centre is where the reader is looking.
 */
export function stepZoom(view: Viewport, direction: 1 | -1, image: Size, stage: Size): Viewport {
  const fit = fitScale(image, stage)
  const rungs = [fit, ...LADDER.filter((rung) => rung > fit + EPSILON && rung <= MAX_SCALE)]

  const next =
    direction === 1
      ? rungs.find((rung) => rung > view.scale + EPSILON)
      : [...rungs].reverse().find((rung) => rung < view.scale - EPSILON)

  if (next === undefined) return view
  return zoomTo(view, next, { x: stage.width / 2, y: stage.height / 2 }, image, stage)
}

/**
 * What a double-click or double-tap does: away from fit, or back to it.
 *
 * Going *in*, the target is 1:1 for anything that had to be shrunk to fit — which is
 * the case that matters, because a screenshot shown at 40% is exactly the picture whose
 * text cannot be read, and its natural size is precisely the size that fixes it. An
 * image that already fits whole has nothing to reveal at 1:1, so it doubles instead.
 */
export function toggleScale(view: Viewport, anchor: Point, image: Size, stage: Size): Viewport {
  const fit = fitScale(image, stage)
  if (view.scale > fit + EPSILON) return fitViewport(image, stage)

  const target = clamp(fit < 1 - EPSILON ? 1 : 2, fit, MAX_SCALE)
  return zoomTo(view, target, anchor, image, stage)
}

/** Drag, and arrow keys. The clamp is what stops a fast flick losing the picture. */
export function panBy(view: Viewport, dx: number, dy: number, image: Size, stage: Size): Viewport {
  return clampPan({ scale: view.scale, x: view.x + dx, y: view.y + dy }, image, stage)
}

/**
 * Whether there is anything to pan to.
 *
 * Drives the cursor as much as the behaviour: a grab hand over an image that cannot
 * move is a promise the viewer does not keep.
 */
export function isPannable(view: Viewport, image: Size, stage: Size): boolean {
  if (!usable(image) || !usable(stage)) return false
  return (
    image.width * view.scale > stage.width + EPSILON ||
    image.height * view.scale > stage.height + EPSILON
  )
}

/** Whether the viewer is showing the picture exactly as it opened. */
export function isFitted(view: Viewport, image: Size, stage: Size): boolean {
  return Math.abs(view.scale - fitScale(image, stage)) < EPSILON
}

/**
 * A wheel notch as a zoom factor.
 *
 * Exponential rather than linear, so a notch is the same *proportion* at every scale —
 * linear steps crawl when zoomed in and lurch when zoomed out. `deltaMode` is honoured
 * because Firefox reports wheels in lines, not pixels, and reading the number without
 * its unit makes the same gesture behave differently in one browser.
 *
 * The clamp catches the other end of that: a single high-resolution trackpad flick can
 * report several hundred pixels, and an unbounded exponent turns it into a jump from
 * fit to the ceiling.
 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1
  const lines = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1
  return clamp(Math.exp(-deltaY * lines * 0.0025), 0.2, 5)
}

/** The midpoint and separation of two pointers, which is all a pinch is. */
export function pinchOf(a: Point, b: Point): { centre: Point; distance: number } {
  return {
    centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.hypot(a.x - b.x, a.y - b.y),
  }
}

/** A percentage a person can read, for the toolbar. */
export function scaleLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`
}
