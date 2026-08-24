'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { ImageOff, Loader2, Maximize2, Minus, Plus, X } from 'lucide-react'
import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { claimKeyboard } from '@/lib/modal-keys'
import { cn } from '@/lib/utils'
import {
  clampPan,
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
  type Point,
  type Size,
  type Viewport,
} from './image-zoom'

/** One picture, as the viewer needs it. */
export interface ViewedImage {
  /**
   * The URL to load, **already resolved**.
   *
   * The viewer never maps a vault path to a URL, and that is the load-bearing decision
   * of the whole feature (D1 in docs/image-viewer-plan.md). Two resolvers exist —
   * `resolveImageSrc` points at the session-gated route, `shareImageSrc` carries a
   * public reader's only credential — and sprint 7 kept them apart deliberately. A
   * viewer that chose between them would be a third place that could choose wrong. It
   * cannot choose wrong, because it has no idea what a token is.
   */
  src: string
  alt: string
  /**
   * What the document says the image is — the raw `![…](here)` target.
   *
   * Shown to a person, and used to name the file when an image fails to load. Never
   * fetched, never resolved, never turned into a URL.
   */
  source?: string
}

interface ImageLightboxProps {
  /** The picture on screen, or null when the viewer is closed. */
  image: ViewedImage | null
  onClose: () => void
  /**
   * Where focus goes when the viewer closes. Defaults to the element that opened it.
   *
   * The editor has to override this: its trigger lives inside a CodeMirror widget that
   * any keystroke may have rebuilt, so the default would restore focus to a node that
   * is no longer in the document.
   */
  finalFocus?: DialogPrimitive.Popup.Props['finalFocus']
}

type Status = 'loading' | 'ready' | 'error'

const NO_SIZE: Size = { width: 0, height: 0 }

/**
 * Everything the viewer knows, in one object.
 *
 * One piece of state rather than five, because every gesture needs the sizes *and* the
 * current viewport to compute the next one, and a functional update is the only way to
 * read those without either a stale closure or a ref written during render. The
 * alternative — mirroring sizes into refs for the native listeners — is what this
 * replaced, and the linter was right about it.
 */
interface Session {
  status: Status
  /** The image's own pixel size, known only once it has loaded. */
  natural: Size
  /** The box it is shown in, measured. */
  stage: Size
  view: Viewport
  /** Whether this change should animate. Off for wheel, drag and pinch. */
  smooth: boolean
  /** Whether the reader has zoomed. Until they have, a resize refits. */
  touched: boolean
}

const START: Session = {
  status: 'loading',
  natural: NO_SIZE,
  stage: NO_SIZE,
  view: { scale: 1, x: 0, y: 0 },
  smooth: false,
  touched: false,
}

/**
 * A picture, as large as the screen will allow, zoomable and pannable.
 *
 * Built on the project's `Dialog` primitives rather than a bespoke overlay: the focus
 * trap, the scroll lock, Esc, the portal and the enter/exit animation are all solved
 * there and themed with everything else. What is *not* reused is `DialogContent`, which
 * is a centred small card — the six dialogs that use it should keep looking like cards,
 * so the full-bleed stage is composed here instead of adding a mode to a shared thing.
 *
 * All the arithmetic lives in image-zoom.ts and is tested headless. What is left here
 * is event plumbing, which is the part that has to be checked in a browser anyway.
 */
