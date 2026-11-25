import { ZodError } from "zod"

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
  "drain-timeout":
    "The gateway is still serving an agent request. Its running configuration was preserved.",
}

const deviceMessages: Record<DeviceFlowError["kind"], string> = {
  expired: "Your device code expired. Start sign-in again.",
  denied:
    "GitHub authorization was denied. Start sign-in again when you are ready.",
  failed: "GitHub could not authorize this device. Try signing in again.",
}

const upstreamSignInMessages: Record<UpstreamError["kind"], string> = {
  unauthorized: "GitHub could not verify this account. Sign in again.",
  network:
    "Could not reach GitHub. Check your connection and try signing in again.",
  unavailable: "GitHub is currently unavailable. Try signing in again.",
  invalid: "GitHub returned an unexpected response. Try signing in again.",
}

function errorPath(error: Error): string {
  return "path" in error && typeof error.path === "string" ? error.path : ""
}

function isSettingsError(error: Error): boolean {
  const path = errorPath(error)
  return /settings/i.test(error.message) || /settings/i.test(path)
}

function isVaultError(error: Error): boolean {
  const path = errorPath(error)
  return (
    /encrypt|decrypt|keychain|vault|credential|safestorage/i.test(error.message)
    || /credentials\.enc/i.test(path)
  )
}

export function gatewayError(error: unknown): string {
  return error instanceof ProxyProcessError ?
      gatewayMessages[error.kind]
    : gatewayMessages.startup
}

export function signInError(error: unknown): string {
  if (error instanceof DeviceFlowError) return deviceMessages[error.kind]
  if (error instanceof ProxyProcessError) return gatewayMessages[error.kind]
  if (error instanceof UpstreamError) return upstreamSignInMessages[error.kind]
  if (error instanceof ZodError) return upstreamSignInMessages.invalid
  if (error instanceof Error) {
    if (error.message.includes("still serving an agent request"))
      return gatewayMessages["drain-timeout"]
    if (isSettingsError(error))
      return "Sign-in succeeded, but local settings could not be saved. Check disk permissions and try again."
    if (isVaultError(error))
      return "Sign-in succeeded, but your credentials could not be saved securely. Check system keychain and disk permissions, then try again."
  }
  return "Sign-in could not be completed locally. Check system permissions and try again."
}
