'use client'

import { useEffect, useRef, useState } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  dropCursor,
  placeholder as cmPlaceholder,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import {
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  indentOnInput,
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete'
import { toast } from 'sonner'
import type { MarkdownDocument } from '@/lib/file-store'
import { isResolvable } from '@/lib/resolve-link'
import { resolveImageSrc, uploadAsset } from '@/lib/workspace-api'
import { MAX_ASSET_BYTES } from '@/lib/asset-limits'
import type { OpenIntent } from '@/lib/tabs'
import { livePreview } from './live-preview'
import { hideFrontmatterId } from './hide-frontmatter-id'
import { blockHandle } from './block-handle'
import { ImageLightbox, type ViewedImage } from './image-lightbox'
import { reconcileEdit } from './reconcile'
import { wikilinkCompletions } from './wikilink-complete'
import { slashCommands } from './slash-commands'
import { imageDrop } from './image-drop'
import { EditorToolbar } from './editor-toolbar'
import {
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
} from './editor-commands'

/**
 * CodeMirror 6 editor, live-preview style.
 *
 * The buffer is the file. There is no document model between what is typed and what
 * is written, which is why Markdown integrity cannot break here — see
 * docs/sprint-3-editor-decision.md for why this replaced Milkdown.
 *
 * Markdown markers are hidden while the cursor is elsewhere and revealed when it
 * enters (live-preview.ts). That is a paint-time decision only: the document still
 * holds every byte, so this changes how the file looks, never what it is.
 */

interface MarkdownEditorProps {
  /** Identifies the open document. Changing it rebuilds the editor. */
  docPath: string
  /**
   * The complete file text, frontmatter included.
   *
   * Deliberately not `MarkdownDocument.content` — that field is the body with the
   * YAML block stripped, and round-tripping it through the editor would delete
   * every document's frontmatter on first save.
   */
  initialValue: string
  /** All indexed documents — the source for `[[` autocomplete. */
  allDocs: Record<string, MarkdownDocument>
  onChange: (value: string) => void
  /** Fired on Mod-s. Saving is automatic; this is for the reflex. */
  onRequestSave?: () => void
  /**
   * Text the server wrote that differs from the buffer — an `id` injected into
   * frontmatter on first save. Applied as a minimal edit so the cursor survives.
   */
  reconciledContent?: string | null
  /**
   * Mod-click on a rendered wikilink. Same resolver as the reading view.
   *
   * Mod-Shift-click opens the target in a new tab. Not plain Mod-click, which is
   * already spoken for here — see LivePreviewConfig.
   */
  onNavigateWikilink?: (target: string, intent: OpenIntent) => void
}

/**
 * Styling for Markdown structure. Syntax stays visible — this is the Obsidian
 * source-mode model, not WYSIWYG.
 */
const markdownHighlight = HighlightStyle.define([
  // Serif headings against the sans body, as in the original design.
  { tag: tags.heading1, fontFamily: 'var(--font-serif)', fontSize: '1.75em', fontWeight: '600', lineHeight: '1.25' },
  { tag: tags.heading2, fontFamily: 'var(--font-serif)', fontSize: '1.4em', fontWeight: '600', lineHeight: '1.3' },
  { tag: tags.heading3, fontFamily: 'var(--font-serif)', fontSize: '1.18em', fontWeight: '600' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontFamily: 'var(--font-serif)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--cm-accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--cm-accent)' },
  { tag: tags.quote, color: 'var(--cm-muted)', fontStyle: 'italic' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--cm-code)' },
  { tag: tags.processingInstruction, color: 'var(--cm-muted)' },
  { tag: tags.contentSeparator, color: 'var(--cm-muted)', fontWeight: '700' },
  // Code block internals (P1 — arrived free with the language-data bundle).
  { tag: tags.keyword, color: 'var(--cm-keyword)' },
  { tag: tags.string, color: 'var(--cm-string)' },
  { tag: tags.number, color: 'var(--cm-number)' },
  { tag: tags.comment, color: 'var(--cm-muted)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--cm-fn)' },
  { tag: [tags.typeName, tags.className], color: 'var(--cm-type)' },
  { tag: tags.bool, color: 'var(--cm-number)' },
  { tag: tags.operator, color: 'var(--cm-muted)' },
])

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '15px',
    backgroundColor: 'transparent',
    color: 'var(--cm-text)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
    lineHeight: '1.75',
    padding: '0 0 40vh 0',
    overflow: 'auto',
  },
  '.cm-content': { padding: '0 0 0 32px', caretColor: 'var(--cm-accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0 2px' },
  // Frontmatter lines (id, created, title, ---) carry this class via
  // hide-frontmatter-id.ts. Hiding the line is a paint-only concern — the
  // document buffer still has every byte, so the file is saved intact.
  '.cm-frontmatter-hidden': { display: 'none' },
  '.cm-block-handle': {
    position: 'absolute',
    left: '4px',
    width: '20px',
    textAlign: 'center',
    cursor: 'grab',
    color: 'var(--muted-foreground)',
    opacity: '0',
    userSelect: 'none',
    transition: 'opacity 100ms ease',
    fontSize: '14px',
    lineHeight: 'inherit',
  },
  '.cm-block-handle:hover': { opacity: '1' },
  '.cm-line:hover > .cm-block-handle, .cm-line:focus-within > .cm-block-handle': { opacity: '1' },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cm-accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--cm-selection)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--cm-panel)',
    border: '1px solid var(--cm-border)',
    borderRadius: '8px',
    overflow: 'hidden',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.12)',
  },
  '.cm-tooltip-autocomplete ul li': { padding: '5px 10px', fontSize: '13px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--cm-accent)',
    color: 'var(--cm-on-accent)',
  },
  '.cm-completionLabel': { fontFamily: 'inherit' },
  '.cm-completionDetail': { fontStyle: 'normal', opacity: 0.6, marginLeft: '8px', fontSize: '11px' },
  // A rendered image. Constrained so a large photo cannot push the caret off screen;
  // the raw link comes back the moment the caret reaches this line.
  '.cm-image-block': {
    display: 'inline-block',
    padding: '4px 0',
    verticalAlign: 'top',
    // The expand button is positioned against this.
    position: 'relative',
  },
  '.cm-image-block img': {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '60vh',
    borderRadius: '8px',
    border: '1px solid var(--cm-border)',
  },
  /*
    The way into the image viewer from the editor. Hidden until the picture is hovered
    or the button itself is focused, so the editor still looks like a text editor — but
    present in the DOM either way, because a control that only exists on hover is a
    control that does not exist for a keyboard.
  */
  '.cm-image-expand': {
    position: 'absolute',
    top: '12px',
    right: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: '6px',
    border: '1px solid rgba(255,255,255,0.25)',
    background: 'rgba(0,0,0,0.55)',
    color: '#fff',
    fontSize: '13px',
    lineHeight: 1,
    cursor: 'zoom-in',
    opacity: 0,
    transition: 'opacity 120ms',
  },
  '.cm-image-block:hover .cm-image-expand, .cm-image-expand:focus-visible': { opacity: 1 },
  '.cm-image-broken': {
    color: 'var(--cm-muted)',
    fontStyle: 'italic',
    fontSize: '0.9em',
    border: '1px dashed var(--cm-border)',
    borderRadius: '8px',
    padding: '8px 12px',
  },
  // Upload in progress. A widget, not text: the document is untouched until the
  // bytes are actually stored — see image-drop.ts.
  '.cm-image-uploading': {
    display: 'inline-block',
    padding: '1px 8px',
    borderRadius: '6px',
    backgroundColor: 'var(--cm-active-line)',
    color: 'var(--cm-muted)',
    fontSize: '0.85em',
    verticalAlign: 'baseline',
    userSelect: 'none',
  },
  // Rendered wikilinks. Ghosts stay visibly unresolved rather than being hidden —
  // a link that goes nowhere should look like one.
  '.cm-wikilink': { color: 'var(--cm-accent)', cursor: 'pointer' },
  '.cm-wikilink-ghost': {
    color: 'var(--cm-muted)',
    textDecoration: 'underline',
    textDecorationStyle: 'dashed',
    textUnderlineOffset: '3px',
  },
})

