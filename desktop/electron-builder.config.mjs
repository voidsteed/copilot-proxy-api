import { realpathSync } from "node:fs"
import path from "node:path"

const root = import.meta.dirname

export default {
  appId: "com.voidsteed.copilotbridge",
  productName: "Copilot Bridge",
  buildVersion: "0.0.1.1",
  directories: {
    output: process.env.COPILOT_BRIDGE_PACKAGE_OUTPUT || "release",
    buildResources: "assets",
  },
  files: [
    {
      from: realpathSync(path.join(root, "dist")),
      to: "dist",
      filter: ["main.cjs", "preload.cjs", "engine.cjs", "renderer/**"],
    },
    "assets/**",
    "package.json",
  ],
  asar: true,
  asarUnpack: [
    "**/engine.cjs",
    "node_modules/pdf-parse/**",
    "node_modules/pdfjs-dist/**",
    "node_modules/@napi-rs/**",
  ],
  npmRebuild: false,
  publish: null,
  mac: {
    bundleVersion: "1",
    category: "public.app-category.developer-tools",
    icon: "assets/icon.png",
    hardenedRuntime: true,
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
  },
  win: {
    icon: "assets/icon.png",
    executableName: "copilot-bridge",
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
  },
  linux: {
    icon: "assets/icon.png",
    category: "Development",
    executableName: "copilot-bridge",
    target: [
      { target: "AppImage", arch: ["x64", "arm64"] },
      { target: "deb", arch: ["x64", "arm64"] },
    ],
  },
}
