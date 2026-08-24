import { normalizePath, type MarkdownDocument } from '../file-store'
import { countLinksTo, retargetWikiLinks } from '../markdown/links'
import { splitFrontmatter, frontmatterTitle } from '../markdown/frontmatter'
import { retitleFirstHeading } from '../markdown/serializer'
import type { WorkspaceStore } from './workspace-store'

/**
 * Rename with inbound-link rewrite.
 *
 * Object storage has no transactions. A rename touching 12 documents is 13
 * independent writes and any of them can fail, with no rollback. Everything here is
 * shaped around that fact:
 *
 *  1. **Compute the whole changeset before writing anything.** If the plan cannot be
 *     built, nothing has been touched.
 *  2. **Write the renamed file last.** Up to that moment the old name still exists on
 *     disk, so a failure partway through leaves a corpus where the old document is
 *     still there to be found.
 *  3. **Report per-file success and failure.** "Renamed. 10 of 12 links updated — 2
 *     failed" with a retry, never silence. Silence is how link graphs rot.
 *  4. **Degrade to cosmetic.** When any link rewrite fails, the old title is recorded
 *     as an alias on the renamed document, so the links that did not get rewritten
 *     still resolve. A correctness bug becomes a formatting inconsistency.
 *
 * On (4): the sprint plan proposed wikilinks carrying an optional id. That is not
 * done here, because it would mean emitting link syntax Obsidian cannot read, and
 * round-tripping with other Markdown tools is a premise of the product rather than a
 * nice-to-have. `aliases:` is the standard frontmatter field for exactly this and
 * costs no compatibility.
 */

export interface RenameEdit {
  path: string
  title: string
  /** How many links in this document point at the old name. */
  occurrences: number
  /** Etag observed while planning; used as the If-Match precondition. */
  etag: string
}

export interface RenamePlan {
  from: string
  to: string
  oldTitle: string
  newTitle: string
  /** False when the title is pinned by frontmatter, so no link needs rewriting. */
  titleChanged: boolean
  /** Names the old document could be linked by: its title and its filename. */
  oldTargets: string[]
  edits: RenameEdit[]
  /** Etag of the document being renamed. */
  sourceEtag: string
}

export interface FileOutcome {
  path: string
  ok: boolean
  occurrences?: number
  error?: string
  code?: string
}

export interface RenameReport {
  from: string
  to: string
  oldTitle: string
  newTitle: string
  /** True when the document itself reached its new path. */
  renamed: boolean
  renameError?: string
  linkUpdates: FileOutcome[]
  updatedCount: number
  failedCount: number
  totalLinkFiles: number
  /** Set when the old title was recorded as an alias to keep stale links resolving. */
  aliasAdded?: string
  /** Set when an alias was needed but could not be added safely. */
  aliasWarning?: string
  /**
   * Set when the document's own H1 was rewritten to the new name.
   *
   * Reported rather than done quietly: this is the one part of a rename that edits
   * the contents of a file rather than moving it.
   */
  headingUpdated?: string
  /** Set when the heading could not be rewritten. The rename itself still stands. */
  headingWarning?: string
  document?: MarkdownDocument
}

/** Filename without its extension — the other name a document can be linked by. */
function baseName(path: string): string {
  const file = normalizePath(path).split('/').pop() ?? path
  return file.replace(/\.md$/i, '')
}

/**
 * Builds the full changeset without writing anything.
 *
 * Candidates come from the index (cheap), but occurrence counts and etags come from
 * reading each file (correct). The index can be stale; a rename driven by stale data
 * would miss links that exist and rewrite ones that do not.
 */
