# Copilot Bridge

Copilot Bridge is a desktop app for one GitHub Copilot account. It runs a local gateway and prepares terminal commands for Claude Code, Codex, OpenCode, and HTTP clients. The installed app includes Electron and Node. Users do not need Bun or Node.

The desktop version is **0.0.1 build 1**. The CLI keeps its separate **0.10.32** release history.

The app has five views.

| View     | Behavior                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------ |
| Overview | Sign in, start or stop the gateway, inspect usage, and see recent requests.                      |
| Models   | Search the Copilot catalog, inspect model capabilities, select a model, and send a test request. |
| Agents   | Copy setup commands for a compatible model and either POSIX shells or PowerShell.                |
| Activity | Filter or clear session request metadata, including timing, tokens, and outcomes.                |
| Settings | Change the port, account type, appearance, preferred model, shell, and desktop behavior.         |

## Sign in and connect an agent

1. Select **Sign in with GitHub** and copy the device code.
2. Open GitHub from the app and approve the code at `https://github.com/login/device`.
3. Start the gateway in **Overview**.
4. Select a model in **Models**, then choose your agent and shell in **Agents**.
5. Copy the setup commands and run them in your terminal.

The gateway binds to `127.0.0.1` and requires a generated local key. Copied setup commands contain that key. GitHub and Copilot tokens remain in the native process. The app does not overwrite your agent configuration files. Codex setup uses per-command configuration flags and requires a model that supports the Responses API.

The app persists credentials only with OS-backed encryption. On Linux without a supported secret store, sign-in lasts for the current session. Tray support depends on the Linux desktop environment. Activity contains request metadata, not prompts, generated text, tool arguments, or headers.

## Develop the app

Development requires **Bun 1.3.12 or newer** and **Node 24 or newer**. Run these commands from the repository root.

On this Mac, first configure `desktop/dist`, `desktop/node_modules`, and tool caches under the verified mac-ssd project root in [AGENTS.md](../AGENTS.md). `ai-storage path` resolves the project directory. Keep temporary files there with `TMPDIR`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun install --cwd desktop --frozen-lockfile --ignore-scripts
node desktop/node_modules/electron/install.js
bun run desktop:dev
```

`desktop:dev` builds and launches the native app. It uses the real GitHub device flow unless `--fixture` is supplied.

```sh
bun run desktop:dev -- --fixture
```

The fixture browser preview runs the renderer, native controller, proxy child, and controlled upstream services. It prints its local URL, normally `http://127.0.0.1:5174`.

```sh
bun run desktop:build
bun run desktop:preview
```

The preview and native fixture mode use test credentials and need no GitHub approval. They do not prove live Copilot authentication or inference.

`COPILOT_BRIDGE_PREVIEW_DATA` sets the preview's data directory. `ELECTRON_CACHE` and `ELECTRON_BUILDER_CACHE` set the Electron cache directories.

## Verify the app

The [feature map](FEATURES.md) defines the expected workflows. Root and desktop tests run separately because each suite owns its global fixtures.

```sh
bun run typecheck
bun test ./tests
bun run desktop:typecheck
bun run desktop:test
bun run desktop:build
bun run desktop:smoke
node desktop/scripts/package-smoke.ts
```

The optional live check reuses the existing CLI credential in memory and sends one short Copilot request. It does not import that credential into the app or change the CLI sign-in.

```sh
node desktop/dist/live-check.cjs --use-cli-sign-in
```

The native smoke launches the Electron window, exercises fixture UI workflows, makes local gateway requests, and checks shutdown. The package smoke builds an unsigned app directory for the host architecture and runs the same workflows through its executable. Each smoke run reports its evidence directory. `smoke.json`, screenshots, and `electron.log` record the result.

`COPILOT_BRIDGE_PACKAGE_OUTPUT` sets the package directory. `COPILOT_BRIDGE_SMOKE_OUTPUT` sets the smoke evidence directory. Without these variables, the scripts use temporary storage. The package smoke does not copy artifacts into the source tree. On Linux, run the two smoke commands inside `xvfb-run -a` when no graphical session is available.

The [desktop workflow](../.github/workflows/desktop.yml) runs native jobs on macOS, Windows, and Linux. It uploads fixture evidence and unsigned self-contained app archives. Each job builds only its host architecture. Signing and publishing are disabled.

Local validation covers 13 macOS UI workflows in the development and packaged apps, encrypted-vault filesystem tests, shell-command tests, and the proxy and desktop suites. A live Copilot request through the controller and local gateway also passed using an existing CLI sign-in in memory. New GitHub device consent requires a user. Native Windows and Linux validation runs in CI.

## Package an app

After `bun run desktop:build`, `bun run desktop:package` uses [electron-builder.config.mjs](electron-builder.config.mjs). Pass `--x64` or `--arm64` to restrict the build to the host architecture and match the installed native PDF dependencies.

| OS      | Configured artifact targets         |
| ------- | ----------------------------------- |
| macOS   | DMG and ZIP for x64 and arm64.      |
| Windows | NSIS installer for x64.             |
| Linux   | AppImage and DEB for x64 and arm64. |

These are configured targets. The CI package smoke verifies unpacked app directories and does not create or validate installers. No signed or published release is included.

The [architecture guide](ARCHITECTURE.md) describes the native process, sandboxed renderer, encrypted vault, and proxy child. This release has no other providers, account rotation, automatic edits to agent files, cloud sync, or telemetry.
