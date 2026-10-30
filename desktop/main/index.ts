import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  session,
  shell,
  Tray,
} from "electron"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { DesktopSnapshot } from "../shared/contracts"
import type { DesktopController } from "./types"

import { IPC_CHANNELS } from "../shared/contracts"
import { isolateFixturePort } from "../testing/settings"
import { startFixtureUpstream } from "../testing/upstream"
import { createController } from "./controller"
import { createCredentialVault } from "./vault"

app.setName("Copilot Bridge")
app.setAppUserModelId("com.voidsteed.copilotbridge")

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const fixtureMode = process.argv.includes("--fixture")
const smokeOutput = argument("--smoke-output")
const dataDirectory = argument("--data-dir")
if (dataDirectory) app.setPath("userData", path.resolve(dataDirectory))

let window: BrowserWindow | null = null
let tray: Tray | null = null
let controller: DesktopController | null = null
let stopFixture: (() => Promise<void>) | undefined
let shuttingDown = false
let allowQuit = false
let exitStatus = 0

function markFailure(): void {
  exitStatus = 1
}

function platform(): DesktopSnapshot["platform"] {
  switch (process.platform) {
    case "darwin": {
      return "darwin"
    }
    case "win32": {
      return "win32"
    }
    case "linux": {
      return "linux"
    }
    default: {
      throw new Error("Copilot Bridge supports macOS, Windows, and Linux.")
    }
  }
}

function showWindow(): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

async function applyLoginItem(enabled: boolean): Promise<void> {
  if (fixtureMode) return
  if (!app.isPackaged)
    throw new Error("Install the app before enabling launch at login.")
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return
  }
  const directory = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "autostart",
  )
  const filename = path.join(directory, "copilot-bridge.desktop")
  if (!enabled) {
    await fs.unlink(filename).catch((error: unknown) => {
      if (
        !(error instanceof Error)
        || !("code" in error)
        || error.code !== "ENOENT"
      )
        throw error
    })
    return
  }
  const executable = (process.env.APPIMAGE || app.getPath("exe")).replaceAll(
    /[\\"`$]/g,
    String.raw`\$&`,
  )
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    filename,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Copilot Bridge",
      `Exec="${executable}"`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  )
}

function updateTray(snapshot: DesktopSnapshot): void {
  if (!tray || tray.isDestroyed()) return
  const running = snapshot.gateway.kind === "running"
  tray.setToolTip(
    `Copilot Bridge: ${running ? "Gateway running" : "Gateway stopped"}`,
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Copilot Bridge", click: showWindow },
      { type: "separator" },
      {
        label: running ? "Stop gateway" : "Start gateway",
        enabled:
          snapshot.account.kind === "signed-in"
          && snapshot.gateway.kind !== "starting"
          && snapshot.gateway.kind !== "stopping",
        click: () => {
          void controller?.invoke({
            kind: running ? "stop-gateway" : "start-gateway",
          })
        },
      },
      { type: "separator" },
      { label: "Quit Copilot Bridge", click: () => app.quit() },
    ]),
  )
}

async function createNativeController(): Promise<DesktopController> {
  const fixture = fixtureMode ? await startFixtureUpstream() : null
  if (fixture) stopFixture = () => fixture.close()
  const storageAvailable =
    !fixtureMode
    && (await safeStorage.isAsyncEncryptionAvailable())
    && (process.platform !== "linux"
      || safeStorage.getSelectedStorageBackend() !== "basic_text")
  const directory = app.getPath("userData")
  const runtimePath =
    app.isPackaged ?
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "dist",
        "engine.cjs",
      )
    : path.join(__dirname, "engine.cjs")
  const companion = await createController({
    dataDirectory: directory,
    runtimePath,
    runtimeExecPath: process.execPath,
    fixtureOrigin: fixture?.origin,
    platform: platform(),
    version: app.getVersion(),
    vault: createCredentialVault({
      directory,
      encryption:
        storageAvailable ?
          {
            encrypt: (value) => safeStorage.encryptStringAsync(value),
            decrypt: (value) => safeStorage.decryptStringAsync(value),
          }
        : null,
    }),
    writeClipboard: (text) => clipboard.writeText(text),
    async openExternal(url) {
      if (url !== "https://github.com/login/device")
        throw new Error("Only GitHub sign-in can be opened.")
      if (!fixtureMode) await shell.openExternal(url)
    },
    applyLoginItem,
  })
  if (fixtureMode) await isolateFixturePort(companion)
  return companion
}

