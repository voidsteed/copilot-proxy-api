# Desktop architecture

Copilot Bridge gives a Copilot subscriber a local gateway and agent setup in one desktop app. The sandboxed renderer presents safe snapshots. Electron main owns settings, GitHub device login, encrypted persistence, clipboard actions, and the lifetime of one proxy child. That child owns the existing process-wide proxy state and protocol handlers.

The app bundles Electron's Node runtime. Users do not install Bun or Node. The desktop package starts at 0.0.1 and does not change the CLI's release history.

## Runtime choice

Two independent designs compared running Hono inside Electron main with running it in a dedicated child. The child design preserves the current route and service signatures, contains CPU work and failures, and makes a stopped process a reliable boundary for account state. The embedded design required a broad state refactor through the existing CLI and handlers. An independent reviewer selected the child design.

The child runs a desktop-specific HTTP composition around the existing inference routes. It binds to 127.0.0.1, requires a generated local key, rejects browser origins, and never mounts the CLI token or debug routes. It uses the Hono Node adapter because a direct Node experiment found the current srvx adapter can treat normal POST upload completion as cancellation.

## Ownership

| Area | Owner |
| --- | --- |
| Safe commands and snapshots | `shared/contracts.ts` |
| Agent setup text | `shared/connections.ts` |
| Account and desired gateway state | `main/controller.ts` |
| GitHub device flow | Native account code |
| Persistent secrets | Native vault using Electron safeStorage |
| Proxy singleton and response streams | Dedicated child |
| Native window, IPC, tray, and quit | Electron bootstrap |
| Presentation and local filters | React renderer |

No renderer API accepts an arbitrary URL, file path, executable, or IPC channel. Upstream credentials do not enter snapshots. Local-key copies and complete agent configurations go directly from native code to the clipboard. IPC checks the originating window and frame, and validates commands at the controller boundary.

## Lifecycle

Start and stop converge to one desired state. Login cancellation and sign-out invalidate old asynchronous work before cleanup. Stop closes the listener and drains active work for a bounded period, then terminates the child if needed. A replacement starts only after the previous child exits. Parent disconnection also ends the child. Quit waits for cleanup.

Settings and credentials have one writer. Credentials persist only when OS-backed encryption is available. Linux basic-text storage is treated as unavailable. Otherwise the app explicitly runs in session-only mode. Existing CLI token files and agent configuration files remain under their current owners.

Activity is a bounded session history of completed-request metadata. The existing stream observer supplies final timing and token counts. It does not record prompts, generated text, tool arguments, headers, or raw upstream errors. This release adds no history database or telemetry.

## Verification

The [feature map](FEATURES.md) defines observable workflows. Local fixtures replace only upstream services; the renderer, native bridge, child, Hono routes, and loopback requests still run. Browser checks use gstack browse. Native smoke checks launch Electron and verify the actual window and listener. Packaged checks cover dependency assets and shutdown. Tests on this Mac establish macOS behavior. Windows and Linux require their native CI jobs before a cross-platform release claim.

The decision trail and architecture candidates for this development run are under the project's mac-ssd `desktop-app` directory.
