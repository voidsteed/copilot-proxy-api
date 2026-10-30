// GitHub lists VS Code 1.128 as the minimum version for Claude Opus 5.
export const DEFAULT_VSCODE_VERSION = "1.128.0"

export async function getVSCodeVersion() {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(
      "https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin",
      {
        signal: controller.signal,
      },
    )

    const pkgbuild = await response.text()
    const pkgverRegex = /pkgver=([0-9.]+)/
    const match = pkgbuild.match(pkgverRegex)

    if (match) {
      return match[1]
    }

    return DEFAULT_VSCODE_VERSION
  } catch {
    return DEFAULT_VSCODE_VERSION
  } finally {
    clearTimeout(timeout)
  }
}
