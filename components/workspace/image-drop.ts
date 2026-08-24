import {
  Facet,
  StateEffect,
  StateField,
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type SelectionRange,
} from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

/**
 * Dropping and pasting images into the editor.
 *
 * The rule this whole feature has to obey: **nothing enters the document until the
 * upload has succeeded.** The progress indicator is a widget decoration, not text —
 * the same paint-time-only device live-preview.ts uses — so a save that fires
 * mid-upload writes the file exactly as it was, and an upload that fails leaves no
 * trace to clean up. A placeholder written into the buffer would be a half-finished
 * link in the user's file, saved by an autosave that had no way to know better.
 *
 * What does land is plain CommonMark: `![alt](assets/2026/…png)`, a vault-relative
 * path, byte-for-byte what someone typing by hand would write. The same document
 * opens with working images in Obsidian or any other Markdown reader — which is the
 * whole premise, and the reason the images live in the vault rather than in a blob
 * store this app alone can address.
 *
 * The pure half — where an image goes and what it reads as — is exported separately
 * and tested with no DOM, exactly as `previewNodes` is.
 */

/**
 * What a file picker should offer.
 *
 * A hint to the dialog, not a check — the server decides from the bytes, and a picker
 * filter is trivially bypassed. It exists so the dialog does not present a folder full
 * of documents as though any of them would work. SVG is absent for the reason
 * lib/server/assets.ts gives.
 */
export const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp'

export interface ImageDropConfig {
  /** Uploads one file and resolves with the vault path it landed on. */
  upload: (file: File) => Promise<{ path: string }>
  /** Reports a failed upload. The message is already fit to show a person. */
  onError: (message: string) => void
  /**
   * Largest upload the server will accept. A photo over this is shrunk to fit rather
   * than refused; omit to send every file exactly as it is.
   */
  maxBytes?: number
  /**
   * Says that a picture was altered on the way in.
   *
   * Not optional in spirit, only in type: re-encoding someone's file is a thing they
   * are entitled to know about, and a silent one would mean the bytes in the vault
   * quietly stopped being the bytes they chose.
   */
  onNotice?: (message: string) => void
}

// --- the pure half ----------------------------------------------------------

/**
 * The alt text for a dropped file: its name, minus the path and the extension.
 *
 * Deliberately not the slug that goes in the key. A slug has to survive a URL and a
 * filesystem, so it is reduced to ASCII; alt text is read aloud by a screen reader and
 * shown when the image will not load, so it keeps the user's own words, accents and
 * all. Only the three characters that would break out of `![…]` are removed.
 */
