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
import originalFs from "original-fs"

import type { NativePackageFileSystem } from "../../src/lib/proxy-session"
import type { DesktopSnapshot } from "../shared/contracts"
import type { DesktopController } from "./types"

import {
  hostProxySession,
  nativeControlCapability,
  nativePackageFingerprint,
  proxyStateDirectory,
} from "../../src/lib/proxy-session"
import { IPC_CHANNELS } from "../shared/contracts"
import { isolateFixturePort } from "../testing/settings"
import { startFixtureUpstream } from "../testing/upstream"
import { createController } from "./controller"
import { selectDataDirectory } from "./profile"
import { createCredentialVault } from "./vault"

const packageFileSystem = originalFs.promises satisfies NativePackageFileSystem

app.setName("Copilot Proxy")
app.setAppUserModelId("com.voidsteed.copilotproxy")

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const fixtureMode = process.argv.includes("--fixture")
const backgroundMode = process.argv.includes("--background")
const smokeOutput = argument("--smoke-output")
const vaultSmokeOutput = argument("--vault-smoke-output")
const dataDirectory = selectDataDirectory({
  fixture: fixtureMode,
  explicit: argument("--data-dir") || process.env.COPILOT_PROXY_DATA_DIR,
})
if (dataDirectory) app.setPath("userData", path.resolve(dataDirectory))
const nativeStateDirectory =
  argument("--state-dir")
  || process.env.COPILOT_PROXY_STATE_DIR
  || (fixtureMode ?
    path.join(app.getPath("userData"), "native")
  : proxyStateDirectory(os.homedir()))

let window: BrowserWindow | null = null
let tray: Tray | null = null
let controller: DesktopController | null = null
let stopFixture: (() => Promise<void>) | undefined
let stopControl: (() => Promise<void>) | undefined
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
      throw new Error("Copilot Proxy supports macOS, Windows, and Linux.")
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
  const filename = path.join(directory, "copilot-proxy.desktop")
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
      "Name=Copilot Proxy",
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
    `Copilot Proxy: ${running ? "Gateway running" : "Gateway stopped"}`,
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Copilot Proxy", click: showWindow },
      { type: "separator" },
      {
        label: running ? "Stop gateway" : "Start gateway",
        enabled:
          snapshot.account.kind === "signed-in"
          && snapshot.source.kind !== "legacy-cli"
          && snapshot.gateway.kind !== "starting"
          && snapshot.gateway.kind !== "stopping"
          && snapshot.gateway.kind !== "draining",
        click: () => {
          void controller?.invoke({
            kind: running ? "stop-gateway" : "start-gateway",
          })
        },
      },
      { type: "separator" },
      { label: "Quit Copilot Proxy", click: () => app.quit() },
    ]),
  )
}

type VaultEncryption = NonNullable<
  Parameters<typeof createCredentialVault>[0]["encryption"]
>

function nativeEncryptionPolicy(): VaultEncryption | null {
  if (
    fixtureMode
    || (process.platform === "linux"
      && safeStorage.getSelectedStorageBackend() === "basic_text")
  )
    return null

  async function requireDurableEncryption(): Promise<void> {
    if (
      !(await safeStorage.isAsyncEncryptionAvailable())
      || (process.platform === "linux"
        && safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new Error("Secure credential storage is unavailable.")
  }

  return {
    async encrypt(value) {
      await requireDurableEncryption()
      return safeStorage.encryptStringAsync(value)
    },
    async decrypt(value) {
      await requireDurableEncryption()
      return safeStorage.decryptStringAsync(value)
    },
  }
}

async function createNativeController(): Promise<DesktopController> {
  const fixture = fixtureMode ? await startFixtureUpstream() : null
  if (fixture) stopFixture = () => fixture.close()
  const directory = app.getPath("userData")
  const homeDirectory = fixtureMode ? directory : os.homedir()
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
    homeDirectory: fixtureMode ? undefined : homeDirectory,
    stateDirectory: nativeStateDirectory,
    runtimePath,
    runtimeExecPath: process.execPath,
    fixtureOrigin: fixture?.origin,
    platform: platform(),
    version: app.getVersion(),
    vault: createCredentialVault({
      directory,
      encryption: nativeEncryptionPolicy(),
    }),
    writeClipboard: (text) => clipboard.writeText(text),
    async openExternal(url) {
      if (url !== "https://github.com/login/device")
        throw new Error("Only GitHub sign-in can be opened.")
      if (!fixtureMode) await shell.openExternal(url)
    },
    async openFolder(folder) {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 })
      if (fixtureMode) return
      const error = await shell.openPath(folder)
      if (error) throw new Error("The configuration folder could not open.")
    },
    showUi: showWindow,
    applyLoginItem,
  })
  if (fixtureMode) await isolateFixturePort(companion)
  const executablePath = app.getPath("exe")
  const controlCapability = nativeControlCapability()
  stopControl = await hostProxySession(
    {
      stateDirectory: nativeStateDirectory,
      authority: companion.sessionApi(),
      installation:
        (
          app.isPackaged
          && !fixtureMode
          && controlCapability.kind === "supported"
        ) ?
          {
            executablePath,
            packageFingerprint: await nativePackageFingerprint(
              executablePath,
              packageFileSystem,
            ),
          }
        : undefined,
      showUi: showWindow,
    },
    { packageFileSystem },
  )
  return companion
}

async function verifyVaultIfRequested(): Promise<boolean> {
  if (!vaultSmokeOutput) return false
  if (fixtureMode || !dataDirectory)
    throw new Error(
      "Native vault verification requires an explicit isolated data directory.",
    )
  const { runNativeVaultSmoke } = await import("./smoke-vault")
  await runNativeVaultSmoke({
    dataDirectory: app.getPath("userData"),
    outputDirectory: path.resolve(vaultSmokeOutput),
  })
  app.quit()
  return true
}

async function start(): Promise<void> {
  await app.whenReady()
  if (await verifyVaultIfRequested()) return
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
    title: "Copilot Proxy",
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
  if (!backgroundMode) appWindow.show()
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
        homeDirectory: app.getPath("userData"),
        stateDirectory: nativeStateDirectory,
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
  app.on("second-instance", (_event, argv) => {
    if (!argv.includes("--background")) showWindow()
  })
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
      await stopControl?.()
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
    if (!smokeOutput && !vaultSmokeOutput)
      dialog.showErrorBox("Copilot Proxy", message)
    markFailure()
    app.quit()
  })
}
