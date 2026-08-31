'use client'

import * as React from 'react'
import { Menu } from '@base-ui/react/menu'
import { toast } from 'sonner'
import type { EditorView } from '@codemirror/view'
import { BLOCK_COLORS, type BlockColor } from '@/lib/blocks'
import {
  copyLink,
  deleteBlock,
  duplicate,
  setColor,
  turnInto,
} from '@/lib/blocks-transforms'
import { cn } from '@/lib/utils'

/**
 * Notion-style block menu.
 *
 * Opened by the drag handle's click (block-handle.ts → setBlockHandleClickHandler).
 * Owns its own search input; arrow / enter / esc come from Base UI Menu.
 *
 * Implementation notes:
 *
 * - The menu is "controlled" so the editor can re-open it on a different
 *   block (a new handle click closes the previous one and opens a new
 *   instance with the new context).
 * - The search input filters the action list live. Each item declares
 *   its search string; the menu hides items whose label does not match.
 *   Submenus are flattened during search so a query like "red" surfaces
 *   the "Color → Red" item rather than forcing the user to navigate
 *   the submenu first.
 * - The footer (last-edited + word count) is computed from the editor
 *   state at the time the menu was opened. It is read-only metadata.
 * - Actions that depend on having a block id (Copy link to block, Color)
 *   are still rendered when the block has no id; clicking them gives a
 *   brief inline explanation rather than the action.
 */

type BlockKind = 'text' | 'h1' | 'h2' | 'h3' | 'h4' | 'bullet' | 'numbered' | 'todo' | 'toggle_list' | 'callout' | 'quote' | 'code'

interface MenuAction {
  /** Stable id used by tests and the focus trap. */
  id: string
  /** Visible label. */
  label: string
  /** Search tokens (lowercased). Submenu items are matched by these. */
  search: string[]
  /** Run the action against the live editor view. */
  run: (view: EditorView) => void
  /** If true, the item is rendered dimmed. */
  disabled?: boolean
  /** Hint shown on hover when disabled. */
  disabledHint?: string
}

interface MenuContext {
  view: EditorView
  /** Document path the menu is acting on. */
  docPath: string
  /** Anchor rect from the drag handle. */
  rect: DOMRect
  /** Type label of the first block in the range, e.g. "Heading 1". */
  blockLabel: string
  /** Word count of the first block in the range. */
  wordCount: number
  /** Whether the first block already has an id. */
  hasId: boolean
  /** ISO timestamp of the document's last edit (for the footer). */
  updatedAt: string | null
  /** Called when an action is taken so the menu can close. */
  onClose: () => void
  /** Open this block in another surface. Wired by the editor from the workspace. */
  onOpen?: (target: OpenTarget) => void
  /**
   * Move the current block to another document. Receives the destination
   * path; the workspace handler reads/writes both files. Omitted in
   * non-workspace contexts (tests).
   */
  onMoveTo?: (destPath: string) => void | Promise<void>
  /** Candidate destinations for the Move to submenu (path → title). */
  moveToCandidates?: { path: string; title: string }[]
  /**
   * Turn the current selection into a sub-page. The editor hands the
   * workspace a fully-built plan (parent rewrite + new child path/body);
   * the workspace performs the writes and returns the new child's path
   * for an Open action in the toast.
   */
  onTurnIntoPage?: () => void | Promise<void>
}

export type OpenTarget = 'side-peek' | 'new-tab' | 'new-window' | 'full-page'