export async function planRename(
  store: WorkspaceStore,
  fromPath: string,
  toPath: string
): Promise<RenamePlan> {
  const from = normalizePath(fromPath)
  const to = normalizePath(toPath)

  const source = await store.readDocument(from)
  if (!source) throw new Error(`Cannot rename: ${from} does not exist`)

  const oldTitle = source.document.title
  const pinnedTitle = frontmatterTitle(splitFrontmatter(source.raw).frontmatter)
  // A document whose title is pinned in frontmatter keeps that title through a file
  // rename, so nothing links to it by a name that is about to change.
  const newTitle = pinnedTitle ?? baseName(to)
  const titleChanged = oldTitle !== newTitle

  const oldTargets = Array.from(new Set([oldTitle, baseName(from)].filter(Boolean)))

  const edits: RenameEdit[] = []

  if (titleChanged) {
    const index = await store.getIndex()
    const lowered = new Set(oldTargets.map((t) => t.toLowerCase()))

    for (const entry of Object.values(index.documents)) {
      if (entry.path === from) continue
      const mightLink = entry.outboundLinks.some((link) => lowered.has(link.trim().toLowerCase()))
      if (!mightLink) continue

      // Confirm against the file itself rather than trusting the index.
      const candidate = await store.readDocument(entry.path)
      if (!candidate) continue

      const occurrences = countLinksTo(candidate.raw, oldTargets)
      if (occurrences === 0) continue

      edits.push({
        path: entry.path,
        title: candidate.document.title,
        occurrences,
        etag: candidate.document.etag!,
      })
    }
  }

  edits.sort((a, b) => a.path.localeCompare(b.path))

  return {
    from,
    to,
    oldTitle,
    newTitle,
    titleChanged,
    oldTargets,
    edits,
    sourceEtag: source.document.etag!,
  }
}

/**
 * Adds `aliases: [Old Title]` when the document has no aliases key yet.
 *
 * Deliberately does not merge into an existing aliases value. Appending to a YAML
 * list means handling inline arrays, block sequences, quoting and comments, and
 * getting it subtly wrong would corrupt frontmatter the user wrote by hand. When an
 * aliases key already exists the caller is told, and the user can add the entry
 * themselves in one keystroke.
 */
