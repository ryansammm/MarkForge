'use client'

import type { MouseEvent } from 'react'
import { openIntent, type OpenIntent } from '@/lib/tabs'

/**
 * The click handlers every control that opens a document needs.
 *
 * Spread onto a button rather than written out five times, because the three of them
 * only work as a set: `onClick` alone misses the middle button entirely — a `<button>`
 * never fires it — and `onAuxClick` alone leaves Windows and Linux starting autoscroll
 * under the pointer, which leaves a scroll cursor stuck over the app.
 */
export function openHandlers(open: (intent: OpenIntent) => void) {
  return {
    onClick: (event: MouseEvent) => open(openIntent(event)),
    onAuxClick: (event: MouseEvent) => {
      if (event.button !== 1) return
      event.preventDefault()
      open({ newTab: true, background: true })
    },
    onMouseDown: (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault()
    },
  }
}
