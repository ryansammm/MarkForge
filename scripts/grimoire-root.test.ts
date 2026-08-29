import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

const REPO = path.resolve(__dirname, '..', '..')
const FIXTURE = path.join(REPO, 'scripts', 'fixtures', 'root-folder')
const APPDATA = path.join(process.env.APPDATA || '', 'markforge')

test('per-grimoire root folder: picker sets path, reindex populates index', async () => {
  // Fresh AppData so the test is deterministic across runs.
  fs.rmSync(APPDATA, { recursive: true, force: true })

  const app: ElectronApplication = await electron.launch({
    args: [path.join(REPO, 'electron', 'main.cjs')],
    env: { ...process.env, NODE_ENV: 'production' },
  })
  const page: Page = await app.firstWindow()

  // Mock the native folder picker to return our fixture path.
  await app.evaluate(({ ipcMain, dialog }, fixturePath) => {
    ipcMain.removeHandler('markforge:select-directory')
    ipcMain.handle('markforge:select-directory', async () => fixturePath)
    void dialog
  }, FIXTURE)

  await page.waitForLoadState('load', { timeout: 30000 })
  await page.waitForTimeout(2000)

  // Pass the login gate.
  const passwordInput = page.locator('input[type="password"]')
  if (await passwordInput.count()) {
    // Default dev/test password for offline mode is empty — submit whatever is there.
    await page.keyboard.press('Enter').catch(() => {})
    await page.waitForTimeout(500)
  }

  // Create a grimoire via the API (faster + more deterministic than UI).
  const created = await page.evaluate(async () => {
    const res = await fetch('/api/grimoires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'smoke-root' }),
    })
    return { status: res.status, body: await res.json() }
  })
  expect(created.status).toBe(201)
  const grimoireId: string = created.body.id

  // Open the switcher → settings → Set Root Folder.
  await page.locator('button:has-text("smoke-root")').first().click({ timeout: 10000 })
  await page.locator('[title="Grimoire settings"]').first().click()
  await page.locator('button:has-text("Choose…")').first().click()

  // PUT resolves; UI updates; warning strip clears.
  await expect(page.locator('button:has-text("Change…")')).toBeVisible({ timeout: 10000 })

  // Verify the path persisted on the server.
  const got = await page.evaluate(async (id) => {
    const r = await fetch(`/api/grimoires/${id}`)
    return r.json()
  }, grimoireId)
  expect(got.path).toBe(FIXTURE)

  // Verify the index reindexed and now includes the fixture's docs.
  const index = await page.evaluate(async () => {
    const r = await fetch('/api/index')
    return r.json()
  })
  const docPaths = Object.keys(index.documents || {})
  expect(docPaths).toEqual(expect.arrayContaining(['hello.md', 'world.md']))

  await app.close()
})
