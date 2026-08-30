import type { Bucket } from './bucket'
import { R2Bucket, r2ConfigFromEnv } from './r2-bucket'
import { WorkspaceStore } from './workspace-store'
import { readRegistry } from './grimoire'
import { devLog } from './dev-log'
import { MissingR2ConfigError, REQUIRED_R2_VARS } from './missing-r2-config'

export class GrimoireNotFoundError extends Error {
  readonly code = 'GRIMOIRE_NOT_FOUND'
}

/**
 * Picks a storage backend.
 *
 * R2 only. The boot-time configuration screen surfaces `MissingR2ConfigError`
 * with the four env var names when they are absent. There is no filesystem
 * fallback in production code paths; `lib/server/fs-bucket.ts` exists for
 * tests that construct it directly.
 */

export type BackendKind = 'r2' | 'unknown'

export function createBucket(): Bucket {
  if (!r2ConfigFromEnv()) {
    const missing = REQUIRED_R2_VARS.filter((name) => !process.env[name])
    throw new MissingR2ConfigError(missing)
  }
  return new R2Bucket()
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
 * R2 is the only production backend. When the env vars are missing the answer
 * is `unknown`: the boot-time configuration screen is what the user sees.
 */
export function backendHealth(): {
  kind: BackendKind
  durable: boolean
  warning?: string
} {
  if (r2ConfigFromEnv()) return { kind: 'r2', durable: true }

  const missing = REQUIRED_R2_VARS.filter((name) => !process.env[name])
  return {
    kind: 'unknown',
    durable: false,
    warning: `MarkForge requires R2. Missing env vars: ${missing.join(', ')}. Set ${REQUIRED_R2_VARS.join(', ')} and restart.`,
  }
}

