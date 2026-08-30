// MarkForge smoke test — loads the app in headless Chromium and
// captures console errors, page errors, failed requests, and a screenshot.
// Usage: node scripts/markforge-smoke.cjs   (server must be up on MF_URL)
const { chromium } = require('@playwright/test')
const fs = require('fs')

;(async () => {
  const url = process.env.MF_URL || 'http://127.0.0.1:3457'
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] })
  const page = await browser.newPage()
  const logs = []
  page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }))
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: e.message }))
  page.on('requestfailed', (r) =>
    logs.push({ type: 'requestfailed', text: `${r.url()} :: ${r.failure() && r.failure().errorText}` })
  )

  const summary = { url, ok: true, title: null, bodyTextLen: 0, rendered: false, consoleErrors: [], pageErrors: [], requestFailures: [], screenshot: '' }
  try {
    // 'networkidle' never settles on a Next dev server (HMR socket stays open),
    // so wait for 'load' then give the client JS time to render.
    await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  } catch (e) {
    summary.ok = false
    summary.gotoError = String(e)
  }
  await page.waitForTimeout(4000)
  summary.title = await page.title().catch(() => null)
  summary.bodyTextLen = (await page.evaluate(() => document.body.innerText.length).catch(() => 0)) || 0
  summary.rendered = (await page.evaluate(() => document.getElementById('root')?.childElementCount > 0).catch(() => false)) || false
  summary.consoleErrors = logs.filter((l) => l.type === 'error').map((l) => l.text)
  summary.pageErrors = logs.filter((l) => l.type === 'pageerror').map((l) => l.text)
  summary.requestFailures = logs.filter((l) => l.type === 'requestfailed').map((l) => l.text)
  const shot = process.env.MF_SHOT || 'markforge-smoke.png'
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {})
  summary.screenshot = shot

  console.log(JSON.stringify(summary, null, 2))
  fs.writeFileSync('markforge-smoke.result.json', JSON.stringify(summary, null, 2))
  await browser.close()
})().catch((e) => {
  console.error('SMOKE FAILED:', e)
  process.exit(1)
})
