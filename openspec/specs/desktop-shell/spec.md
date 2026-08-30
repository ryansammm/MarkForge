# desktop-shell Specification

## Purpose
Specifies the desktop (Electron) shell behavior: launching the workspace locally, native import of files/folders, and how imported content becomes visible in the workspace.

## Requirements

### Requirement: Desktop launch

Running the desktop entry point SHALL start a local production server of the app and display it in a desktop window; closing the window SHALL stop the server.

#### Scenario: First launch

- **WHEN** the user runs the desktop command
- **THEN** a window opens showing the workspace login, backed by the local data directory

### Requirement: R2 env required

The desktop shell SHALL refuse to mount the editor when any
`R2_*` env var is missing, and SHALL surface the same
configuration screen as the web app. The desktop server SHALL
NOT write to the OS user-data directory; all storage is in R2.

#### Scenario: Missing R2 env

- **WHEN** the user launches the desktop shell with one or more
  `R2_*` env vars missing
- **THEN** the shell shows the configuration screen instead of
  the editor

#### Scenario: No local data directory

- **WHEN** the desktop shell is running
- **THEN** no files appear in `%APPDATA%\MarkForge`

### Requirement: Native import

The desktop shell SHALL offer native dialogs to add individual files or a whole folder into the workspace; supported documents are copied preserving their relative folder structure.

#### Scenario: Import a folder of notes

- **WHEN** the user picks "Import folder" and selects a directory containing `.md` files
- **THEN** the files appear as workspace documents after import completes

### Requirement: Index consistency after import

After copying imported content, the workspace index SHALL be rebuilt through the existing authenticated reindex endpoint before the UI refreshes the sidebar.

#### Scenario: Imported notes are listed

- **WHEN** an import finishes
- **THEN** the new documents appear in search and the sidebar without restarting the app
