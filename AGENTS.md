# MarkForge — agent rules

## Editing source files (CRITICAL — mojibake history)

Never read or write source files through PowerShell `Get-Content`/`Set-Content`
pipelines. PowerShell 5.1 decodes UTF-8 as the system ANSI codepage, silently
corrupting em-dashes, ellipses, ⌘, © and every other non-ASCII character. This
shipped broken UI text to users three times before being gated.

Correct ways to edit:

1. The Edit/Write tools (they are UTF-8 safe), or
2. Node scripts: `fs.readFileSync(p,'utf8')` +
   `fs.writeFileSync(p, s, 'utf8')`, or
3. `[System.IO.File]::WriteAllText($full, $text, [System.Text.UTF8Encoding]::new($false))`
   — note `$false`: .NET's "UTF8" encoding adds a BOM that breaks Turbopack and
   JSON.parse.

## Encoding gate

- `npm run check:encoding` scans all sources for mojibake/BOM; it runs inside
  `npm run verify` (CI) and as a pre-commit hook (`.githooks/`,
  activated via `git config core.hooksPath .githooks`).
- If it fails: fix the file as clean UTF-8-no-BOM. Do not weaken the scanner
  patterns to make it pass.

## Project conventions

- Package manager: **pnpm** (`pnpm install`, `pnpm build`, `pnpm dev`).
- Desktop app: `pnpm desktop` / `pnpm desktop:start`.
- Spec-driven work lives in `openspec/`; check `openspec list` before inventing
  scope.
