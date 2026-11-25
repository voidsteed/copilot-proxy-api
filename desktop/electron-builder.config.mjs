import { existsSync, realpathSync } from "node:fs"
import path from "node:path"

import desktopPackage from "./package.json" with { type: "json" }

const root = import.meta.dirname
const version = desktopPackage.version
const buildNumber =
  process.env.COPILOT_PROXY_BUILD_NUMBER
  || version.split(".").at(-1)?.replaceAll(/\D+/gu, "")
  || "1"
const distDirectory = path.resolve(root, "dist")
const dist =
  existsSync(distDirectory) ? realpathSync(distDirectory) : distDirectory

export default {
  appId: "com.voidsteed.copilotproxy",
  productName: "Copilot Proxy",
  buildVersion: `${version}.${buildNumber}`,
  directories: {
    output: process.env.COPILOT_PROXY_PACKAGE_OUTPUT || "release",
    buildResources: "assets",
  },
  files: [
    {
      from: dist,
      to: "dist",
      filter: ["main.cjs", "preload.cjs", "renderer/**"],
    },
    "assets/**",
    "package.json",
  ],
  extraResources: [
    {
      from: dist,
      to: "app.asar.unpacked/dist",
      filter: ["engine.cjs"],
    },
  ],
  asar: true,
  asarUnpack: [
    "node_modules/pdf-parse/**",
    "node_modules/pdfjs-dist/**",
    "node_modules/@napi-rs/**",
  ],
  npmRebuild: false,
  publish: null,
  mac: {
    bundleVersion: buildNumber,
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
    executableName: "copilot-proxy",
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
    executableName: "copilot-proxy",
    target: [
      { target: "AppImage", arch: ["x64", "arm64"] },
      { target: "deb", arch: ["x64", "arm64"] },
    ],
  },
}
