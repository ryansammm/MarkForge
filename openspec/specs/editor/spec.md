# editor Specification

## Purpose

Specifies the block-level markdown features added in the
`2026-08-30-notion-parity` change: callout, toggle list, the AI block,
and the per-page lock.

## Requirements

### Requirement: A callout is a blockquote whose first line carries a marker

The first line of a callout blockquote is `> [!info|warn|warning|danger|success] `.
The marker is case-insensitive and recognised before the generic `> ` so
callouts win over plain quotes.

#### Scenario: An info callout renders as a callout

- **WHEN** the buffer contains a blockquote whose first line is
  `> [!info] heading`
- **THEN** the rendered output is a callout box with the `info` style
  and the heading text

#### Scenario: A plain quote does not become a callout

- **WHEN** the buffer contains a blockquote with no `[!...]` marker
- **THEN** the rendered output is a regular blockquote

### Requirement: A toggle list is a bullet list whose meta comment is `type:toggle_list`

The meta comment is a hidden HTML comment on the same line as the first
bullet: `<!-- mkf:b:… type:toggle_list -->`. The body is then
`- item` lines that, when clicked, expand or collapse.

#### Scenario: A toggle list renders as a `<details><summary>` per item

- **WHEN** the buffer contains a bullet list with the `type:toggle_list`
  meta comment
- **THEN** each bullet becomes a `<details><summary>` element with
  the bullet text as the summary

### Requirement: A `- [ ]` line is a todo, not a toggle list

The detection rule is unambiguous: a line starting with `- [ ]` is a
todo. The `type:toggle_list` meta is required for the toggle-list
behaviour.

#### Scenario: A todo list is not a toggle list

- **WHEN** the buffer contains `- [ ] task` without a meta comment
- **THEN** the rendered output is a checkbox todo
- **AND** the toggle-list `<details>` wrapper is not used

### Requirement: `Shift+Enter` inside a paragraph inserts a hard break

`Shift+Enter` is a Markdown hard break (`<br>`). `Enter` alone starts
a new paragraph.

#### Scenario: Shift+Enter inserts a hard break

- **WHEN** the cursor is in a paragraph and the user presses
  `Shift+Enter`
- **THEN** the buffer gains a hard break (two trailing spaces) at the
  cursor
- **AND** the rendered output shows the two halves on separate lines
  with a `<br>`

### Requirement: A page can be locked at the frontmatter level

The lock is a UI gate, not a server-side guard. The block is written as
flow-style YAML at the top of the frontmatter:

```yaml
lock:
  kdf: PBKDF2-SHA256
  salt: <base64>
  iterations: 100000
  hash: <base64>
```

The editor mount on a locked page is gated by a passphrase prompt; the
reading view does not require the passphrase.

#### Scenario: Locking a page writes the block

- **WHEN** the user picks `Lock page` and submits a passphrase
- **THEN** the document's frontmatter has the `lock:` block above
- **AND** subsequent mounts of the editor require the same passphrase
  to render the editor

#### Scenario: Wrong passphrase shakes the prompt and refuses

- **WHEN** the user submits a passphrase that does not match the lock
- **THEN** the prompt shakes once (CSS keyframe `lock-shake`)
- **AND** the editor does not mount

#### Scenario: A malformed or missing lock is treated as no lock

- **WHEN** the frontmatter `lock:` block is missing a required field
  (kdf, salt, iterations, or hash)
- **THEN** `frontmatterLock` returns `null`
- **AND** the editor mounts without prompting

### Requirement: New-page modal routes through `openNewDocument`

The sidebar's `+ New page` button and the `Mod-N` keymap both
invoke the same `openNewDocument('')` callback. The callback is
exposed via a ref (`openNewDocumentRef`) that is mirrored from
the `useCallback` so the keydown handler can reference the
function before its declaration.

#### Scenario: Mod-N opens the new-page modal

- **WHEN** the editor has focus and `Mod-N` is pressed
- **THEN** the new-page modal opens with the same behaviour as
  the sidebar's `+ New page`

#### Scenario: ref mirrors the latest callback

- **WHEN** `openNewDocument` is recreated by React
- **THEN** `openNewDocumentRef.current` points at the latest
  closure (no stale reference)

### Requirement: Page-ref chip for wikilinks

A `[[Page Title]]` wikilink in a block renders as a chip in the
editor and as a link in the reader. The chip's text is the page
title; the chip's click target is the workspace-relative path
of the referenced page.

#### Scenario: chip text matches the page title

- **WHEN** a block contains `[[Project Plan]]` and a page
  titled "Project Plan" exists in the workspace
- **THEN** the editor renders a chip whose text is "Project
  Plan" and whose click target opens the page

### Requirement: `requireRange` is null-safe

Editor commands that need a non-collapsed selection do not
crash when the active selection is collapsed. They either no-op
or fall back to single-cursor behaviour.

#### Scenario: collapsed selection on a range-only command

- **WHEN** the user invokes a command that requires a range
  (e.g. a transform over a selection) and the active selection
  is collapsed
- **THEN** the command is a no-op; no exception is raised
