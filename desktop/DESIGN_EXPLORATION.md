# Copilot Proxy design exploration

The default window should answer whether the selected agent can use the gateway. Use a compact connection strip, independent agent rows, and a recent request result. Keep the existing native typography, gray chrome, white panels, and teal accent.

This is a proposal based on source inspection and public browser research on 31 October 2026. The research produced two standalone layout concepts. It does not change the app's visual design.

## References from Designeer

| Reference | Observed pattern | Application to Copilot Proxy |
| --- | --- | --- |
| [Designeer](https://designeer.xyz/) | Search, category filters, and separate list and tile views organize a large collection. | Keep model and request filters visible. Preserve them when opening details or testing a model. |
| [BoardUI](https://www.boardui.com/), listed by Designeer | Its public dashboard examples combine sidebar navigation, filtered tables, result labels, model controls, and compact activity information. | Put Agents before Models. Use a readable request table and an adjacent detail panel. Borrow organization, without installing the library or copying its assets. |
| [Details on Designeer](https://designeer.xyz/inspiration/details) and [Details](https://www.details.so/) | Public examples have component categories, search, and detail views. | Use short transitions for drawers and inline request feedback. Keep navigation and data stable during an action. |

The linked sites were visited with gstack Browse. Screenshots and rendered page structure were retained on mac-ssd. Direct tool-image viewing failed, so the pass used read-only Codex CLI image review for the actual native window and the final Overview concept. The current native window visibly shows Overview, Gateway running, and localhost:4141/v1. The final concept review reports no major clipping or legibility defect. Recommendations also use observed page structure, browser styles, and actual app source. Paid libraries and their private flows were not inspected.

## Proposed screen changes

Replace the large static connection diagram on Overview with one compact gateway strip. Account state, listener state, agent configuration, and a completed inference request are separate facts. An available catalog establishes neither an authenticated upstream request nor a working Codex session.

Show Claude Code, Codex, and OpenCode as independent rows. Put the configured model beside its configuration status. Keep endpoint, protocol, shell, and file path in agent details. Use one next action where possible. A missing OpenCode configuration remains missing until the user chooses to configure it.

Keep model testing in a drawer beside the catalog. A test should preserve search and filters. Catalog browsing continues to leave each agent's configured model unchanged.

Give Activity a result label and a request detail panel. The proposed panel connects a failure to a useful recovery action. Actual legacy traces currently lack sanitized error explanations, model IDs, and token counts. Richer guidance needs an explicit backend contract; the concept's sample errors are not available production data.

Reflow narrow windows instead of reducing control text to 9px. The concepts retain at least 13px text, stack side panels, and scroll wide tables within their own container. Add clear keyboard focus and respect reduced motion.

## Layout choice

Concept A leads with gateway and agent setup. Use it as the default window because connection and configuration questions are the app's main task.

Concept B places the agent list beside Activity. Use this organization for the Activity screen because filters, errors, and request details need more room. Both concepts use the same palette, so the comparison isolates layout and density.

The [standalone comparison](/Volumes/mac-ssd/AI/projects/copilot-proxy-desktop-fix-20261030--6f1ad44130b9/shared-proxy/design-inspiration-designeer-20261031/mockups/comparison.html) has a layout switch, theme switch, sample gateway state, agent details, request filters, and a request drawer. Overview keeps each agent's last test prominent and moves request history into Activity. Connection details are collapsed until needed. All data and actions are illustrative. The page reads no user files, sends no inference requests, and changes no configuration.

Experience First shaped the choice to put agent readiness before statistics. Exhaust the Design Space shaped the two comparable layouts. Prove It Works separates verified connection behavior from sample UI states.
