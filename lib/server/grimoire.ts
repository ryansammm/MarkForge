/**
 * Grimoire — isolated note groups (like Obsidian vaults / VS Code workspaces).
 *
 * Registry lives at `_grimoires.json` in the meta namespace.
 * Each grimoire's notes live under `notes/{name}/` and its index at
 * `_grimoires/{id}/index.json` in the meta namespace.
 */

import { randomUUID } from 'crypto'
import type { Bucket } from './bucket'

export interface Grimoire {
  id: string
  name: string
  createdAt: string
  lastActive: string
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
  name: string
): Promise<Grimoire> {
  const registry = await readRegistry(bucket)

  if (registry.grimoires.some((g) => g.name === name)) {
    throw new Error(`Grimoire "${name}" already exists`)
  }

  const now = new Date().toISOString()
  const grimoire: Grimoire = {
    id: randomUUID().slice(0, 12),
    name,
    createdAt: now,
    lastActive: now,
  }

  registry.grimoires.push(grimoire)
  registry.lastActiveId = grimoire.id
  await writeRegistry(bucket, registry)

  // Create the notes directory for the new grimoire
  await bucket.createFolder(name)

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

  // Delete the notes directory
  await bucket.deleteFolder(grimoire.name)

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
