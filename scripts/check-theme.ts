/**
 * Self-check for the Settings appearance card.
 *
 * The settings page exposes a three-way control (Day / Night / System) that
 * writes through `next-themes` to the same persistence the header switcher
 * already uses. Both surfaces stay in sync because they share the same
 * provider.
 *
 * Run with `pnpm tsx scripts/check-theme.ts`. Exit 0 = pass.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const failures: string[] = []
function check(label: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    console.log(`  FAIL ${label}${extra ? `  (${extra})` : ''}`)
    failures.push(label)
  }
}

const root = resolve(process.cwd())
const settings = readFileSync(resolve(root, 'app/settings/page.tsx'), 'utf8')
const provider = readFileSync(resolve(root, 'components/theme-switcher.tsx'), 'utf8')

console.log('theme settings card')

check('settings page imports useTheme from next-themes', /useTheme\b/.test(settings) && /from 'next-themes'/.test(settings))
check('settings page renders three options (Day / Night / System)', /['"]light['"]/.test(settings) && /['"]dark['"]/.test(settings) && /['"]system['"]/.test(settings))
check('settings page calls setTheme on click', /setTheme\(value\)/.test(settings))
check('settings page card is in the App section (above the App PIN card)', /Appearance/.test(settings) && /<h2[^>]*>App PIN</.test(settings) && settings.indexOf('Appearance') < settings.indexOf('<h2 className="text-sm font-semibold tracking-tight">App PIN'))
check('next-themes provider still wraps the app', /NextThemesProvider/.test(provider) && /enableSystem/.test(provider))

if (failures.length === 0) {
  console.log('\nALL OK')
  process.exit(0)
}
console.error(`\n${failures.length} failure(s):`)
for (const f of failures) console.error(`  - ${f}`)
process.exit(1)
