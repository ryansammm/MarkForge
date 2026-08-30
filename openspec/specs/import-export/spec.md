# import-export Specification

## Purpose

Specifies the per-page Import and Export actions, the on-disk format of
the exported Markdown, and the Electron-vs-web code path for writing
the exported bytes.

## Requirements

### Requirement: Import accepts a `.md` file and creates a sibling page

The file picker returns a `File`; the parser reads the bytes, picks a
title, and creates a new page in the active grimoire. The new page is
a sibling of the source — not a child.

#### Scenario: A `.md` file becomes a new page

- **WHEN** the user picks a `.md` file from the page menu's `Import`
- **THEN** a new document is written to the active grimoire root with
  the parsed body
- **AND** the new document's title is taken, in order, from: the file's
  `title` frontmatter, the first `# H1` line, or the filename (minus
  the `.md` extension)
- **AND** the new tab opens in the editor

#### Scenario: A non-`.md` file is refused

- **WHEN** the user picks a file that does not end in `.md`
- **THEN** `Import` shows an error and does not write anything

### Requirement: Export writes UTF-8 Markdown via the OS dialog

The export path goes through the Electron `saveFile` IPC when running
in the desktop app, and falls back to a transient `<a download>` in
the web. Both paths write UTF-8 without a BOM.

#### Scenario: Electron Save-As dialog

- **WHEN** the user picks `Export` while `window.markforge` is present
- **THEN** the Electron Save-As dialog opens
- **AND** the chosen path is written with UTF-8 bytes
- **AND** the chosen path is returned to the caller

#### Scenario: Web download fallback

- **WHEN** the user picks `Export` in a web browser
- **THEN** a transient anchor with a `Blob` URL is created
- **AND** clicking it triggers a download
- **AND** the blob URL is revoked after the click

### Requirement: The exported body is the active document

The export is the current document's body with the frontmatter block
removed (unless the document's body itself starts with one). The
default filename is the document's title plus `.md`.

#### Scenario: Round-trip preserves the body

- **WHEN** the user exports a page and re-imports it
- **THEN** the title and body match the original
- **AND** any new links resolve to the same destinations
