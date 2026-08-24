## Purpose

Specifies the desktop (Electron) shell behavior: launching the workspace locally, native import of files/folders, and how imported content becomes visible in the workspace.

## ADDED Requirements

### Requirement: Desktop launch

Running the desktop entry point SHALL start a local production server of the app and display it in a desktop window; closing the window SHALL stop the server.

#### Scenario: First launch

- **WHEN** the user runs the desktop command
- **THEN** a window opens showing the workspace login, backed by the local data directory

### Requirement: Isolated local data

The desktop server SHALL store documents and metadata under the OS user-data directory (`%APPDATA%\MarkForge`), never inside the repository working tree.

#### Scenario: Import does not dirty the repo

- **WHEN** the user imports files on the desktop
- **THEN** no new or modified files appear in the repository's git status

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
