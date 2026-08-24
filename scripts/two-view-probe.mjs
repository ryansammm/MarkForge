import { chromium } from '@playwright/test'
import fs from 'node:fs'

const pass = fs
  .readFileSync('.env', 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('APP_PASSWORD='))
  ?.split('=')
  .slice(1)
  .join('=')

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('http://127.0.0.1:3457', { waitUntil: 'networkidle' })
const pw = page.locator('input[type="password"]')
if (await pw.count()) {
  await pw.fill(pass)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
}
const rows = page.locator('[data-tree-row]')
if (await rows.count()) {
  await rows.first().click()
  await page.waitForTimeout(1000)
}
await page.keyboard.press('Control+e')
await page.waitForTimeout(600)

const info = await page.evaluate(() => {
  const editors = [...document.querySelectorAll('.cm-editor')]
  return editors.map((el, i) => {
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const parentChain = []
    let p = el
    while (p && p !== document.body) {
      const ps = getComputedStyle(p)
      if (ps.display === 'none' || ps.visibility === 'hidden' || ps.overflow === 'hidden')
        parentChain.push(p.tagName + '.' + String(p.className).split(' ').slice(0, 2).join('.') + ':' + ps.display + '/' + ps.visibility + '/' + ps.overflow)
      p = p.parentElement
    }
    return {
      i,
      rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      display: style.display,
      contentLen: el.querySelector('.cm-content')?.textContent?.length ?? -1,
      hiddenAncestors: parentChain.slice(0, 3),
    }
  })
})
console.log(JSON.stringify(info, null, 1))

// Type into whichever cm-content is actually visible, then re-check both views for tooltips
const vis = page.locator('.cm-content:visible').first()
await vis.click()
await page.keyboard.press('Control+Home')
await page.keyboard.type('/')
await page.waitForTimeout(600)
const after = await page.evaluate(() => ({
  tooltipsInDoc: document.querySelectorAll('.cm-tooltip').length,
  tooltipsInsideEditors: [...document.querySelectorAll('.cm-editor')].map((e) => e.querySelectorAll('.cm-tooltip').length),
}))
console.log('after typing /:', JSON.stringify(after))
await browser.close()
