# trash-30d Specification

## Purpose

Specifies how MarkForge soft-deletes documents: a deleted file
moves to an R2 prefix `.trash/` with a timestamp, is listed in a
trash panel for 30 days, and is permanently removed by a daily
cron sweeper after that.

## Requirements

### Requirement: Soft delete

`DELETE /api/files?path=<path>` SHALL move the R2 object to
`.trash/<unix_ms>/<path>` and return `{ ok: true, trashId:
<unix_ms> }`. The original key is removed.

#### Scenario: Delete a file

- **WHEN** the user deletes a file
- **THEN** the R2 object is no longer at the original path
  and is instead at `.trash/<ts>/<path>`

### Requirement: Trash panel

The sidebar SHALL expose a `Trash` button that opens a
slide-over panel listing all `.trash/*` entries with their
`Deleted <relative-time>` and `Original path`. Each row has
`Restore` and `Delete forever` buttons.

#### Scenario: List trash

- **WHEN** the user opens the trash panel
- **THEN** every entry under `.trash/*` is listed with its
  original path and deletion time

### Requirement: Restore is move-back

`POST /api/trash/restore` SHALL move the R2 object from
`.trash/<ts>/<path>` back to `<path>`, overwriting any
existing object at that path. The trash entry is removed.

#### Scenario: Restore a file

- **WHEN** the user clicks `Restore` on a trash entry
- **THEN** the file is back at its original path and the
  trash entry is gone

### Requirement: Permanent delete

`DELETE /api/trash/<trashId>` SHALL remove the R2 object at
`.trash/<trashId>/<path>` permanently. There is no further
recovery.

#### Scenario: Delete forever

- **WHEN** the user clicks `Delete forever` on a trash entry
- **THEN** the R2 object is removed with no copy retained

### Requirement: 30-day retention sweep

A daily cron route at `/api/cron/sweep-trash` SHALL list every
`.trash/*` entry, compute the age from `<unix_ms>`, and delete
entries older than 30 days. The route SHALL be wired to
`vercel.json` with schedule `0 3 * * *` (03:00 UTC).

#### Scenario: Sweep old entries

- **WHEN** the cron runs and an entry is older than 30 days
- **THEN** the entry is removed from R2

#### Scenario: Young entries kept

- **WHEN** the cron runs and an entry is younger than 30 days
- **THEN** the entry is left in place
