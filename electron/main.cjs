'use strict'

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const PORT = 3457
const BASE = `http://127.0.0.1:${PORT}`
app.setName('MarkForge')
// Data lives outside the repo so imports never dirty git status. The name is
// pinned before getPath('userData') because an unpackaged Electron falls back
// to the package name ("my-project") - a rename would orphan the corpus.
const DATA_ROOT = app.getPath('userData')
const NOTES_DIR = path.join(DATA_ROOT, 'notes')
const META_DIR = path.join(DATA_ROOT, 'meta')
const ASSET_PREFIX = 'assets'

let server = null
let win = null

function waitUntilReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http
        .get(url, (res) => {
          res.resume()
          // Any HTTP answer means the server is up; the app handles its own
          // login gate and redirects.
          resolve(res.statusCode)
        })
        .on('error', () => {
          if (Date.now() > deadline) reject(new Error(`Server did not start within ${timeoutMs}ms`))
          else setTimeout(attempt, 400)
        })
    }
    attempt()
  })
}

function startServer() {
  // ── Packaged (portable exe) ──────────────────────────────────────────────
  // Runs the Next standalone server with Electron's own embedded Node
  // (ELECTRON_RUN_AS_NODE): no system Node, no pnpm, no terminal. The server
  // folder ships in resources/server, assembled by scripts/prepare-electron.mjs.
  if (app.isPackaged) {
    const serverDir = path.join(process.resourcesPath, 'server')
    process.env.MARKFORG_SYNC = '0' // tsx-based cloud push needs the repo; hidden in packaged builds
    server = spawn(process.execPath, [path.join(serverDir, 'server.js')], {
      cwd: serverDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        PORT: String(PORT),
        NOTES_DIR: NOTES_DIR,
        META_DIR: META_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } else {
    // ── Development (repo checkout) ────────────────────────────────────────
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    // The repo's .env carries R2 credentials for the deployed web app, and Next
    // loads it automatically - which would silently turn this local instance into
    // a cloud-backed one, every save round-tripping to another hemisphere. Next
    // only fills variables that are NOT already present, so pre-setting empties
    // pins them off; the backend treats '' as unset.
    const localOnly = {
      R2_ACCOUNT_ID: '',
      R2_ACCESS_KEY_ID: '',
      R2_SECRET_ACCESS_KEY: '',
      R2_BUCKET: '',
    }
    server = spawn(npx, ['next', 'start', '-p', String(PORT)], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...localOnly, NOTES_DIR: NOTES_DIR, META_DIR: META_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Windows refuses to spawn .cmd shims without a shell since Node 20.12.
      shell: process.platform === 'win32',
    })
  }
  server.stdout.on('data', (d) => process.stdout.write(`[next] ${d}`))
  server.stderr.on('data', (d) => process.stderr.write(`[next] ${d}`))
  server.on('exit', (code) => console.log(`[next] exited with ${code}`))
  return server
}

function copyFileToWorkspace(srcPath, relativeName) {
  const dest = path.join(NOTES_DIR, relativeName)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(srcPath, dest)
}

function walkMarkdown(dir, baseDir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkMarkdown(full, baseDir, out)
    else out.push({ src: full, rel: path.relative(baseDir, full).split(path.sep).join('/') })
  }
  return out
}

ipcMain.handle('markforge:choose-files', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import files',
    properties: ['openFile', 'multiSelections'],
  })
  if (res.canceled) return { copied: 0 }
  let copied = 0
  for (const file of res.filePaths) {
    const name = path.basename(file)
    const rel = name.endsWith('.md') ? name : `${ASSET_PREFIX}/${Date.now()}-${name}`
    copyFileToWorkspace(file, rel)
    copied++
  }
  return { copied }
})

ipcMain.handle('markforge:choose-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import folder',
    properties: ['openDirectory'],
  })
  if (res.canceled) return { copied: 0 }
  const files = walkMarkdown(res.filePaths[0], res.filePaths[0], [])
  let copied = 0
  for (const f of files) {
    copyFileToWorkspace(f.src, f.rel)
    copied++
  }
  return { copied }
})

/** Reads the repo .env - the one place cloud credentials legitimately live.
 *  Packaged builds look next to the exe resources instead (copied at build time). */
function readRepoEnv() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, '.env')]
    : [path.join(__dirname, '..', '.env')]
  const out = {}
  for (const envPath of candidates) {
    try {
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const [key, ...rest] = line.split('=')
        if (key && rest.length) out[key.trim()] = rest.join('=').trim()
      }
      break
    } catch {
      // Try the next candidate; caller reports cloud as unconfigured if none work.
    }
  }
  return out
}

/**
 * Push the local corpus to R2 on demand. Runs scripts/push-to-cloud.ts in a
 * child with cloud credentials injected; the workspace server itself never
 * sees them, so browsing/editing stays purely local.
 */
ipcMain.handle('markforge:sync-to-cloud', async () => {
  const env = readRepoEnv()
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) {
    return { ok: false, error: 'Cloud not configured - R2_* missing from .env' }
  }
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  return new Promise((resolve) => {
    const child = spawn(
      npx,
      ['tsx', 'scripts/push-to-cloud.ts', '--dir', NOTES_DIR],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      }
    )
    let out = ''
    let errOut = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (errOut += d))
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `sync failed (${code}): ${errOut.trim().slice(-200)}` })
        return
      }
      try {
        const line = out.trim().split(/\r?\n/).pop()
        resolve({ ok: true, ...JSON.parse(line) })
      } catch {
        resolve({ ok: false, error: 'unexpected sync output' })
      }
    })
  })
})

async function main() {
  await app.whenReady()
  fs.mkdirSync(NOTES_DIR, { recursive: true })
  fs.mkdirSync(META_DIR, { recursive: true })

  startServer()
  try {
    await waitUntilReady(BASE, 60000)
  } catch (err) {
    // Silent by design: popups mid-game are worse than a dead window. The
    // failure is fully visible in the log file instead.
    console.error('[markforge] server did not become ready:', err)
    app.quit()
    return
  }

  win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'MarkForge',
    // Unpackaged Electron shows its own logo unless told otherwise; PNG is
    // enough for the window and taskbar at runtime.
    icon: path.join(__dirname, '..', 'public', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadURL(BASE)
  // Surface renderer-side errors in our log - a silent console is how the
  // slash-menu bug stayed invisible for an entire session.
  win.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    if (sourceId.startsWith('devtools://')) return
    process.stdout.write(`[renderer] ${message} (${path.basename(String(sourceId))}:${line})\n`)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

main().catch((err) => {
  console.error(err)
  app.quit()
})

process.on('exit', () => {
  if (!server || server.killed) return
  if (process.platform === 'win32') {
    // shell:true means server.pid is the cmd shim; /T takes the whole tree with it.
    spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true })
  } else {
    server.kill()
  }
})