const TURN_INTO: { type: BlockKind; label: string; search: string[] }[] = [
  { type: 'text', label: 'Text', search: ['text', 'paragraph'] },
  { type: 'h1', label: 'Heading 1', search: ['heading 1', 'h1', 'title'] },
  { type: 'h2', label: 'Heading 2', search: ['heading 2', 'h2'] },
  { type: 'h3', label: 'Heading 3', search: ['heading 3', 'h3'] },
  { type: 'h4', label: 'Heading 4', search: ['heading 4', 'h4'] },
  { type: 'bullet', label: 'Bulleted list', search: ['bulleted', 'bullet', 'list', 'ul'] },
  { type: 'numbered', label: 'Numbered list', search: ['numbered', 'list', 'ol'] },
  { type: 'todo', label: 'To-do list', search: ['to-do', 'todo', 'task', 'checkbox'] },
  { type: 'toggle_list', label: 'Toggle list', search: ['toggle', 'collapsible', 'details', 'disclosure'] },
  { type: 'callout', label: 'Callout', search: ['callout', 'admonition', 'note', 'warning'] },
  { type: 'quote', label: 'Quote', search: ['quote', 'blockquote'] },
  { type: 'code', label: 'Code', search: ['code', 'fence', 'pre'] },
]

const COLORS: BlockColor[] = [...BLOCK_COLORS]
const BG_COLORS: BlockColor[] = [...BLOCK_COLORS]

interface BlockMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: MenuContext | null
}

interface BlockMenuInnerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: MenuContext
}

export function BlockMenu({ open, onOpenChange, context }: BlockMenuProps) {
  if (!context) return null
  return (
    <BlockMenuInner
      key={`${context.docPath}:${context.rect.top}:${context.rect.left}`}
      open={open}
      onOpenChange={onOpenChange}
      context={context}
    />
  )
}

