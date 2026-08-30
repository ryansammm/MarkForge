/**
 * Client-safe app-settings constants.
 *
 * Pure values, no I/O, no Node builtins — safe to import from a client
 * component. The full store lives at `lib/server/app-settings.ts`; this
 * file is the constants the keypad, login page, and any other browser
 * surface need.
 */

export const APP_PIN_LENGTH = 6

/** Visual hint shown in the keypad placeholder. Never the real default. */
export const APP_PIN_PLACEHOLDER = '123456'

/** Exactly 6 digits. */
export function isValidAppPin(value: string): boolean {
  return /^\d{6}$/.test(value)
}
