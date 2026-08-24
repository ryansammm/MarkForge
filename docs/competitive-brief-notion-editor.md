# Competitive Brief — Notion: rich editor and preview

**Date:** 6 August 2026 · **Shelf life:** ~1 quarter; editor and AI features move fast
**Focus:** Editing and preview experience, plus the publish/share surface
**Decision this informs:** Whether Sprint 3's editor trade-off (CodeMirror source-mode
over a WYSIWYG block editor) leaves us exposed, and what — if anything — belongs in
Sprints 5–6 versus v2.

**Research basis:** public web sources listed at the end, plus this repo. No internal
win/loss or usage data: the Notion, Slack, Linear and Amplitude connectors are not
authorized in this session, so there is no first-party evidence here. Everything below
is desk research and should be treated as such.

---

## The framing, tested first

The request reads as "Notion has a rich editor and better preview — should we?" Those
are two different questions with opposite answers, and separating them is the single
most useful thing this brief does.

- **Rich block editor: no.** Notion's block model is the direct cause of Notion's
  worst-reviewed weakness, and adopting it would reintroduce the exact failure Sprint 3
  killed on evidence.
- **Better preview: yes, and it is the real gap.** What reads as "Notion feels richer"
  is mostly that our editor shows raw syntax in a hard modal split. That is fixable
  without touching the data model.

---

## Competitor overview

### Notion — the named competitor, but not a direct one

Notion is an all-in-one workspace: docs, databases, wikis, projects, and since 2025–26 a
heavy AI agent layer. ~100M users. Pricing in 2026 is Free / Plus $10 / Business $20 per
user/month annually (roughly $12 / $24 month-to-month), with meaningful AI gated to
Business.

2026 momentum is almost entirely AI and platform, not editing: Notion 3.2 shipped mobile
AI and new models (January), and April brought Workers for Agents (a code execution
environment for agents), a Developer Platform, voice dictation, and eight new database
view API endpoints. **Notably, the April release also made the API return page content as
clean Markdown** — more on why that cuts both ways below.

**Notion is an indirect competitor for our use case, not a direct one.** It is
cloud-first, block-model, team-oriented. Our PRD targets a single-corpus personal
Markdown vault where files are the source of truth. Users choose between these on
philosophy, not feature count.

### The direct competitive set

| | Model | Editor | Publish | Price |
|---|---|---|---|---|
| **Obsidian** | Local Markdown files | Source + **Live Preview** | Publish add-on | Free app; Publish $8–10/**site**/mo |
| **Notion** | Cloud blocks | Block WYSIWYG | Notion Sites, included in plan | $10–20/user/mo |
| **Craft** | Cloud + local | Block, design-led | Included | Mid |
| **Us** | Local/R2 Markdown files | Source (CodeMirror 6) | Sprint 6 | — |

Obsidian is the real competitor. Notion is the thing users are *leaving*, which makes it
strategically interesting for a different reason than feature parity.

---

## Feature comparison — editing and preview

Rated: **Strong** (market-leading) · **Adequate** (works, undifferentiated) · **Weak**
(exists, gaps) · **Absent**.

