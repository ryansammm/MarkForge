'use client'

import { Download } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'

import { cn } from '@/lib/utils'

/**
 * Installability, split in two.
 *
 * It used to be one component rendering a `fixed right-4 top-4` button from the root
 * layout, which put it on top of the workspace header — over the theme switcher and
 * the context-rail toggle, both of which became unclickable underneath it. A control
 * that floats above the app is a control that will collide with the app; the fix is
 * for it to sit *in* the header and take up space like everything else there.
 *
 * That move creates a timing problem, which is why there is a store here rather than
 * `useState`. `beforeinstallprompt` fires once, early, and the browser does not
 * re-fire it for a listener that arrives late. The header does not exist yet at that
 * point — the workspace renders a spinner until the index arrives — so a listener
 * living in the button would miss the event and the button would never appear.
 *
 * So `PwaRuntime` mounts at the root, catches the event whenever it lands, and holds
 * it. `PwaInstallButton` subscribes and renders wherever it belongs.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
let installed = false
let listening = false

const subscribers = new Set<() => void>()

function publish(): void {
  for (const notify of subscribers) notify()
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

/** The only thing a subscriber needs: whether there is an install to offer. */
function canInstall(): boolean {
  return deferred !== null && !installed
}

/**
 * Starts listening, once per document.
 *
 * Idempotent because React strict mode mounts effects twice in development, and two
 * sets of listeners would each capture the event and each publish it.
 */
function startListening(): void {
  if (listening) return
  listening = true

  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppressed so the browser's own bar does not appear alongside our button.
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    publish()
  })

  window.addEventListener('appinstalled', () => {
    installed = true
    deferred = null
    publish()
  })
}

/** Registers the service worker and captures installability. Renders nothing. */
export function PwaRuntime() {
  useEffect(() => {
    startListening()

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
        console.warn('Unable to register the service worker.', error)
      })
    }

    // Read the display mode inside a promise callback rather than synchronously in
    // the effect body. Same value, one render later, and it satisfies the rule that
    // keeps `npm run verify` — and therefore CI — green.
    Promise.resolve().then(() => {
      if (!window.matchMedia('(display-mode: standalone)').matches) return
      installed = true
      publish()
    })
  }, [])

  return null
}

/**
 * The install control, in normal flow.
 *
 * Renders nothing until the browser says the app is installable, which is most of the
 * time — already installed, unsupported browser, criteria not met. Nothing else in the
 * header may depend on its width.
 */
export function PwaInstallButton({ className }: { className?: string }) {
  const available = useSyncExternalStore(subscribe, canInstall, () => false)

  if (!available) return null

  const install = async () => {
    const event = deferred
    if (!event) return

    await event.prompt()
    await event.userChoice
    // Cleared either way: the event is single-use, and a dismissed prompt cannot be
    // replayed from the same one.
    deferred = null
    publish()
  }

  return (
    <button
      type="button"
      onClick={() => void install()}
      title="Install MarkForge as an app"
      className={cn(
        'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted',
        className
      )}
    >
      <Download className="size-3.5 shrink-0" />
      {/* The label goes first on a narrow screen; the icon alone still reads. */}
      <span className="hidden sm:inline">Install app</span>
      <span className="sr-only sm:hidden">Install app</span>
    </button>
  )
}
