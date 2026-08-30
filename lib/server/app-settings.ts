/**
 * App-level settings persisted in the bucket.
 *
 * Lives at `_meta/app-settings.json` so a setting survives an index rebuild
 * and a backend swap. Today the only field is the app gate PIN; new ones go
 * here, not into env vars, when they are runtime-mutable per deployment.
 *
 * Resolution order for the app PIN:
 *   1. `APP_PIN` env (operator-pinned, takes precedence)
 *   2. `appSettings.appPin` from the bucket
 *   3. default `123098`
 *
 * Stored shape is a strict allowlist (see `parseAppSettings`) so a stray
 * field in a future write does not silently inject a new control.
 */

import { getStore } from './store'
import type { Bucket } from './bucket'
import { isValidAppPin as isValidAppPinShared } from '../app-settings-shared'

export { APP_PIN_LENGTH } from '../app-settings-shared'

export const APP_SETTINGS_FILE = 'app-settings.json'
export const APP_SETTINGS_VERSION = 1

/** Real default the gate accepts when no env and no stored setting. */
export const DEFAULT_APP_PIN = '123098'

export interface AppSettings {
  version: typeof APP_SETTINGS_VERSION
  appPin?: string
  updatedAt: string
}

export class InvalidAppSettingsError extends Error {
  readonly code = 'INVALID_APP_SETTINGS'
  constructor(reason: string) {
    super(`Invalid app settings: ${reason}`)
    this.name = 'InvalidAppSettingsError'
  }
}

const ALLOWED_KEYS = ['version', 'appPin', 'updatedAt'] as const

function allowKeys(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAppSettingsError('must be an object')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new InvalidAppSettingsError(`unexpected field: ${key}`)
    }
  }
  return record
}

function parseAppSettings(value: unknown): AppSettings {
  const record = allowKeys(value)
  if (record.version !== APP_SETTINGS_VERSION) {
    throw new InvalidAppSettingsError('unsupported version')
  }
  if (record.appPin !== undefined) {
    if (typeof record.appPin !== 'string' || !isValidAppPin(record.appPin)) {
      throw new InvalidAppSettingsError('appPin must be 6 digits')
    }
  }
  if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new InvalidAppSettingsError('updatedAt is not a timestamp')
  }
  return {
    version: APP_SETTINGS_VERSION,
    ...(record.appPin !== undefined ? { appPin: record.appPin } : {}),
    updatedAt: record.updatedAt,
  }
}

/** A valid PIN is exactly 6 digits. Same shape the login form enforces. */
export const isValidAppPin = isValidAppPinShared

export class AppSettingsStore {
  constructor(private readonly bucket: Bucket = getStore().bucket) {}

  private async read(): Promise<AppSettings | null> {
    const raw = await this.bucket.readMeta(APP_SETTINGS_FILE)
    if (!raw) return null
    try {
      return parseAppSettings(JSON.parse(raw))
    } catch {
      // A corrupt settings file must not grant access: read as if no settings exist.
      return null
    }
  }

  private async write(settings: AppSettings): Promise<void> {
    await this.bucket.writeMeta(APP_SETTINGS_FILE, JSON.stringify(settings, null, 2))
  }

  /** Reads the current stored settings, or `null` when none. */
  async load(): Promise<AppSettings | null> {
    return this.read()
  }

  /**
   * Replaces the stored app PIN.
   *
   * Callers must validate the PIN shape themselves; this method only asserts
   * because a UI bug should not let a malformed value reach the bucket.
   */
  async setAppPin(pin: string): Promise<AppSettings> {
    if (!isValidAppPin(pin)) {
      throw new InvalidAppSettingsError('appPin must be 6 digits')
    }
    const next: AppSettings = {
      version: APP_SETTINGS_VERSION,
      appPin: pin,
      updatedAt: new Date().toISOString(),
    }
    await this.write(next)
    return next
  }
}

/**
 * Resolves the effective app PIN: env first, then stored, then default.
 *
 * The env is intentionally ahead: an operator pinning `APP_PIN` in a
 * deployment must win, even if someone changed the bucket setting from
 * another device.
 */
export function resolveAppPin(
  env: Record<string, string | undefined>,
  stored: AppSettings | null
): string {
  const fromEnv = env.APP_PIN?.trim()
  if (fromEnv) {
    if (!isValidAppPin(fromEnv)) {
      // Surface as the default; the env validator logs the warning.
      return DEFAULT_APP_PIN
    }
    return fromEnv
  }
  if (stored?.appPin && isValidAppPin(stored.appPin)) {
    return stored.appPin
  }
  return DEFAULT_APP_PIN
}