| Capability | Us (post-Sprint 4) | Notion | Obsidian | Why it matters |
|---|---|---|---|---|
| **Editing surface** | | | | |
| Typing latency on long docs | Strong | Weak | Strong | Notion's block model lags; reviewers name it repeatedly |
| Inline rendered formatting while typing | **Absent** | Strong | Strong | **Our real gap** — see below |
| Rendered reading view | Adequate | Strong | Strong | Ours is a separate mode with a full remount |
| Raw Markdown always visible/editable | Strong | Absent | Strong | The premise of the product |
| Slash-command block insertion | Absent | Strong | Adequate | Notion's most-imitated affordance |
| Drag-to-reorder blocks | Absent | Strong | Weak | Genuinely good in Notion |
| Multi-column layout, callouts, toggles | Absent | Strong | Weak (plugins) | Notion's real layout advantage |
| **Links and structure** | | | | |
| `[[wikilink]]` with autocomplete | Strong | Weak | Strong | Notion has `@`-mentions, not a link graph |
| Backlinks panel | Strong | Adequate | Strong | |
| Rename rewrites inbound links | **Strong** | Adequate | Strong | Ours reports per-file success/failure; few do |
| Ghost-page creation from a dead link | Strong | Adequate | Strong | |
| **File integrity** | | | | |
| Round-trip fidelity to `.md` | **Strong** | **Weak** | Strong | Ours is a byte-level no-op; tested |
| Opens files edited elsewhere | Strong | Absent | Strong | |
| Export without loss | Strong | **Weak** | Strong | Notion's most-complained-about trait |
| **Publishing** | | | | |
| Public page speed | Sprint 6 target <1.5s | Weak | Adequate | Notion Sites is slow |
| SEO control / custom domain | Sprint 6 | Weak | Adequate | `notion.site` links build *Notion's* domain authority |
| Per-site vs per-seat pricing | TBD | Per-seat | **Per-site** | Obsidian's per-site model is a vulnerable position |
| **AI** | Absent | Strong | Weak | We are not competing here and should not start |

Honest reading: Notion beats us on layout expressiveness and on AI, decisively. We beat
Notion on file integrity, link-graph mechanics, and speed. On **inline live preview we
are behind both** — and that is the only row in this table where our gap is a *user
experience* gap rather than a deliberate scope choice.

---

## Positioning analysis

**Notion:** For teams who need docs, wikis, and projects in one place, Notion is a
connected workspace that replaces several tools. Unlike point solutions, everything lives
in one system with AI across it.
Category: *connected workspace*. Differentiator: *all-in-one + AI agents*. Proof: 100M
users, enterprise logos.

**Obsidian:** For people who think in connected notes, Obsidian is a local-first
Markdown knowledge base you own. Unlike cloud tools, your notes are files on your disk.
Category: *personal knowledge base*. Differentiator: *local files + 1,400 plugins*.

**Us (implied by the PRD):** For someone who keeps a connected Markdown vault, this is a
browser-native workspace where the files stay the source of truth and any document can
become a public URL in one click.
Category: *browser-native Markdown workspace*. Differentiator: **files survive + sharing
is native, not an add-on.**

### The unclaimed position

Nobody owns **"local-first integrity with first-class sharing."** Obsidian owns integrity
but treats publishing as a $8–10/site add-on with limited design and no analytics. Notion
owns sharing but its export is the loudest complaint in its community. That gap is
precisely where Sprint 6 lands, and it is worth more than any editor feature in this
brief.

### The crowded position

"AI-powered." Every competitor claims it, Notion has spent two years and a platform on
it, and matching them is not a fight this product can win or needs to.

---

## Strengths and weaknesses

### Notion — strengths (be honest about these)

- **Layout expressiveness.** Multi-column, callouts, toggles, synced blocks. This is real
  and plugins do not replicate it well.
- **Zero-friction onboarding.** Non-technical users are productive in minutes.
- **Databases.** No Markdown tool has a credible answer.
- **AI depth.** Agents, meeting notes with custom instructions, mobile parity, a
  developer platform. A serious, funded bet.
- **Collaboration.** Real-time multiplayer that a file-based model cannot easily match.

### Notion — weaknesses

- **Markdown export is broken, and it is the top community complaint.** Databases export
  as CSV, not Markdown. Callouts become raw `<aside>` HTML with inline styles that most
  renderers drop. Internal links are rewritten to local paths with a 32-character ID
  baked in — "my links broke" is the canonical report. Images come out as a separate zip
  rather than inline references. Some embeds still point at time-limited signed URLs.
- **This weakness is caused by the block model.** It is not a bug they have neglected; it
  is what happens when the document model is richer than the format you export to.
- **Performance** degrades on complex pages; typing lag is named in reviews.
- **Notion Sites is weak as a publishing surface** — limited control of meta titles,
  descriptions, structured data, and page speed, and ranking strength accrues to
  `notion.site`, not to you.
- **No offline-first story.**

### Us — strengths

