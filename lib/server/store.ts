import type { Bucket } from './bucket'
import { R2Bucket, r2ConfigFromEnv } from './r2-bucket'
import { WorkspaceStore } from './workspace-store'
import { devLog } from './dev-log'
import { MissingR2ConfigError, REQUIRED_R2_VARS } from './missing-r2-config'

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

/** Process-wide store, so the write queue is genuinely shared across requests. */
export function getStore(): WorkspaceStore {
  if (!shared) {
    devLog.info('store', 'creating-root-store')
    shared = new WorkspaceStore(createBucket())
  }
  return shared
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
