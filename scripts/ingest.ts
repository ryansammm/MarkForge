import * as path from 'path'
import { FsBucket } from '../lib/server/fs-bucket'
import { WorkspaceStore } from '../lib/server/workspace-store'

/**
 * Full-reindex CLI.
 *
 * A thin wrapper around `WorkspaceStore.reindex()` — deliberately not a second
 * implementation. A rebuild from storage and a sequence of in-app edits must land
 * on the same index, or "the index is disposable" stops being true, and the cheapest
 * way to guarantee that is to have exactly one rebuild shared by every backend and
 * every entry point.
 */

export async function ingestDirectory(targetDir: string, outputJsonPath: string): Promise<number> {
  const store = new WorkspaceStore(
    new FsBucket({ notesDir: targetDir, indexPath: outputJsonPath })
  )

  const index = await store.reindex()
  const count = Object.keys(index.documents).length
  console.log(`Ingestion complete! Ingested ${count} documents. Index saved to ${outputJsonPath}`)
  return count
}

// CLI Execution Entrypoint
if (require.main === module) {
  const args = process.argv.slice(2)
  const targetDir = args[0] || '.'
  const outputPath = args[1] || path.join(process.cwd(), 'public', 'index.json')

  console.log(`Starting ingestion from "${targetDir}"...`)
  ingestDirectory(path.resolve(targetDir), path.resolve(outputPath)).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
