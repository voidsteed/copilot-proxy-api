# Copilot Proxy renderer

This document explains the renderer design. The native controller remains the sole owner of account state, credentials, settings, and gateway lifecycle.

## Data shape and ownership

`DesktopSnapshot` is the authoritative domain shape. A discriminated transport state separates loading, unavailable, and ready views. `renderer/bridge.ts` is the single boundary that parses snapshots with `snapshotSchema` and command responses with `commandResponseSchema`. A session-scoped revision check accepts snapshots from a new `sessionId` or a strictly higher `revision` in the current session, and clears connection errors only when a snapshot is accepted. Command execution keys pending actions by command identity so distinct sibling commands run without dropping each other, and determines success from the command's `outcome` rather than unrelated notices. Device authorization uses the `authorization` union so account replacement preserves an active account. An `ErrorBoundary` wraps the root app with reload and retry controls, and `index.html` enforces a strict Content Security Policy.

The renderer exposes no token or local-key field. HTTP previews show the request payload without the local key, configured agents preview their normal launch command, and native code writes keys or full commands directly to the clipboard.

## Design alternatives

| Layout | Strength | Cost | Decision |
| --- | --- | --- | --- |
| Equal summary cards | Familiar scanning | Hides the actual provider-to-agent relationship | Reject |
| Terminal workspace | Dense operational view | Makes account setup and settings harder to discover | Reject |
| Desktop control center | Connects account, listener, and agents in one path | Needs careful compact layout | Use |

The selected overview is left aligned, with a quiet sidebar, a single connection panel, a session metric strip, and an operational request table.

```text
Sidebar       Overview                              Gateway status
              GitHub Copilot ----- Gateway ----- Agents
              [authenticated endpoint]       [copy URL] [copy key]
              Requests     Input tokens     Output tokens     Errors
              Recent requests                  Premium allowance
              Test request
```

## Tokens

- Canvas `#f6f7f8`.
- Surface `#ffffff`.
- Graphite `#24292f`.
- Muted text `#606c77`.
- Deep teal `#146b65`.
- Hairline `#e1e5e8`.

The dark theme preserves the same hierarchy with charcoal surfaces and a lighter teal. System appearance follows the OS. Typography uses offline system UI fonts, with a 13px body and 22px page headings. Monospace is reserved for endpoints, request IDs, code, and the actual device code.

Spacing follows a 4px base, with 24px page insets, 16px group gaps, and 8px control gaps. Controls use 6px corners. Major panels use 10px corners. Tables use aligned columns and horizontal rules.

## Critique against the brief

The first sketch used separate metric cards. Replacing them with one ruled strip gives the connection diagram priority and makes the app read as a desktop utility. The diagram has no animated decoration. Teal identifies active gateway state, selected controls, and primary actions. Fixture mode uses a persistent amber banner and explicit account-data wording.

The interface contains no remote assets, invented history, or default sample models. Empty states lead to sign-in, refresh, setup, or a test request. Narrow layouts collapse the sidebar and stack the connection path without hiding actions. Dialogs trap focus, restore it, and cancel authorization on Escape.

Model the Domain keeps account and gateway variants in their shared unions. Type System Discipline and Boundary Discipline put snapshot parsing at the bridge. Experience First keeps the connection path and useful empty states ahead of decorative cards. Prove It Works leaves the final UI verdict with the parent's real browser and native runs.
