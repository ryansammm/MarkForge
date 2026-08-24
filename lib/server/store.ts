import type { Bucket } from './bucket'
import { FsBucket } from './fs-bucket'
import { R2Bucket, r2ConfigFromEnv } from './r2-bucket'
import { WorkspaceStore } from './workspace-store'

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

/** Process-wide store, so the write queue is genuinely shared across requests. */
export function getStore(): WorkspaceStore {
  if (!shared) shared = new WorkspaceStore(createBucket())
  return shared
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