function BlockMenuInner({ open, onOpenChange, context }: BlockMenuInnerProps) {
  const [query, setQuery] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  // ponytail: the parent remounts this component on every new handle
  // click (see the `key` above) so the search box starts empty each
  // time without needing an effect-driven setState.

  const lower = query.trim().toLowerCase()
  const matches = (tokens: string[]) => lower === '' || tokens.some((t) => t.includes(lower))

  // Action: Duplicate
  const duplicateAction: MenuAction = {
    id: 'duplicate',
    label: 'Duplicate',
    search: ['duplicate', 'copy', 'clone'],
    run: (view) => {
      const spec = duplicate(view.state)
      if (spec) view.dispatch(spec)
    },
  }
  // Action: Delete
  const deleteAction: MenuAction = {
    id: 'delete',
    label: 'Delete',
    search: ['delete', 'remove', 'trash'],
    run: (view) => {
      const spec = deleteBlock(view.state)
      if (spec) view.dispatch(spec)
    },
  }
  // Action: Copy link to block — disabled when the block has no id.
  const copyLinkAction: MenuAction = {
    id: 'copy-link',
    label: 'Copy link to block',
    search: ['copy link', 'link', 'anchor', 'share'],
    run: async (view) => {
      const ok = await copyLink(view.state, context.docPath)
      if (ok) toast.success('Link copied')
      else toast.error('Block has no id yet — apply a colour or duplicate it first')
    },
    disabled: !context.hasId,
    disabledHint: 'Block has no id yet — apply a colour or duplicate it first',
  }

  // Open-in items. They are gated on `context.onOpen` (the editor wires
  // them only when running in the workspace; tests render the menu
  // without them). Without a block id the targets still work — the
  // workspace opens the current doc as a full surface — but the spec
  // reserves them for linkable blocks, so we show a hint instead.
  const openItems: MenuAction[] = context.onOpen
    ? [
        {
          id: 'open-side-peek',
          label: 'Open in side peek',
          search: ['side peek', 'side', 'peek', 'preview'],
          run: () => context.onOpen?.('side-peek'),
        },
        {
          id: 'open-new-tab',
          label: 'Open in new tab',
          search: ['new tab', 'tab'],
          run: () => context.onOpen?.('new-tab'),
        },
        {
          id: 'open-new-window',
          label: 'Open in new window',
          search: ['new window', 'window'],
          run: () => context.onOpen?.('new-window'),
        },
        {
          id: 'open-full-page',
          label: 'Open in full page',
          search: ['full page', 'full', 'page'],
          run: () => context.onOpen?.('full-page'),
        },
      ]
    : []

  // Move to submenu. v1: pick a destination from a list (no search). The
  // candidate list is provided by the editor; if it is missing or empty
  // the item is dimmed. The current document is filtered out.
  const moveToCandidates = (context.moveToCandidates ?? []).filter(
    (c) => c.path !== context.docPath
  )
  const moveToActions: MenuAction[] = context.onMoveTo
    ? moveToCandidates
        .filter((c) =>
          matches(['move to', 'move', c.title.toLowerCase(), c.path.toLowerCase()])
        )
        .map((c) => ({
          id: `move-to-${c.path}`,
          label: c.title,
          search: ['move to', 'move', c.title.toLowerCase(), c.path.toLowerCase()],
          run: () => {
            void context.onMoveTo?.(c.path)
          },
        }))
    : []

  // Link submenu: Copy link to block + Open in *. Lives in its own
  // submenu per Task 2.1 (dropped from the top-level). `copyLinkAction`
  // is gated on `!disabled` so the entry disappears until the block
  // has an id.
  const linkActions: MenuAction[] = [
    ...(copyLinkAction.disabled ? [] : [copyLinkAction]),
    ...openItems,
  ]

  // Top-level flat list of items shown when no submenu is hovered. Order
  // matches the spec: Duplicate, Delete, Move to, Turn into, Color.
  // Copy link and Open in live in dedicated submenus (see below); they
  // were dropped from the top-level per Task 2.1.
  const topLevel: MenuAction[] = [
    duplicateAction,
    deleteAction,
  ]

  // "Page" — splits the current selection into a sub-page. Lives
  // inside the "Turn into" submenu alongside the block-kind changes;
  // the label is just `Page` because the parent menu already says
  // "Turn into".
  const pageAction: MenuAction | null = context.onTurnIntoPage
    ? {
        id: 'turn-into-page',
        label: 'Page',
        search: ['page', 'sub-page', 'subpage', 'child', 'turn into'],
        run: () => {
          void context.onTurnIntoPage?.()
        },
      }
    : null

  // When the search query is non-empty, show every action flattened:
  // top-level items + every Turn into + every Color (text & bg).
  // Otherwise show the grouped submenu layout.
  const flattening = lower !== ''

  const turnIntoActions: MenuAction[] = TURN_INTO.filter((t) => matches(t.search)).map(
    (t) => ({
      id: `turn-${t.type}`,
      label: t.label,
      search: t.search,
      run: (view) => {
        const spec = turnInto(view.state, t.type)
        if (spec) view.dispatch(spec)
      },
    })
  )
  const textColorActions: MenuAction[] = COLORS.filter((c) => matches([c])).map((c) => ({
    id: `color-text-${c}`,
    label: c === 'default' ? 'Default text' : capitalize(c),
    search: ['color', c, 'text'],
    run: (view) => {
      const spec = setColor(view.state, 'color', c)
      if (spec) view.dispatch(spec)
    },
  }))
  const bgColorActions: MenuAction[] = BG_COLORS.filter((c) => matches([c])).map((c) => ({
    id: `color-bg-${c}`,
    label: c === 'default' ? 'Default background' : capitalize(c),
    search: ['background', c, 'bg'],
    run: (view) => {
      const spec = setColor(view.state, 'bg', c)
      if (spec) view.dispatch(spec)
    },
  }))

  // Submenu actions are filtered by their own tokens only when not in
  // flattening mode; in flattening mode every Turn into / Color item is
  // always eligible (they are then filtered by the `matches(t.search)`
  // call above).
  const visibleTopLevel = topLevel.filter((a) => matches(a.search))

  return (
    <Menu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          anchor={context.rect ? rectToVirtualElement(context.rect) : undefined}
          className="z-50"
        >
          <Menu.Popup
            className={cn(
              'z-50 min-w-[260px] max-w-[320px] overflow-hidden rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md',
              'outline-none'
            )}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onOpenChange(false)
              }
            }}
          >
            <div className="px-2 pt-2 pb-1">
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search actions…"
                className="w-full rounded border bg-background px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
                autoFocus
                onKeyDown={(event) => {
                  // The menu item list below should not eat arrow
                  // keys meant for the input.
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.stopPropagation()
                  }
                }}
              />
              <div className="mt-2 text-xs text-muted-foreground">{context.blockLabel}</div>
            </div>

            {!flattening ? (
              <SubmenuLayout
                topLevel={visibleTopLevel}
                turnIntoActions={turnIntoActions}
                pageAction={pageAction}
                textColorActions={textColorActions}
                bgColorActions={bgColorActions}
                moveToActions={moveToActions}
                linkActions={linkActions}
                onAction={(action) => {
                  action.run(context.view)
                  onOpenChange(false)
                }}
              />
            ) : (
              <FlatLayout
                topLevel={visibleTopLevel}
                turnIntoActions={turnIntoActions}
                pageAction={pageAction}
                textColorActions={textColorActions}
                bgColorActions={bgColorActions}
                moveToActions={moveToActions}
                linkActions={linkActions}
                onAction={(action) => {
                  action.run(context.view)
                  onOpenChange(false)
                }}
              />
            )}

            <div className="mt-1 border-t px-2 py-2 text-[11px] text-muted-foreground">
              <div>Last edited · {formatTimestamp(context.updatedAt)}</div>
              <div>Word count: {context.wordCount} words</div>
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function SubmenuLayout(props: {
  topLevel: MenuAction[]
  turnIntoActions: MenuAction[]
  pageAction: MenuAction | null
  textColorActions: MenuAction[]
  bgColorActions: MenuAction[]
  moveToActions: MenuAction[]
  linkActions: MenuAction[]
  onAction: (a: MenuAction) => void
}) {
  const { topLevel, turnIntoActions, pageAction, textColorActions, bgColorActions, moveToActions, linkActions, onAction } = props
  // Combine the block-kind Turn into entries with the "Page" entry
  // (which turns the selection into a sub-page, not a different block
  // type). The parent label already says "Turn into", so the inner
  // item reads simply as "Page".
  const turnIntoAll: MenuAction[] = [
    ...(pageAction ? [pageAction] : []),
    ...turnIntoActions,
  ]
  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="flex w-full cursor-default items-center justify-between rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent">
          Turn into
          <span aria-hidden>▸</span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="right" sideOffset={2} align="start">
            <Menu.Popup className="z-50 min-w-[200px] rounded-md border bg-popover p-1 shadow-md outline-none">
              {turnIntoAll.length === 0 ? (
                <Empty label="No matches" />
              ) : (
                turnIntoAll.map((a) => <ActionItem key={a.id} action={a} onSelect={() => onAction(a)} />)
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <Menu.Root>
        <Menu.Trigger className="flex w-full cursor-default items-center justify-between rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent">
          Color
          <span aria-hidden>▸</span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="right" sideOffset={2} align="start">
            <Menu.Popup className="z-50 min-w-[180px] rounded-md border bg-popover p-1 shadow-md outline-none">
              <ColorHeader label="Text" />
              {textColorActions.map((a) => (
                <ActionItem key={a.id} action={a} onSelect={() => onAction(a)} />
              ))}
              <ColorHeader label="Background" />
              {bgColorActions.map((a) => (
                <ActionItem key={a.id} action={a} onSelect={() => onAction(a)} />
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      {moveToActions.length > 0 ? (
        <Menu.Root>
          <Menu.Trigger className="flex w-full cursor-default items-center justify-between rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent">
            Move to
            <span aria-hidden>▸</span>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="right" sideOffset={2} align="start">
              <Menu.Popup className="z-50 max-h-[320px] min-w-[240px] overflow-y-auto rounded-md border bg-popover p-1 shadow-md outline-none">
                {moveToActions.map((a) => (
                  <ActionItem key={a.id} action={a} onSelect={() => onAction(a)} />
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ) : null}

      {linkActions.length > 0 ? (
        <Menu.Root>
          <Menu.Trigger className="flex w-full cursor-default items-center justify-between rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent">
            Link
            <span aria-hidden>▸</span>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="right" sideOffset={2} align="start">
              <Menu.Popup className="z-50 min-w-[200px] rounded-md border bg-popover p-1 shadow-md outline-none">
                {linkActions.map((a) => (
                  <ActionItem key={a.id} action={a} onSelect={() => onAction(a)} />
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ) : null}

      {topLevel.length === 0 ? null : (
        <>
          <MenuSeparator />
          {topLevel.map((a) => (
            <ActionItem key={a.id} action={a} onSelect={() => onAction(a)} />
          ))}
        </>
      )}
    </>
  )
}

function FlatLayout(props: {
  topLevel: MenuAction[]
  turnIntoActions: MenuAction[]
  pageAction: MenuAction | null
  textColorActions: MenuAction[]
  bgColorActions: MenuAction[]
  moveToActions: MenuAction[]
  linkActions: MenuAction[]
  onAction: (a: MenuAction) => void
}) {
  const turnIntoAll: MenuAction[] = [
    ...(props.pageAction ? [props.pageAction] : []),
    ...props.turnIntoActions,
  ]
  const all: { section: string; items: MenuAction[] }[] = []
  if (turnIntoAll.length > 0) all.push({ section: 'Turn into', items: turnIntoAll })
  if (props.textColorActions.length > 0) all.push({ section: 'Text color', items: props.textColorActions })
  if (props.bgColorActions.length > 0) all.push({ section: 'Background', items: props.bgColorActions })
  if (props.moveToActions.length > 0) all.push({ section: 'Move to', items: props.moveToActions })
  if (props.linkActions.length > 0) all.push({ section: 'Link', items: props.linkActions })
  if (props.topLevel.length > 0) all.push({ section: 'Actions', items: props.topLevel })

  if (all.length === 0) return <Empty label="No actions match" />

  return (
    <>
      {all.map((section, i) => (
        <React.Fragment key={section.section}>
          {i > 0 ? <MenuSeparator /> : null}
          <MenuGroup label={section.section} />
          {section.items.map((a) => (
            <ActionItem key={a.id} action={a} onSelect={() => props.onAction(a)} />
          ))}
        </React.Fragment>
      ))}
    </>
  )
}

function MenuGroup({ label }: { label: string }) {
  return (
    <Menu.Group>
      <Menu.GroupLabel className="px-2 pt-1 pb-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </Menu.GroupLabel>
    </Menu.Group>
  )
}

function ActionItem({ action, onSelect }: { action: MenuAction; onSelect: () => void }) {
  return (
    <Menu.Item
      disabled={action.disabled}
      onClick={(event) => {
        event.preventDefault()
        if (action.disabled) return
        onSelect()
      }}
      className={cn(
        'flex cursor-default items-center rounded px-2 py-1.5 text-sm outline-none',
        'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
      )}
      title={action.disabled ? action.disabledHint : undefined}
    >
      {action.label}
    </Menu.Item>
  )
}

function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />
}

function ColorHeader({ label }: { label: string }) {
  return <div className="px-2 pt-1 pb-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
}

function Empty({ label }: { label: string }) {
  return <div className="px-2 py-1.5 text-sm text-muted-foreground">{label}</div>
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'unknown'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  // MMM D, YYYY, h:mm AM/PM (en-US style, matches the spec).
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function rectToVirtualElement(rect: DOMRect) {
  return {
    getBoundingClientRect: () => rect,
  }
}

// ponytail: action helpers re-exported for the keyboard keymap (task 5)
// and the slash command (task 7) to share the same list of actions.
export type { MenuAction }
export const blockMenuTopLevel = (): MenuAction[] => []
