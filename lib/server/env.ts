/**
 * Boot-time environment validator.
 *
 * Logs warnings (never throws) so a misconfiguration is visible at server
 * start without taking the app down. The login flow does the actual
 * gate check at request time; this is for the "I never noticed my
 * password was empty" class of mistake.
 *
 * Each warning is a single human-readable line; no codes, no JSON — the
 * point is a glance in the terminal, not a machine parse.
 */

import { APP_PIN_LENGTH, DEFAULT_APP_PIN, isValidAppPin } from './app-settings'

export interface EnvValidation {
  warnings: string[]
  /** `true` when the auth gate is configured (env or stored). `false` when it is off. */
  gated: boolean
}

const SESSION_SECRET_MIN = 32

export function validateEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: { hasStoredPin?: boolean } = {}
): EnvValidation {
  const warnings: string[] = []
  const e = env as Record<string, string | undefined>

  if (e.APP_PASSWORD) {
    warnings.push(
      'APP_PASSWORD is set but no longer read. Use APP_PIN (6 digits) or SESSION_SECRET instead. ' +
        'Delete APP_PASSWORD to silence this warning.'
    )
  }

  if (e.APP_PIN !== undefined) {
    const pin = e.APP_PIN.trim()
    if (pin.length === 0) {
      warnings.push(`APP_PIN is empty. Gate will use the default (${DEFAULT_APP_PIN}).`)
    } else if (!isValidAppPin(pin)) {
      warnings.push(
        `APP_PIN must be exactly ${APP_PIN_LENGTH} digits (got ${pin.length}). Falling back to default.`
      )
    }
  } else if (!e.SESSION_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      warnings.push(
        `APP_PIN is not set and SESSION_SECRET is not set. Auth gate is off. ` +
          `Set APP_PIN=${DEFAULT_APP_PIN} (or any 6 digits) or APP_PIN=<your-pin> in production.`
      )
    } else {
      warnings.push(
        `APP_PIN is not set. Using the default (${DEFAULT_APP_PIN}). ` +
          `Set APP_PIN in .env to change it.`
      )
    }
  }

  if (e.SESSION_SECRET && e.SESSION_SECRET.length < SESSION_SECRET_MIN) {
    warnings.push(
      `SESSION_SECRET is shorter than ${SESSION_SECRET_MIN} characters. ` +
        'Use a 32+ character random string for production.'
    )
  }

  const gated = Boolean(
    (e.APP_PIN && isValidAppPin(e.APP_PIN.trim())) ||
      (e.SESSION_SECRET && e.SESSION_SECRET.length >= SESSION_SECRET_MIN) ||
      options.hasStoredPin
  )

  return { warnings, gated }
}
