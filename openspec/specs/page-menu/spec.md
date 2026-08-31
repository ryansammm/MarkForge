# page-menu Specification

## Purpose

Specifies the per-page menu in the reading view header — the `⋯` button
that exposes page-level actions: copy content, duplicate, move to a
folder, move to trash, view-size and width toggles, lock, import, export.

## Requirements

### Requirement: The menu is mounted on the active document

The page menu sits in `DocViewer` next to the document title. It is
present only when a document is open and visible.

#### Scenario: An open document renders the menu

- **WHEN** a document is the active one in the reading view
- **THEN** the `⋯` button is visible
- **AND** clicking it opens the menu against the document's path

#### Scenario: A locked document renders the menu

- **WHEN** a locked document is opened but not yet unlocked
- **THEN** the `⋯` button is still visible
- **AND** the `Lock page` action reads `Unlock` (the lock is currently
  held)

### Requirement: The menu has eleven actions

The menu lists exactly: `Copy page content`, `Duplicate`, `Move to`,
`Move to trash`, `Small text`, `Full text`, `Full width`, `Default
width`, `Lock page`, `Import`, `Export`.

#### Scenario: All eleven items render in the menu

- **WHEN** the menu is open
- **THEN** all eleven items are listed with the labels above
- **AND** none of the items are placeholders or "coming soon"

### Requirement: View-size and width toggles write to frontmatter

The four toggles write `view: small | full` and `width: full | default`
into the document's YAML frontmatter. The reading view reads these
fields and applies a `max-w-*` Tailwind class accordingly.

#### Scenario: Small text reduces the max width

- **WHEN** the user picks `Small text`
- **THEN** the document's frontmatter has `view: small`
- **AND** the reading view applies the narrowest available `max-w-*`
  class

#### Scenario: Full width expands the wrapper

- **WHEN** the user picks `Full width`
- **THEN** the document's frontmatter has `width: full`
- **AND** the reading view applies the widest `max-w-*` class

#### Scenario: Default width clears the field

- **WHEN** the user picks `Default width`
- **THEN** the `width` frontmatter field is removed
- **AND** the reading view applies the default `max-w-*` class

### Requirement: Lock / Unlock edit the frontmatter lock block

The `Lock page` action prompts for a passphrase and writes
`frontmatter.lock = { kdf, salt, iterations, hash }` to the document.
`Unlock` removes the same block.

#### Scenario: Locking writes a `lock` block

- **WHEN** the user picks `Lock page` and submits a passphrase
- **THEN** the document's frontmatter has a `lock:` block with the
  kdf, salt, iterations, and hash fields
- **AND** the editor mount is gated by a lock prompt until the same
  passphrase verifies

#### Scenario: Unlocking removes the `lock` block

- **WHEN** the user picks `Unlock` on a locked document
- **THEN** the `lock` block is removed from the frontmatter
- **AND** the editor mounts without prompting

### Requirement: Move to uses a folder picker submenu

`Move to` is not a modal. It opens a submenu of folders (built by
`collectFolders`) that excludes the document's own path and any folder
beneath it. Picking a folder moves the document there.

#### Scenario: The current folder is excluded

- **WHEN** the user opens the `Move to` submenu
- **THEN** the document's current folder is not listed
- **AND** no descendant folder of it is listed (a document cannot be
  moved into its own subtree)

#### Scenario: Picking a folder renames the document

- **WHEN** the user picks a folder from the submenu
- **THEN** the document is moved to `<folder>/<filename>`
- **AND** the sidebar reflects the new path
- **AND** the active tab follows the rename

### Requirement: Import and Export round-trip a single page

`Import` accepts a `.md` file via a file picker, parses the title from
frontmatter / first H1 / filename, and creates a new page in the
workspace root. `Export` writes the active document via the
Electron Save-As dialog or a browser download.

#### Scenario: Import creates a sibling page

- **WHEN** the user picks a `.md` file from `Import`
- **THEN** a new document is created with the parsed title as filename
- **AND** the new document sits at the workspace root, not as a child
  of the source page
- **AND** the editor opens the new page as the active tab

#### Scenario: Export writes the active body

- **WHEN** the user picks `Export` on the active document
- **THEN** a file is written with the document's body (frontmatter
  stripped unless it was present originally)
- **AND** the default filename is the document title with `.md`
- **AND** the chosen path is returned to the caller
