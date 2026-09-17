import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean
  localApiKeys: Array<string>

  /**
   * Opt in to lossy pre-flight trimming of /responses history. Off by default:
   * the proxy forwards the client's conversation verbatim and lets Copilot
   * enforce its own limits, rather than rewriting history on a local estimate.
   */
  responsesContextTrim: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  localApiKeys: [],
  responsesContextTrim: false,
}
