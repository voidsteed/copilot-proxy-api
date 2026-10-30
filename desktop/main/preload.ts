import { contextBridge, ipcRenderer } from "electron"

import type { DesktopBridge, DesktopCommand } from "../shared/contracts"

import { IPC_CHANNELS, snapshotSchema } from "../shared/contracts"

const bridge: DesktopBridge = {
  async snapshot() {
    const snapshot: unknown = await ipcRenderer.invoke(IPC_CHANNELS.snapshot)
    return snapshotSchema.parse(snapshot)
  },
  async invoke(command: DesktopCommand) {
    const snapshot: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.command,
      command,
    )
    return snapshotSchema.parse(snapshot)
  },
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      const result = snapshotSchema.safeParse(input)
      if (result.success) listener(result.data)
    }
    ipcRenderer.on(IPC_CHANNELS.update, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.update, handler)
    }
  },
}

contextBridge.exposeInMainWorld("copilotBridge", bridge)
