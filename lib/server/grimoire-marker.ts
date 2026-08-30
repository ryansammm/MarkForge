import * as fs from 'fs'
import * as path from 'path'
import type { Grimoire } from './grimoire'
import { devLog } from './dev-log'

/**
 * The `.grimoire` marker file written to every folder a grimoire points at.
 *
 * Lives next to the user's notes, not in the app's meta namespace, so a
 * grimoire remains associated with its folder even after the workspace is
 * rebuilt. The file is the canonical record of which grimoires are backed by
 * a given folder; the registry in `meta/grimoires.json` is the other half.
 *
 * Multiple grimoires may share a folder; the file holds a list and is the
 * authoritative tiebreaker when a future write needs to disambiguate.
 */

const MARKER_FILE = '.grimoire'
const MARKER_VERSION = 1

interface GrimoireMarkerEntry {
  id: string
  name: string
  createdAt: string
  lastActive: string
}

export interface GrimoireMarker {
  version: number
  grimoires: GrimoireMarkerEntry[]
  updatedAt: string
}

export function markerPath(folder: string): string {
  return path.join(folder, MARKER_FILE)
}

async function readMarker(folder: string): Promise<GrimoireMarker | null> {
  let raw: string
  try {
    raw = await fs.promises.readFile(markerPath(folder), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GrimoireMarker>
    if (parsed.version !== MARKER_VERSION) {
      devLog.warn('grimoire-marker', 'unknown-version', { version: parsed.version })
      return null
    }
    if (!Array.isArray(parsed.grimoires)) return null
    return parsed as GrimoireMarker
  } catch {
    return null
  }
}

async function writeMarker(folder: string, marker: GrimoireMarker): Promise<void> {
  await fs.promises.mkdir(folder, { recursive: true })
  await fs.promises.writeFile(markerPath(folder), JSON.stringify(marker, null, 2), 'utf8')
}

function entryFrom(grimoire: Grimoire): GrimoireMarkerEntry {
  return {
    id: grimoire.id,
    name: grimoire.name,
    createdAt: grimoire.createdAt,
    lastActive: grimoire.lastActive,
  }
}

/**
 * Upserts a grimoire entry into the folder's marker. Creates the file on first
 * write; leaves any pre-existing entries for other grimoires intact.
 */
export async function addGrimoireToMarker(folder: string, grimoire: Grimoire): Promise<void> {
  const existing = (await readMarker(folder)) ?? {
    version: MARKER_VERSION,
    grimoires: [],
    updatedAt: new Date().toISOString(),
  }
  const idx = existing.grimoires.findIndex((e) => e.id === grimoire.id)
  const entry = entryFrom(grimoire)
  if (idx >= 0) existing.grimoires[idx] = entry
  else existing.grimoires.push(entry)
  existing.updatedAt = new Date().toISOString()
  await writeMarker(folder, existing)
  devLog.info('grimoire-marker', 'added', { folder, grimoire: grimoire.id })
}

/**
 * Removes a grimoire entry from the folder's marker. Deletes the marker file
 * if no entries remain — leaving a folder with a stale marker would be a
 * permanent lie about which grimoires own it.
 */
export async function removeGrimoireFromMarker(
  folder: string,
  grimoireId: string
): Promise<void> {
  const existing = await readMarker(folder)
  if (!existing) return
  const before = existing.grimoires.length
  existing.grimoires = existing.grimoires.filter((e) => e.id !== grimoireId)
  if (existing.grimoires.length === before) return
  existing.updatedAt = new Date().toISOString()
  if (existing.grimoires.length === 0) {
    try {
      await fs.promises.unlink(markerPath(folder))
      devLog.info('grimoire-marker', 'file-removed-empty', { folder })
    } catch {
      // File already gone — nothing to do.
    }
    return
  }
  await writeMarker(folder, existing)
  devLog.info('grimoire-marker', 'removed', { folder, grimoireId })
}
