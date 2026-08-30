# r2-only Specification

## Purpose

Specifies that Cloudflare R2 is the only storage backend for
MarkForge. The local-filesystem backend is removed.

## Requirements

### Requirement: R2 env vars required at boot

The system SHALL refuse to mount the editor when any of
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, or
`R2_BUCKET` is missing. A one-screen configuration page SHALL be
shown instead, listing the four env var names.

#### Scenario: Missing R2 env

- **WHEN** the user opens MarkForge with one or more `R2_*` env
  vars missing
- **THEN** the editor does not mount, and the screen shows
  "MarkForge requires R2 configuration" with the four env var
  names

#### Scenario: R2 env present

- **WHEN** the user opens MarkForge with all four `R2_*` env
  vars set
- **THEN** the editor mounts and the workspace loads from R2

### Requirement: No local filesystem writes

The system SHALL NOT write to the local filesystem for
document storage, the workspace index, the trash, the password
vault, or share metadata. The Electron shell's
`%APPDATA%\MarkForge` user-data directory is unused.

#### Scenario: Electron shell

- **WHEN** the user launches the Electron shell
- **THEN** the shell does not create or write to
  `%APPDATA%\MarkForge`; all reads and writes go to R2

### Requirement: Storage health endpoint

`GET /api/storage` SHALL return `{ backend: 'r2', bucket: <name> }`
unconditionally. `GET /api/health` SHALL return 503 when R2 env
vars are missing and 200 when they are present and the bucket is
reachable.

#### Scenario: Storage report

- **WHEN** `/api/storage` is called
- **THEN** the response names R2 as the active backend with
  the configured bucket name
