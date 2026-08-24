'use client'

import { useCallback, useEffect, useState } from 'react'
import { Dices, Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  DEFAULT_GENERATOR_OPTIONS,
  MAX_LENGTH,
  MIN_LENGTH,
  entropyBits,
  generatePassword,
  type GeneratorOptions,
} from '@/lib/vault/generator'
import type { VaultItem, VaultItemDraft } from '@/lib/vault/items'
import { cn } from '@/lib/utils'

/**
 * The add/edit form for one credential, with the generator attached to it.
 *
 * The generator is here rather than behind its own button because the moment somebody
 * needs a strong password is the moment they are filling this field in. A generator
 * one screen away is a generator people skip, and the password they type instead is
 * the one they already use somewhere else.
 *
 * Nothing in this component is persisted anywhere. It holds what is being typed, hands
 * it to the caller on submit, and is unmounted — the values only ever exist in this
 * component's state and in the vault the caller seals.
 */

interface PasswordItemFormProps {
  /** The item being edited, or null when adding. */
  item: VaultItem | null
  busy: boolean
  onSubmit: (draft: VaultItemDraft) => void
  onCancel: () => void
}

const LABEL = 'text-xs font-medium text-muted-foreground'

export function PasswordItemForm({ item, busy, onSubmit, onCancel }: PasswordItemFormProps) {
  const [name, setName] = useState(item?.name ?? '')
  const [url, setUrl] = useState(item?.url ?? '')
  const [username, setUsername] = useState(item?.username ?? '')
  const [password, setPassword] = useState(item?.password ?? '')
  const [notes, setNotes] = useState(item?.notes ?? '')
  const [tags, setTags] = useState((item?.tags ?? []).join(', '))

  const [revealed, setRevealed] = useState(false)
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [options, setOptions] = useState<GeneratorOptions>(DEFAULT_GENERATOR_OPTIONS)
  const [error, setError] = useState<string | null>(null)

  // Hiding it again on unmount is not enough — a form left open on a shared screen
  // should not keep a password on display while the user reads something else.
  useEffect(() => {
    if (!revealed) return
    const timer = setTimeout(() => setRevealed(false), 30_000)
    return () => clearTimeout(timer)
  }, [revealed])

  const regenerate = useCallback(() => {
    try {
      setPassword(generatePassword(options))
      setRevealed(true)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [options])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError('Give this item a name so you can find it later.')
      return
    }
    if (!password) {
      setError('There is no password to save.')
      return
    }
    setError(null)
    onSubmit({
      name,
      url,
      username,
      password,
      notes,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    })
  }

  const toggle = (key: keyof GeneratorOptions) => (checked: boolean) =>
    setOptions((prev) => ({ ...prev, [key]: checked }))

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      <div className="flex flex-col gap-1">
        <label className={LABEL} htmlFor="vault-name">
          Name
        </label>
        <Input
          id="vault-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="GitHub"
          autoFocus
          required
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className={LABEL} htmlFor="vault-username">
            Username or email
          </label>
          <Input
            id="vault-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className={LABEL} htmlFor="vault-url">
            Website
          </label>
          <Input
            id="vault-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className={LABEL} htmlFor="vault-password">
          Password
        </label>
        <div className="flex items-center gap-1.5">
          <Input
            id="vault-password"
            // `text` when revealed so the value is inspectable; never `autoComplete`,
            // which is how a browser's own password manager ends up with a copy.
            type={revealed ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="font-mono"
            autoComplete="new-password"
            spellCheck={false}
            required
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setRevealed((prev) => !prev)}
            title={revealed ? 'Hide' : 'Show'}
            aria-label={revealed ? 'Hide password' : 'Show password'}
          >
            {revealed ? <EyeOff /> : <Eye />}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => {
              setGeneratorOpen(true)
              regenerate()
            }}
            title="Generate a password"
            aria-label="Generate a password"
          >
            <Dices />
          </Button>
        </div>
      </div>

      {generatorOpen && (
        <fieldset className="flex flex-col gap-2.5 rounded-lg border bg-muted/30 p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">Generator</legend>

          <div className="flex items-center gap-3">
            <input
              type="range"
              min={MIN_LENGTH}
              max={MAX_LENGTH}
              value={options.length}
              aria-label="Password length"
              onChange={(e) => setOptions((prev) => ({ ...prev, length: Number(e.target.value) }))}
              className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-primary"
            />
            <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums">
              {options.length} chars
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
            {(
              [
                ['lowercase', 'a–z'],
                ['uppercase', 'A–Z'],
                ['digits', '0–9'],
                ['symbols', '!@#'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-xs">
                <Switch
                  size="sm"
                  checked={options[key]}
                  onCheckedChange={toggle(key)}
                  aria-label={label}
                />
                <span className="font-mono">{label}</span>
              </label>
            ))}
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              About {entropyBits(options)} bits of entropy. Look-alike characters
              (<span className="font-mono">l I 1 O 0</span>) are left out.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={regenerate}>
              <Dices />
              Regenerate
            </Button>
          </div>
        </fieldset>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className={LABEL} htmlFor="vault-tags">
            Tags
          </label>
          <Input
            id="vault-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="work, email"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className={LABEL} htmlFor="vault-notes">
          Notes
        </label>
        <Textarea
          id="vault-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Recovery codes, security questions, anything else."
        />
        <p className="text-[11px] text-muted-foreground">
          Notes are encrypted with everything else, and are deliberately not searched.
        </p>
      </div>

      {error && (
        <p className={cn('rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive')}>
          {error}
        </p>
      )}

      <div className="mt-auto flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {item ? 'Save changes' : 'Add password'}
        </Button>
      </div>
    </form>
  )
}
