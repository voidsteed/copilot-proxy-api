import type {
  AgentConfigView,
  NativeConnection,
} from "../../src/lib/proxy-contracts"
import type { DesktopCommand, DesktopModel } from "../shared/contracts"

import { createConnectionSnippet, supportsAgent } from "../shared/connections"

type ClipboardCommand = Extract<
  DesktopCommand,
  { kind: "copy" | "copy-config" }
>
type ClipboardResult =
  | { kind: "text"; text: string }
  | { kind: "error"; message: string }
type ClipboardOptions = {
  command: ClipboardCommand
  connection: NativeConnection | null
  agentConfigs: Array<AgentConfigView>
  deviceCode: string | null
  models: Array<DesktopModel>
}

function configurationClipboard(
  options: ClipboardOptions & {
    command: Extract<ClipboardCommand, { kind: "copy-config" }>
  },
): ClipboardResult {
  const { command, connection } = options
  if (!connection)
    return {
      kind: "error",
      message: "Start the proxy before copying an agent configuration.",
    }
  const agentConfig =
    command.target === "curl" ?
      undefined
    : options.agentConfigs.find((view) => view.target === command.target)
  const configuredModel =
    agentConfig?.model.kind === "configured" ? agentConfig.model : null
  const model = options.models.find(
    (item) => item.id === (configuredModel?.catalogId ?? command.modelId),
  )
  const metadata: DesktopModel | undefined =
    model
    ?? (configuredModel ?
      {
        id: configuredModel.exact,
        name: "",
        vendor: "",
        contextWindow: null,
        maxOutput: null,
        supports: [],
        endpoints: [],
        preview: false,
      }
    : undefined)
  if (!metadata)
    return {
      kind: "error",
      message: "This model is no longer available. Refresh the model catalog.",
    }
  if (
    agentConfig?.status !== "configured"
    && !supportsAgent(metadata, command.target)
  )
    return {
      kind: "error",
      message:
        "This model does not support this agent's API. Choose another model.",
    }
  try {
    return {
      kind: "text",
      text: createConnectionSnippet({
        target: command.target,
        connection,
        model: metadata,
        modelId: configuredModel?.exact,
        agentConfig,
        shell: command.shell,
      }),
    }
  } catch {
    return {
      kind: "error",
      message: "Review this agent's existing configuration before connecting.",
    }
  }
}

export function createClipboardText(
  options: ClipboardOptions,
): ClipboardResult {
  const { command, connection, deviceCode } = options
  if (command.kind === "copy-config")
    return configurationClipboard({ ...options, command })
  switch (command.target) {
    case "base-url": {
      return connection ?
          { kind: "text", text: connection.apiUrl }
        : {
            kind: "error",
            message: "Start the proxy before copying its API URL.",
          }
    }
    case "gateway-key": {
      return connection?.authentication.kind === "keyed" ?
          { kind: "text", text: connection.authentication.key }
        : {
            kind: "error",
            message:
              connection ?
                "This proxy does not require a local API key."
              : "Start the proxy before copying its gateway key.",
          }
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
      const exhaustive: never = command
      return exhaustive
    }
  }
}
