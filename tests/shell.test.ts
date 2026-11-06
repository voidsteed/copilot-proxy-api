import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { generateEnvScript } from "~/lib/shell"

const exec = promisify(execFile)

test("POSIX launch instructions preserve literal metacharacters and quotes", async () => {
  const value =
    "actual key ' \" \\ $(printf injected) `printf injected` $HOME; & |\nsecond line"
  for (const shell of ["sh", "bash", "zsh"] as const) {
    const script = generateEnvScript(
      { COPILOT_PROXY_TEST_LITERAL: value },
      'node -p "JSON.stringify(process.env.COPILOT_PROXY_TEST_LITERAL)"',
      shell,
    )
    const result = await exec(`/bin/${shell}`, ["-c", script])
    expect(JSON.parse(result.stdout)).toBe(value)
  }
})

test("PowerShell and cmd instructions quote literal values without percent expansion", () => {
  const values = {
    ANTHROPIC_AUTH_TOKEN: "actual'key %PATH% $(touch sentinel) & \"",
  }
  const powershell = generateEnvScript(values, "claude", "powershell")
  expect(powershell).toBe(
    "$env:ANTHROPIC_AUTH_TOKEN = 'actual''key %PATH% $(touch sentinel) & \"'; claude",
  )
  const cmd = generateEnvScript(values, "claude", "cmd")
  const encoded = cmd.split(" ").at(-1)
  if (!encoded) throw new Error("Expected encoded command")
  expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(powershell)
})

test("rejects invalid environment names and omits absent authentication", () => {
  expect(() =>
    generateEnvScript({ "KEY;touch marker": "value" }, "claude", "sh"),
  ).toThrow()
  expect(
    generateEnvScript({ ANTHROPIC_AUTH_TOKEN: undefined }, "claude", "sh"),
  ).toBe("claude")
})
