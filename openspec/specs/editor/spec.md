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
