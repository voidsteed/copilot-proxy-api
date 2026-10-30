import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export function selectDataDirectory(options: {
  fixture: boolean
  explicit?: string
}): string | undefined {
  if (options.explicit) return path.resolve(options.explicit)
  if (options.fixture)
    return mkdtempSync(path.join(tmpdir(), "copilot-bridge-fixture-"))
  return undefined
}
