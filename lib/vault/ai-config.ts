/**
 * AI provider configs, stored in the same encrypted vault as the password items.
 *
 * Two providers today: an OpenAI-compatible one (any endpoint that speaks the
 * `chat/completions` streaming protocol) and native Gemini, because Gemini is the
 * other realistic ask in this app's footprint. Adding a third is a one-line entry
 * in `AI_PROVIDERS` — there is no factory or interface dance to keep in step.
 *
 * Same envelope, same KDF, same master password. The vault key that already decrypts
 * the password items decrypts this; a config never sees plaintext outside the
 * browser.
 */
import type { VaultData } from './items'

export type AiProvider = 'openai-compatible' | 'gemini'

export interface AiConfig {
  id: string
  provider: AiProvider
  /** Free-text model id; the dropdowns only suggest, they do not enforce. */
  model: string
  /** Empty string means "use the provider default". */
  baseUrl: string
  /** The secret. Never logged, never stored in plaintext anywhere. */
  apiKey: string
  createdAt: string
  updatedAt: string
}

export interface AiConfigDraft {
  provider: AiProvider
  model: string
  baseUrl?: string
  apiKey: string
}

export const AI_PROVIDERS: { value: AiProvider; label: string; defaultBaseUrl: string; defaultModel: string; modelOptions: string[] }[] = [
  {
    value: 'openai-compatible',
    label: 'OpenAI-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    modelOptions: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  },
  {
    value: 'gemini',
    label: 'Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-1.5-flash',
    modelOptions: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'],
  },
]

/** Maps a provider to the base URL the form pre-fills when the user picks it. */
export function defaultBaseUrl(provider: AiProvider): string {
  return AI_PROVIDERS.find((entry) => entry.value === provider)?.defaultBaseUrl ?? ''
}

export function defaultModel(provider: AiProvider): string {
  return AI_PROVIDERS.find((entry) => entry.value === provider)?.defaultModel ?? ''
}

export function modelOptionsFor(provider: AiProvider): string[] {
  return AI_PROVIDERS.find((entry) => entry.value === provider)?.modelOptions ?? []
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? ''
}

function cleanAiDraft(draft: AiConfigDraft): { provider: AiProvider; model: string; baseUrl: string; apiKey: string } {
  const model = trimmed(draft.model)
  if (!model) throw new Error('A model is required.')
  if (!draft.apiKey) throw new Error('An API key is required.')
  return {
    provider: draft.provider,
    model,
    baseUrl: trimmed(draft.baseUrl) || defaultBaseUrl(draft.provider),
    apiKey: draft.apiKey,
  }
}

function newConfigId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function getAiConfigs(data: VaultData | null | undefined): AiConfig[] {
  return data?.ai ?? []
}

export function upsertAiConfig(
  data: VaultData,
  draft: AiConfigDraft,
  options: { id?: string; now?: string } = {}
): { data: VaultData; config: AiConfig } {
  const now = options.now ?? new Date().toISOString()
  const clean = cleanAiDraft(draft)
  const existing = options.id ? data.ai.find((entry) => entry.id === options.id) : undefined

  const config: AiConfig = {
    id: existing?.id ?? options.id ?? newConfigId(),
    provider: clean.provider,
    model: clean.model,
    baseUrl: clean.baseUrl,
    apiKey: clean.apiKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  const ai = existing
    ? data.ai.map((entry) => (entry.id === config.id ? config : entry))
    : [...data.ai, config]

  return { data: { ...data, ai }, config }
}

export function removeAiConfig(data: VaultData, id: string): VaultData {
  return { ...data, ai: data.ai.filter((entry) => entry.id !== id) }
}

/**
 * Tolerant reader for AI configs on a vault record.
 *
 * The actual parser lives in `items.ts` to avoid a circular import; this is a
 * public re-export so callers reading the file can find the normalizer next to
 * the type.
 */
export { parseAiField as normalizeAiConfigs } from './items'
