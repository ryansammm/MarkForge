/**
 * Grimoire — isolated note groups (like Obsidian vaults / VS Code workspaces).
 *
 * Registry lives at `_grimoires.json` in the meta namespace.
 * Each grimoire's notes live under `notes/{name}/` and its index at
 * `_grimoires/{id}/index.json` in the meta namespace.
 */

import * as fs from 'fs'
import { randomUUID } from 'crypto'
import type { Bucket } from './bucket'
import { devLog } from './dev-log'

export interface Grimoire {
  id: string
  name: string
  createdAt: string
  lastActive: string
  /** Absolute folder on disk for grimoires backed by an external directory (offline). When absent, notes live under NOTES_DIR/<name>/. */
  path?: string
}

export interface GrimoireRegistry {
  grimoires: Grimoire[]
  lastActiveId: string | null
}

const REGISTRY_FILE = 'grimoires.json'

export function grimoireIndexPath(id: string): string {
  return `_grimoires/${id}/index.json`
}

export async function readRegistry(bucket: Bucket): Promise<GrimoireRegistry> {
  const raw = await bucket.readMeta(REGISTRY_FILE)
  if (!raw) return { grimoires: [], lastActiveId: null }
  try {
    return JSON.parse(raw)
  } catch {
    return { grimoires: [], lastActiveId: null }
  }
}

export async function writeRegistry(
  bucket: Bucket,
  registry: GrimoireRegistry
): Promise<void> {
  await bucket.writeMeta(REGISTRY_FILE, JSON.stringify(registry, null, 2))
}

export async function createGrimoire(
  bucket: Bucket,
  name: string,
  opts?: { path?: string }
): Promise<Grimoire> {
  devLog.info('grimoire', 'create-read-registry')
  const registry = await readRegistry(bucket)

  if (registry.grimoires.some((g) => g.name === name)) {
    devLog.warn('grimoire', 'create-already-exists', { name })
    throw new Error(`Grimoire "${name}" already exists`)
  }

  if (opts?.path) {
    let stat: fs.Stats | undefined
    try {
      stat = fs.statSync(opts.path)
    } catch {
      throw new Error(`Folder not found: ${opts.path}`)
    }
    if (!stat.isDirectory()) throw new Error(`Not a folder: ${opts.path}`)
  }

  const now = new Date().toISOString()
  const grimoire: Grimoire = {
    id: randomUUID().slice(0, 12),
    name,
    createdAt: now,
    lastActive: now,
    ...(opts?.path ? { path: opts.path } : {}),
  }

  registry.grimoires.push(grimoire)
  registry.lastActiveId = grimoire.id
  devLog.info('grimoire', 'create-write-registry')
  await writeRegistry(bucket, registry)

  // An external grimoire backs a folder that already exists on disk — nothing to
  // create, and no root-level orphans to pull in.
  if (opts?.path) {
    devLog.info('grimoire', 'create-external', { id: grimoire.id, path: opts.path })
    return grimoire
  }

  // Create the notes directory for the new grimoire
  devLog.info('grimoire', 'create-folder', { name })
  await bucket.createFolder(name)

  // First grimoire: migrate orphaned root files into it
  if (registry.grimoires.length === 1) {
    devLog.info('grimoire', 'migrate-root-files', { name })
    const rootKeys = await bucket.listKeys()
    let migrated = 0
    for (const key of rootKeys) {
      // Skip files already inside a grimoire folder
      if (key.startsWith(name + '/')) continue
      const content = await bucket.readText(key)
      if (content === null) continue
      const dest = name + '/' + key
      await bucket.writeText(dest, content)
      migrated++
    }
    devLog.info('grimoire', 'migrate-done', { migrated })
  }

  devLog.info('grimoire', 'create-done', { id: grimoire.id })

  return grimoire
}

export async function renameGrimoire(
  bucket: Bucket,
  id: string,
  newName: string
): Promise<Grimoire> {
  const registry = await readRegistry(bucket)
  const grimoire = registry.grimoires.find((g) => g.id === id)
  if (!grimoire) throw new Error(`Grimoire not found: ${id}`)

  if (registry.grimoires.some((g) => g.name === newName && g.id !== id)) {
    throw new Error(`Grimoire "${newName}" already exists`)
  }

  grimoire.name = newName
  await writeRegistry(bucket, registry)

  // Rename the notes directory
  // FsBucket doesn't have a rename, so we use create + deleteFolder
  // For R2, we'd need to copy+delete. For now, FsBucket only.
  // The caller should handle the actual file move.
  return grimoire
}

export async function deleteGrimoire(
  bucket: Bucket,
  id: string
): Promise<void> {
  const registry = await readRegistry(bucket)
  const idx = registry.grimoires.findIndex((g) => g.id === id)
  if (idx === -1) throw new Error(`Grimoire not found: ${id}`)

  const grimoire = registry.grimoires[idx]

  // External grimoires point at a real folder the user owns — never delete it,
  // only drop the registry entry and its index.
  if (!grimoire.path) {
    await bucket.deleteFolder(grimoire.name)
  }

  // Delete the index
  await bucket.deleteMeta(grimoireIndexPath(id))

  registry.grimoires.splice(idx, 1)
  if (registry.lastActiveId === id) {
    registry.lastActiveId = registry.grimoires[0]?.id ?? null
  }
  await writeRegistry(bucket, registry)
}

export async function setActiveGrimoire(
  bucket: Bucket,
  id: string
): Promise<Grimoire> {
  const registry = await readRegistry(bucket)
  const grimoire = registry.grimoires.find((g) => g.id === id)
  if (!grimoire) throw new Error(`Grimoire not found: ${id}`)

  grimoire.lastActive = new Date().toISOString()
  registry.lastActiveId = id
  await writeRegistry(bucket, registry)

  return grimoire
}
