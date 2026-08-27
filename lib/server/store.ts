import type { Bucket } from './bucket'
import { FsBucket } from './fs-bucket'
import { R2Bucket, r2ConfigFromEnv } from './r2-bucket'
import { WorkspaceStore } from './workspace-store'
import { readRegistry } from './grimoire'
import { devLog } from './dev-log'

export class GrimoireNotFoundError extends Error {
  readonly code = 'GRIMOIRE_NOT_FOUND'
}

/**
 * Picks a storage backend.
 *
 * R2 when it is configured, filesystem otherwise. The choice is made from the
 * environment rather than a flag, so a deployment cannot accidentally run on the
 * filesystem backend and appear to work — writes would succeed into an ephemeral
 * container and vanish at the next cold start, which is the worst possible failure
 * mode because it looks exactly like success.
 */

export type BackendKind = 'r2' | 'filesystem'

export function createBucket(): Bucket {
  return r2ConfigFromEnv() ? new R2Bucket() : new FsBucket()
}

let shared: WorkspaceStore | null = null
const grimoireStores = new Map<string, WorkspaceStore>()

/** Process-wide store, so the write queue is genuinely shared across requests. */
export function getStore(): WorkspaceStore {
  if (!shared) shared = new WorkspaceStore(createBucket())
  return shared
}

/**
 * Returns a grimoire-scoped store. The store uses a grimoire-specific index
 * file and scopes document operations to the grimoire's notes subdirectory.
 */
export async function getGrimoireStore(grimoireId: string): Promise<WorkspaceStore> {
  const existing = grimoireStores.get(grimoireId)
  if (existing) {
    devLog.info('store', 'grimoire-cached', { grimoireId })
    return existing
  }

  devLog.info('store', 'grimoire-creating', { grimoireId })
  const bucket = createBucket()
  devLog.info('store', 'grimoire-reading-registry')
  const registry = await readRegistry(bucket)
  const grimoire = registry.grimoires.find((g) => g.id === grimoireId)
  if (!grimoire) {
    devLog.error('store', 'grimoire-not-found', { grimoireId, available: registry.grimoires.map(g => g.id) })
    throw new GrimoireNotFoundError(`Grimoire not found: ${grimoireId}`)
  }

  // One-time migration: if this is the only grimoire and root has orphaned files, pull them in
  if (registry.grimoires.length === 1) {
    const grimoireKeys = await bucket.listKeys(grimoire.name)
    const rootKeys = await bucket.listKeys()
    const orphaned = rootKeys.filter((k) => !k.startsWith(grimoire.name + '/'))
    if (orphaned.length > 0 && grimoireKeys.length === 0) {
      devLog.info('store', 'migrate-orphaned', { count: orphaned.length })
      for (const key of orphaned) {
        const content = await bucket.readText(key)
        if (content !== null) {
          await bucket.writeText(grimoire.name + '/' + key, content)
        }
      }
    }
  }

  devLog.info('store', 'grimoire-creating-store', { name: grimoire.name })
  const store = new WorkspaceStore(bucket, {
    grimoireId: grimoire.id,
    grimoireName: grimoire.name,
  })

  // Auto-reindex if index doesn't exist yet (new grimoire or migration)
  const existingIndex = await bucket.readMeta(`_grimoires/${grimoire.id}/index.json`)
  if (!existingIndex) {
    devLog.info('store', 'grimoire-auto-reindex', { grimoireId, name: grimoire.name })
    await store.reindex()
  }

  grimoireStores.set(grimoireId, store)
  devLog.info('store', 'grimoire-store-ready', { grimoireId })
  return store
}

/** Clear cached grimoire stores (e.g., after rename or delete). */
export function clearGrimoireStore(grimoireId: string): void {
  grimoireStores.delete(grimoireId)
}

/** Test seam. Passing null forces the next getStore() to rebuild from the env. */
export function setStore(store: WorkspaceStore | null): void {
  shared = store
}

/**
 * Whether the current configuration can actually persist a write.
 *
 * The filesystem backend on a read-only or ephemeral host — Vercel, most
 * containers — accepts writes that do not survive. Surfacing that is the point:
 * a deployment that silently forgets edits is worse than one that refuses them.
 */
export function backendHealth(): {
  kind: BackendKind
  durable: boolean
  warning?: string
} {
  if (r2ConfigFromEnv()) return { kind: 'r2', durable: true }

  const ephemeral = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
  return {
    kind: 'filesystem',
    durable: !ephemeral,
    warning: ephemeral
      ? 'Running on an ephemeral filesystem with no R2 configuration. Edits will not survive. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.'
      : undefined,
  }
}
