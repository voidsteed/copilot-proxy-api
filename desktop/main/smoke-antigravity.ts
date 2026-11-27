import { clipboard } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import type { DesktopController } from "./types"

interface SmokeUi {
  click(selector: string): Promise<void>
  javascript(expression: string): Promise<boolean>
  capture(name: string): Promise<void>
  waitFor(
    name: string,
    predicate: () => boolean | Promise<boolean>,
    timeout?: number,
  ): Promise<void>
}

interface AntigravitySmokeOptions {
  controller: DesktopController
  homeDirectory: string
  gatewayKey: string
  origin: string
  ui: SmokeUi
}

const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(z.object({ text: z.string().optional() })),
        }),
      }),
    )
    .min(1),
})

async function verifyAntigravityUiAndClipboard(
  options: AntigravitySmokeOptions,
): Promise<void> {
  const { homeDirectory, gatewayKey, origin, ui } = options
  const settingsPath = path.join(
    homeDirectory,
    ".gemini",
    "antigravity-cli",
    "settings.json",
  )

  await ui.click("#agent-tab-antigravity")
  await ui.waitFor("Antigravity CLI session preview", () =>
    ui.javascript(
      "document.querySelector('.configuration-preview pre')?.textContent.includes('GOOGLE_GEMINI_BASE_URL') === true",
    ),
  )
  assert(
    await ui.javascript(
      "(() => { const select = document.querySelector('#agent-model'); return select instanceof HTMLSelectElement && Array.from(select.options).map((option) => option.value).join(',') === 'gemini-2.5-pro'; })()",
    ),
    "Antigravity CLI offers only Google chat models",
  )
  assert(
    await ui.javascript(
      "document.querySelector('[data-testid=\"configure-agent\"]') === null",
    ),
    "Antigravity CLI renders no destructive Configure button",
  )
  assert(
    await ui.javascript(
      `document.querySelector('[data-testid="agent-proxy-url"]')?.value === ${JSON.stringify(origin)}`,
    ),
    "Antigravity CLI shows the root origin without a trailing slash",
  )
  assert(
    await ui.javascript(
      `document.querySelector('.configuration-preview pre')?.textContent.includes('<LOCAL_API_KEY>') === true && !document.body.innerText.includes(${JSON.stringify(gatewayKey)})`,
    ),
    "Antigravity CLI preview masks the local API key",
  )
  await ui.capture("native-agent-antigravity")

  await ui.click('[data-testid="copy-config"]')
  await ui.waitFor("Antigravity CLI clipboard command", async () => {
    const text = await clipboard.readText()
    return text.includes("GOOGLE_GEMINI_BASE_URL") && text.includes(gatewayKey)
  })
  const copied = await clipboard.readText()
  assert(copied.includes(origin))
  assert(copied.includes("GEMINI_API_KEY"))
  assert(copied.includes(gatewayKey))
  assert(!copied.includes("fixture_github_token"))
  if (process.platform === "win32") {
    assert(
      copied.includes("agy --settings $agySettings --model 'gemini-2.5-pro'"),
    )
  } else {
    assert(
      copied.includes(
        `agy --settings '{"modelProvider":"gemini"}' --model 'gemini-2.5-pro'`,
      ),
    )
  }
  assert.equal(
    await fs.stat(settingsPath).catch(() => null),
    null,
    "Antigravity CLI copy never creates settings.json",
  )
  assert.equal(
    await fs.stat(path.join(homeDirectory, ".gemini")).catch(() => null),
    null,
    "Antigravity CLI inspection and copy never create ~/.gemini",
  )
}

async function verifyGeminiEndpointsAndProbe(
  options: AntigravitySmokeOptions,
): Promise<void> {
  const { controller, gatewayKey, origin, ui } = options
  for (const route of [
    `${origin}/v1beta/models/gemini-2.5-pro:generateContent`,
    `${origin}/v1/models/gemini-2.5-pro:generateContent`,
  ]) {
    const response = await fetch(route, {
      method: "POST",
      headers: {
        "x-goog-api-key": gatewayKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Reply with exactly: Copilot Proxy is connected." },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 128 },
      }),
    })
    assert.equal(response.status, 200, `Expected HTTP 200 from ${route}`)
    const parsed = geminiResponseSchema.parse(await response.json())
    const text = parsed.candidates[0].content.parts
      .map((part) => part.text ?? "")
      .join("")
    assert.match(text, /Copilot Proxy is connected/)
  }

  const probeCommand = await controller.execute({
    kind: "run-probe",
    modelId: "gemini-2.5-pro",
    prompt: "Reply with exactly: Copilot Proxy is connected.",
  })
  assert.equal(probeCommand.outcome.kind, "ok")
  await ui.waitFor("Gemini probe completion", () => {
    const probe = controller.snapshot().probe
    return probe.kind === "complete" && probe.model === "gemini-2.5-pro"
  })
  const geminiProbe = controller.snapshot().probe
  assert.equal(geminiProbe.kind, "complete")
  assert.match(geminiProbe.text, /Copilot Proxy is connected/)
}

export async function verifyNativeAntigravity(
  options: AntigravitySmokeOptions,
): Promise<Array<string>> {
  await verifyAntigravityUiAndClipboard(options)
  await verifyGeminiEndpointsAndProbe(options)
  return [
    "Antigravity CLI tab filters Google chat models, masks preview key, copies session command without touching settings.json, and serves Gemini generateContent and probes",
  ]
}