- Round-trip integrity is *structural*, not defended by tests: the buffer is the file.
- Rename-with-link-rewrite does byte-offset splicing and reports per-file outcomes —
  better failure reporting than anything in the comparison set.
- Fast, small, no database.

### Us — weaknesses

- **No inline live preview.** Editing shows raw `##`, `**`, and `[[ ]]`. Reading is a
  separate mode. Every serious competitor renders inline.
- No block-level manipulation of any kind.
- **The write backend still does not work on Vercel** (carried from Sprint 3). This
  outranks every item in this brief.
- No collaboration, no AI, no mobile story.
- Two documents in the corpus; nothing has been validated at real scale.

---

## Opportunities

1. **The Notion refugee migration path.** Notion's export breakage is well-documented and
   unsolved — "no tool provides a clean automated export" for database-heavy workspaces.
   An importer that correctly handles Notion's `<aside>` callouts and its 32-char ID
   links would be a sharp wedge. It also plays directly to our strength: we can prove
   round-trip integrity, they cannot.
2. **The Notion API now returns clean Markdown** (April 2026). Notion built the on-ramp
   out of their own product. That materially lowers the cost of building the importer
   above.
3. **Publishing is the soft target, not editing.** Notion Sites is slow with poor SEO
   control; Obsidian Publish is $8–10 per site with limited design and no analytics.
   Sprint 6's "<1.5s cold load, no editor JS in the bundle" is a genuinely
   differentiated claim in this set. Custom domain support would sharpen it further.
4. **Live preview is available off the shelf.** `@atomic-editor/editor` is a CodeMirror 6
   React library doing Obsidian-style inline live preview — headings, emphasis, tables,
   images, task lists, code highlighting, reading mode, and **`[[target]]` /
   `[[target|label]]` wikilinks with async resolution and autocomplete**. That is close
   to a description of what we already built by hand. Build-vs-buy is a real question
   here rather than a rhetorical one.

## Threats

1. **Notion's AI investment compounds.** Agents that act across a workspace are a
   different product category. If knowledge work moves to agent-mediated, a fast file
   viewer is a smaller thing to be. No cheap counter; monitor.
2. **Obsidian is the actual threat, not Notion.** It already has live preview, local
   files, a link graph, and 1,400 plugins. If Obsidian ships a good browser experience,
   our core differentiator narrows to sharing alone.
3. **The nightmare move:** Obsidian bundles Publish into the base product, or drops it to
   per-user pricing. That would take the unclaimed position above off the board.
4. **Self-inflicted:** the plan's own standing rule 4 warns that after five sprints of
   build fatigue, Sprint 6 is exactly when a fun feature starts looking like a good
   reason to avoid Sprint 5's unglamorous work. **A live-preview editor upgrade is
   precisely that temptation.** Naming it here so it is harder to rationalize later.

---

## Strategic implications

### 1. Do not build a block editor. Close the preview gap instead.

Chasing Notion's block model means adopting Notion's document model, which means
inheriting Notion's export problem — the very thing their users complain about most and
the thing we win on. Sprint 3 already ran this experiment and got hard evidence: a
round-trip through the block-editor serializer escaped `[[Principles]]` into
`\[\[Principles]]`. **Notion's broken export is the same failure at product scale.**

What people actually mean by "Notion feels richer" is overwhelmingly *inline rendering*.
Obsidian closed most of that perceived gap with Live Preview without a block model. That
is the move available to us, and it costs the data model nothing.

### 2. Differentiate vs achieve parity

| Area | Stance |
|---|---|
| File integrity, round-trip | **Differentiate** — already ahead, keep pressing |
| Public sharing speed and control | **Differentiate** — the unclaimed position |
| Rename / link-graph safety | **Differentiate** — quietly best-in-set already |
| Inline live preview | **Parity** — table stakes, not a differentiator |
| Block layout, multi-column, callouts | **Concede** |
| AI, real-time collaboration, databases | **Concede** |

### 3. Where this lands in the plan — and where it must not

**Not Sprint 5.** Sprint 5 is the failure-handling sprint, and the plan is explicit that
it is the one that decides whether the tool is still trusted in six months. Nothing in
this brief outranks it. The R2 backend gap outranks everything here too — a beautiful
editor on a deployment that cannot save is worth nothing.

