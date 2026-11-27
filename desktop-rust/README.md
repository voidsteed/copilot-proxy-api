# Copilot Proxy Desktop (Rust)

Native macOS desktop companion for `copilot-proxy-api`, built with Rust (`iced 0.14`) and a headless Node 24 controller bridge (`desktop/dist/bridge.cjs`).

## Architecture

- **Pure Rust UI (`src/`).** Uses `iced::daemon` with `tiny-skia` software rendering, SVG icons, and push-based `tray-icon` and `muda` menu bar callbacks (`0.0%` idle CPU). Closing the window releases the window framebuffer while keeping the menu bar tray active.
- **macOS Keychain vault (`src/vault.rs`).** Stores a 256-bit AES-GCM master key in macOS Keychain (`com.voidsteed.copilotproxy.rust`) and encrypts saved credentials in `credentials-rust.enc`.
- **Headless TypeScript bridge (`../desktop/bridge/index.ts`).** Reuses the tested `DesktopController`, legacy CLI proxy attachment, duplicate-safe agent config patching, and proxy child (`engine.cjs`) over stdin and stdout NDJSON without Electron.

## Build and test

Run unit tests:

```sh
cd desktop-rust
cargo test --bin copilot-proxy-desktop
```

Render `AppIcon.icns` and Retina menu bar template icons from the SVG sources in `assets/`:

```sh
cd desktop-rust
cargo run --release --bin render_icons
```

Package `Copilot Proxy.app`, `.dmg`, `.zip`, and `SHA256SUMS.txt`:

```sh
./desktop-rust/scripts/package-mac.sh
```

## Releases

Tag a release with `desktop-v<version>` (for example `desktop-v0.0.9`) or trigger `.github/workflows/release-desktop.yml` via `workflow_dispatch`.
