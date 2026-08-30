/**
 * R2 environment is missing.
 *
 * The boot-time configuration screen surfaces this error so the user
 * sees which four env vars they need to set, instead of an opaque
 * crash deeper in the storage stack.
 */

export const REQUIRED_R2_VARS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
] as const

export type RequiredR2Var = (typeof REQUIRED_R2_VARS)[number]

export class MissingR2ConfigError extends Error {
  readonly code = 'MISSING_R2_CONFIG'
  readonly missing: string[]

  constructor(missing: string[]) {
    super(
      `MarkForge requires R2. Missing env vars: ${missing.join(', ')}. ` +
        `Set ${REQUIRED_R2_VARS.join(', ')} and restart.`
    )
    this.name = 'MissingR2ConfigError'
    this.missing = missing
  }
}
