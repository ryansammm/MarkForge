# Sprint 5 Plan

## Goal

Deliver the highest‑priority backlog items, close the remaining gaps from Sprint 4, and prepare the write backend for Vercel deployment.

## Backlog Summary (from Sprint 4)

- **Frontmatter contract (PRD R7)** – Done (3 h)
- **File & folder CRUD in the tree** – Done (3 h)
- **Move / rename with path update** – Done (2 h)
- **Rename with inbound‑link rewrite** – Done (5 h)
- **Ghost page creation** – Done (2 h)
- **Document outline / TOC panel** – Not started (2 h)
- **Recently edited list** – Not started (1.5 h)

## Gap Items to Address

1. **Write backend for Vercel** (P0, ≈3–4 h)
   - Implement `WritableFileStore` for Vercel's read‑only environment.
   - Add `createDirectory`, `removeDirectory`, `moveDirectory` handling.
2. **Interactive UI verification suite** (P0, ~20 min)
   - Automate the 6‑step manual checklist from the Sprint 4 "Open gaps" section.
3. **Expand test corpus** (P1, ~1 h)
   - Add a handful of markdown documents to the test corpus to simulate a realistic corpus size.
4. **Remaining P1 backlog items**
   - Document outline / TOC panel (2 h)
   - Recently edited list (1.5 h)

## Proposed Sprint 5 Allocation (16 h total)

| Item | Estimate | Priority |
|------|----------|----------|
| Write backend for Vercel | 3–4 h | P0 |
| UI verification suite | 0.5 h | P0 |
| Document outline / TOC panel | 2 h | P1 |
| Recently edited list | 1.5 h | P1 |
| Expand test corpus | 1 h | P1 |
| Buffer / unforeseen work | 4–5 h | — |

## Acceptance Criteria

- All automated tests (`npm test`) pass.
- Vercel preview deployment can write files without errors.
- Manual UI checklist runs without failures.
- New docs appear correctly in the UI and backlinks update as expected.

---

*Prepared based on the approved implementation plan.*
