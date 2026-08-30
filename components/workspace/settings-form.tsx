'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, EyeOff, Loader2, Plus, Save, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { type UseVault } from '@/lib/vault/use-vault'
import {
  AI_PROVIDERS,
  defaultBaseUrl,
  defaultModel,
  getAiConfigs,
  modelOptionsFor,
  removeAiConfig,
  upsertAiConfig,
  type AiConfig,
  type AiConfigDraft,
  type AiProvider,
} from '@/lib/vault/ai-config'
import { cn } from '@/lib/utils'

/**
 * AI provider settings.
 *
 * Three responsibilities, in this order:
 *  1. show the configs the user already has,
 *  2. let them add or edit one,
 *  3. never leak the API key into the DOM as a `value=` attribute.
 *
 * The last one matters more than it looks. A `value` attribute on an input is
 * what `view-source:` and any injected script see, and the same value lands in
 * React DevTools' tree. The form uses an uncontrolled input for the key
 * (`defaultValue` for edits, no `value`) and reads it from the DOM only on
 * submit, so the masked placeholder is all the page ever shows for the secret.
 */
interface SettingsFormProps {
  vault: UseVault
}

type Pane = { kind: 'list' } | { kind: 'edit'; config: AiConfig | null }

const FIELD_LABEL = 'block text-xs font-medium text-muted-foreground'
const FIELD_INPUT =
  'w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground outline-none ring-primary/20 placeholder:text-muted-foreground focus:border-primary focus:ring-2'
const CARD = 'rounded-lg border bg-card p-4 shadow-sm'
const MUTED = 'text-xs text-muted-foreground'

export function SettingsForm({ vault }: SettingsFormProps) {
  const [pane, setPane] = useState<Pane>({ kind: 'list' })
  const configs = useMemo(() => (vault.data ? getAiConfigs(vault.data) : []), [vault.data])
  const [pendingDelete, setPendingDelete] = useState<AiConfig | null>(null)

  const closePane = useCallback(() => {
    setPane({ kind: 'list' })
    setPendingDelete(null)
  }, [])

  return (
    <div className="space-y-4">
      <header className={CARD}>
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Sparkles className="size-5" />
          </div>
          <div className="space-y-1">
            <h2 className="text-sm font-semibold tracking-tight">AI providers</h2>
            <p className={MUTED}>
              API keys are encrypted with the same envelope as the password vault.
              They never leave this browser unencrypted.
            </p>
          </div>
        </div>
      </header>

      {pane.kind === 'list' ? (
        <ListPane
          configs={configs}
          pendingDelete={pendingDelete}
          onAskDelete={setPendingDelete}
          onCancelDelete={() => setPendingDelete(null)}
          onConfirmDelete={async (config) => {
            if (!vault.data) return
            try {
              await vault.commit(removeAiConfig(vault.data, config.id))
              setPendingDelete(null)
              toast.success(`Removed ${config.model}.`)
            } catch (err) {
              toast.error((err as Error).message)
            }
          }}
          onEdit={(config) => setPane({ kind: 'edit', config })}
          onAdd={() => setPane({ kind: 'edit', config: null })}
        />
      ) : (
        <EditPane
          existing={pane.config}
          onCancel={closePane}
          onSave={async (draft, id) => {
            if (!vault.data) return
            try {
              const { data, config } = upsertAiConfig(vault.data, draft, id ? { id } : {})
              await vault.commit(data)
              toast.success(id ? `Updated ${config.model}.` : `Added ${config.model}.`)
              closePane()
            } catch (err) {
              toast.error((err as Error).message)
            }
          }}
        />
      )}
    </div>
  )
}

interface ListPaneProps {
  configs: AiConfig[]
  pendingDelete: AiConfig | null
  onAskDelete: (config: AiConfig) => void
  onCancelDelete: () => void
  onConfirmDelete: (config: AiConfig) => void | Promise<void>
  onEdit: (config: AiConfig) => void
  onAdd: () => void
}

