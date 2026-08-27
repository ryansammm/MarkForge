'use strict'

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
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
const DEFAULT_NOTES_DIR = path.join(DATA_ROOT, 'notes')
const DEFAULT_META_DIR = path.join(DATA_ROOT, 'meta')
// The grimoire root folder the user chose. Persisted so the app reopens the same
// folder every launch — no re-import, no re-adding files. Edited in place on disk.
const ROOT_CONFIG_PATH = path.join(DATA_ROOT, 'grimoire-root.json')
let NOTES_DIR = DEFAULT_NOTES_DIR
let META_DIR = DEFAULT_META_DIR
const ASSET_PREFIX = 'assets'

// ── Grimoire root selection (full offline, local only) ──────────────────────
function loadRoot() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf-8'))
    if (cfg && typeof cfg.notesDir === 'string') return cfg
  } catch {
    // No saved root yet — first run.
  }
  return null
}

function saveRoot(notesDir) {
  fs.mkdirSync(path.dirname(ROOT_CONFIG_PATH), { recursive: true })
  fs.writeFileSync(ROOT_CONFIG_PATH, JSON.stringify({ notesDir, metaDir: META_DIR }), 'utf-8')
}

function pickRootDir() {
  const res = dialog.showOpenDialogSync(null, {
    title: 'Pilih folder grimoire MarkForge',
    message: 'Pilih folder yang berisi (atau akan berisi) catatan .md kamu',
    properties: ['openDirectory'],
  })
  return res && res.length ? res[0] : null
}

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

function startServer(notesDir) {
  NOTES_DIR = notesDir || NOTES_DIR
  // Full offline: never talk to R2, no matter what the environment says. The
  // web-deploy .env may carry R2 credentials, and Next would pick them up.
  const offline = {
    MARKFORGE_OFFLINE: '1',
    R2_ACCOUNT_ID: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_BUCKET: '',
  }
  // ── Packaged (portable exe) ──────────────────────────────────────────────
  // Runs the Next standalone server with Electron's own embedded Node
  // (ELECTRON_RUN_AS_NODE): no system Node, no pnpm, no terminal. The server
  // folder ships in resources/server, assembled by scripts/prepare-electron.mjs.
  if (app.isPackaged) {
    const serverDir = path.join(process.resourcesPath, 'server')
    server = spawn(process.execPath, [path.join(serverDir, 'server.js')], {
      cwd: serverDir,
      env: {
        ...process.env,
        ...offline,
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
    server = spawn(npx, ['next', 'dev', '-p', String(PORT)], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...offline, NOTES_DIR: NOTES_DIR, META_DIR: META_DIR },
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

/** Kill the running server and start a fresh one pointed at a new grimoire root. */
function restartServer(notesDir) {
  if (server) {
    try {
      server.kill()
    } catch {
      // already gone
    }
    server = null
  }
  startServer(notesDir)
}

/** Pick a folder, persist it as the grimoire root, and reload the app against it. */
function openGrimoire() {
  const dir = pickRootDir()
  if (!dir) return
  saveRoot(dir)
  restartServer(dir)
  if (win) win.reload()
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

/** Pick a local folder, persist it as the grimoire root, and reload. */
ipcMain.handle('markforge:open-grimoire', () => {
  openGrimoire()
  return Promise.resolve({ ok: true })
})

async function main() {
  await app.whenReady()

  // Restore or choose the grimoire root folder. Editing happens in place on disk,
  // and the choice is remembered so the app reopens the same folder every launch.
  let root = loadRoot()
  if (!root || !fs.existsSync(root.notesDir)) {
    const dir = pickRootDir()
    if (!dir) {
      app.quit()
      return
    }
    saveRoot(dir)
    root = { notesDir: dir, metaDir: META_DIR }
  }
  NOTES_DIR = root.notesDir
  META_DIR = root.metaDir || DEFAULT_META_DIR
  fs.mkdirSync(NOTES_DIR, { recursive: true })
  fs.mkdirSync(META_DIR, { recursive: true })

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Buka folder grimoire…', click: () => openGrimoire() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ])
  Menu.setApplicationMenu(menu)

  startServer(NOTES_DIR)
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
