# PRD Blocking Questions Q1 & Q3 Decision Document

**Sprint**: Sprint 2 (The Soak / Gate Sprint)  
**Author**: Xyks  
**Status**: Decided  

---

## ❓ Question 1: Git Sync Priority vs. Web Editing

**Context**: Should local git synchronization be a blocking prerequisite before enabling web editing in Sprint 3, or can local ingestion be automated via CLI/Cron?

### Decision: Automated CLI / Webhook Ingestion over Built-in Git Sync

1. **Rationale**:
   - Implementing full Git client sync (e.g. isomorphic-git or server-side git operations) in Sprint 3 adds ~10–12 hours of complex conflict resolution and auth key management overhead.
   - For read-only and initial write phases, running `scripts/ingest.ts` via local file watchers or GitHub Actions on push provides a clean separation of concerns.
   - Web editing in Sprint 3 will write directly to storage/Turso or emit `.conflict.md` files upon save collisions without blocking on Git plumbing.

2. **Action Item for Sprint 3**:
   - Keep `FileStore` write methods decoupled from Git. Git sync remains an external transport layer.

---

## ❓ Question 3: Single-Corpus vs. Multi-Workspace Architecture

**Context**: Should the workspace architecture enforce a strict single-corpus model (one root Markdown directory) or expand to multi-workspace switching?

### Decision: Single-Corpus Primary with Virtual Folder Namespaces

1. **Rationale**:
   - 95% of daily note taking and wikilink navigation relies on a single interconnected personal knowledge graph.
   - Multi-workspace switching fragments wikilinks and complicates cross-note backlink indexing.
   - Sub-directories (e.g., `Getting started/`, `Product/`, `Personal/`) already serve as effective folder namespaces within a single unified `index.json`.

2. **Action Item for Sprint 3**:
   - Enforce single-corpus workspace per instance. If multi-vault support is needed in Sprint 6, run separate deployed instances or use root folder scopes rather than altering core indexing logic.
