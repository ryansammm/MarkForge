import {
  MAX_SCALE,
  clampPan,
  fitScale,
  fitViewport,
  isFitted,
  isPannable,
  panBy,
  pinchOf,
  scaleLabel,
  stepZoom,
  toggleScale,
  wheelFactor,
  zoomAbout,
  zoomTo,
  type Size,
  type Viewport,
} from '../components/workspace/image-zoom'

/**
 * Image viewer zoom model suite.
 *
 * The property under test is that a picture can never be lost. A viewer is a box with
 * one thing in it, and every failure mode is the same shape: the reader zooms or drags,
 * the image goes somewhere they cannot follow, and the only way back is a button they
 * have to think to find. So most of what is asserted here is containment — after any
 * operation, the stage is still full of picture, or the picture is centred in it.
 *
 * The other load-bearing check is the anchor rule. `zoomAbout` keeps the image point
 * under the cursor fixed, and getting that subtly wrong does not throw, does not log,
 * and does not look broken in a screenshot — it just makes the viewer feel like it is
 * pulling away from wherever you point. That is asserted numerically rather than left
 * to the hand pass.
 *
 * No DOM here: this is the whole reason the model was split out of the component.
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

function close(actual: number, expected: number, message: string, tolerance = 0.01) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}\n      expected: ${expected}\n      actual:   ${actual}`)
  }
}

/** A stage the size of a laptop viewport, less the viewer's own chrome. */
const STAGE: Size = { width: 1000, height: 700 }
/** A screenshot too big to fit — the case the whole feature exists for. */
const BIG: Size = { width: 2400, height: 1600 }
/** An icon that fits several times over. */
const SMALL: Size = { width: 200, height: 120 }

/**
 * Where an image point lands on the stage, given a viewport. The inverse of what the
 * component asks CSS to do, and the only way to state the anchor rule as a number.
 */
function project(view: Viewport, point: Point): Point {
  return { x: view.x + point.x * view.scale, y: view.y + point.y * view.scale }
}

/** Which image point is currently under a point on the stage. */
function imagePointAt(view: Viewport, stagePoint: Point): Point {
  return {
    x: (stagePoint.x - view.x) / view.scale,
    y: (stagePoint.y - view.y) / view.scale,
  }
}

interface Point {
  x: number
  y: number
}

/** The invariant every operation has to leave standing. */
function assertContained(view: Viewport, image: Size, stage: Size, message: string) {
  const width = image.width * view.scale
  const height = image.height * view.scale

  if (width <= stage.width + 0.01) {
    close(view.x, (stage.width - width) / 2, `${message}: not centred horizontally`)
  } else {
    assert(view.x <= 0.01, `${message}: a gap opened on the left`)
    assert(view.x + width >= stage.width - 0.01, `${message}: a gap opened on the right`)
  }

  if (height <= stage.height + 0.01) {
    close(view.y, (stage.height - height) / 2, `${message}: not centred vertically`)
  } else {
    assert(view.y <= 0.01, `${message}: a gap opened at the top`)
    assert(view.y + height >= stage.height - 0.01, `${message}: a gap opened at the bottom`)
  }
}

