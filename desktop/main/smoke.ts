import type { BrowserWindow } from "electron"

import { clipboard } from "electron"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { z } from "zod"

import type { DesktopController } from "./types"

import { fixturePdf } from "../testing/pdf"
import { availablePort } from "../testing/settings"
import {
  seedNativeAgentFiles,
  verifyNativeAgentFile,
} from "../testing/smoke-fixtures"
import { verifyNativeLegacy } from "./smoke-legacy"
import { verifyNativeSharing } from "./smoke-shared"

export async function runNativeSmoke(options: {
  window: BrowserWindow
  controller: DesktopController
  outputDirectory: string
  homeDirectory: string
  stateDirectory: string
}): Promise<void> {
  const { window, controller, outputDirectory } = options
  await fs.mkdir(outputDirectory, { recursive: true })
  const checks: Array<string> = []
  const startedAt = new Date().toISOString()
  const originalClipboard = await clipboard.readText()
  const legacyMode = process.argv.includes("--legacy-native-smoke")

  async function writeReport(): Promise<void> {
    await fs.writeFile(
      path.join(outputDirectory, "smoke.json"),
      JSON.stringify(
        {
          passed: true,
          mode: legacyMode ? "legacy-fixture" : "fixture",
          platform: process.platform,
          electron: process.versions.electron,
          node: process.versions.node,
          startedAt,
          completedAt: new Date().toISOString(),
          checks,
          limitations: [
            "Controlled upstream services; no live Copilot inference or GitHub consent",
            "Session-only fixture vault; OS credential encryption requires a live user session",
            "The fixture folder callback creates its selected directory; OS folder opening is verified separately",
            ...(process.platform === "darwin" ?
              []
            : [
                "Private native-control workflows require Mac execution; they were not verified on this platform",
              ]),
            ...(process.platform === "win32" ?
              [
                "Symlink preservation and POSIX copied-command execution require a supported native environment",
              ]
            : []),
          ],
        },
        null,
        2,
      ) + "\n",
    )
  }

  async function waitFor(
    name: string,
    predicate: () => boolean | Promise<boolean>,
    timeout = 30_000,
  ): Promise<void> {
    const expires = Date.now() + timeout
    while (Date.now() < expires) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Native smoke timed out: ${name}`)
  }

  async function javascript(expression: string): Promise<boolean> {
    const result: unknown = await window.webContents.executeJavaScript(
      expression,
      true,
    )
    return z.boolean().parse(result)
  }

  async function click(selector: string): Promise<void> {
    await waitFor(`control ${selector}`, () =>
      javascript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement) || element.hasAttribute('disabled') || !element.getClientRects().length) return false;
      element.click(); return true;
    })()`),
    )
  }

  async function input(selector: string, value: string): Promise<void> {
    const applied = await javascript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return false;
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    assert(applied, `Input ${selector} exists`)
  }

  async function capture(name: string): Promise<void> {
    try {
      assert(window.isVisible(), `Native window is visible for ${name}`)
      let painted = false
      window.webContents.beginFrameSubscription((image) => {
        if (!image.isEmpty()) painted = true
      })
      try {
        window.webContents.invalidate()
        await waitFor(`painted frame for ${name}`, () => painted, 10_000)
      } finally {
        window.webContents.endFrameSubscription()
      }
      const image = await window.webContents.capturePage()
      assert(!image.isEmpty(), `Native screenshot ${name} is not empty`)
      const png = image.toPNG()
      assert(png.length > 0, `Native screenshot ${name} has PNG data`)
      await fs.writeFile(path.join(outputDirectory, `${name}.png`), png)
    } catch (error) {
      const destroyed = window.isDestroyed()
      const contents = destroyed ? undefined : window.webContents
      await fs.writeFile(
        path.join(outputDirectory, `${name}-capture-failure.json`),
        JSON.stringify(
          {
            capture: name,
            platform: process.platform,
            electron: process.versions.electron,
            chromium: process.versions.chrome,
            error:
              error instanceof Error ?
                { name: error.name, message: error.message }
              : { name: "UnknownError" },
            window:
              destroyed ?
                { destroyed: true }
              : {
                  destroyed: false,
                  bounds: window.getBounds(),
                  contentBounds: window.getContentBounds(),
                  visible: window.isVisible(),
                  minimized: window.isMinimized(),
                },
            renderer:
              !contents || contents.isDestroyed() ?
                { destroyed: true }
              : { destroyed: false, loading: contents.isLoading() },
          },
          null,
          2,
        ) + "\n",
      )
      throw error
    }
  }

  try {
    await waitFor("renderer bridge", () =>
      javascript(
        "Boolean(window.copilotProxy && document.querySelector('[data-testid=nav-overview]'))",
      ),
    )
    assert(
      await javascript(
        "typeof require === 'undefined' && typeof process === 'undefined'",
      ),
    )
    checks.push("Sandboxed native renderer loads without Node access")
    if (legacyMode) {
      assert.equal(
        process.platform,
        "darwin",
        "The legacy private-control workflow requires this Mac",
      )
      checks.push(
        ...(await verifyNativeLegacy({
          ...options,
          ui: { click, input, javascript, capture, waitFor },
        })),
      )
      await writeReport()
      return
    }
    assert.equal(
      controller.snapshot().account.kind,
      "signed-out",
      "Native smoke requires a fresh isolated fixture profile",
    )
    await capture("native-signed-out")

    await click('[data-testid="sign-in"]')
    await waitFor(
      "device code",
      () => controller.snapshot().account.kind === "awaiting-authorization",
    )
    await capture("native-device-code")
    await click('[data-testid="cancel-sign-in"]')
    await waitFor(
      "cancelled login",
      () => controller.snapshot().account.kind === "signed-out",
    )
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(controller.snapshot().account.kind, "signed-out")
    checks.push(
      "Rendered GitHub device sign-in cancels without late account restoration",
    )

    await click('[data-testid="sign-in"]')
    await waitFor(
      "approved login and gateway",
      () =>
        controller.snapshot().account.kind === "signed-in"
        && controller.snapshot().gateway.kind === "running",
    )
    const fixtureKey =
      "fixture_native_gateway_key_012345678901234567890123456789"
    const keyed = await controller.sessionApi().dispatch({
      kind: "update-runtime",
      explicit: { authentication: { kind: "keyed", keys: [fixtureKey] } },
    })
    assert.equal(keyed.kind, "applied")
    const connected = controller.snapshot()
    assert.equal(connected.fixture, true)
    assert.equal(connected.models.length, 6)
    assert(
      connected.models.some((model) => model.id === "fixture-responses-only"),
    )
    assert(connected.usage?.quotas.length)
    const gateway = connected.gateway
    assert.equal(gateway.kind, "running")
    const originalBase = gateway.url
    assert.equal((await fetch(`${originalBase}/models`)).status, 401)
    checks.push(
      "Approved fixture login loads the real catalog and quota path into the native window",
    )
    await capture("native-overview")
    if (process.platform === "darwin")
      checks.push(
        ...(await verifyNativeSharing({
          ...options,
          async verifyReplacement() {
            await waitFor(
              "signed-in account replacement dialog",
              async () =>
                controller.snapshot().authorization.kind === "awaiting"
                && (await javascript(
                  "Boolean(document.querySelector('.device-code'))",
                )),
            )
            assert.equal(controller.snapshot().account.kind, "signed-in")
            assert.equal(controller.snapshot().gateway.kind, "running")
            await capture("native-account-replacement")
            await click('[data-testid="cancel-sign-in"]')
            await waitFor(
              "cancelled account replacement",
              async () =>
                controller.snapshot().authorization.kind === "idle"
                && (await javascript(
                  "!document.querySelector('.device-code')",
                )),
            )
            await new Promise((resolve) => setTimeout(resolve, 3500))
          },
        })),
      )

    await click('[data-testid="nav-settings"]')
    await click('button[aria-label="Copy local API key"]')
    await waitFor(
      "native clipboard key",
      async () => (await clipboard.readText()) === fixtureKey,
    )
    const gatewayKey = await clipboard.readText()
    assert(
      gatewayKey === fixtureKey,
      "Native copy returns the active fixture key",
    )
    const headers = () => ({
      authorization: `Bearer ${gatewayKey}`,
      "content-type": "application/json",
    })
    assert.equal(
      (await fetch(`${originalBase}/models`, { headers: headers() })).status,
      200,
    )
    assert.equal(
      (
        await fetch(`${originalBase.replace(/\/v1$/, "")}/token`, {
          headers: headers(),
        })
      ).status,
      404,
    )
    assert.equal(
      (
        await fetch(`${originalBase}/models`, {
          headers: { ...headers(), origin: "https://example.com" },
        })
      ).status,
      403,
    )
    checks.push(
      "Native local key authenticates HTTP while token and browser-origin access are blocked",
    )

    await click('[data-testid="nav-overview"]')
    await click('[data-testid="open-probe"]')
    await input(
      '[data-testid="probe-prompt"]',
      "Reply with exactly: Copilot Proxy is connected.",
    )
    await click('[data-testid="probe-send"]')
    await waitFor(
      "native test request",
      () => controller.snapshot().probe.kind === "complete",
    )
    const probe = controller.snapshot().probe
    assert.equal(probe.kind, "complete")
    assert.match(probe.text, /Copilot Proxy is connected/)
    checks.push(
      "Rendered test-request form sends through the owned gateway and shows a response",
    )

    const chatModel = connected.models.find((model) =>
      model.endpoints.includes("/chat/completions"),
    )
    assert(chatModel)
    const streamStartedAt = Date.now()
    const stream = await fetch(`${originalBase}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: chatModel.id,
        messages: [{ role: "user", content: "native streaming check" }],
        stream: true,
      }),
    })
    assert.equal(stream.status, 200)
    assert.match(await stream.text(), /\[DONE\]/)
    await waitFor("completed stream activity", () =>
      controller
        .snapshot()
        .activity.some(
          (entry) =>
            entry.outcome === "completed"
            && entry.model === chatModel.id
            && Date.parse(entry.startedAt) >= streamStartedAt
            && entry.outputTokens === 9
            && entry.inputTokens === 37,
        ),
    )
    checks.push(
      "Actual Node child completes streaming POSTs and records final token usage",
    )

    const pdfResponse = await fetch(`${originalBase}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: chatModel.id,
        max_tokens: 32,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: fixturePdf().toString("base64"),
                },
              },
              { type: "text", text: "Read the attached PDF." },
            ],
          },
        ],
      }),
    })
    const pdfBody = await pdfResponse.text()
    assert.equal(
      pdfResponse.status,
      200,
      `Packaged PDF extraction returned ${pdfResponse.status}: ${pdfBody.slice(0, 300)}`,
    )
    checks.push(
      "Native child loads the real PDF parser, native dependency, and worker assets",
    )

    await click('[data-testid="nav-models"]')
    await input('[data-testid="model-search"]', "responses")
    await waitFor("model search", () =>
      javascript(
        "document.querySelectorAll('.model-table tbody tr').length === 1 && Boolean(document.querySelector('.catalog-model-name[title=fixture-responses-only]'))",
      ),
    )
    assert(
      await javascript(
        "Array.from(document.querySelectorAll('.model-actions button')).every(button => button.getAttribute('aria-label')?.startsWith('Test '))",
      ),
    )
    await capture("native-models")
    await click('[data-testid="nav-agents"]')
    await click("#agent-tab-opencode")
    const openCodeFolder = path.join(
      options.homeDirectory,
      ".config",
      "opencode",
    )
    assert.equal(await fs.stat(openCodeFolder).catch(() => null), null)
    await click('[data-testid="open-config-folder"]')
    await waitFor(
      "native configuration folder handler",
      async () =>
        (await fs.stat(openCodeFolder).catch(() => null))?.isDirectory()
        === true,
    )
    checks.push(
      "Rendered Open configuration folder invokes the native handler for the selected agent",
    )
    const files = await seedNativeAgentFiles(options.homeDirectory)
    const codexFile = files.find((file) => file.target === "codex")
    const claudeFile = files.find((file) => file.target === "claude-code")
    const openCodeFile = files.find((file) => file.target === "opencode")
    assert(codexFile && claudeFile && openCodeFile)
    await click("#agent-tab-codex")
    await click('[data-testid="inspect-agent-config"]')
    await waitFor("existing Codex model inspection", () =>
      javascript(
        "document.querySelector('[data-testid=configured-agent-model]')?.value === 'fixture-responses-only'",
      ),
    )
    await click('[data-testid="configure-agent"]')
    await waitFor("Codex configuration", () =>
      controller
        .snapshot()
        .agentConfigs.some(
          (config) =>
            config.target === "codex" && config.status === "configured",
        ),
    )
    const codexConfig = controller
      .snapshot()
      .agentConfigs.find((config) => config.target === "codex")
    assert(codexConfig)
    assert.equal(codexConfig.path, codexFile.path)
    const beforeRepeat = await verifyNativeAgentFile(codexFile)
    assert(beforeRepeat.includes(gatewayKey))
    assert(!beforeRepeat.includes("fixture_github_token"))
    assert(
      await javascript(
        "(async () => { await window.copilotProxy.invoke({ kind: 'configure-agent', target: 'codex' }); return true; })()",
      ),
    )
    assert.equal(await fs.readFile(codexConfig.path, "utf8"), beforeRepeat)
    assert(
      await javascript(
        `document.querySelector('[data-testid=agent-proxy-url]')?.value === ${JSON.stringify(connected.connection?.apiUrl)}`,
      ),
    )
    await click('[data-testid="copy-config"]')
    await waitFor(
      "native configuration clipboard",
      async () => (await clipboard.readText()).trim() === "codex",
    )
    const copiedConfiguration = await clipboard.readText()
    assert(
      copiedConfiguration.trim() === "codex",
      "Native copy returns the configured Codex launch command",
    )
    assert(!copiedConfiguration.includes("fixture_github_token"))
    await capture("native-agent-codex")
    checks.push(
      "Rendered Codex Configure preserves its model, TOML comments, MCP server, permissions and repeated contents, and copies its normal command",
    )
    await click("#agent-tab-claude-code")
    await click('[data-testid="inspect-agent-config"]')
    await waitFor("existing Claude alias inspection", () =>
      javascript(
        "document.querySelector('[data-testid=configured-agent-model]')?.value === 'fixture-claude-sonnet[1m]' && document.querySelector('[data-testid=configured-agent-model]')?.readOnly === true",
      ),
    )
    await click('[data-testid="configure-agent"]')
    await waitFor("Claude configuration", () =>
      controller
        .snapshot()
        .agentConfigs.some(
          (config) =>
            config.target === "claude-code" && config.status === "configured",
        ),
    )
    const claudeConfig = controller
      .snapshot()
      .agentConfigs.find((config) => config.target === "claude-code")
    assert(claudeConfig?.model.kind === "configured")
    assert.equal(claudeConfig.path, claudeFile.path)
    assert.equal(claudeConfig.model.exact, "fixture-claude-sonnet[1m]")
    assert(codexConfig.model.kind === "configured")
    assert.notEqual(claudeConfig.model.exact, codexConfig.model.exact)
    const beforeModels = await verifyNativeAgentFile(claudeFile)
    assert(
      await javascript(
        `document.querySelector('[data-testid=agent-proxy-url]')?.value === ${JSON.stringify(connected.connection?.rootUrl)}`,
      ),
    )
    await click('[data-testid="copy-config"]')
    await waitFor(
      "native Claude launch command",
      async () => (await clipboard.readText()).trim() === "claude",
    )
    await capture("native-agent-claude")
    checks.push(
      "Rendered Claude setup preserves its exact [1m] alias, settings and root URL, independently of Codex",
    )

    await click("#agent-tab-opencode")
    await click('[data-testid="inspect-agent-config"]')
    await waitFor("OpenCode missing model", () =>
      javascript(
        "document.querySelector('#agent-model') instanceof HTMLSelectElement",
      ),
    )
    const previousChoices = controller.snapshot().settings.agentModelChoices
    await input("#agent-model", "fixture-fast")
    await waitFor(
      "independent OpenCode proposal",
      () =>
        controller.snapshot().settings.agentModelChoices.opencode
        === "fixture-fast",
    )
    assert.equal(
      controller.snapshot().settings.agentModelChoices["claude-code"],
      previousChoices["claude-code"],
    )
    assert.equal(
      controller.snapshot().settings.agentModelChoices.codex,
      previousChoices.codex,
    )
    await click('[data-testid="configure-agent"]')
    await waitFor("OpenCode configuration", () =>
      controller
        .snapshot()
        .agentConfigs.some(
          (config) =>
            config.target === "opencode"
            && config.status === "configured"
            && config.model.kind === "configured"
            && config.model.exact === "copilot_proxy/fixture-fast",
        ),
    )
    const beforeOpenCodeRepeat = await verifyNativeAgentFile(openCodeFile)
    assert(
      await javascript(
        "(async () => { await window.copilotProxy.invoke({ kind: 'configure-agent', target: 'opencode' }); return true; })()",
      ),
    )
    assert.equal(
      await fs.readFile(openCodeFile.path, "utf8"),
      beforeOpenCodeRepeat,
    )
    await click('[data-testid="copy-config"]')
    await waitFor(
      "native OpenCode launch command",
      async () => (await clipboard.readText()).trim() === "opencode",
    )
    await capture("native-agent-opencode")
    checks.push(
      "Rendered OpenCode Configure adds its own missing model and preserves its symlink, comments, permissions, MCP settings and repeated contents",
    )

    await click("#agent-tab-curl")
    await input("#agent-model", "fixture-responses-only")
    await waitFor("HTTP Responses preview", () =>
      javascript(
        "document.querySelector('.configuration-preview pre')?.textContent.includes('fixture-responses-only') === true",
      ),
    )
    assert(
      await javascript(
        `document.querySelector('.code-toolbar')?.textContent.includes(${JSON.stringify(`${originalBase}/responses`)}) === true && !document.body.innerText.includes(${JSON.stringify(gatewayKey)})`,
      ),
    )
    await capture("native-http-preview")
    await click('[data-testid="copy-config"]')
    await waitFor("private HTTP request clipboard", async () =>
      (await clipboard.readText()).includes(gatewayKey),
    )
    const copiedRequest = await clipboard.readText()
    assert(copiedRequest.includes(`${originalBase}/responses`))
    assert(!copiedRequest.includes("fixture_github_token"))
    if (process.platform !== "win32") {
      const result = await promisify(execFile)(
        "/bin/sh",
        ["-c", copiedRequest],
        {
          cwd: options.homeDirectory,
          timeout: 15_000,
        },
      ).catch(() => {
        throw new Error("The copied HTTP request failed in the POSIX shell.")
      })
      const response: unknown = JSON.parse(result.stdout)
      assert.equal(
        z.object({ output_text: z.string() }).parse(response).output_text,
        "Copilot Proxy is connected.",
      )
    }
    checks.push(
      "HTTP preview hides the local key and Copy request uses the actual connection and Responses model",
    )

    await click('[data-testid="nav-models"]')
    await click('[data-testid="nav-agents"]')
    assert.equal(await fs.readFile(claudeConfig.path, "utf8"), beforeModels)
    assert.equal(await fs.readFile(codexConfig.path, "utf8"), beforeRepeat)
    assert.equal(
      await fs.readFile(openCodeFile.path, "utf8"),
      beforeOpenCodeRepeat,
    )
    checks.push(
      "Agent models remain independent and catalog navigation changes no configured file",
    )
    await capture("native-agent-setup")

    await click('[data-testid="nav-activity"]')
    assert(controller.snapshot().activity.length >= 3)
    await capture("native-activity")
    const serializedActivity = JSON.stringify(controller.snapshot().activity)
    assert(!serializedActivity.includes("fixture_github_token"))
    assert(!serializedActivity.includes("fixture_copilot_token"))
    assert(!serializedActivity.includes("native streaming check"))
    await click('[data-testid="clear-activity"]')
    await waitFor(
      "cleared activity",
      () => controller.snapshot().activity.length === 0,
    )
    checks.push(
      "Rendered activity reflects real requests, excludes content and credentials, and clears",
    )

    await click('[data-testid="nav-settings"]')
    await input('[data-testid="settings-port"]', "0")
    await waitFor("invalid port", () =>
      javascript(
        "document.querySelector('[data-testid=save-settings]').disabled === true",
      ),
    )
    const nextPort = await availablePort()
    await input('[data-testid="settings-port"]', String(nextPort))
    await javascript(
      "Array.from(document.querySelectorAll('button[role=radio]')).find(button => button.textContent.trim() === 'Dark').click(); true",
    )
    await click('[data-testid="save-settings"]')
    await waitFor(
      "settings and restart",
      () =>
        controller.snapshot().settings.port === nextPort
        && controller.snapshot().settings.theme === "dark"
        && controller.snapshot().gateway.kind === "running",
    )
    await assert.rejects(() =>
      fetch(`${originalBase}/models`, {
        headers: headers(),
        signal: AbortSignal.timeout(2000),
      }),
    )
    await capture("native-settings-dark")
    checks.push(
      "Rendered settings reject an invalid port and restart on a saved port without retaining the old listener",
    )

    const beforeReload = controller.snapshot().revision
    window.webContents.reload()
    await waitFor("native renderer reload", () =>
      javascript(
        "document.documentElement.dataset.theme === 'dark' && Boolean(document.querySelector('[data-testid=nav-settings]'))",
      ),
    )
    assert(controller.snapshot().revision >= beforeReload)
    checks.push(
      "Window reload restores the saved appearance and current native state",
    )

    await click('[data-testid="nav-overview"]')
    await click('[data-testid="stop-gateway"]')
    await waitFor(
      "stopped gateway",
      () => controller.snapshot().gateway.kind === "stopped",
    )
    await assert.rejects(() =>
      fetch(`http://127.0.0.1:${nextPort}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      }),
    )
    checks.push("Rendered Stop action releases the real loopback port")
    await click('[data-testid="start-gateway"]')
    await waitFor(
      "gateway restarted",
      () => controller.snapshot().gateway.kind === "running",
    )
    await click('[data-testid="nav-settings"]')
    await click('[data-testid="sign-out"]')
    await waitFor(
      "signed-out cleanup",
      () =>
        controller.snapshot().account.kind === "signed-out"
        && controller.snapshot().gateway.kind === "stopped",
    )
    await assert.rejects(() =>
      fetch(`http://127.0.0.1:${nextPort}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      }),
    )
    checks.push(
      "Rendered Sign out stops the child and clears account/model state",
    )
    assert.equal(controller.snapshot().models.length, 0)
    await writeReport()
  } catch (error) {
    await capture("native-failure").catch(() => undefined)
    throw error
  } finally {
    await clipboard.writeText(originalClipboard)
  }
}
