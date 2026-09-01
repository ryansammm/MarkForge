# Specs: r2-encrypted-nested

Two new specs and two modified specs land with this change.

## New: `encrypted-r2`

Lives at `openspec/specs/encrypted-r2/spec.md`. Covers the
client-side encryption layer for note bodies and the password-vault
blob.

## New: `nested-pages`

Lives at `openspec/specs/nested-pages/spec.md`. Covers `parent_id`
in the index, the sidebar tree, the breadcrumb, and the
renderer-generated child-pages section.

## New: `r2-only`

Lives at `openspec/specs/r2-only/spec.md`. Covers the removal of the
local filesystem backend and the env-var requirement at boot.

## New: `trash-30d`

Lives at `openspec/specs/trash-30d/spec.md`. Covers soft delete,
30-day retention, the trash panel, and the cron sweeper.

## Modified: `cloud-sync` → superseded

`openspec/specs/cloud-sync/spec.md` is marked "Superseded by
`r2-only` on 2026-08-30." The text of the spec is preserved for
history; no active requirement lives there anymore.

## Modified: `desktop-shell`

`openspec/specs/desktop-shell/spec.md`: the "Isolated local data"
requirement is dropped, replaced by a "R2 env required" requirement
that the Electron shell surfaces in its loading screen.