function addAlias(content: string, alias: string): { content: string; ok: boolean; reason?: string } {
  const split = splitFrontmatter(content)

  if (split.invalid) {
    return { content, ok: false, reason: 'frontmatter is not valid YAML' }
  }
  if ('aliases' in split.frontmatter) {
    return { content, ok: false, reason: 'document already has an aliases field' }
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const quoted = JSON.stringify(alias)
  const line = `aliases: [${quoted}]${eol}`

  if (split.raw === null) {
    const separator = content.startsWith(eol) || content === '' ? '' : eol
    return { content: `---${eol}${line}---${eol}${separator}${content}`, ok: true }
  }

  const blockStart = content.indexOf(split.raw)
  return { content: content.slice(0, blockStart) + line + content.slice(blockStart), ok: true }
}

/**
 * Executes a plan.
 *
 * Link-holding documents are written first, each with the etag captured at plan
 * time, so a document edited between planning and execution is refused rather than
 * clobbered. The renamed file moves last.
 */
export async function executeRename(
  store: WorkspaceStore,
  plan: RenamePlan
): Promise<RenameReport> {
  const linkUpdates: FileOutcome[] = []

  for (const edit of plan.edits) {
    try {
      const current = await store.readDocument(edit.path)
      if (!current) {
        linkUpdates.push({ path: edit.path, ok: false, error: 'Document disappeared', code: 'NOT_FOUND' })
        continue
      }

      const { content, changed } = retargetWikiLinks(current.raw, plan.oldTargets, plan.newTitle)
      if (changed === 0) {
        // Already up to date — not a failure.
        linkUpdates.push({ path: edit.path, ok: true, occurrences: 0 })
        continue
      }

      await store.write(edit.path, content, { ifMatch: edit.etag })
      linkUpdates.push({ path: edit.path, ok: true, occurrences: changed })
    } catch (err) {
      const error = err as Error & { code?: string }
      linkUpdates.push({
        path: edit.path,
        ok: false,
        error: error.message,
        code: error.code ?? 'WRITE_FAILED',
      })
    }
  }

  const failedCount = linkUpdates.filter((u) => !u.ok).length
  const updatedCount = linkUpdates.filter((u) => u.ok && (u.occurrences ?? 0) > 0).length

  const report: RenameReport = {
    from: plan.from,
    to: plan.to,
    oldTitle: plan.oldTitle,
    newTitle: plan.newTitle,
    renamed: false,
    linkUpdates,
    updatedCount,
    failedCount,
    totalLinkFiles: plan.edits.length,
  }

  /*
    The two edits to the document's own bytes, done as one write.

    Both are conditional, both are about the title, and both have to happen before the
    move — after it the path in `plan.from` is gone. Batching them also means the
    common case (a heading to sync, nothing failed) costs one write rather than two,
    and there is no window in which the file carries one change but not the other.

      - **Retitle.** The heading the document is titled by follows the filename, or
        the rename is invisible everywhere the app shows a title. See
        `retitleFirstHeading` for how narrowly this is scoped.
      - **Alias** (mitigation 4). Only when a link rewrite failed: the old title is
        recorded so the links that did not get rewritten still resolve.
  */
  let sourceEtag = plan.sourceEtag
  const needsAlias = failedCount > 0 && plan.titleChanged

  if (plan.titleChanged) {
    try {
      const source = await store.readDocument(plan.from)
      if (source) {
        // Never against a pinned title: `planRename` sets `newTitle` to the pinned
        // value in that case, so `titleChanged` is already false and we are not here.
        const retitled = retitleFirstHeading(source.raw, plan.oldTitle, plan.newTitle)
        let content = retitled.content

        let aliased: ReturnType<typeof addAlias> | null = null
        if (needsAlias) {
          aliased = addAlias(content, plan.oldTitle)
          if (aliased.ok) content = aliased.content
        }

        if (content !== source.raw) {
          const written = await store.write(plan.from, content, { ifMatch: sourceEtag })
          sourceEtag = written.etag
          if (retitled.changed) report.headingUpdated = plan.newTitle
          if (aliased?.ok) report.aliasAdded = plan.oldTitle
        }

        if (aliased && !aliased.ok) {
          report.aliasWarning = `Could not record "${plan.oldTitle}" as an alias: ${aliased.reason}. Links that failed to update will not resolve until they are fixed.`
        }
      }
    } catch (err) {
      // One write carried both changes, so a failure loses both — and the two are
      // reported separately because they mean different things to the reader.
      const message = (err as Error).message
      if (needsAlias) {
        report.aliasWarning = `Could not record "${plan.oldTitle}" as an alias: ${message}`
      }
      report.headingWarning = `The document's heading could not be updated and still reads "${plan.oldTitle}": ${message}`
    }
  }

  // The renamed file moves last, so until this line the old name still exists.
  try {
    const result = await store.move(plan.from, plan.to, { ifMatch: sourceEtag })
    report.renamed = true
    report.document = result.document
  } catch (err) {
    report.renamed = false
    report.renameError = (err as Error).message
  }

  return report
}

/** One-shot convenience: plan, then execute. */
export async function renameDocument(
  store: WorkspaceStore,
  fromPath: string,
  toPath: string
): Promise<RenameReport> {
  return executeRename(store, await planRename(store, fromPath, toPath))
}

/** Human-readable summary, in the shape the sprint plan asked for. */
export function summarizeRename(report: RenameReport): string {
  if (!report.renamed) {
    return `Rename failed: ${report.renameError ?? 'unknown error'}`
  }

  // Said out loud, because it is the one part of a rename that edits the file's
  // contents rather than moving it.
  const heading = report.headingUpdated ? ' The heading now reads the new name.' : ''

  if (report.totalLinkFiles === 0) {
    return `Renamed. No inbound links needed updating.${heading}`
  }
  if (report.failedCount === 0) {
    return `Renamed. ${report.updatedCount} of ${report.totalLinkFiles} linking documents updated.${heading}`
  }

  const failed = report.linkUpdates
    .filter((u) => !u.ok)
    .map((u) => u.path)
    .join(', ')
  return `Renamed. ${report.updatedCount} of ${report.totalLinkFiles} links updated — ${report.failedCount} failed: ${failed}`
}
