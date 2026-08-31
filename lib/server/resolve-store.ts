import { type NextRequest } from 'next/server'
import { getStore } from '@/lib/server/store'
import type { WorkspaceStore } from '@/lib/server/workspace-store'
import { devLog } from './dev-log'

/**
 * Resolves the workspace store for the current request.
 *
 * Ponytail: there is only one workspace store now (grimoire feature removed);
 * the helper is kept so call sites can be grepped and so the request shape is
 * expressed in one place.
 */
export async function resolveStore(_request: NextRequest): Promise<WorkspaceStore> {
  devLog.info('resolve-store', 'default-store')
  return getStore()
}
