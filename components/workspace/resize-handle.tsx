'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface ResizeHandleProps {
  /** Current width of the panel, in pixels. */
  width: number
  min: number
  max: number
  onResize: (width: number) => void
  /**
   * Which edge of the panel this sits on.
   *
   * `left` means the handle is on the panel's left edge, so dragging left makes the
   * panel wider — the right rail. `right` is the sidebar: dragging right widens it.
   */
  edge: 'left' | 'right'
  /** Names the panel in the accessibility tree, e.g. "Sidebar". */
  label: string
  /** Width to snap to on a double-click. */
  defaultWidth: number
  className?: string
}

/** How far one arrow key moves the edge; Shift multiplies it. */
const STEP = 16
const COARSE_STEP = 64

/**
 * The draggable divider between a panel and the document.
 *
 * A `separator` with `aria-orientation="vertical"` and a value, which is what makes it
 * a control rather than a decoration: the width is reachable with the arrow keys, and
 * announced while it changes. A drag-only handle is unusable without a mouse, and
 * these panels exist to be resized when a title does not fit — a problem that has
 * nothing to do with which input device someone is using.
 *
 * Sizing is driven by the pointer's absolute position rather than by accumulated
 * deltas. Deltas drift once the pointer runs past the clamp: the panel stops at `max`
 * while the delta keeps growing, and the edge then lags behind the cursor by however
 * far it overshot on the way back.
 */
export function ResizeHandle({
  width,
  min,
  max,
  onResize,
  edge,
  label,
  defaultWidth,
  className,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false)
  const elementRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dragging) return

    const panel = elementRef.current?.parentElement
    if (!panel) return

    const onPointerMove = (event: PointerEvent) => {
      event.preventDefault()
      // The panel's far edge is anchored and its near edge follows the pointer, so
      // the width is a distance between the two. Measured fresh each time rather
      // than accumulated from a start position: `width` is clamped, and a pointer
      // that runs past the clamp would otherwise leave the edge trailing the cursor
      // by however far it overshot.
      const box = panel.getBoundingClientRect()
      onResize(edge === 'right' ? event.clientX - box.left : box.right - event.clientX)
    }
    const stop = () => setDragging(false)

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)

    /*
      Held on the body for the length of the drag.

      Without them the pointer picks up the I-beam over the document text it passes
      across, and any text it passes across gets selected — the drag reads as a
      failed attempt to select a paragraph. Both are removed on cleanup, including
      the cleanup that runs if this unmounts mid-drag.
    */
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
    }
  }, [dragging, edge, onResize])

  const nudge = (direction: -1 | 1, coarse: boolean) => {
    const step = (coarse ? COARSE_STEP : STEP) * (edge === 'right' ? direction : -direction)
    onResize(width + step)
  }

  return (
    <div
      ref={elementRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        // Left button only. A right-click here belongs to whatever context menu the
        // surrounding panel offers.
        if (event.button !== 0) return
        event.preventDefault()
        setDragging(true)
      }}
      onDoubleClick={() => onResize(defaultWidth)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          nudge(-1, event.shiftKey)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          nudge(1, event.shiftKey)
        } else if (event.key === 'Home') {
          event.preventDefault()
          onResize(min)
        } else if (event.key === 'End') {
          event.preventDefault()
          onResize(max)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          onResize(defaultWidth)
        }
      }}
      title={`Drag to resize ${label} — double-click to reset`}
      className={cn(
        /*
          A 1px border is the visible divider; the target is 7px wide and sits half
          outside the panel, because a 1px hit area is a 1px hit area. `after` draws
          the highlight so the target itself stays invisible until it is wanted.
        */
        'group absolute inset-y-0 z-20 hidden w-[7px] cursor-col-resize touch-none select-none md:block',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary',
        edge === 'right' ? '-right-[3px]' : '-left-[3px]',
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors',
          'group-hover:bg-primary/60 group-focus-visible:bg-primary',
          dragging ? 'bg-primary' : 'bg-transparent'
        )}
      />
    </div>
  )
}