export function altTextFor(filename: string): string {
  const name = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1)

  return name
    // `(?!^)` so a dotfile keeps its name instead of being stripped to nothing.
    .replace(/(?!^)\.[^.]*$/, '')
    .replace(/[[\]\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `![alt](path)` — nothing more, and nothing app-specific. */
export function imageMarkdown(input: { alt: string; path: string }): string {
  return `![${input.alt}](${input.path})`
}

/**
 * Where an image goes when it is dropped at `pos`.
 *
 * An image is a block: it gets its own line, with a blank line between it and any
 * prose on either side. Dropping into the middle of a paragraph and having the
 * picture appear inline mid-sentence is never what was meant.
 *
 * The neighbouring lines are what decide, not just the line dropped on — and that
 * distinction is the whole reason this is a function worth testing. Dropping on the
 * empty line above a paragraph looks like it needs no separator, but `![x]\nSome text`
 * is a single paragraph in CommonMark, so the image would render inline with the text
 * it was dropped above. One newline short is not a cosmetic difference.
 *
 * Separators are added only where they are missing, so a drop into a genuinely blank
 * stretch — the common case, and the one the drop cursor invites — inserts the link
 * and nothing else.
 *
 * Returns `end` as well as the spec: the position just past everything inserted, which
 * is where the next image in a multi-file drop starts.
 */
export function insertImageAt(
  state: EditorState,
  pos: number,
  markdown: string
): { changes: ChangeSpec; selection: SelectionRange; end: number } {
  const at = Math.max(0, Math.min(pos, state.doc.length))
  const line = state.doc.lineAt(at)

  const before = state.doc.sliceString(line.from, at)
  const after = state.doc.sliceString(at, line.to)

  // Two newlines when there is content to push away on this line, one when the line is
  // clear but the adjacent line has content, none at a document edge or inside an
  // already-blank stretch.
  const previous = line.number > 1 ? state.doc.line(line.number - 1) : null
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null

  const prefix = before.trim() ? '\n\n' : previous?.text.trim() ? '\n' : ''
  const suffix = after.trim() ? '\n\n' : next?.text.trim() ? '\n' : ''

  /**
   * There has to be a line below the image for the caret to land on — see the
   * selection note. Everywhere but the very end of a document there already is one.
   */
  const following = suffix ? suffix[0] : state.doc.sliceString(at, at + 1)
  const insert = `${prefix}${markdown}${suffix}${following === '\n' ? '' : '\n'}`

  return {
    changes: { from: at, insert },
    /**
     * The caret lands on the line *below* the image, not at the end of its line.
     *
     * Not cosmetic: the live-preview rule is that a caret touching a node reveals its
     * raw syntax, so leaving the caret on the image's own line means every freshly
     * dropped image shows as `![alt](…)` instead of as a picture until the user
     * happens to click elsewhere. Landing below renders it immediately, and clicking
     * the picture still brings the link back — which is the way round that matches
     * what someone does after dropping an image, which is carry on writing under it.
     */
    selection: EditorSelection.cursor(at + prefix.length + markdown.length + 1),
    end: at + insert.length,
  }
}

// --- shrinking to fit -------------------------------------------------------

/**
 * How far down each attempt scales the longest edge.
 *
 * A phone photo is 4000-odd pixels wide and nothing in this app displays an image
 * larger than the reading column, so the first step already loses nothing visible.
 * The later steps exist for the rare picture that is enormous rather than merely big.
 */
const SHRINK_STEPS = [2560, 2048, 1600, 1280]

/** Re-encode quality. High enough that the result is not visibly worse on a photo. */
const SHRINK_QUALITY = 0.82

/**
 * The size an image becomes when its longest edge is capped.
 *
 * Split out from the canvas work because this is the part worth being sure about, and
 * it is arithmetic: aspect ratio preserved, never enlarged, never rounded away to
 * nothing. See tests/assets.test.ts.
 */
export function scaledSize(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  const longest = Math.max(width, height)
  // Never upscale. A small image asked to fit a large box stays exactly as it is —
  // enlarging it would add bytes and invent detail, which is the opposite of the job.
  if (longest <= maxEdge) return { width, height }

  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Shrinks an image that would otherwise be refused, and returns everything else
 * untouched.
 *
 * The rule is narrow on purpose: **re-encoding only happens to make an impossible
 * upload possible.** Silently recompressing every screenshot would mean the file in
 * the vault is never quite the file the user had, which is not a trade this project
 * gets to make on their behalf. Anything already under the limit is stored byte for
 * byte as it arrived.
 *
 * A GIF is returned unchanged even when it is too large: a canvas holds one frame, so
 * re-encoding would silently turn an animation into a still. Better to be refused with
 * a message than to succeed with the content destroyed.
 *
 * Best-effort throughout. If the browser cannot decode the image, or nothing gets
 * small enough, the original is returned and the server refuses it by name — a bad
 * shrink must never be worse than no shrink.
 */
export async function shrinkToFit(file: File, maxBytes: number): Promise<File> {
  if (file.size <= maxBytes) return file
  if (file.type === 'image/gif') return file
  if (typeof createImageBitmap !== 'function') return file

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }

  try {
    for (const maxEdge of SHRINK_STEPS) {
      const size = scaledSize(bitmap.width, bitmap.height, maxEdge)

      const canvas = document.createElement('canvas')
      canvas.width = size.width
      canvas.height = size.height

      const context = canvas.getContext('2d')
      if (!context) return file
      context.drawImage(bitmap, 0, 0, size.width, size.height)

      // WebP rather than JPEG: it keeps an alpha channel, and a screenshot with a
      // transparent corner should not come back with a black one.
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', SHRINK_QUALITY)
      )

      // A re-encode that came out larger is not a shrink. Keep going, or give up and
      // let the original be refused honestly.
      if (blob && blob.size <= maxBytes && blob.size < file.size) {
        return new File([blob], file.name, { type: 'image/webp', lastModified: file.lastModified })
      }
    }
  } catch {
    return file
  } finally {
    bitmap.close()
  }

  return file
}

/** The image files in a drop or a paste, in the order they were given. */
export function imageFilesIn(data: DataTransfer | null): File[] {
  if (!data) return []
  return Array.from(data.files).filter((file) => file.type.startsWith('image/'))
}

// --- the plumbing -----------------------------------------------------------

interface Pending {
  id: number
  /** Where the next image lands. Walks forward as each one arrives. */
  pos: number
  label: string
}

const startUpload = StateEffect.define<Pending>()
const moveUpload = StateEffect.define<Pending>()
const endUpload = StateEffect.define<number>()

/**
 * In-flight uploads.
 *
 * One entry per drop, not per file: it behaves as a second cursor that walks forward
 * as each image lands, which keeps a three-image drop in order without three
 * positions competing to occupy the same offset. Mapping it through every transaction
 * is what lets the user keep typing — including above the drop point — while the
 * upload is in flight.
 */
const pendingUploads = StateField.define<readonly Pending[]>({
  create: () => [],

  update(value, tr) {
    let next = value.map((pending) => ({ ...pending, pos: tr.changes.mapPos(pending.pos, -1) }))

    for (const effect of tr.effects) {
      if (effect.is(startUpload)) {
        next = [...next, effect.value]
      } else if (effect.is(moveUpload)) {
        // The position here is already in the new document's coordinates — it is
        // computed from the insertion this same transaction is making.
        next = next.map((pending) => (pending.id === effect.value.id ? effect.value : pending))
      } else if (effect.is(endUpload)) {
        next = next.filter((pending) => pending.id !== effect.value)
      }
    }

    return next
  },

  provide: (field) =>
    EditorView.decorations.from(field, (pending) =>
      pending.length === 0
        ? Decoration.none
        : Decoration.set(
            pending.map((entry) =>
              Decoration.widget({ widget: new UploadWidget(entry.label), side: 1 }).range(entry.pos)
            ),
            true
          )
    ),
})

class UploadWidget extends WidgetType {
  constructor(readonly label: string) {
    super()
  }

  eq(other: UploadWidget): boolean {
    return other.label === this.label
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'cm-image-uploading'
    element.textContent = this.label
    return element
  }

  /** Not part of the document, so it must not swallow clicks meant for the text. */
  ignoreEvent(): boolean {
    return true
  }
}

let nextUploadId = 1

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function labelFor(files: File[], index: number): string {
  const name = files[Math.min(index, files.length - 1)]?.name ?? 'image'
  return files.length > 1
    ? `Uploading ${name}… (${index + 1} of ${files.length})`
    : `Uploading ${name}…`
}

/**
 * Uploads the batch, inserting each image as it arrives.
 *
 * Sequential on purpose. Parallel uploads would finish out of order, and "the images
 * came out in a different order than I dropped them" is a worse failure than a slower
 * batch — there is no way for the user to tell it was the network rather than the app.
 *
 * One file failing does not abandon the rest; the failures are collected and reported
 * together at the end, because five toasts for one bad drop is not a report.
 */
async function runUploads(
  view: EditorView,
  files: File[],
  pos: number,
  config: ImageDropConfig
): Promise<void> {
  const id = nextUploadId++
  const failures: string[] = []

  view.dispatch({ effects: startUpload.of({ id, pos, label: labelFor(files, 0) }) })

  for (const [index, original] of files.entries()) {
    try {
      const file = config.maxBytes ? await shrinkToFit(original, config.maxBytes) : original
      if (file !== original) {
        config.onNotice?.(
          `${original.name} was ${mb(original.size)} and has been resized to ${mb(file.size)} to fit the ${mb(config.maxBytes!)} limit.`
        )
      }

      const { path } = await config.upload(file)

      // Read the position back out of the field rather than reusing the one we
      // started with: the user may have typed, and the field has been mapping it.
      const current = view.state.field(pendingUploads).find((entry) => entry.id === id)
      const at = current?.pos ?? pos

      // The alt text comes from the name the user knows, which a re-encode does not
      // change — only the bytes and the stored extension do.
      const insertion = insertImageAt(
        view.state,
        at,
        imageMarkdown({ alt: altTextFor(original.name), path })
      )

      view.dispatch({
        changes: insertion.changes,
        selection: insertion.selection,
        effects: moveUpload.of({ id, pos: insertion.end, label: labelFor(files, index + 1) }),
        scrollIntoView: true,
        userEvent: 'input.image',
      })
    } catch (err) {
      failures.push(`${original.name}: ${(err as Error).message}`)
    }
  }

  view.dispatch({ effects: endUpload.of(id) })

  if (failures.length === 1) config.onError(failures[0]!)
  else if (failures.length > 1) {
    config.onError(`${failures.length} images could not be uploaded. ${failures.join(' · ')}`)
  }
}

/**
 * How the extension was configured, readable from a bare `EditorView`.
 *
 * The toolbar needs to start an upload, and it has a view and nothing else. Putting
 * the config here rather than exporting a second configured function means the button
 * runs the *same* code the drop handler runs — one upload path, so the two cannot
 * come to behave differently.
 */
const imageUploadConfig = Facet.define<ImageDropConfig, ImageDropConfig | null>({
  combine: (values) => values[0] ?? null,
})

/**
 * Uploads files at the cursor, as though they had been dropped there.
 *
 * For the toolbar's file picker: dragging is unreachable by keyboard and does not
 * exist on a phone, so it cannot be the only way in. Returns false when the editor
 * has no image support configured, or when nothing given was an image.
 */
export function insertImageFiles(view: EditorView, files: readonly File[]): boolean {
  const config = view.state.facet(imageUploadConfig)
  if (!config) return false

  const images = files.filter((file) => file.type.startsWith('image/'))
  if (images.length === 0) return false

  void runUploads(view, images, view.state.selection.main.head, config)
  return true
}

/**
 * The extension: drop and paste, plus the progress widget.
 *
 * Both handlers return false for anything that is not an image, so dropping a `.md`
 * file or pasting text keeps whatever behaviour it has today. Only a drop we are
 * actually going to act on is prevented — otherwise the browser would navigate away
 * from the app to display the dropped file.
 */
export function imageDrop(config: ImageDropConfig): Extension {
  return [
    pendingUploads,
    imageUploadConfig.of(config),

    EditorView.domEventHandlers({
      drop(event, view) {
        const files = imageFilesIn(event.dataTransfer)
        if (files.length === 0) return false

        event.preventDefault()
        const pos =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head

        void runUploads(view, files, pos, config)
        return true
      },

      paste(event, view) {
        const files = imageFilesIn(event.clipboardData)
        if (files.length === 0) return false

        event.preventDefault()
        void runUploads(view, files, view.state.selection.main.head, config)
        return true
      },
    }),
  ]
}
