import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
await import(path.join(root, "dist/preview.cjs"))
