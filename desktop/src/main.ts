import { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import http from "node:http"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

const DEFAULT_API_BASE = process.env.PAPERCLIP_DESKTOP_API_BASE ?? "http://localhost:3100"
const HEALTH_ENDPOINT = `${DEFAULT_API_BASE}/api/health`
const HEALTH_POLL_INTERVAL_MS = 750
const HEALTH_POLL_TIMEOUT_MS = 120_000

const PROJECT_ROOT = resolveProjectRoot()
const LOG_DIR = path.join(os.homedir(), ".paperclip", "desktop")
const LOG_FILE = path.join(LOG_DIR, "sidecar.log")

const state: {
  tray: Tray | null
  window: BrowserWindow | null
  sidecar: ChildProcess | null
  isQuitting: boolean
  serverReady: boolean
} = {
  tray: null,
  window: null,
  sidecar: null,
  isQuitting: false,
  serverReady: false,
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock?.hide()
  }

  ensureLogDir()
  state.tray = createTray()
  state.sidecar = startSidecar()

  refreshTrayMenu()

  try {
    await waitForServer(HEALTH_ENDPOINT, HEALTH_POLL_TIMEOUT_MS)
    state.serverReady = true
    refreshTrayMenu()
    showWindow()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox(
      "Paperclip failed to start",
      `The Paperclip sidecar did not become healthy at ${HEALTH_ENDPOINT}.\n\n${message}\n\nSee logs at ${LOG_FILE}`,
    )
  }
})

app.on("window-all-closed", () => {
  // Keep the tray-resident app alive on all platforms when windows close.
})

app.on("before-quit", () => {
  state.isQuitting = true
  stopSidecar()
})

function createTray(): Tray {
  const icon = buildTrayIcon()
  const tray = new Tray(icon)
  tray.setToolTip("Paperclip")
  tray.on("click", () => showWindow())
  return tray
}

function refreshTrayMenu(): void {
  if (!state.tray) return
  const status = state.serverReady ? "Running" : "Starting…"
  const menu = Menu.buildFromTemplate([
    { label: `Paperclip — ${status}`, enabled: false },
    { type: "separator" },
    { label: "Show Window", click: () => showWindow() },
    {
      label: "Open in Browser",
      click: () => {
        void shell.openExternal(DEFAULT_API_BASE)
      },
    },
    { type: "separator" },
    {
      label: "Reveal Logs",
      click: () => {
        void shell.openPath(LOG_FILE)
      },
    },
    {
      label: "Restart Sidecar",
      click: () => {
        stopSidecar()
        state.serverReady = false
        refreshTrayMenu()
        state.sidecar = startSidecar()
        void waitForServer(HEALTH_ENDPOINT, HEALTH_POLL_TIMEOUT_MS).then(() => {
          state.serverReady = true
          refreshTrayMenu()
        })
      },
    },
    { type: "separator" },
    {
      label: "Quit Paperclip",
      click: () => {
        state.isQuitting = true
        app.quit()
      },
    },
  ])
  state.tray.setContextMenu(menu)
}

