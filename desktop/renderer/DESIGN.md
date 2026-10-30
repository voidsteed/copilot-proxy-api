# Copilot Bridge renderer

This document explains the renderer design. The native controller remains the sole owner of account state, credentials, settings, and gateway lifecycle.

## Worklist

- [x] `how` over the affected subsystem.
- [x] `architect` for parallel design exploration.
  Parent architecture exploration selected a dedicated proxy child. Renderer alternatives below were compared locally within the assigned renderer scope.
- [x] Write the throughput checkpoint as four todo items.
- [x] Delegate code-writing to a subagent using your configured feature model.
  This renderer is the parent's delegated implementation. Nested delegation is outside this assignment.
- [ ] Verify on the matching surface.
  Parent owns the shared browser and native verification sessions.
- [ ] Rebase into small, ordered commits. Stack follow-ups.
  Parent owns integration. This assignment makes no commits.
- [x] If the design is contested, `interrogate` before shipping.
  Skip because the parent supplied an agreed design direction.
- [ ] Run **Opening a PR**.
  Parent owns delivery.

## Throughput checkpoint

- Blocking first steps. Read the shared contract and agree on the connection snippet signature before rendering commands.
- Independent workstreams. The parent owns bootstrap, build, preview, and shared snippets. Another worker owns the controller. This worker owns only the renderer and HTML entry.
- Shared mutable state. Renderer filters and drafts stay local. Every persistent operation is a validated command to the controller.
- Smallest safe decomposition. One renderer owner keeps styling, interactions, and accessibility coherent. Parent performs independent review and UI verification.

## Data shape and ownership

`DesktopSnapshot` is the authoritative domain shape. A discriminated transport state separates loading, unavailable, and ready views. Every incoming snapshot is parsed with `snapshotSchema`. A revision comparison rejects snapshots older than the currently rendered one. A pending-command set prevents repeated identical actions. Device authorization uses the account union rather than a second sign-in state machine.

The renderer exposes no token or local-key field. It previews configurations with the literal `<LOCAL_API_KEY>` and sends copy commands to native code.

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
