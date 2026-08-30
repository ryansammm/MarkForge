'use client'

import { useEffect, useState, useRef } from 'react'
import { BookOpen, ChevronDown, Plus, Pencil, Trash2, Check, Settings, Calendar } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface Grimoire {
  id: string
  name: string
  createdAt: string
  lastActive: string
  path?: string
}

interface GrimoireRegistry {
  grimoires: Grimoire[]
  lastActiveId: string | null
}

interface GrimoireSwitcherProps {
  activeGrimoireId: string | null
  onSelect: (id: string) => void
  onCreated: (grimoire: Grimoire) => void
  /** Backend kind from /api/health — drives the auto-pick-root prompt after create. */
  storageKind: string | null
}

export function GrimoireSwitcher({
  activeGrimoireId,
  onSelect,
  onCreated,
  storageKind,
}: GrimoireSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [grimoires, setGrimoires] = useState<Grimoire[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const activeGrimoire = grimoires.find((g) => g.id === activeGrimoireId)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/grimoires')
        const data: GrimoireRegistry = await res.json()
        if (cancelled) return
        setGrimoires(data.grimoires)
        if (!activeGrimoireId && data.lastActiveId) {
          onSelect(data.lastActiveId)
        }
      } catch {
        // Silently fail — grimoires will be empty
      }
    }
    void load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch
  }, [])

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return

    try {
      const res = await fetch('/api/grimoires', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const err = await res.json()
        toast.error(err.error || 'Failed to create grimoire')
        return
      }
      const grimoire: Grimoire = await res.json()
      setGrimoires((prev) => [...prev, grimoire])
      setNewName('')
      setCreating(false)
      onCreated(grimoire)
      onSelect(grimoire.id)
      toast.success(`Grimoire "${name}" created`)
      // Offline desktop: a grimoire without a root folder is a stub. Prompt now
      // while the user's intent is fresh; the next reload reindexes against the
      // chosen directory. Online grimoires live in R2, not on disk, so skip.
      const mk = (window as unknown as { markforge?: { selectDirectory?: () => Promise<string | null> } }).markforge
      if (storageKind !== 'cloud' && mk?.selectDirectory) {
        const p = await mk.selectDirectory()
        if (p) {
          const put = await fetch(`/api/grimoires/${grimoire.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: p }),
          })
          if (put.ok) {
            setGrimoires((prev) => prev.map((g) => g.id === grimoire.id ? { ...g, path: p } : g))
            window.location.reload()
          } else {
            const err = await put.json()
            toast.error(err.error || 'Failed to set root folder')
          }
        }
      }
    } catch {
      toast.error('Failed to create grimoire')
    }
  }

  async function handleRename(id: string) {
    const name = renameValue.trim()
    if (!name) return

    try {
      const res = await fetch(`/api/grimoires/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const err = await res.json()
        toast.error(err.error || 'Failed to rename')
        return
      }
      setGrimoires((prev) => prev.map((g) => (g.id === id ? { ...g, name } : g)))
      setRenamingId(null)
      toast.success('Renamed')
    } catch {
      toast.error('Failed to rename')
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete grimoire "${name}"? This cannot be undone.`)) return

    try {
      const res = await fetch(`/api/grimoires/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json()
        toast.error(err.error || 'Failed to delete')
        return
      }
      setGrimoires((prev) => prev.filter((g) => g.id !== id))
      if (activeGrimoireId === id) {
        onSelect(grimoires.find((g) => g.id !== id)?.id ?? '')
      }
      toast.success(`Deleted "${name}"`)
    } catch {
      toast.error('Failed to delete')
    }
  }

  return (
    <div className="relative px-2 py-1" ref={dropdownRef}>
      <div className="flex h-8 items-center gap-1 rounded-md px-2 text-sm transition-colors hover:bg-sidebar-accent">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <BookOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left font-medium">
            {activeGrimoire?.name ?? 'Select Grimoire'}
          </span>
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180'
            )}
          />
        </button>
        {activeGrimoire && (
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(!settingsOpen)
              setOpen(false)
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
            title="Grimoire settings"
          >
            <Settings className="size-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute left-2 right-2 top-full z-50 mt-1 rounded-lg border bg-popover shadow-md">
          <div className="p-1">
            {grimoires.map((g) => (
              <div key={g.id} className="flex items-center">
                {renamingId === g.id ? (
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(g.id)
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    onBlur={() => handleRename(g.id)}
                    className="h-7 flex-1 rounded px-2 text-sm outline-none ring-1 ring-ring"
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(g.id)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex h-7 flex-1 items-center gap-2 rounded px-2 text-sm transition-colors hover:bg-accent',
                      g.id === activeGrimoireId && 'bg-accent'
                    )}
                  >
                    {g.id === activeGrimoireId && <Check className="size-3.5 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate text-left">{g.name}</span>
                  </button>
                )}
                {renamingId !== g.id && (
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(g.id)
                        setRenameValue(g.name)
                      }}
                      className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                      title="Rename"
                    >
                      <Pencil className="size-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(g.id, g.name)}
                      className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      title="Delete"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                )}
              </div>
            ))}

            {creating ? (
              <div className="mt-1 flex items-center gap-1 rounded-md border px-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate()
                    if (e.key === 'Escape') setCreating(false)
                  }}
                  onBlur={() => {
                    if (!newName.trim()) setCreating(false)
                  }}
                  placeholder="Grimoire name…"
                  className="h-7 flex-1 bg-transparent text-sm outline-none"
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex h-7 w-full items-center gap-2 rounded px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="size-3.5" />
                <span>New Grimoire…</span>
              </button>
            )}
          </div>
        </div>
      )}

      {settingsOpen && activeGrimoire && (
        <div className="absolute left-2 right-2 top-full z-50 mt-1 rounded-lg border bg-popover p-3 shadow-md">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Grimoire Settings</span>
            <button
              type="button"
              onClick={() => setSettingsOpen(false)}
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
            >
              ×
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Name</label>
              <input
                type="text"
                defaultValue={activeGrimoire.name}
                onBlur={async (e) => {
                  const newName = e.target.value.trim()
                  if (!newName || newName === activeGrimoire.name) return
                  const res = await fetch(`/api/grimoires/${activeGrimoire.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: newName }),
                  })
                  if (res.ok) {
                    setGrimoires((prev) => prev.map((g) => g.id === activeGrimoire.id ? { ...g, name: newName } : g))
                    toast.success('Renamed')
                  } else {
                    const err = await res.json()
                    toast.error(err.error || 'Failed to rename')
                    e.target.value = activeGrimoire.name
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                className="h-7 w-full rounded border bg-background px-2 text-sm outline-none ring-ring/50 focus:ring-2"
              />
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Calendar className="size-3" />
              <span>Created {new Date(activeGrimoire.createdAt).toLocaleDateString()}</span>
            </div>

            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Root folder</label>
              <div className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate rounded border bg-background px-2 py-1 text-xs text-muted-foreground"
                  title={activeGrimoire.path ?? ''}
                >
                  {activeGrimoire.path ?? 'Not set — choose a folder on disk'}
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    const mk = (window as unknown as { markforge?: { selectDirectory?: () => Promise<string | null> } }).markforge
                    if (!mk?.selectDirectory) {
                      toast.error('Folder picker only available in desktop app')
                      return
                    }
                    const p = await mk.selectDirectory()
                    if (!p) return
                    const res = await fetch(`/api/grimoires/${activeGrimoire.id}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ path: p }),
                    })
                    if (res.ok) {
                      setGrimoires((prev) => prev.map((g) => g.id === activeGrimoire.id ? { ...g, path: p } : g))
                      toast.success('Root folder set')
                      window.location.reload()
                    } else {
                      const err = await res.json()
                      toast.error(err.error || 'Failed to set root folder')
                    }
                  }}
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded border bg-background px-2 text-xs transition-colors hover:bg-accent"
                >
                  {activeGrimoire.path ? 'Change…' : 'Choose…'}
                </button>
              </div>
            </div>

            <div className="border-t pt-2">
              <button
                type="button"
                onClick={async () => {
                  if (!confirm(`Delete grimoire "${activeGrimoire.name}"? This cannot be undone.`)) return
                  const res = await fetch(`/api/grimoires/${activeGrimoire.id}`, { method: 'DELETE' })
                  if (res.ok) {
                    setGrimoires((prev) => prev.filter((g) => g.id !== activeGrimoire.id))
                    const next = grimoires.find((g) => g.id !== activeGrimoire.id)
                    if (next) onSelect(next.id)
                    setSettingsOpen(false)
                    toast.success(`Deleted "${activeGrimoire.name}"`)
                  } else {
                    const err = await res.json()
                    toast.error(err.error || 'Failed to delete')
                  }
                }}
                className="flex h-7 w-full items-center gap-2 rounded px-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
              >
                <Trash2 className="size-3.5" />
                <span>Delete Grimoire</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
