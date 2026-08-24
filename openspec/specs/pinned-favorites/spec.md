# pinned-favorites Specification

## Purpose
Specifies pinning documents so favorites stay one click away at the top of the sidebar.

## Requirements

### Requirement: Pin from the document tree

Hovering a document row SHALL offer a pin action; pinned documents SHALL appear in a Pinned section above the tree, ordered by when they were pinned.

#### Scenario: Pin a document

- **WHEN** the user clicks the pin action on a document row
- **THEN** the document appears in the Pinned section without leaving its place in the tree

### Requirement: Pins persist per device

Pins SHALL be remembered across app restarts via localStorage; they are a device-local convenience, not synced cloud state.

#### Scenario: Reload keeps pins

- **WHEN** the workspace is reloaded after pinning
- **THEN** the Pinned section still lists the same documents

### Requirement: Stale pins self-heal

A pinned path whose document no longer exists (deleted or renamed) SHALL be omitted from the section until its path is valid again.

#### Scenario: Pin a deleted path

- **WHEN** a pinned document is moved to trash
- **THEN** it disappears from the Pinned section while the pin remains dormant
