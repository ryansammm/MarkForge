# cloud-sync Specification

> **Superseded by `r2-only` on 2026-08-30.** MarkForge no longer has
> a local corpus; the "upload from local" workflow is moot. This
> spec is preserved for history; no active requirement lives here.

## Purpose (historical)

Originally specified the explicit desktop action that uploads the
local corpus to Cloudflare R2 on demand, keeping the workspace
itself local-first.
## Requirements

### Requirement: Explicit push only

The desktop app SHALL upload local documents to the configured R2 bucket only when the user triggers the sync action; no automatic or background uploading SHALL occur.

#### Scenario: Editing stays local

- **WHEN** the user creates or edits documents without syncing
- **THEN** nothing is sent to the cloud bucket

### Requirement: Create-only push

The sync SHALL skip documents whose path already exists in the bucket rather than overwriting them, so edits made through the web app survive a desktop push.

#### Scenario: Push with an existing document

- **WHEN** the local corpus contains a path already present in the bucket
- **THEN** that document is reported as skipped and the bucket copy remains unchanged

### Requirement: Destination index rebuilt once

After uploads complete, the destination index SHALL be rebuilt exactly once and the outcome (uploaded / skipped counts) SHALL be reported to the user.

#### Scenario: Successful sync feedback

- **WHEN** a sync finishes
- **THEN** the user sees how many documents were uploaded and how many were already in sync
