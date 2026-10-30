import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

const resolvePackage = createRequire(import.meta.url)
const directory = path.dirname(resolvePackage.resolve("electron/package.json"))
const binary = (
  await fs.readFile(path.join(directory, "path.txt"), "utf8")
).trim()
export const electronExecutable = path.join(directory, "dist", binary)
