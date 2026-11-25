import { contextBridge, ipcRenderer } from "electron"

import type { DesktopBridge, DesktopCommand } from "../shared/contracts"

import { IPC_CHANNELS } from "../shared/contracts"

const bridge: DesktopBridge = {
  snapshot() {
    return ipcRenderer.invoke(IPC_CHANNELS.snapshot)
  },
  invoke(command: DesktopCommand) {
    return ipcRenderer.invoke(IPC_CHANNELS.command, command)
  },
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      listener(input)
    }
    ipcRenderer.on(IPC_CHANNELS.update, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.update, handler)
    }
  },
}

contextBridge.exposeInMainWorld("copilotProxy", bridge)
