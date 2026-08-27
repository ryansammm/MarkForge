import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

interface GrimoireEntry {
  id: string
  name: string
  createdAt: string
  lastActive: string
}
interface MigrationRegistry {
  grimoires: GrimoireEntry[]
  lastActiveId?: string | null
}

const META = 'C:\\Users\\Xyks\\AppData\\Roaming\\MarkForge\\meta'
const NOTES = 'C:\\Users\\Xyks\\AppData\\Roaming\\MarkForge\\notes'

function moveFolder(src: string, dest: string) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) {
      moveFolder(s, d)
    } else {
      renameSync(s, d)
    }
  }
}

function main() {
  console.log('=== Local Grimoire Migration ===\n')

  // Read current registry
  const regPath = join(META, 'grimoires.json')
  const registry = JSON.parse(readFileSync(regPath, 'utf-8')) as MigrationRegistry
  console.log('Current grimoires:', registry.grimoires.map((g) => g.name).join(', '))

  // Create Work and Origin
  const now = new Date().toISOString()
  const work = { id: randomUUID().slice(0, 12), name: 'Work', createdAt: now, lastActive: now }
  const origin = { id: randomUUID().slice(0, 12), name: 'Origin', createdAt: now, lastActive: now }

  // Create destination dirs
  mkdirSync(join(NOTES, 'Work'), { recursive: true })
  mkdirSync(join(NOTES, 'Origin'), { recursive: true })

  // Move GDI → Work/GDI
  if (existsSync(join(NOTES, 'GDI'))) {
    console.log('Moving GDI → Work/GDI')
    moveFolder(join(NOTES, 'GDI'), join(NOTES, 'Work', 'GDI'))
    rmSync(join(NOTES, 'GDI'), { recursive: true, force: true })
  }

  // Move K2 → Work/K2
  if (existsSync(join(NOTES, 'K2'))) {
    console.log('Moving K2 → Work/K2')
    moveFolder(join(NOTES, 'K2'), join(NOTES, 'Work', 'K2'))
    rmSync(join(NOTES, 'K2'), { recursive: true, force: true })
  }

  // Move Friday → Origin/Friday
  if (existsSync(join(NOTES, 'Friday'))) {
    console.log('Moving Friday → Origin/Friday')
    moveFolder(join(NOTES, 'Friday'), join(NOTES, 'Origin', 'Friday'))
    rmSync(join(NOTES, 'Friday'), { recursive: true, force: true })
  }

  // Move Ryan → Origin/Ryan
  if (existsSync(join(NOTES, 'Ryan'))) {
    console.log('Moving Ryan → Origin/Ryan')
    moveFolder(join(NOTES, 'Ryan'), join(NOTES, 'Origin', 'Ryan'))
    rmSync(join(NOTES, 'Ryan'), { recursive: true, force: true })
  }

  // Move root .md files → Origin/
  for (const f of readdirSync(NOTES)) {
    if (f.endsWith('.md')) {
      console.log(`Moving ${f} → Origin/${f}`)
      renameSync(join(NOTES, f), join(NOTES, 'Origin', f))
    }
  }

  // Delete old GDI index
  const oldIndex = join(META, '_grimoires', '2dc16615-752', 'index.json')
  if (existsSync(oldIndex)) {
    rmSync(join(META, '_grimoires', '2dc16615-752'), { recursive: true, force: true })
    console.log('Deleted old GDI index')
  }

  // Update registry
  registry.grimoires = [work, origin]
  registry.lastActiveId = work.id
  writeFileSync(regPath, JSON.stringify(registry, null, 2), 'utf-8')
  console.log('\nRegistry updated:')
  console.log(JSON.stringify(registry, null, 2))

  // Verify
  console.log('\n=== Verification ===')
  console.log('Work contents:', readdirSync(join(NOTES, 'Work')))
  console.log('Origin contents:', readdirSync(join(NOTES, 'Origin')))
  console.log('Root .md:', readdirSync(NOTES).filter(f => f.endsWith('.md')))
}

main()