async function start(): Promise<void> {
  await app.whenReady()
  controller = await createNativeController()
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  )
  const rendererFile = path.join(__dirname, "renderer", "index.html")
  const rendererUrl = pathToFileURL(rendererFile).href
  window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    show: false,
    title: "Copilot Bridge",
    backgroundColor: "#f5f7f8",
    ...(process.platform === "darwin" ?
      {
        titleBarStyle: "hiddenInset" as const,
        trafficLightPosition: { x: 17, y: 17 },
      }
    : {}),
    icon: path.join(app.getAppPath(), "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  })
  const appWindow = window
  const companion = controller
  function trusted(event: Electron.IpcMainInvokeEvent): boolean {
    return (
      !appWindow.isDestroyed()
      && event.sender === appWindow.webContents
      && event.senderFrame === appWindow.webContents.mainFrame
      && event.senderFrame.url === rendererUrl
    )
  }
  ipcMain.handle(IPC_CHANNELS.snapshot, (event) => {
    if (!trusted(event)) throw new Error("Untrusted application frame.")
    return companion.snapshot()
  })
  ipcMain.handle(IPC_CHANNELS.command, (event, command: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted application frame.")
    return companion.invoke(command)
  })
  const unsubscribe = companion.subscribe((snapshot) => {
    if (!appWindow.isDestroyed() && !appWindow.webContents.isDestroyed()) {
      appWindow.webContents.send(IPC_CHANNELS.update, snapshot)
    }
    updateTray(snapshot)
  })
  appWindow.once("closed", unsubscribe)
  appWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  appWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault()
  })
  appWindow.on("close", (event) => {
    if (
      !shuttingDown
      && companion.snapshot().settings.closeToTray
      && tray
      && !tray.isDestroyed()
    ) {
      event.preventDefault()
      appWindow.hide()
    }
  })
  try {
    const trayIcon = nativeImage
      .createFromPath(
        path.join(
          app.getAppPath(),
          "assets",
          process.platform === "darwin" ? "trayTemplate.png" : "icon.png",
        ),
      )
      .resize({ width: 20, height: 20 })
    if (!trayIcon.isEmpty()) {
      if (process.platform === "darwin") trayIcon.setTemplateImage(true)
      tray = new Tray(trayIcon)
      tray.on("click", showWindow)
      updateTray(companion.snapshot())
    }
  } catch {
    tray = null
  }
  await appWindow.loadFile(rendererFile)
  appWindow.show()
  app.on("activate", showWindow)

  await smokeIfRequested(appWindow, companion)
}

async function smokeIfRequested(
  appWindow: BrowserWindow,
  companion: DesktopController,
): Promise<void> {
  if (fixtureMode && smokeOutput) {
    const { runNativeSmoke } = await import("./smoke")
    try {
      await runNativeSmoke({
        window: appWindow,
        controller: companion,
        outputDirectory: path.resolve(smokeOutput),
      })
    } catch (error) {
      await fs.mkdir(smokeOutput, { recursive: true })
      await fs.writeFile(
        path.join(smokeOutput, "failure.txt"),
        error instanceof Error ? error.message : "Native smoke failed",
      )
      markFailure()
    }
    app.quit()
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", showWindow)
  app.on("window-all-closed", () => {
    if (!tray || !controller?.snapshot().settings.closeToTray) app.quit()
  })
  app.on("before-quit", (event) => {
    if (allowQuit) return
    event.preventDefault()
    if (shuttingDown) return
    shuttingDown = true
    void (async () => {
      await controller?.dispose()
      await stopFixture?.()
    })()
      .catch(() => {
        markFailure()
      })
      .finally(() => {
        tray?.destroy()
        allowQuit = true
        app.exit(exitStatus)
      })
  })
  void start().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "The app could not start."
    if (!smokeOutput) dialog.showErrorBox("Copilot Bridge", message)
    markFailure()
    app.quit()
  })
}