export function ImageLightbox({ image, onClose, finalFocus }: ImageLightboxProps) {
  return (
    <Dialog
      open={image !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogPortal>
        {/* Darker than the shared card backdrop, which is `bg-black/10`: a picture is
            looked at, and it cannot be looked at against the document it came from. */}
        <DialogOverlay className="bg-black/80 supports-backdrop-filter:backdrop-blur-sm" />
        <DialogPrimitive.Popup
          data-slot="image-lightbox"
          finalFocus={finalFocus}
          className="fixed inset-0 z-50 flex flex-col outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          {/*
            Keyed on the URL and mounted only while open, so every picture starts from
            a clean session — loading, unmeasured, unzoomed. An effect resetting five
            pieces of state on the way in is the same thing written worse, and it
            renders one frame of the previous image's zoom before it takes effect.
          */}
          {image && <Stage key={image.src} image={image} onClose={onClose} />}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

function Stage({ image, onClose }: { image: ViewedImage; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [session, setSession] = useState<Session>(START)
  const { status, natural, stage, view, smooth } = session

  /* --- the modal owns the keyboard while it is up ------------------------------- */
  /*
    The workspace binds Alt+Arrow and Alt+digit on `window`, where they fire whatever
    is on screen — including this. See lib/modal-keys.ts.
  */
  useEffect(() => claimKeyboard(), [])

  /* --- the stage measures itself ------------------------------------------------ */
  /*
    `ResizeObserver` reports once when it starts observing, so the first measurement
    arrives through the same path as every later one and the effect body itself sets
    nothing.
  */
  useEffect(() => {
    const element = stageRef.current
    if (!element) return

    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      const next: Size = { width: rect.width, height: rect.height }

      setSession((current) => {
        if (current.stage.width === next.width && current.stage.height === next.height) {
          return current
        }
        if (!current.natural.width) return { ...current, stage: next }
        /*
          Until the reader has zoomed, a resize refits. After that their scale is kept
          and only the offset is corrected: silently undoing someone's zoom because
          they dragged the window is worse than a slightly odd framing.
        */
        return {
          ...current,
          stage: next,
          smooth: false,
          view: current.touched
            ? clampPan(current.view, current.natural, next)
            : fitViewport(current.natural, next),
        }
      })
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /** Every gesture, expressed as "here is the next viewport, given the current one". */
  const apply = useCallback((next: (current: Session) => Viewport, animate: boolean) => {
    setSession((current) => {
      if (current.status !== 'ready' || !current.natural.width || !current.stage.width) {
        return current
      }
      const view = next(current)
      if (view === current.view) return current
      return { ...current, view, smooth: animate, touched: true }
    })
  }, [])

  /** A client point in the stage's own coordinates, which is what the model works in. */
  const stagePoint = useCallback((clientX: number, clientY: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect()
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) }
  }, [])

  /* --- wheel -------------------------------------------------------------------- */
  /*
    Attached natively, with `{ passive: false }`. React registers its root `wheel`
    listener as passive, so `preventDefault()` from an `onWheel` prop does not stop the
    page scrolling behind the overlay — and on macOS a trackpad pinch arrives as a
    `ctrlKey` wheel event, which unprevented zooms the entire application instead of
    the picture.
  */
  useEffect(() => {
    const element = stageRef.current
    if (!element) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = wheelFactor(event.deltaY, event.deltaMode)
      const anchor = stagePoint(event.clientX, event.clientY)
      apply((current) => zoomAbout(current.view, factor, anchor, current.natural, current.stage), false)
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [apply, stagePoint])

  /* --- drag and pinch ----------------------------------------------------------- */
  /*
    Pointer Events rather than mouse and touch handlers, so one code path covers a
    mouse, a finger and a pen. Capture is taken on the way down: a drag that leaves the
    window still delivers its `pointerup`, which is what stops the image sticking to
    the cursor after the button was released somewhere else.
  */
  const pointers = useRef(new Map<number, Point>())
  const pinchDistance = useRef<number | null>(null)
  /** Set once a pointer has moved, so a click can be told from the end of a drag. */
  const dragged = useRef(false)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    dragged.current = false
    /*
      Capture is an improvement on the gesture, not a precondition for it: it keeps a
      drag that leaves the window delivering its moves and its `pointerup`. Taken after
      the pointer is tracked, and allowed to fail — `setPointerCapture` throws for a
      pointer the browser no longer considers active, and losing the whole drag over
      the thing that was only meant to make it more robust is the wrong trade.
    */
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Drag still works; it just ends if the pointer leaves the window.
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchDistance.current = pinchOf(a, b).distance
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    const current = { x: event.clientX, y: event.clientY }
    pointers.current.set(event.pointerId, current)

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const { centre, distance } = pinchOf(a, b)
      const was = pinchDistance.current
      pinchDistance.current = distance
      if (!was || !distance) return
      dragged.current = true
      const anchor = stagePoint(centre.x, centre.y)
      apply((state) => zoomAbout(state.view, distance / was, anchor, state.natural, state.stage), false)
      return
    }

    const dx = current.x - previous.x
    const dy = current.y - previous.y
    if (dx === 0 && dy === 0) return
    dragged.current = true
    apply((state) => {
      // Checked here rather than before the gesture, so a pointer that started at fit
      // and zoomed mid-drag is still handled by the same code path.
      if (!isPannable(state.view, state.natural, state.stage)) return state.view
      return panBy(state.view, dx, dy, state.natural, state.stage)
    }, false)
  }

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinchDistance.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  /* --- keys --------------------------------------------------------------------- */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      apply((current) => stepZoom(current.view, 1, current.natural, current.stage), true)
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      apply((current) => stepZoom(current.view, -1, current.natural, current.stage), true)
    } else if (event.key === '0') {
      event.preventDefault()
      apply((current) => fitViewport(current.natural, current.stage), true)
    } else if (event.key.startsWith('Arrow')) {
      // Panning only, and only when there is somewhere to pan to. At fit the key is
      // left alone rather than swallowed, which is what keeps the viewer feeling
      // finished instead of unresponsive.
      if (!isPannable(view, natural, stage)) return
      event.preventDefault()
      const step = event.shiftKey ? 200 : 60
      const [dx, dy] =
        event.key === 'ArrowLeft'
          ? [step, 0]
          : event.key === 'ArrowRight'
            ? [-step, 0]
            : event.key === 'ArrowUp'
              ? [0, step]
              : [0, -step]
      apply((current) => panBy(current.view, dx, dy, current.natural, current.stage), true)
    }
  }

  const fitted = isFitted(view, natural, stage)
  const pannable = isPannable(view, natural, stage)
  const name = image.source?.split('/').pop()
  /* A dialog needs a name, and a decorative image has no alt to give it one. */
  const title = image.alt || name || 'Image'

  return (
    <>
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>

      <div
        ref={stageRef}
        onKeyDown={onKeyDown}
        /*
          Focusable so the keys below have somewhere to land — Base UI moves focus into
          the popup on open, and the stage is the only thing in it worth focusing.
          `tabIndex={-1}` keeps it out of the tab order, where a scrollable region with
          no controls is a dead stop.
        */
        tabIndex={-1}
        className={cn(
          'relative flex-1 overflow-hidden outline-none select-none',
          // Without this the browser claims the second finger for its own pinch zoom
          // and the gesture never reaches the handlers above.
          'touch-none',
          status === 'ready' && (pannable ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in')
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={(event) => {
          const anchor = stagePoint(event.clientX, event.clientY)
          apply((current) => toggleScale(current.view, anchor, current.natural, current.stage), true)
        }}
        onClick={(event) => {
          // Clicking the empty space around the picture dismisses, the way every
          // lightbox does. A drag that happens to end on the backdrop is not a click,
          // or panning a zoomed image would close the viewer half the time.
          if (dragged.current) return
          if (event.target === event.currentTarget) onClose()
        }}
      >
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-white/70">
            <Loader2 className="size-8 animate-spin" aria-hidden />
            <span className="sr-only">Loading image</span>
          </div>
        )}

        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-white/80">
            <ImageOff className="size-8 stroke-[1.5]" aria-hidden />
            {/* Named, not a broken-image glyph — the stance the editor already takes,
                and the gap sprint 7 left open in the reading view. */}
            <p className="text-sm font-medium">Missing image</p>
            <p className="max-w-lg font-mono text-xs break-all opacity-70">
              {image.source ?? image.alt}
            </p>
          </div>
        )}

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.src}
          alt={image.alt}
          draggable={false}
          onLoad={(event) => {
            const element = event.currentTarget
            const measured = stageRef.current?.getBoundingClientRect()
            const next: Size = measured
              ? { width: measured.width, height: measured.height }
              : NO_SIZE
            const naturalSize: Size = {
              width: element.naturalWidth,
              height: element.naturalHeight,
            }
            setSession((current) => {
              const box = next.width ? next : current.stage
              return {
                ...current,
                status: 'ready',
                natural: naturalSize,
                stage: box,
                smooth: false,
                view: fitViewport(naturalSize, box),
              }
            })
          }}
          onError={() => setSession((current) => ({ ...current, status: 'error' }))}
          style={{
            width: natural.width || undefined,
            height: natural.height || undefined,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: 'top left',
            willChange: 'transform',
          }}
          className={cn(
            'absolute top-0 left-0 max-w-none',
            status === 'ready' ? 'opacity-100' : 'opacity-0',
            // Only button- and key-driven changes animate, and only for readers who
            // have not asked for less motion. A viewer that eases every wheel notch
            // lags behind the gesture it is meant to be following.
            smooth && 'transition-transform duration-150 motion-reduce:transition-none'
          )}
        />
      </div>

      {/* --- chrome ------------------------------------------------------------- */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-3">
        <p className="pointer-events-auto max-w-[60%] truncate rounded-md bg-black/40 px-2 py-1 text-xs text-white/80">
          {title}
        </p>

        <div className="pointer-events-auto flex items-center gap-1 rounded-lg bg-black/40 p-1 text-white">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-white hover:bg-white/15 hover:text-white"
            disabled={status !== 'ready' || fitted}
            onClick={() => apply((c) => stepZoom(c.view, -1, c.natural, c.stage), true)}
            aria-label="Zoom out"
          >
            <Minus />
          </Button>

          {/* A label, not decoration: at 340% it is the only thing that explains why
              nothing is where it was left. */}
          <span className="min-w-14 text-center font-mono text-xs tabular-nums" aria-live="polite">
            {status === 'ready' ? scaleLabel(view.scale) : '—'}
          </span>

          <Button
            variant="ghost"
            size="icon-sm"
            className="text-white hover:bg-white/15 hover:text-white"
            disabled={status !== 'ready'}
            onClick={() => apply((c) => stepZoom(c.view, 1, c.natural, c.stage), true)}
            aria-label="Zoom in"
          >
            <Plus />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            className="text-white hover:bg-white/15 hover:text-white"
            disabled={status !== 'ready' || fitted}
            onClick={() => apply((c) => fitViewport(c.natural, c.stage), true)}
            aria-label="Reset zoom"
          >
            <Maximize2 />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            className="text-white hover:bg-white/15 hover:text-white"
            onClick={onClose}
            aria-label="Close"
          >
            <X />
          </Button>
        </div>
      </div>
    </>
  )
}
