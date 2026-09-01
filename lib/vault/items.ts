/**
 * The plaintext vault — the thing inside the ciphertext.
 *
 * Every field on `VaultItem` is sensitive, including the ones that do not look it.
 * `name` and `url` are the site you have an account with; `tags` describe your life.
 * That is why the whole structure is sealed as one blob rather than encrypted
 * field-by-field with a searchable index: an index over item names is a list of every
 * service you use, sitting in a bucket, readable by anyone who gets the bucket.
 *
 * Consequence, stated because it is a real trade: search runs over decrypted items in
 * memory and there is no server-side search. That is the MVP's non-goal, not an
 * oversight — see docs/password-manager-plan.md.
 *
 * These values only ever exist in a browser with an open vault. Nothing in this module
 * touches the network.
 */

export const VAULT_DATA_VERSION = 1

export interface VaultItem {
  id: string
  /** What the credential is for. Required — an unnamed item is unfindable. */
  name: string
  url?: string
  username?: string
  password: string
  notes?: string
  tags?: string[]
  /**
   * Base32-encoded TOTP secret (RFC 6238). Stored alongside the password
   * and encrypted with the same envelope; the 6-digit code is computed on
   * demand and never persisted.
   */
  totp?: string
  createdAt: string
  updatedAt: string
}

export interface VaultData {
  version: typeof VAULT_DATA_VERSION
  items: VaultItem[]
}

export function emptyVault(): VaultData {
  return { version: VAULT_DATA_VERSION, items: [] }
}

/** Random id, not a counter: ids have to survive two devices adding items offline. */
export function newItemId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * What the user typed, cleaned up.
 *
 * Empty optional fields are dropped rather than stored as `''`, so a re-seal of an
 * untouched vault produces the same plaintext and the diff between two versions means
 * something.
 */
export interface VaultItemDraft {
  name: string
  url?: string
  username?: string
  password: string
  notes?: string
  tags?: string[]
  totp?: string
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

function cleanDraft(draft: VaultItemDraft): Omit<VaultItemDraft, 'name'> & { name: string } {
  const tags = draft.tags?.map((tag) => tag.trim()).filter(Boolean)
  const totp = draft.totp?.replace(/\s+/g, '').toUpperCase() || undefined
  return {
    name: draft.name.trim(),
    url: trimmed(draft.url),
    username: trimmed(draft.username),
    // Not trimmed: a trailing space can be part of a password, and silently
    // "fixing" one produces a credential that does not work and cannot be debugged.
    password: draft.password,
    notes: trimmed(draft.notes),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(totp ? { totp } : {}),
  }
}

/**
 * Adds or replaces an item, returning a new `VaultData`.
 *
 * Immutable on purpose: the open vault is React state, and mutating it in place is how
 * a save writes one thing and the screen shows another.
 */
export function upsertItem(
  data: VaultData,
  draft: VaultItemDraft,
  options: { id?: string; now?: string } = {}
): { data: VaultData; item: VaultItem } {
  const now = options.now ?? new Date().toISOString()
  const clean = cleanDraft(draft)
  if (!clean.name) throw new Error('An item needs a name.')

  const existing = options.id ? data.items.find((item) => item.id === options.id) : undefined

  const item: VaultItem = {
    id: existing?.id ?? options.id ?? newItemId(),
    ...clean,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  const items = existing
    ? data.items.map((current) => (current.id === item.id ? item : current))
    : [...data.items, item]

  return { data: { ...data, items }, item }
}

export function removeItem(data: VaultData, id: string): VaultData {
  return { ...data, items: data.items.filter((item) => item.id !== id) }
}

/**
 * Local search across the fields worth matching on.
 *
 * Passwords and notes are deliberately not searched. Notes hold recovery answers and
 * one-off secrets, and a substring match against them turns the search box into an
 * oracle for anyone who gets thirty seconds at an unlocked screen.
 */
/**
 * Cheap subsequence score for the quick-switcher. Returns a non-negative
 * number when every character of `needle` appears in `haystack` in order;
 * `Infinity` (treated as "no match" by the caller) otherwise. A real
 * implementation would weight by gap length and case, but the quick
 * switcher is a five-item list, not a typeahead.
 */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0
  const lower = haystack.toLowerCase()
  let score = 0
  let previousIndex = -1
  for (const char of needle.toLowerCase()) {
    const next = lower.indexOf(char, previousIndex + 1)
    if (next < 0) return Number.POSITIVE_INFINITY
    score += next - previousIndex
    previousIndex = next
  }
  return score
}

/**
 * Ranked match for the quick switcher. Same fields as `filterItems`, plus
 * an ordering: items that start with the query come first, then by
 * subsequence score. The list is small enough that the linear scan is
 * cheaper than a trie.
 */
export function matchQuick(items: VaultItem[], query: string): VaultItem[] {
  const needle = query.trim()
  if (!needle) return items
  const scored: Array<{ item: VaultItem; score: number }> = []
  for (const item of items) {
    const fields = [item.name, item.url, item.username, ...(item.tags ?? [])]
    let best = Number.POSITIVE_INFINITY
    for (const field of fields) {
      if (!field) continue
      const candidate = fuzzyScore(field, needle)
      if (candidate < best) best = candidate
    }
    if (best !== Number.POSITIVE_INFINITY) scored.push({ item, score: best })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.map((entry) => entry.item)
}

export function filterItems(items: VaultItem[], query: string): VaultItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return items

  return items.filter((item) => {
    const haystack = [item.name, item.url, item.username, ...(item.tags ?? [])]
    return haystack.some((field) => field?.toLowerCase().includes(needle))
  })
}

export function sortItems(items: VaultItem[]): VaultItem[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Reconciles two versions of the same vault after a save conflict.
 *
 * Item ids are random and stable, so two devices editing different credentials
 * produce disjoint sets and merge cleanly — which is the overwhelmingly common case
 * and the one that must not cost anybody a password. Where both edited the *same*
 * item, the later `updatedAt` wins, and the older value is genuinely lost; that is a
 * last-write-wins field merge and the plan is explicit that anything better is out of
 * scope for the MVP.
 *
 * What this deliberately does not do is resurrect deletions. An item present in one
 * side and absent from the other is kept, because a merge that silently dropped a
 * credential would be the same failure as the overwrite this exists to prevent, and
 * an extra item is visible and deletable while a missing one is not.
 */
export function mergeVaults(local: VaultData, remote: VaultData): VaultData {
  const byId = new Map<string, VaultItem>()
  for (const item of remote.items) byId.set(item.id, item)

  for (const item of local.items) {
    const other = byId.get(item.id)
    if (!other || item.updatedAt >= other.updatedAt) byId.set(item.id, item)
  }

  return { version: VAULT_DATA_VERSION, items: [...byId.values()] }
}

/**
 * Reads decrypted bytes back into a vault.
 *
 * Tolerant where record.ts is strict, and for the opposite reason: this data was
 * authenticated by AES-GCM before it got here, so it is ours. What it guards against
 * is an older or newer shape, not an attacker — a missing `items` array must read as
 * an empty vault rather than crashing the screen that holds the only copy.
 */
export function normalizeVaultData(value: unknown): VaultData {
  if (typeof value !== 'object' || value === null) return emptyVault()
  const parsed = value as Partial<VaultData>
  if (!Array.isArray(parsed.items)) return emptyVault()

  const items = parsed.items.filter(
    (item): item is VaultItem =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as VaultItem).id === 'string' &&
      typeof (item as VaultItem).name === 'string' &&
      typeof (item as VaultItem).password === 'string'
  )

  return { version: VAULT_DATA_VERSION, items }
}
