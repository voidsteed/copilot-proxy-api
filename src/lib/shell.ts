import { execFileSync } from "node:child_process"
import process from "node:process"

export type ShellName = "bash" | "zsh" | "fish" | "powershell" | "cmd" | "sh"
type EnvVars = Record<string, string | undefined>

function getShell(): ShellName {
  const { platform, ppid, env } = process

  if (platform === "win32") {
    try {
      const parentProcess = execFileSync(
        "wmic",
        ["process", "where", `ProcessId=${ppid}`, "get", "Name"],
        { stdio: "pipe" },
      ).toString()

      if (parentProcess.toLowerCase().includes("powershell.exe")) {
        return "powershell"
      }
    } catch {
      return "cmd"
    }

    return "cmd"
  } else {
    const shellPath = env.SHELL
    if (shellPath) {
      if (shellPath.endsWith("zsh")) return "zsh"
      if (shellPath.endsWith("fish")) return "fish"
      if (shellPath.endsWith("bash")) return "bash"
    }

    return "sh"
  }
}

/**
 * Generates a copy-pasteable script to set multiple environment variables
 * and run a subsequent command.
 * @param {EnvVars} envVars - An object of environment variables to set.
 * @param {string} commandToRun - The command to run after setting the variables.
 * @returns {string} The formatted script string.
 */
export function generateEnvScript(
  envVars: EnvVars,
  commandToRun: string = "",
  selectedShell?: ShellName,
): string {
  const shell = selectedShell ?? getShell()
  const filteredEnvVars: Array<[string, string]> = []
  for (const [key, value] of Object.entries(envVars)) {
    if (!/^[A-Z_]\w*$/i.test(key))
      throw new Error("Invalid environment variable name")
    if (value !== undefined) filteredEnvVars.push([key, value])
  }
  if (filteredEnvVars.length === 0) return commandToRun

  let commandBlock: string

  switch (shell) {
    case "powershell": {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `$env:${key} = '${value.replaceAll("'", "''")}'`)
        .join("; ")
      break
    }
    case "cmd": {
      const powershell = generateEnvScript(envVars, commandToRun, "powershell")
      return `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(powershell, "utf16le").toString("base64")}`
    }
    case "fish": {
      commandBlock = filteredEnvVars
        .map(
          ([key, value]) =>
            `set -gx ${key} '${value.replaceAll("\\", "\\\\").replaceAll("'", String.raw`\'`)}'`,
        )
        .join("; ")
      break
    }
    case "bash":
    case "zsh":
    case "sh": {
      const assignments = filteredEnvVars
        .map(
          ([key, value]) =>
            `${key}='${value.replaceAll("'", String.raw`'\''`)}'`,
        )
        .join(" ")
      commandBlock = `export ${assignments}`
      break
    }
    default: {
      const exhaustive: never = shell
      return exhaustive
    }
  }

  if (!commandToRun) return commandBlock
  const separators = {
    powershell: "; ",
    fish: "; and ",
    sh: " && ",
    bash: " && ",
    zsh: " && ",
  }
  return `${commandBlock}${separators[shell]}${commandToRun}`
}