export function MarkdownEditor({
  docPath,
  initialValue,
  allDocs,
  onChange,
  onRequestSave,
  reconciledContent,
  onNavigateWikilink,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // State as well as a ref, because the toolbar renders against the live view.
  const [view, setView] = useState<EditorView | null>(null)
  /** The picture the viewer is showing, if any. */
  const [viewing, setViewing] = useState<ViewedImage | null>(null)

  // Read through refs so the editor is never torn down just because a callback
  // identity changed — that would cost the user their cursor position mid-sentence.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onRequestSave)
  const docsRef = useRef(allDocs)
  const initialValueRef = useRef(initialValue)
  const onNavigateRef = useRef(onNavigateWikilink)
  const reconciledRef = useRef(reconciledContent)
  /**
   * The server version this editor has already adopted.
   *
   * Seeded on every build below rather than left null, which is the whole of the fix
   * described in reconcile.ts: `reconciledContent` lives in the workspace and outlives
   * the editor, so a fresh mount would otherwise re-apply a version from several
   * edits ago and revert everything typed since.
   */
  const appliedReconcileRef = useRef<string | null>(null)

  // Synced in an effect rather than during render. Declared before the effect that
  // builds the editor so a docPath change lands the new text in the ref first.
  useEffect(() => {
    onChangeRef.current = onChange
    onSaveRef.current = onRequestSave
    docsRef.current = allDocs
    initialValueRef.current = initialValue
    onNavigateRef.current = onNavigateWikilink
    reconciledRef.current = reconciledContent
  }, [onChange, onRequestSave, allDocs, initialValue, onNavigateWikilink, reconciledContent])

  // A changed index changes which wikilinks resolve. The decorations are rebuilt on
  // any transaction, so an empty one is enough to repaint ghosts that just became
  // real documents.
  useEffect(() => {
    viewRef.current?.dispatch({})
  }, [allDocs])

  useEffect(() => {
    if (!hostRef.current) return

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      // Shows where a dragged image will land. The theme has always styled
      // `.cm-dropCursor`; until now nothing drew one.
      dropCursor(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(markdownHighlight, { fallback: true }),
      // Hover drag handle for every paragraph. Only registered for the
      // edit mode — the reading view does not need it.
      blockHandle(),
      livePreview({
        // The reading view's resolver, not a second one. Two would drift, and the
        // symptom would be a link that renders as resolved but navigates nowhere.
        isResolved: (target) => isResolvable(target, docsRef.current),
        onNavigate: (target, intent) => onNavigateRef.current?.(target, intent),
        // The same mapping the reading view uses, for the same reason the resolver is
        // shared: two of them would drift.
        resolveImage: resolveImageSrc,
        /*
          The expand button on a rendered image, and Mod-click on the picture. The
          `src` arrives as the document writes it and is resolved here, at the call
          site, which is the same rule the reading view and the share page follow —
          the viewer itself never maps a path (D1 in docs/image-viewer-plan.md).
        */
        onExpandImage: (src, alt) => setViewing({ src: resolveImageSrc(src), alt, source: src }),
      }),
      hideFrontmatterId(),
      imageDrop({
        upload: uploadAsset,
        onError: (message) => toast.error(message),
        // A photo off a phone is routinely larger than the route will accept. Shrinking
        // it here turns a refusal into an upload; the notice is because altering
        // somebody's file silently is not something to do quietly.
        maxBytes: MAX_ASSET_BYTES,
        onNotice: (message) => toast.info(message),
      }),
      autocompletion({
        override: [wikilinkCompletions(() => docsRef.current), slashCommands()],
        closeOnBlur: true,
        icons: false,
      }),
      cmPlaceholder('Start writing…'),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current?.()
            return true
          },
        },
        { key: 'Mod-b', preventDefault: true, run: toggleBold },
        { key: 'Mod-i', preventDefault: true, run: toggleItalic },
        { key: 'Mod-`', preventDefault: true, run: toggleInlineCode },
        { key: 'Mod-Shift-x', preventDefault: true, run: toggleStrikethrough },
        /*
          Reopens the document list inside a `[[` that has already been dismissed —
          Escape closes the popup, and without this the only way back was to delete
          the brackets and retype them. `completionKeymap` binds Ctrl-Space for the
          same thing, which is not reachable on a Mac.
        */
        { key: 'Mod-Space', preventDefault: true, run: startCompletion },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString())
        }
      }),
      editorTheme,
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: initialValueRef.current, extensions }),
      parent: hostRef.current,
    })

    viewRef.current = view
    /*
      This buffer was built from `initialValue`, which the workspace keeps at the
      server's latest bytes for this document — so whatever version it is currently
      holding is, by definition, already in the text on screen. Recording it as
      applied is what stops the effect below from replaying it. Without this line,
      leaving and re-entering the editor reverts to whenever the last frontmatter
      splice happened and autosaves that over the file.
    */
    appliedReconcileRef.current = reconciledRef.current ?? null
    setView(view)
    view.focus()

    /*
      Ctrl/Cmd-A must select the whole document, not the whole window. The default
      `keymap` already binds it, but only when CodeMirror is the focus target — a
      click that lands on a child of the editor (a completion popup, an inline
      image's expand button) leaves the active element outside the keymap, and
      the browser's whole-window select-all runs instead. A window-level guard
      re-runs CM's selectAll whenever the active element is inside the editor
      host, regardless of which child owns focus.
    */
    const handleSelectAll = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key !== 'a' && event.key !== 'A') return
      const host = hostRef.current
      const active = document.activeElement
      if (!host || !active || !host.contains(active)) return
      event.preventDefault()
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length }, scrollIntoView: true })
      view.focus()
    }
    window.addEventListener('keydown', handleSelectAll)

    return () => {
      window.removeEventListener('keydown', handleSelectAll)
      view.destroy()
      viewRef.current = null
      setView(null)
    }
    // Rebuilt only when the open document changes. Buffer edits flow out through
    // onChange; they must not flow back in and reset the cursor.
  }, [docPath])

  /*
    Applies server-side rewrites — the `id` and `created` spliced into frontmatter on
    a document's first in-app save — without disturbing the cursor.

    Only ones that arrive *while this editor is mounted*. See reconcile.ts: the value
    lives in the workspace and outlives the editor, so without the applied-record this
    re-ran on every mount and reverted the document to whenever the splice happened.
  */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const { edit, applied } = reconcileEdit(
      view.state.doc.toString(),
      reconciledContent,
      appliedReconcileRef.current
    )

    appliedReconcileRef.current = applied
    if (edit) view.dispatch({ changes: edit })
  }, [reconciledContent])

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full overflow-hidden" />
      {view && <EditorToolbar view={view} />}
      <ImageLightbox
        image={viewing}
        onClose={() => setViewing(null)}
        /*
          Focus goes back to the editor, not to the button that opened the viewer.
          That button lives inside a CodeMirror widget, and `eq()` only preserves a
          widget across repaints when src and alt are unchanged — so a keystroke while
          the viewer was open can have replaced the element the default would restore
          focus to. Returning false tells Base UI this has been handled.
        */
        finalFocus={() => {
          viewRef.current?.focus()
          return false
        }}
      />
    </div>
  )
}

export default MarkdownEditor
