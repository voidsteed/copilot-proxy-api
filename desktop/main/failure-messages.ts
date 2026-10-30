import { UpstreamError } from "../engine/upstream"
import { DeviceFlowError } from "./oauth"
import { ProxyProcessError } from "./proxy-process"

const gatewayMessages: Record<ProxyProcessError["kind"], string> = {
  "address-in-use":
    "This port is already in use. Choose another port in Settings.",
  authentication: "Copilot could not verify this account. Sign in again.",
  upstream: "Copilot is unavailable. Check your connection and try again.",
  startup: "The gateway could not start. Try again.",
  stopped: "The gateway stopped.",
}

const deviceMessages: Record<DeviceFlowError["kind"], string> = {
  expired: "Your device code expired. Start sign-in again.",
  denied:
    "GitHub authorization was denied. Start sign-in again when you are ready.",
  failed: "GitHub could not authorize this device. Try signing in again.",
}

export function gatewayError(error: unknown): string {
  return error instanceof ProxyProcessError ?
      gatewayMessages[error.kind]
    : gatewayMessages.startup
}

export function signInError(error: unknown): string {
  if (error instanceof DeviceFlowError) return deviceMessages[error.kind]
  return error instanceof UpstreamError && error.kind === "unauthorized" ?
      "GitHub could not verify this account. Sign in again."
    : "Could not reach GitHub. Check your connection and try signing in again."
}
