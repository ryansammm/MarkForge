'use client'

import { useState } from 'react'
import { ImageOff } from 'lucide-react'
import type { ViewedImage } from './image-lightbox'

interface ViewableImageProps {
  /**
   * The URL to load, **already resolved by the caller**.
   *
   * Resolution stays at the call site on purpose (D1 in docs/image-viewer-plan.md):
   * the reading view maps a vault path with `resolveImageSrc`, the public share page
   * with `shareImageSrc`, and those two must never be interchanged — one points at the
   * session gate, the other carries a reader's only credential. Nothing below this
   * line knows which of them produced this string, so nothing below this line can pick
   * the wrong one.
   */
  src: string | undefined
  /** What the document says — the raw `![…](here)` target. Shown, never fetched. */
  source: string | undefined
  alt: string
  onOpen: (image: ViewedImage) => void
}

/**
 * An image in the prose, and the control that opens it in the viewer.
 *
 * Shared by the reading view and the public share page, which rendered two copies of
 * the same `<img>` before this existed. A second copy of the rule would drift, and the
 * symptom would be a picture that opens on one surface and not the other.
 *
 * A real `<button>` rather than a click handler on the `<img>`: an image is not
 * focusable and not activatable from a keyboard, so a handler alone would build a
 * feature that only exists for people using a mouse — the same mistake the toolbar's
 * file picker was added to fix in sprint 7 item 6. A button is phrasing content, so it
 * is valid inside the `<p>` the Markdown renderer puts an image in.
 */
export function ViewableImage({ src, source, alt, onOpen }: ViewableImageProps) {
  /*
    Tracked per image so a picture that cannot load is not offered as a control. A
    button that opens a viewer onto nothing is worse than no button at all.
  */
  const [failed, setFailed] = useState(false)

  if (!src) return null

  if (failed) {
    /*
      Names the file rather than leaving the browser's broken-image glyph — the stance
      the editor already takes (`Missing image: …`), and the gap sprint 7 item 4
      recorded as worth closing when something next touched this area.

      A `<span>` laid out as a block: this sits inside a `<p>`, where a `<div>` would
      be invalid and the renderer would split the paragraph around it.
    */
    return (
      <span className="not-prose my-4 flex items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-muted-foreground">
        <ImageOff className="size-4 shrink-0" aria-hidden />
        <span className="font-mono text-xs break-all">Missing image: {source ?? src}</span>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onOpen({ src, alt, source })}
      title={alt ? `${alt} — open full size` : 'Open full size'}
      /*
        Stripped of everything button-ish. Prose is typeset, and a border, a background
        or default padding behind every picture would restyle documents nobody asked to
        have restyled. What is left is the cursor and a shadow on hover, so the picture
        looks like something that can be opened without looking like a widget.
      */
      className="group/image mx-auto block cursor-zoom-in border-0 bg-transparent p-0"
    >
      {/*
        A plain <img>, deliberately. next/image would route this through the Next image
        optimizer, which fetches the URL from the server with no browser session
        attached — and /api/assets is behind the session gate, so every image would come
        back 401. On the share page it is worse: the optimizer has no token at all, and
        would put a copy of a private vault's pictures in a public cache.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onError={() => setFailed(true)}
        className="mx-auto max-h-[70vh] rounded-lg border transition-shadow group-hover/image:shadow-lg"
      />
    </button>
  )
}
