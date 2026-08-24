## Purpose

Specifies behavior when users drop files or folders from their operating system onto the sidebar.

## ADDED Requirements

### Requirement: Drop imports documents

Dropping files or folders onto the sidebar SHALL import every `.md` file found (recursively) as a workspace document, preserving relative folder paths.

#### Scenario: Drop a mixed folder

- **WHEN** a folder containing `.md` files and other file types is dropped on the sidebar
- **THEN** all `.md` files become documents at their relative paths and non-markdown files are ignored

### Requirement: Never overwrite on drop

An imported document whose path already exists SHALL be skipped; the existing document MUST remain unchanged.

#### Scenario: Drop containing an existing path

- **WHEN** the dropped set includes a path that already exists in the workspace
- **THEN** that file is not written and the user is told how many were skipped

### Requirement: Index reflects the drop

After the uploads finish, the index SHALL be rebuilt and the sidebar refreshed without a restart.

#### Scenario: Dropped notes appear immediately

- **WHEN** a drop finishes uploading
- **THEN** the new documents appear in the sidebar and search
