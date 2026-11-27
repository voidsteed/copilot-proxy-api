#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUST_DIR="$REPO_ROOT/desktop-rust"
VERSION="${COPILOT_PROXY_DESKTOP_VERSION:-0.0.8}"
BUILD_NUMBER="$(printf '%s' "${VERSION##*.}" | tr -cd '0-9')"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  ARCH_LABEL="arm64"
else
  ARCH_LABEL="x64"
fi

if [ -n "${COPILOT_PROXY_PACKAGE_OUTPUT:-}" ]; then
  OUT_ROOT="$COPILOT_PROXY_PACKAGE_OUTPUT"
  TARGET_DIR="${CARGO_TARGET_DIR:-$OUT_ROOT/target}"
elif command -v ai-storage >/dev/null 2>&1 && [ -d /Volumes/mac-ssd ]; then
  STORAGE_ROOT="$(cd "$REPO_ROOT" && ai-storage path)"
  RUST_ROOT="$STORAGE_ROOT/rust"
  export RUSTUP_HOME="${RUSTUP_HOME:-$RUST_ROOT/rustup}"
  export CARGO_HOME="${CARGO_HOME:-$RUST_ROOT/cargo}"
  export TMPDIR="${TMPDIR:-$RUST_ROOT/tmp}"
  export PATH="$CARGO_HOME/bin:$PATH"
  TARGET_DIR="${CARGO_TARGET_DIR:-$RUST_ROOT/target}"
  OUT_ROOT="$STORAGE_ROOT/rust-package"
else
  OUT_ROOT="${RUNNER_TEMP:-/tmp}/copilot-proxy-rust-package"
  TARGET_DIR="${CARGO_TARGET_DIR:-$OUT_ROOT/target}"
fi

export CARGO_TARGET_DIR="$TARGET_DIR"
mkdir -p "$OUT_ROOT" "$TARGET_DIR"

echo "1. Building TypeScript headless bridge and engine..."
(cd "$REPO_ROOT" && bun run desktop:build)

echo "2. Rendering AppIcon.icns and Retina tray assets..."
(cd "$RUST_DIR" && cargo run --release --bin render_icons)

echo "3. Building optimized Pure Rust release binary..."
(cd "$RUST_DIR" && cargo build --release --bin copilot-proxy-desktop)

APP_OUT="$OUT_ROOT/Copilot Proxy.app"
rm -rf "$APP_OUT"
mkdir -p "$APP_OUT/Contents/MacOS" "$APP_OUT/Contents/Resources/bridge/node_modules"

cp "$CARGO_TARGET_DIR/release/copilot-proxy-desktop" "$APP_OUT/Contents/MacOS/copilot-proxy-desktop"
chmod +x "$APP_OUT/Contents/MacOS/copilot-proxy-desktop"
cp "$RUST_DIR/assets/generated/AppIcon.icns" "$APP_OUT/Contents/Resources/AppIcon.icns"
cp "$REPO_ROOT/desktop/dist/bridge.cjs" "$APP_OUT/Contents/Resources/bridge/bridge.cjs"
cp "$REPO_ROOT/desktop/dist/engine.cjs" "$APP_OUT/Contents/Resources/bridge/engine.cjs"

NODE_MODS_SRC="$(realpath "$REPO_ROOT/desktop/node_modules")"
for pkg in pdf-parse jsonc-parser pdfjs-dist @napi-rs; do
  if [ -e "$NODE_MODS_SRC/$pkg" ]; then
    cp -RL "$NODE_MODS_SRC/$pkg" "$APP_OUT/Contents/Resources/bridge/node_modules/$pkg"
  fi
done

cat > "$APP_OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Copilot Proxy</string>
  <key>CFBundleExecutable</key>
  <string>copilot-proxy-desktop</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.voidsteed.copilotproxy</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Copilot Proxy</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${BUILD_NUMBER}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSRequiresAquaSystemAppearance</key>
  <false/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP_OUT"

RELEASE_DIR="$OUT_ROOT/release-artifacts"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

ZIP_NAME="Copilot-Proxy-${VERSION}-macos-${ARCH_LABEL}.zip"
DMG_NAME="Copilot-Proxy-${VERSION}-macos-${ARCH_LABEL}.dmg"

echo "4. Creating distributable ZIP archive..."
ditto -c -k --sequesterRsrc --keepParent "$APP_OUT" "$RELEASE_DIR/$ZIP_NAME"

echo "5. Creating distributable DMG image..."
DMG_STAGE="$OUT_ROOT/dmg-stage"
rm -rf "$DMG_STAGE"
mkdir -p "$DMG_STAGE"
cp -R "$APP_OUT" "$DMG_STAGE/Copilot Proxy.app"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create \
  -volname "Copilot Proxy ${VERSION}" \
  -srcfolder "$DMG_STAGE" \
  -ov \
  -format UDZO \
  "$RELEASE_DIR/$DMG_NAME" >/dev/null
rm -rf "$DMG_STAGE"

echo "6. Computing SHA-256 checksums..."
(cd "$RELEASE_DIR" && shasum -a 256 "$DMG_NAME" "$ZIP_NAME" > SHA256SUMS.txt)

echo "Packaged app: $APP_OUT"
du -sh "$APP_OUT"
ls -lh "$RELEASE_DIR"
cat "$RELEASE_DIR/SHA256SUMS.txt"
