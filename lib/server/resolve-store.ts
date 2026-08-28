import { type NextRequest } from 'next/server'
import { getStore, getGrimoireStore } from '@/lib/server/store'
import type { WorkspaceStore } from '@/lib/server/workspace-store'
import { devLog } from './dev-log'

/**
 * Resolves the workspace store for the current request.
 *
 * The grimoire id is read from the `X-Grimoire-Id` header, falling back to the
 * `grimoireId` query parameter. The query fallback exists because some consumers —
 * notably `<img src>` asset URLs built by `assetUrl` — cannot set request headers.
 * Without a grimoire id, returns the default (root) store for backward compatibility.
 */
export async function resolveStore(request: NextRequest): Promise<WorkspaceStore> {
  const grimoireId =
    request.headers.get('x-grimoire-id') ?? request.nextUrl.searchParams.get('grimoireId')
  if (grimoireId) {
    devLog.info('resolve-store', 'grimoire-request', { grimoireId })
    const store = await getGrimoireStore(grimoireId)
    devLog.info('resolve-store', 'grimoire-store-ready')
    return store
  }
  devLog.info('resolve-store', 'default-store')
  return getStore()
}
