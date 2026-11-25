import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { electronExecutable } from "./electron-path.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
await import("./build.mjs")
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electronExecutable, [root, ...process.argv.slice(2)], {
  cwd: root,
  env: environment,
  stdio: "inherit",
})
child.once("exit", (code) => {
  process.exitCode = code ?? 1
})
const signals: Array<NodeJS.Signals> = ["SIGINT", "SIGTERM"]
for (const signal of signals) {
  process.once(signal, () => child.kill(signal))
}
