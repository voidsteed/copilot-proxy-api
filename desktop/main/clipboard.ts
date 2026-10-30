import type { DesktopCommand, DesktopModel } from "../shared/contracts"

import { createConnectionSnippet, supportsAgent } from "../shared/connections"

type ClipboardCommand = Extract<
  DesktopCommand,
  { kind: "copy" | "copy-config" }
>
type ClipboardResult =
  | { kind: "text"; text: string }
  | { kind: "error"; message: string }

export function createClipboardText(options: {
  command: ClipboardCommand
  port: number
  gatewayKey: string | null
  deviceCode: string | null
  models: Array<DesktopModel>
}): ClipboardResult {
  const { command, gatewayKey, deviceCode } = options
  if (command.kind === "copy") {
    const target = command.target
    switch (target) {
      case "base-url": {
        return { kind: "text", text: `http://127.0.0.1:${options.port}/v1` }
      }
      case "gateway-key": {
        return gatewayKey ?
            { kind: "text", text: gatewayKey }
          : { kind: "error", message: "Sign in before copying a gateway key." }
      }
      case "device-code": {
        return deviceCode ?
            { kind: "text", text: deviceCode }
          : {
              kind: "error",
              message: "A device code is available only during sign-in.",
            }
      }
      default: {
        const exhaustive: never = target
        return exhaustive
      }
    }
  }
  const model = options.models.find((item) => item.id === command.modelId)
  if (!gatewayKey)
    return {
      kind: "error",
      message: "Sign in before copying an agent configuration.",
    }
  if (!model)
    return {
      kind: "error",
      message: "This model is no longer available. Refresh the model catalog.",
    }
  if (!supportsAgent(model, command.target))
    return {
      kind: "error",
      message:
        "This model does not support this agent's API. Choose another model.",
    }
  return {
    kind: "text",
    text: createConnectionSnippet({
      target: command.target,
      model,
      port: options.port,
      apiKey: gatewayKey,
      shell: command.shell,
    }),
  }
}
