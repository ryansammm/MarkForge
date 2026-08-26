import { type NextRequest } from 'next/server'
import { getStore, getGrimoireStore } from '@/lib/server/store'
import type { WorkspaceStore } from '@/lib/server/workspace-store'

/**
 * Resolves the workspace store for the current request.
 *
 * If the request includes an `X-Grimoire-Id` header, returns a grimoire-scoped
 * store. Otherwise returns the default (root) store for backward compatibility.
 */
export async function resolveStore(request: NextRequest): Promise<WorkspaceStore> {
  const grimoireId = request.headers.get('x-grimoire-id')
  if (grimoireId) return getGrimoireStore(grimoireId)
  return getStore()
}