**Sprint 6, as a scoped P1 swap.** Sprint 6 is deliberately light at 11.5h committed. If
live preview goes anywhere in v1, it goes there, as a swap against the existing P1s (dark
mode 1.5h, tag browsing 2h) per standing rule 3 — and only after the P0 share-link work
is done. Timebox the spike hard, exactly as Sprint 3 did.

**Recommended v1 scope for "better preview" — 3h, spike-gated:**
- Inline rendering for headings, emphasis, code spans, and `[[wikilinks]]` only. Syntax
  reveals when the cursor enters the node. Nothing else.
- Reading view stays as it is; this is not a rewrite of `DocViewer`.
- Evaluate `@atomic-editor/editor` against hand-rolling in the first hour. It already
  handles our wikilink syntax, which is the part that would otherwise cost the most.
- **Gate:** if inline rendering destabilizes the cursor or breaks the round-trip suite,
  stop. Integrity is the product; preview is polish.

Everything beyond that — slash commands, block drag, multi-column — is a v2 conversation,
and should be argued on its own merits rather than on Notion having it.

### 4. Positioning and messaging

Stop implying competition with Notion on capability. The line that follows from this
analysis:

> **Your notes stay files you can open in vim. Any of them can be a URL in one click.**

Against Notion, lead with *export integrity* and *page speed*. Against Obsidian, lead
with *sharing included, not $10 a site*. Do not lead with the editor in either case.

### 5. Monitor

- Obsidian Publish pricing or bundling changes — the single highest-impact signal here.
- Notion Sites gaining custom domains, real SEO control, or speed improvements.
- Notion improving Markdown export fidelity (would blunt the migration wedge).
- Whether the PRD's own metric moves: *Notion/Obsidian opened for the same job — 0 times
  in 30 days*. That is better evidence than anything in this brief.

---

## Sources

- [Notion export limitations (2026): what travels, what breaks — Raccoon Page](https://raccoon.page/blog/notion-export-limitations/)
- [Notion Export Is Broken: How to Fix It With Markdown — Unmarkdown](https://unmarkdown.com/blog/notion-export-broken)
- [The Complete Guide to Exporting Notion Data — ClonePartner](https://clonepartner.com/blog/definitive-guide-notion-data-export-api-pdf-html/)
- [Notion vs Obsidian – All Features Compared (2026) — Productive](https://productive.io/blog/notion-vs-obsidian/)
- [Obsidian vs Notion (2026): I tested both for 6 months — Edopedia](https://www.edopedia.com/blog/obsidian-vs-notion/)
- [Notion vs Obsidian: Which Knowledge Tool Wins in 2026? — AFFiNE](https://affine.pro/vs/notion-vs-obsidian)
- [Notion 3.2 release notes, January 2026](https://www.notion.com/releases/2026-01-20)
- [Notion Updates 2026 April: Full Changelog — Fazm](https://fazm.ai/blog/notion-updates-2026-april)
- [Notion Pricing 2026: Free, $10 Plus, $20 Business — Automation Atlas](https://automationatlas.io/answers/notion-pricing-explained-2026/)
- [Notion pricing 2026: Which plan is actually worth it? — eesel AI](https://www.eesel.ai/blog/notion-pricing)
- [Is Notion good for SEO? — Simple.ink](https://www.simple.ink/faq/is-notion-good-for-seo)
- [Notion slow? Easy way to make Notion faster — Bullet.so](https://bullet.so/blog/how-to-make-notion-website-faster/)
- [Obsidian Publish Review (2026) — MakerStack](https://makerstack.co/reviews/obsidian-publish-review/)
- [Obsidian Pricing 2026: Free App, Sync & Publish Costs — TheToolsverse](https://thetoolsverse.com/tools/obsidian)
- [atomic-editor — CodeMirror 6 Obsidian-style live preview](https://github.com/kenforthewin/atomic-editor)
- [codemirror-live-markdown](https://github.com/blueberrycongee/codemirror-live-markdown)
