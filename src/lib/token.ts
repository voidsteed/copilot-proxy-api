import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"
import { sleep } from "./utils"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

interface TokenRetryOptions {
  attempts?: number
  backoff?: "linear" | "exponential"
}

let copilotTokenRefresh:
  | { promise: Promise<string>; options: Required<TokenRetryOptions> }
  | undefined

export function getCopilotTokenWithRetry(
  attempts = 3,
  retryDelayMs = 1000,
  backoff: TokenRetryOptions["backoff"] = "linear",
) {
  return getCopilotTokenWithRetryPolicy({ attempts, backoff }, retryDelayMs)
}

async function getCopilotTokenWithRetryPolicy(
  options: Required<TokenRetryOptions>,
  retryDelayMs: number,
) {
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await getCopilotToken()
    } catch (error) {
      if (attempt === options.attempts || !isTransientTokenError(error))
        throw error

      consola.warn(
        `Failed to get Copilot token; retrying (${attempt}/${options.attempts})`,
      )
      const multiplier =
        options.backoff === "exponential" ? 2 ** (attempt - 1) : attempt
      await sleep(retryDelayMs * multiplier)
    }
  }

  throw new Error("Failed to get Copilot token")
}

export function isTransientTokenError(error: unknown): boolean {
  if (!(error instanceof HTTPError)) return true

  return (
    error.response.status === 408
    || error.response.status === 429
    || error.response.status >= 500
  )
}

export function refreshCopilotToken(
  staleToken?: string,
  options: TokenRetryOptions = {},
): Promise<string> {
  if (staleToken && state.copilotToken && state.copilotToken !== staleToken) {
    return Promise.resolve(state.copilotToken)
  }

  if (copilotTokenRefresh) {
    // A scheduled renewal can extend the shared loop without resetting attempts.
    copilotTokenRefresh.options.attempts = Math.max(
      copilotTokenRefresh.options.attempts,
      options.attempts ?? 3,
    )
    if (options.backoff === "exponential") {
      copilotTokenRefresh.options.backoff = "exponential"
    }
    return copilotTokenRefresh.promise
  }

  const retryOptions: Required<TokenRetryOptions> = {
    attempts: options.attempts ?? 3,
    backoff: options.backoff ?? "linear",
  }
  const promise = getCopilotTokenWithRetryPolicy(retryOptions, 1000)
    .then(({ token }) => {
      state.copilotToken = token
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }
      return token
    })
    .finally(() => {
      copilotTokenRefresh = undefined
    })

  copilotTokenRefresh = { promise, options: retryOptions }
  return promise
}

export const setupCopilotToken = async () => {
  const { token, refresh_in } = await getCopilotTokenWithRetry()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  const refreshInterval = (refresh_in - 60) * 1000

  setInterval(() => {
    consola.debug("Refreshing Copilot token")
    void refreshCopilotToken(undefined, {
      attempts: 5,
      backoff: "exponential",
    }).catch((error: unknown) => {
      consola.error(
        "Token refresh failed, but keeping server alive with the old token.",
        error,
      )
    })
  }, refreshInterval)
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

export async function logUser() {
  try {
    const user = await getGitHubUser()
    consola.info(`Logged in as ${user.login}`)
  } catch (error) {
    consola.warn(
      "Failed to get GitHub user; continuing with the saved token",
      error,
    )
  }
}