function ListPane({ configs, pendingDelete, onAskDelete, onCancelDelete, onConfirmDelete, onEdit, onAdd }: ListPaneProps) {
  return (
    <section className={CARD}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Saved providers</h3>
        <Button size="sm" onClick={onAdd}>
          <Plus className="size-3.5" />
          <span>Add provider</span>
        </Button>
      </div>
      {configs.length === 0 ? (
        <p className={MUTED}>
          No providers yet. Add one to enable inline AI in the editor (coming in Task 8).
        </p>
      ) : (
        <ul className="divide-y">
          {configs.map((config) => (
            <li key={config.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {providerLabel(config.provider)}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">· {config.model}</span>
                </div>
                {config.baseUrl ? (
                  <div className="truncate text-[11px] text-muted-foreground">{config.baseUrl}</div>
                ) : null}
              </div>
              <Button variant="ghost" size="sm" onClick={() => onEdit(config)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Remove this provider"
                onClick={() => onAskDelete(config)}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {pendingDelete ? (
        <div className="mt-3 flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
          <span>
            Remove <strong className="font-medium">{pendingDelete.model}</strong>?
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancelDelete}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void onConfirmDelete(pendingDelete)}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

interface EditPaneProps {
  existing: AiConfig | null
  onCancel: () => void
  onSave: (draft: AiConfigDraft, id: string | null) => void | Promise<void>
}

function EditPane({ existing, onCancel, onSave }: EditPaneProps) {
  const [provider, setProvider] = useState<AiProvider>(existing?.provider ?? 'openai-compatible')
  const [modelOverride, setModelOverride] = useState<string | null>(null)
  const [baseUrlOverride, setBaseUrlOverride] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const keyInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const node = keyInputRef.current
    if (node && existing?.apiKey && !node.value) {
      node.value = existing.apiKey
    }
  }, [existing?.apiKey])

  // Reset overrides on provider change so the new defaults take over.
  const handleProviderChange = useCallback((next: AiProvider) => {
    setProvider(next)
    setModelOverride(null)
    setBaseUrlOverride(null)
  }, [])

  const model = modelOverride ?? existing?.model ?? defaultModel(provider)
  const baseUrl = baseUrlOverride ?? existing?.baseUrl ?? defaultBaseUrl(provider)

  const modelOptions = useMemo(() => modelOptionsFor(provider), [provider])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = e.currentTarget
    const keyInput = form.elements.namedItem('apiKey') as HTMLInputElement | null
    const apiKey = keyInput?.value ?? ''
    if (!apiKey) {
      setError('An API key is required.')
      return
    }
    if (!model) {
      setError('A model is required.')
      return
    }
    setBusy(true)
    try {
      await onSave({ provider, model, baseUrl, apiKey }, existing?.id ?? null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={CARD}>
      <h3 className="mb-3 text-sm font-semibold">
        {existing ? 'Edit provider' : 'Add provider'}
      </h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label htmlFor="ai-provider" className={FIELD_LABEL}>
            Provider
          </label>
          <select
            id="ai-provider"
            value={provider}
            onChange={(event) => handleProviderChange(event.target.value as AiProvider)}
            className={cn(FIELD_INPUT, 'cursor-pointer')}
          >
            {AI_PROVIDERS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="ai-model" className={FIELD_LABEL}>
            Model
          </label>
          <input
            id="ai-model"
            list={`ai-model-options-${provider}`}
            value={model}
            onChange={(event) => setModelOverride(event.target.value)}
            placeholder="model-id"
            className={FIELD_INPUT}
          />
          <datalist id={`ai-model-options-${provider}`}>
            {modelOptions.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </div>

        <div>
          <label htmlFor="ai-base-url" className={FIELD_LABEL}>
            Base URL
          </label>
          <input
            id="ai-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrlOverride(event.target.value)}
            placeholder={defaultBaseUrl(provider)}
            className={FIELD_INPUT}
          />
        </div>

        <div>
          <label htmlFor="ai-api-key" className={FIELD_LABEL}>
            API key
          </label>
          <div className="relative">
            <input
              ref={keyInputRef}
              id="ai-api-key"
              name="apiKey"
              type={revealed ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="••••••••••"
              className={cn(FIELD_INPUT, 'pr-10 font-mono')}
            />
            <button
              type="button"
              onClick={() => setRevealed((value) => !value)}
              className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title={revealed ? 'Hide' : 'Reveal'}
            >
              {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
          <p className={cn(MUTED, 'mt-1')}>
            Stored encrypted with the same envelope as the password vault. The masked
            placeholder is all the page ever shows for this field.
          </p>
        </div>

        {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            <span>{existing ? 'Update' : 'Add provider'}</span>
          </Button>
        </div>
      </form>
    </section>
  )
}

function providerLabel(provider: AiProvider): string {
  return AI_PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider
}
