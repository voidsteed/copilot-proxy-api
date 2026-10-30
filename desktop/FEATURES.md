# Desktop feature map

The desktop app has its own version, starting at 0.0.1. The existing CLI keeps its release history.

| Feature | Expected behavior | Verification |
| --- | --- | --- |
| GitHub sign-in | Show a device code, open GitHub, obey polling limits, and handle approval, denial, expiry, cancellation, and network errors. | Local upstream fixtures and the rendered sign-in flow. Live sign-in is recorded separately. |
| Account storage | Keep credentials in the native process. Persist only encrypted credentials. Use a visible session-only mode when secure storage is unavailable. | Native storage tests and inspection of test data and renderer snapshots. |
| Local gateway | Start one authenticated listener at 127.0.0.1. Stop releases its port. Repeated actions, failed binds, sign-out, and quit leave no orphan listener. | Real local HTTP, a controlled child process, and the native UI. |
| Protocols | Preserve OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and their supported streaming behavior. | Existing proxy tests plus real HTTP through the desktop-owned Node runtime. |
| Models | Show the actual Copilot catalog, supported features, and model limits. Search and select a model for agent setup and test requests. | Fixture catalog in the UI and live discovery when credentials are available. |
| Usage | Display account quotas from GitHub. Distinguish unlimited, unavailable, and zero remaining. Keep fetch timestamps visible. | Controlled quota responses and UI refresh. |
| Agent setup | Preview and copy Claude Code, Codex, OpenCode, and HTTP configurations with POSIX or PowerShell setup. Copy the local key without exposing upstream credentials. | UI copy actions and requests using the resulting endpoint and key. Existing agent files are never overwritten. |
| Test request | Send the selected model a real request through the local gateway and show its response or an actionable error. | Controlled upstream response, completed activity, and live Copilot execution recorded separately. |
| Activity | Show bounded session metadata after streams finish. Distinguish failures and cancellations. Store no prompt, generated text, headers, or upstream error bodies in history. | JSON and streaming requests, cancellation, clearing, and redaction checks. |
| Settings | Validate ports and persist appearance, preferred model, start behavior, account type, and shell choice. Apply lifecycle changes through the native owner. | UI save, invalid-input checks, and app restart. |
| Desktop lifecycle | Offer native tray actions, a single app instance, safe close behavior, and complete quit cleanup. | Actual Electron launches. Platform-specific behavior requires the matching OS. |
| Packaging | Bundle the runtime for macOS, Windows, and Linux. Users need neither Node nor Bun. Include PDF dependencies and worker assets. | Local macOS launch and package checks. Native Windows/Linux CI must be distinguished from checks run on this Mac. |

The first release supports one Copilot account. Other providers, account rotation, automatic edits to agent files, cloud sync, signing, publishing, and deployment are outside this development scope.
