import type { BrowserWindow } from "electron"

import { clipboard } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import type { DesktopController } from "./types"

import { fixturePdf } from "../testing/pdf"
import { availablePort } from "../testing/settings"

export async function runNativeSmoke(options: {
  window: BrowserWindow
  controller: DesktopController
  outputDirectory: string
}): Promise<void> {
  const { window, controller, outputDirectory } = options
  await fs.mkdir(outputDirectory, { recursive: true })
  const checks: Array<string> = []
  const startedAt = new Date().toISOString()

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
    const image = await window.webContents.capturePage()
    await fs.writeFile(path.join(outputDirectory, `${name}.png`), image.toPNG())
  }

  try {
    await waitFor("renderer bridge", () =>
      javascript(
        "Boolean(window.copilotBridge && document.querySelector('[data-testid=sign-in]'))",
      ),
    )
    assert(
      await javascript(
        "typeof require === 'undefined' && typeof process === 'undefined'",
      ),
    )
    checks.push("Sandboxed native renderer loads without Node access")
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
    const connected = controller.snapshot()
    assert.equal(connected.fixture, true)
    assert(connected.models.length >= 5)
    assert(connected.usage?.quotas.length)
    const gateway = connected.gateway
    assert.equal(gateway.kind, "running")
    const originalBase = gateway.url
    assert.equal((await fetch(`${originalBase}/models`)).status, 401)
    checks.push(
      "Approved fixture login loads the real catalog and quota path into the native window",
    )
    await capture("native-overview")

    await click('[data-testid="nav-settings"]')
    await click('button[aria-label="Copy local API key"]')
    await waitFor(
      "native clipboard key",
      async () => (await clipboard.readText()).length >= 32,
    )
    const gatewayKey = await clipboard.readText()
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
      "Reply with exactly: Copilot Bridge is connected.",
    )
    await click('[data-testid="probe-send"]')
    await waitFor(
      "native test request",
      () => controller.snapshot().probe.kind === "complete",
    )
    const probe = controller.snapshot().probe
    assert.equal(probe.kind, "complete")
    assert.match(probe.text, /Copilot Bridge is connected/)
    checks.push(
      "Rendered test-request form sends through the owned gateway and shows a response",
    )

    const chatModel = connected.models.find((model) =>
      model.endpoints.includes("/chat/completions"),
    )
    assert(chatModel)
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
          (entry) => entry.outputTokens === 9 && entry.inputTokens === 37,
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
        "document.querySelectorAll('.model-table tbody tr, .models-table tbody tr').length <= 2",
      ),
    )
    await capture("native-models")
    await click('[data-testid="nav-agents"]')
    await click("#agent-tab-codex")
    await click('[data-testid="copy-config"]')
    await waitFor("native configuration clipboard", async () =>
      (await clipboard.readText()).includes('wire_api="responses"'),
    )
    const copiedConfiguration = await clipboard.readText()
    assert(copiedConfiguration.includes(gatewayKey))
    assert(!copiedConfiguration.includes("fixture_github_token"))
    checks.push(
      "Rendered agent setup copies an authenticated Responses configuration to the native clipboard",
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
    await fs.writeFile(
      path.join(outputDirectory, "smoke.json"),
      JSON.stringify(
        {
          passed: true,
          mode: "fixture",
          platform: process.platform,
          electron: process.versions.electron,
          node: process.versions.node,
          startedAt,
          completedAt: new Date().toISOString(),
          checks,
          limitations: [
            "Controlled upstream services; no live Copilot inference or GitHub consent",
            "Session-only fixture vault; OS credential encryption requires a live user session",
          ],
        },
        null,
        2,
      ) + "\n",
    )
  } catch (error) {
    await capture("native-failure").catch(() => undefined)
    throw error
  }
}
