/**
 * Password generation.
 *
 * Two things go wrong in generators, and both are here on purpose:
 *
 *   1. `Math.random()`. It is a PRNG seeded from something predictable, and a password
 *      it produces is guessable by anyone who can reproduce the seed. Every byte here
 *      comes from `crypto.getRandomValues`.
 *
 *   2. Modulo bias. `byte % alphabet.length` is not uniform unless the alphabet
 *      divides 256 evenly — with 26 letters the first six are ~1.5% likelier than the
 *      rest, which is small, free to avoid, and exactly the kind of thing that
 *      compounds. `randomIndex` rejects the tail instead.
 */

export interface GeneratorOptions {
  length: number
  lowercase: boolean
  uppercase: boolean
  digits: boolean
  symbols: boolean
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
}

export const MIN_LENGTH = 8
export const MAX_LENGTH = 128

const SETS = {
  lowercase: 'abcdefghijkmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  // No quotes or backslashes: they are the characters that get mangled by shells,
  // CSV exports, and the occasional login form that escapes badly.
  symbols: '!@#$%^&*()-_=+[]{}<>?,.:;',
} as const

/**
 * Ambiguous characters are absent from the sets above — `l`, `I`, `1`, `O`, `0`.
 *
 * A password that cannot be read off a screen and typed into a phone gets replaced by
 * a worse one the user makes up. The cost is about 0.2 bits per character.
 */

function randomIndex(bound: number): number {
  // The largest multiple of `bound` that fits in a byte. Values at or above it would
  // wrap unevenly, so they are drawn again.
  const limit = Math.floor(256 / bound) * bound
  const buffer = new Uint8Array(1)
  for (;;) {
    crypto.getRandomValues(buffer)
    if (buffer[0] < limit) return buffer[0] % bound
  }
}

function pick(alphabet: string): string {
  return alphabet[randomIndex(alphabet.length)]
}

/** Fisher-Yates, with the same unbiased source. */
function shuffle(characters: string[]): string[] {
  for (let i = characters.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1)
    ;[characters[i], characters[j]] = [characters[j], characters[i]]
  }
  return characters
}

export function activeAlphabets(options: GeneratorOptions): string[] {
  const sets: string[] = []
  if (options.lowercase) sets.push(SETS.lowercase)
  if (options.uppercase) sets.push(SETS.uppercase)
  if (options.digits) sets.push(SETS.digits)
  if (options.symbols) sets.push(SETS.symbols)
  return sets
}

/**
 * Generates a password containing at least one character from every enabled set.
 *
 * The guarantee is what makes "include symbols" mean something — without it a
 * 20-character password with symbols enabled omits them about 12% of the time, and the
 * user finds out when the site rejects it. Positions are shuffled afterwards so the
 * guaranteed characters are not always at the front, which would be a pattern.
 */
export function generatePassword(options: GeneratorOptions): string {
  const sets = activeAlphabets(options)
  if (sets.length === 0) throw new Error('Choose at least one kind of character.')

  const length = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.floor(options.length)))
  const pool = sets.join('')

  const characters = sets.slice(0, length).map(pick)
  while (characters.length < length) characters.push(pick(pool))

  return shuffle(characters).join('')
}

/**
 * Rough entropy of the generator's own output, in bits.
 *
 * Honest about what it measures: the strength of a password *this generator* produced,
 * which is `length × log2(alphabet)`. It is not a strength meter for a password
 * somebody typed — those are dictionary-shaped and this number would flatter them.
 */
export function entropyBits(options: GeneratorOptions): number {
  const pool = activeAlphabets(options).join('').length
  if (pool === 0) return 0
  const length = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.floor(options.length)))
  return Math.round(length * Math.log2(pool))
}