export function runImageZoomTests(): boolean {
  console.log('Image viewer zoom model suite\n')

  console.log('opening')

  check('a large image is scaled down to fit', () => {
    // 1000/2400 is tighter than 700/1600 for this pair, so width is the axis that
    // decides. Taking the looser one would overflow the stage on the other.
    close(fitScale(BIG, STAGE), 1000 / 2400, 'the tighter of the two axes did not win')
  })

  check('a small image opens at natural size, not blown up', () => {
    close(fitScale(SMALL, STAGE), 1, 'fit means fits, not fills')
  })

  check('the opening viewport centres the image', () => {
    const view = fitViewport(BIG, STAGE)
    assertContained(view, BIG, STAGE, 'the opening view')
    close(view.x, 0, 'the deciding axis should touch both edges')
    close(view.y, (700 - 1600 * (1000 / 2400)) / 2, 'the other axis is not centred')
  })

  check('an unmeasured stage does not produce NaN', () => {
    // The first frame runs before anything has been laid out, and a NaN transform
    // silently paints nothing at all rather than failing loudly.
    const view = fitViewport(BIG, { width: 0, height: 0 })
    assert(Number.isFinite(view.scale), 'scale went non-finite')
    assert(Number.isFinite(view.x) && Number.isFinite(view.y), 'an offset went non-finite')
  })

  console.log('\nthe anchor rule')

  check('the point under the cursor stays under the cursor', () => {
    const view = fitViewport(BIG, STAGE)
    const anchor = { x: 300, y: 200 }
    const before = imagePointAt(view, anchor)

    const zoomed = zoomAbout(view, 2, anchor, BIG, STAGE)
    const after = project(zoomed, before)

    close(after.x, anchor.x, 'the image slid horizontally under the cursor', 0.5)
    close(after.y, anchor.y, 'the image slid vertically under the cursor', 0.5)
  })

  check('the anchor holds through a run of small steps', () => {
    // A trackpad delivers dozens of these a second; drift that is invisible in one
    // step is what makes a viewer feel like it is crawling away from the pointer.
    //
    // Started from a viewport that already overflows the stage on both axes, so the
    // containment rule is not competing for the same numbers — see the check below,
    // which is where that competition is asserted deliberately.
    let view = zoomTo(fitViewport(BIG, STAGE), 2, { x: 500, y: 350 }, BIG, STAGE)
    const anchor = { x: 620, y: 260 }
    const before = imagePointAt(view, anchor)

    for (let i = 0; i < 20; i++) view = zoomAbout(view, 1.06, anchor, BIG, STAGE)

    const after = project(view, before)
    close(after.x, anchor.x, 'drift accumulated horizontally', 1)
    close(after.y, anchor.y, 'drift accumulated vertically', 1)
  })

  check('containment beats the anchor when the two disagree', () => {
    // Zooming about a point near the edge of an image that does not yet fill the
    // stage would open a gap beside it. The anchor loses, on purpose: a gap is a
    // visible defect, and a picture sliding a few pixels under the cursor is not.
    const view = zoomAbout(fitViewport(BIG, STAGE), 1.2, { x: 990, y: 10 }, BIG, STAGE)
    assertContained(view, BIG, STAGE, 'after zooming about a corner')
  })

  check('zooming in and back out returns to the opening view', () => {
    const view = fitViewport(BIG, STAGE)
    const anchor = { x: 500, y: 350 }
    const round = zoomAbout(zoomAbout(view, 3, anchor, BIG, STAGE), 1 / 3, anchor, BIG, STAGE)

    close(round.scale, view.scale, 'the scale did not come back')
    close(round.x, view.x, 'the horizontal offset did not come back', 0.5)
    close(round.y, view.y, 'the vertical offset did not come back', 0.5)
  })

  check('zoom stops at the ceiling', () => {
    const view = zoomAbout(fitViewport(BIG, STAGE), 1000, { x: 0, y: 0 }, BIG, STAGE)
    close(view.scale, MAX_SCALE, 'the ceiling was passed')
  })

  check('zoom out stops at fit, not below it', () => {
    const view = zoomAbout(fitViewport(BIG, STAGE), 0.001, { x: 0, y: 0 }, BIG, STAGE)
    close(view.scale, fitScale(BIG, STAGE), 'the image shrank below fit')
    assertContained(view, BIG, STAGE, 'after zooming out hard')
  })

  check('a zoom that changes nothing returns the same viewport', () => {
    const view = fitViewport(BIG, STAGE)
    assert(zoomAbout(view, 1, { x: 10, y: 10 }, BIG, STAGE) === view, 'a no-op still allocated')
  })

  console.log('\ncontainment')

  check('an image smaller than the stage cannot be panned', () => {
    const view = panBy(fitViewport(SMALL, STAGE), 400, 400, SMALL, STAGE)
    assertContained(view, SMALL, STAGE, 'after dragging a small image')
    assert(!isPannable(view, SMALL, STAGE), 'a small image reported itself pannable')
  })

  check('a fitted large image is not pannable either', () => {
    const view = fitViewport(BIG, STAGE)
    assert(!isPannable(view, BIG, STAGE), 'a fitted image reported itself pannable')
    assert(isFitted(view, BIG, STAGE), 'the opening view did not report itself fitted')
  })

  check('a flick cannot throw the picture off the stage', () => {
    const zoomed = zoomTo(fitViewport(BIG, STAGE), 4, { x: 500, y: 350 }, BIG, STAGE)
    assert(isPannable(zoomed, BIG, STAGE), 'a zoomed image should be pannable')

    for (const [dx, dy] of [
      [99999, 0],
      [-99999, 0],
      [0, 99999],
      [0, -99999],
      [99999, -99999],
    ]) {
      assertContained(panBy(zoomed, dx, dy, BIG, STAGE), BIG, STAGE, `after a flick of ${dx},${dy}`)
    }
  })

  check('zooming out from a corner pulls the image back over the stage', () => {
    // The case a naive clamp misses: the offset was legal at 6x and is not at 1x, and
    // nothing else will correct it — the reader would be left with a band of backdrop
    // down one side and no gesture that closes it.
    const corner = panBy(
      zoomTo(fitViewport(BIG, STAGE), 6, { x: 0, y: 0 }, BIG, STAGE),
      99999,
      99999,
      BIG,
      STAGE
    )
    assertContained(zoomAbout(corner, 1 / 6, { x: 0, y: 0 }, BIG, STAGE), BIG, STAGE, 'after zooming back out')
  })

  console.log('\nsteps, keys and gestures')

  check('the ladder starts at fit and climbs', () => {
    const fit = fitViewport(BIG, STAGE)
    const one = stepZoom(fit, 1, BIG, STAGE)
    const two = stepZoom(one, 1, BIG, STAGE)

    close(one.scale, 1, 'the first step up should be 1:1')
    close(two.scale, 1.5, 'the second step should be 1.5')
  })

  check('stepping down from the first rung lands exactly on fit', () => {
    const fit = fitViewport(BIG, STAGE)
    const back = stepZoom(stepZoom(fit, 1, BIG, STAGE), -1, BIG, STAGE)
    close(back.scale, fitScale(BIG, STAGE), 'fit is not reachable from the ladder')
    assert(isFitted(back, BIG, STAGE), 'the view did not report itself fitted again')
  })

  check('stepping past either end is a no-op, not an error', () => {
    const fit = fitViewport(BIG, STAGE)
    assert(stepZoom(fit, -1, BIG, STAGE) === fit, 'stepped below fit')

    let view = fit
    for (let i = 0; i < 20; i++) view = stepZoom(view, 1, BIG, STAGE)
    close(view.scale, MAX_SCALE, 'the ladder climbed past the ceiling')
  })

  check('double-click on a shrunken image goes to 1:1, and back', () => {
    const fit = fitViewport(BIG, STAGE)
    const anchor = { x: 400, y: 300 }
    const zoomed = toggleScale(fit, anchor, BIG, STAGE)

    close(zoomed.scale, 1, 'a screenshot should open out to its own pixels')
    assert(isFitted(toggleScale(zoomed, anchor, BIG, STAGE), BIG, STAGE), 'the second click did not return to fit')
  })

  check('double-click on an image that already fits doubles it instead', () => {
    const view = toggleScale(fitViewport(SMALL, STAGE), { x: 500, y: 350 }, SMALL, STAGE)
    close(view.scale, 2, '1:1 would have done nothing here')
  })

  check('a wheel notch is proportional, and reversible', () => {
    const inward = wheelFactor(-100)
    const outward = wheelFactor(100)
    assert(inward > 1, 'scrolling up did not zoom in')
    assert(outward < 1, 'scrolling down did not zoom out')
    close(inward * outward, 1, 'a notch each way did not cancel out')
  })

  check('a wheel reported in lines is not read as pixels', () => {
    // Firefox reports deltaMode 1. Read as pixels, three lines would be a rounding
    // error instead of a zoom, and the wheel would feel dead in one browser only.
    close(wheelFactor(-3, 1), wheelFactor(-48, 0), 'lines and pixels disagree')
  })

  check('a violent flick cannot cross the whole range in one event', () => {
    assert(wheelFactor(-5000) <= 5, 'one event could jump five-fold or more')
    assert(wheelFactor(5000) >= 0.2, 'one event could collapse the view')
  })

  check('a pinch is a midpoint and a distance', () => {
    const { centre, distance } = pinchOf({ x: 0, y: 0 }, { x: 60, y: 80 })
    close(centre.x, 30, 'the midpoint is wrong horizontally')
    close(centre.y, 40, 'the midpoint is wrong vertically')
    close(distance, 100, 'the separation is wrong')
  })

  check('the percentage is readable', () => {
    close(Number(scaleLabel(0.4375).replace('%', '')), 44, 'the label did not round')
  })

  console.log('\nresizing the window under an open viewer')

  check('a stage that shrinks re-centres rather than stranding the image', () => {
    const view = clampPan(fitViewport(BIG, STAGE), BIG, { width: 400, height: 300 })
    assertContained(view, BIG, { width: 400, height: 300 }, 'after the stage shrank')
  })

  check('a stage that grows past the image re-centres it', () => {
    const wide = { width: 4000, height: 3000 }
    assertContained(clampPan(fitViewport(BIG, STAGE), BIG, wide), BIG, wide, 'after the stage grew')
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

if (require.main === module) {
  process.exit(runImageZoomTests() ? 0 : 1)
}