function showWindow(): void {
  if (state.window && !state.window.isDestroyed()) {
    if (state.window.isMinimized()) state.window.restore()
    state.window.show()
    state.window.focus()
    if (process.platform === "darwin") app.dock?.show()
    return
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: "Paperclip",
    backgroundColor: "#0b0d10",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once("ready-to-show", () => {
    win.show()
    if (process.platform === "darwin") app.dock?.show()
  })

  win.on("close", (event) => {
    if (state.isQuitting) return
    event.preventDefault()
    win.hide()
    if (process.platform === "darwin") app.dock?.hide()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  void win.loadURL(state.serverReady ? DEFAULT_API_BASE : buildWaitingPageUrl())
  state.window = win
}

function buildWaitingPageUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Paperclip — starting…</title>
<style>html,body{margin:0;background:#0b0d10;color:#cbd5e1;font:14px -apple-system,BlinkMacSystemFont,sans-serif;height:100%}
.wrap{display:flex;align-items:center;justify-content:center;height:100%}
.card{text-align:center}.spinner{width:28px;height:28px;border:3px solid #334155;border-top-color:#38bdf8;border-radius:50%;animation:s 1s linear infinite;margin:0 auto 16px}
@keyframes s{to{transform:rotate(360deg)}}
.url{color:#64748b;font-family:ui-monospace,Menlo,monospace;margin-top:12px}</style></head>
<body><div class="wrap"><div class="card"><div class="spinner"></div><div>Starting Paperclip…</div><div class="url">${DEFAULT_API_BASE}</div></div></div>
<script>setInterval(()=>{fetch("${HEALTH_ENDPOINT}").then(r=>{if(r.ok)location.replace("${DEFAULT_API_BASE}")}).catch(()=>{})},1000)</script>
</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function startSidecar(): ChildProcess {
  const invocation = resolveSidecarInvocation()
  appendLog(
    `\n[${new Date().toISOString()}] starting sidecar (mode=${invocation.mode}) ${invocation.command} ${invocation.args.join(" ")} (cwd=${invocation.cwd})\n`,
  )
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  })

  child.stdout?.on("data", (chunk: Buffer) => appendLog(chunk.toString()))
  child.stderr?.on("data", (chunk: Buffer) => appendLog(chunk.toString()))
  child.on("exit", (code, signal) => {
    appendLog(`\n[${new Date().toISOString()}] sidecar exited code=${code} signal=${signal}\n`)
    state.sidecar = null
    state.serverReady = false
    refreshTrayMenu()
  })

  return child
}

type SidecarInvocation = {
  mode: "monorepo" | "npx"
  command: string
  args: string[]
  cwd: string
}

function resolveSidecarInvocation(): SidecarInvocation {
  const workspaceMarker = path.join(PROJECT_ROOT, "pnpm-workspace.yaml")
  if (!app.isPackaged && fs.existsSync(workspaceMarker)) {
    return {
      mode: "monorepo",
      command: "pnpm",
      args: ["paperclipai", "run"],
      cwd: PROJECT_ROOT,
    }
  }
  // Packaged app: spawn via the user's login shell so PATH (npx/node) resolves.
  const shell = process.env.SHELL ?? "/bin/zsh"
  return {
    mode: "npx",
    command: shell,
    args: ["-lc", "exec npx -y paperclipai run"],
    cwd: os.homedir(),
  }
}

function stopSidecar(): void {
  const child = state.sidecar
  if (!child || child.killed) return
  try {
    child.kill("SIGTERM")
  } catch {
    /* noop */
  }
  state.sidecar = null
}

function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve()
          return
        }
        retry()
      })
      req.on("error", retry)
      req.setTimeout(2000, () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${url}`))
        return
      }
      setTimeout(tick, HEALTH_POLL_INTERVAL_MS)
    }
    tick()
  })
}

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "")
}

function appendLog(line: string): void {
  try {
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    /* ignore log failures */
  }
}

function resolveProjectRoot(): string {
  const fromEnv = process.env.PAPERCLIP_DESKTOP_PROJECT_ROOT
  if (fromEnv && fs.existsSync(path.join(fromEnv, "pnpm-workspace.yaml"))) return fromEnv
  let dir = path.resolve(__dirname, "..", "..")
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function buildTrayIcon(): Electron.NativeImage {
  const assetPath = path.resolve(__dirname, "..", "assets", "tray-template.png")
  if (fs.existsSync(assetPath)) {
    const img = nativeImage.createFromPath(assetPath)
    if (process.platform === "darwin") img.setTemplateImage(true)
    return img
  }
  const img = drawPaperclipBitmap()
  if (process.platform === "darwin") img.setTemplateImage(true)
  return img
}

function drawPaperclipBitmap(): Electron.NativeImage {
  // 16x16 monochrome paperclip glyph rendered into a BGRA buffer.
  // 1 = opaque black, 0 = transparent. macOS treats this as a template image.
  const glyph = [
    "0000000000000000",
    "0000011111100000",
    "0000110000110000",
    "0001100110011000",
    "0001100110011000",
    "0001100110011000",
    "0001100110011000",
    "0001100110011000",
    "0001100110011000",
    "0001100110011000",
    "0001100110011000",
    "0000110011110000",
    "0000011111000000",
    "0000000110000000",
    "0000000000000000",
    "0000000000000000",
  ]
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const row = glyph[y]!
    for (let x = 0; x < size; x++) {
      const on = row.charCodeAt(x) === 49 /* '1' */
      const offset = (y * size + x) * 4
      // BGRA on macOS
      buf[offset + 0] = 0
      buf[offset + 1] = 0
      buf[offset + 2] = 0
      buf[offset + 3] = on ? 255 : 0
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}
