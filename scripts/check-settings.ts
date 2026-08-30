/**
 * Task 6.4 self-check: settings page mounts, vault reuses the existing envelope
 * for AI configs, and the API key input does not leak its value into the rendered
 * DOM via a `value=` attribute.
 *
 * Run from repo root: `node --import tsx scripts/check-settings.ts`.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ok: string[] = []
const fail: string[] = []

function check(name: string, passed: boolean, detail?: string): void {
  ;(passed ? ok : fail).push(detail ? `${name} (${detail})` : name)
}

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const settingsPage = read('app/settings/page.tsx')
const settingsForm = read('components/workspace/settings-form.tsx')
const sidebar = read('components/workspace/sidebar.tsx')
const workspaceApp = read('components/workspace/workspace-app.tsx')
const aiConfig = read('lib/vault/ai-config.ts')
const items = read('lib/vault/items.ts')

// 6.1 / 6.3: /settings route mounts the SettingsForm, which in turn mounts the
// list + edit panes.
check('app/settings/page.tsx exists', existsSync(join(ROOT, 'app/settings/page.tsx')))
check('settings page mounts SettingsForm', /<SettingsForm/.test(settingsPage))
check('settings page gates on auth + vault', /useVault\(authed\)/.test(settingsPage) && /\/api\/health/.test(settingsPage))
check('settings form has Add provider entry', /Add provider/.test(settingsForm))
check('settings form has provider dropdown', /<select[\s\S]+AI_PROVIDERS/.test(settingsForm))
check('settings form has model input + datalist', /datalist id=\{`ai-model-options-\$\{/.test(settingsForm) || /ai-model-options-/.test(settingsForm))
check('settings form has base URL input', /id="ai-base-url"/.test(settingsForm))
check('settings form has masked API key input', /id="ai-api-key"[\s\S]+type=\{revealed \? 'text' : 'password'\}/.test(settingsForm))
check('settings form has Save/Update submit button', /type="submit"/.test(settingsForm))

// 6.2: AI config is a typed config, encrypted with the same envelope (no new
// crypto module).
check('ai-config.ts is the AI config module', /AiConfig\b/.test(aiConfig) && /export const AI_PROVIDERS/.test(aiConfig))
check('VaultData now carries an `ai` field', /ai: AiConfig\[\]/.test(items))
check('mergeVaults unions AI configs by id', /aiById/.test(items))
check('normalizeVaultData parses the optional ai field', /parseAiField/.test(items))
check('getAiConfigs reads from VaultData', /export function getAiConfigs/.test(aiConfig))
check('upsertAiConfig adds or replaces by id', /export function upsertAiConfig[\s\S]+existing[\s\S]+config/.test(aiConfig))
check('removeAiConfig drops by id', /export function removeAiConfig/.test(aiConfig))

// 6.3: API key input must not have a `value=` attribute that would render the
// key into the DOM. The form is uncontrolled for the key; the submit handler
// reads `keyInput.value` directly.
const apiKeyBlock = settingsForm.match(/<input[\s\S]+id="ai-api-key"[\s\S]+?\/>/)
check('api key input block found in settings-form', Boolean(apiKeyBlock))
if (apiKeyBlock) {
  // The block may contain `value=` inside a JSX expression like `type={...}` —
  // strip the attribute-shaped occurrences and only fail on a plain literal.
  const literalValue = / value="[^"]+"/.test(apiKeyBlock[0]) || / value=\{[^}]*apiKey[^}]*\}/.test(apiKeyBlock[0])
  check('api key input has no value= attribute (masked input does not leak)', !literalValue)
}

// Sidebar entry: Settings link in the footer, plumbed through workspace-app.
check('sidebar has a Settings link', /onClick=\{onOpenSettings\}/.test(sidebar) && /Settings/.test(sidebar))
check('workspace-app passes onOpenSettings to sidebar', /onOpenSettings=\{/.test(workspaceApp))
check('workspace-app routes Settings to /settings', /router\.push\('\/settings'\)/.test(workspaceApp))

// Encoder safety: no mojibake sneaked in while editing these files.
check('settings-form has no mojibake markers', !/[ÃÂ]/.test(settingsForm))
check('ai-config has no mojibake markers', !/[ÃÂ]/.test(aiConfig))
check('settings page has no mojibake markers', !/[ÃÂ]/.test(settingsPage))

console.log(`settings: Task 6.4 check`)
ok.forEach((name) => console.log(`  ok  ${name}`))
fail.forEach((name) => console.log(`  FAIL ${name}`))
console.log('')
console.log(`${ok.length}/${ok.length + fail.length} pass`)
if (fail.length > 0) process.exit(1)
