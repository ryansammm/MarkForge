'use client'

import { useRef } from 'react'
import { Bold, Code, Hash, Image as ImageIcon, Italic, Link2, List } from 'lucide-react'
import { startCompletion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { StateCommand } from '@codemirror/state'
import {
  cycleHeading,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
  toggleItalic,
  wrapWikilink,
} from './editor-commands'
import { ACCEPTED_IMAGE_TYPES, insertImageFiles } from './image-drop'

/**
 * The floating format bar from the original design.
 *
 * It is a convenience over the keymap, not a second way to edit: every button runs the
 * same `StateCommand` the keyboard does and writes the same plain Markdown.
 */

interface EditorToolbarProps {
  view: EditorView
}

interface ToolbarAction {
  label: string
  hint: string
  icon: typeof Bold
  run: (view: EditorView) => void
}

function apply(command: StateCommand) {
  return (view: EditorView) => {
    command(view)
  }
}

const ACTIONS: ToolbarAction[] = [
  { label: 'Bold', hint: 'Ctrl+B', icon: Bold, run: apply(toggleBold) },
  { label: 'Italic', hint: 'Ctrl+I', icon: Italic, run: apply(toggleItalic) },
  {
    label: 'Link to a document',
    hint: '[[',
    icon: Link2,
    run: (view) => {
      const empty = view.state.selection.main.empty
      wrapWikilink(view)
      // With nothing selected the cursor is now between the brackets, which is exactly
      // where the `[[` completion list belongs.
      if (empty) startCompletion(view)
    },
  },
  { label: 'Heading', hint: 'Cycles H1 – H3', icon: Hash, run: apply(cycleHeading) },
  { label: 'Bullet list', hint: 'Toggles “- ”', icon: List, run: apply(toggleBulletList) },
  { label: 'Inline code', hint: 'Ctrl+`', icon: Code, run: apply(toggleInlineCode) },
]

const BUTTON_CLASS =
  'flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

export function EditorToolbar({ view }: EditorToolbarProps) {
  const fileInput = useRef<HTMLInputElement | null>(null)

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      {/*
        The keyboard and touch route to the same upload the drop handler uses. Dragging
        a file is unreachable without a pointer and does not exist on a phone, so it
        cannot be the only way to add a picture.
      */}
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES}
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          // Cleared before the upload starts, so choosing the same file twice in a row
          // still fires a change event the second time.
          event.target.value = ''
          if (files.length > 0) insertImageFiles(view, files)
          view.focus()
        }}
      />
      <div
        role="toolbar"
        aria-label="Formatting"
        className="pointer-events-auto flex items-center gap-0.5 rounded-xl border bg-popover/95 p-1 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-popover/80"
      >
        {ACTIONS.map((action, i) => {
          const Icon = action.icon
          return (
            <span key={action.label} className="flex items-center">
              {i === 3 && <span className="mx-1 h-5 w-px bg-border" aria-hidden />}
              <button
                type="button"
                title={`${action.label} · ${action.hint}`}
                aria-label={action.label}
                // The editor must not lose focus, or the command would run against a
                // selection the user can no longer see.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  action.run(view)
                  view.focus()
                }}
                className={BUTTON_CLASS}
              >
                <Icon className="size-4" />
              </button>
            </span>
          )
        })}

        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <button
          type="button"
          title="Insert image · or drop one anywhere"
          aria-label="Insert image"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => fileInput.current?.click()}
          className={BUTTON_CLASS}
        >
          <ImageIcon className="size-4" />
        </button>
      </div>
    </div>
  )
}

export default EditorToolbar
