import { clipboard } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"

import type { OpenProxySessionOptions } from "../../src/lib/proxy-contracts"
import type { DesktopController } from "./types"

import { cliProxyOptions, openProxySession } from "../../src/lib/proxy-session"

export interface NativeSmokeControls {
  click(selector: string): Promise<void>
  input(selector: string, value: string): Promise<void>
  javascript(expression: string): Promise<boolean>
  capture(name: string): Promise<void>
  waitFor(
    name: string,
    predicate: () => boolean | Promise<boolean>,
    timeout?: number,
  ): Promise<void>
}

const legacyChecks = [
  "Native startup observes the existing anonymous CLI connection, complete catalog, quota and prior inference activity",
  "Rendered legacy controls identify Terminal ownership and reject account or runtime mutations",
  "Independent configured Claude and Codex models retain their exact aliases, URLs and normal launch commands",
  "Native test requests use the existing CLI and its rendered activity reports observations with unknown metrics",
  "Releasing native-broker clients preserves the external CLI listener and all existing configuration files",
]

async function verifyLegacyAgent(options: {
  ui: NativeSmokeControls
  target: "claude-code" | "codex"
  model: string
  url: string
  command: string
}): Promise<void> {
  const { ui } = options
  await ui.click(`#agent-tab-${options.target}`)
  await ui.click('[data-testid="inspect-agent-config"]')
  await ui.waitFor(`legacy ${options.target} model and URL`, () =>
    ui.javascript(
      `document.querySelector('[data-testid=configured-agent-model]')?.value === ${JSON.stringify(options.model)} && document.querySelector('[data-testid=agent-proxy-url]')?.value === ${JSON.stringify(options.url)}`,
    ),
  )
  assert(
    await ui.javascript(
      "!document.querySelector('[data-testid=configure-agent]')",
    ),
  )
  await ui.click('[data-testid="copy-config"]')
  await ui.waitFor(
    `legacy ${options.target} launch command`,
    async () => (await clipboard.readText()).trim() === options.command,
  )
  await ui.capture(`native-legacy-${options.target}`)
}

async function verifyLegacyActivity(options: {
  controller: DesktopController
  ui: NativeSmokeControls
}): Promise<void> {
  const { controller, ui } = options
  await ui.click('[data-testid="nav-overview"]')
  await ui.click('[data-testid="open-probe"]')
  await ui.input(
    '[data-testid="probe-prompt"]',
    "Verify the existing legacy listener.",
  )
  await ui.click('[data-testid="probe-send"]')
  await ui.waitFor(
    "legacy native test request",
    () => controller.snapshot().probe.kind === "complete",
  )
  const probe = controller.snapshot().probe
  assert(probe.kind === "complete")
  assert.equal(probe.text, "Legacy Copilot Proxy is connected.")
  await controller.invoke({ kind: "refresh" })
  await ui.waitFor(
    "legacy activity import",
    () => controller.snapshot().activity.length >= 2,
  )
  for (const record of controller.snapshot().activity) {
    assert.equal(record.outcome, "observed")
    assert.equal(record.model, null)
    assert.equal(record.inputTokens, null)
    assert.equal(record.outputTokens, null)
  }
  assert(
    Object.values(controller.snapshot().totals).every(
      (value) => value === null,
    ),
  )
  await ui.click('[data-testid="nav-activity"]')
  await ui.waitFor("rendered legacy activity", () =>
    ui.javascript(
      "document.querySelectorAll('.request-table tbody tr').length >= 2 && Array.from(document.querySelectorAll('.model-cell')).every(element => element.textContent === 'Not reported') && Array.from(document.querySelectorAll('.request-table tbody tr td:nth-last-child(2)')).every(element => element.textContent === 'n/a') && document.querySelector('.request-table')?.textContent.includes('200 observed') === true",
    ),
  )
  await ui.capture("native-legacy-activity")
}

export async function verifyNativeLegacy(options: {
  controller: DesktopController
  homeDirectory: string
  stateDirectory: string
  ui: NativeSmokeControls
}): Promise<Array<string>> {
  const { controller, ui } = options
  const initial = controller.snapshot()
  assert.equal(initial.source.kind, "legacy-cli")
  assert.equal(initial.account.kind, "external-unverified")
  assert.equal(initial.gateway.kind, "running")
  assert.equal(initial.runtime, null)
  assert.equal(initial.connection?.authentication.kind, "none")
  assert.equal(initial.models.length, 2)
  assert(
    initial.activity.some((record) => record.id.includes("legacy-inference-1")),
  )
  const connection = controller.activeConnection()
  assert(connection)
  const paths = [
    path.join(options.homeDirectory, ".claude", "settings.json"),
    path.join(options.homeDirectory, ".codex", "config.toml"),
  ]
  const originalFiles = await Promise.all(
    paths.map((filename) => fs.readFile(filename, "utf8")),
  )
  await ui.capture("native-legacy-overview")
  assert(
    await ui.javascript(
      "document.querySelector('[data-testid=stop-gateway]')?.disabled === true && document.body.innerText.includes('Controlled in Terminal')",
    ),
  )
  const observer = await openProxySession({
    ...(await cliProxyOptions(options)),
    intent: {
      kind: "ensure-running",
      explicit: {},
      credential: { kind: "native-saved-account" },
    },
  } satisfies OpenProxySessionOptions)
  assert(observer.kind === "managed")
  try {
    const shared = await observer.read()
    assert(shared.kind === "legacy")
    assert.equal(shared.capabilities.runtime, "read-only")
    assert.deepEqual(await observer.connection(), connection)
    for (const intent of [
      { kind: "update-runtime", explicit: { rateLimitWait: true } },
      { kind: "sign-out" },
    ] satisfies Array<Parameters<typeof observer.invoke>[0]>) {
      const result = await observer.invoke(intent)
      assert(
        result.kind === "session-changed" && result.snapshot.kind === "legacy",
      )
    }
    assert(
      await ui.javascript(
        "(async () => { await window.copilotProxy.invoke({ kind: 'stop-gateway' }); await window.copilotProxy.invoke({ kind: 'sign-out' }); return true; })()",
      ),
    )
    assert.equal(controller.snapshot().gateway.kind, "running")
    assert.equal(controller.snapshot().account.kind, "external-unverified")
    assert.equal((await fetch(`${connection.apiUrl}/models`)).status, 200)
    await ui.click('[data-testid="nav-settings"]')
    assert(
      await ui.javascript(
        "document.querySelector('[data-testid=settings-port]')?.disabled === true && !document.querySelector('[data-testid=sign-out]')",
      ),
    )
    await ui.capture("native-legacy-settings")
    await ui.click('[data-testid="nav-agents"]')
    await verifyLegacyAgent({
      ui,
      target: "claude-code",
      model: "fixture-legacy-claude[1m]",
      url: connection.rootUrl,
      command: "claude",
    })
    await verifyLegacyAgent({
      ui,
      target: "codex",
      model: "fixture-legacy-responses",
      url: connection.apiUrl,
      command: "codex",
    })
    await verifyLegacyActivity({ controller, ui })
    await observer.release()
    assert.equal((await fetch(connection.rootUrl)).status, 200)
    assert.deepEqual(
      await Promise.all(paths.map((filename) => fs.readFile(filename, "utf8"))),
      originalFiles,
    )
    return [...legacyChecks]
  } finally {
    await observer.release()
  }
}
