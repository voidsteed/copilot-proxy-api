import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    target: "es2022",
  },
  server: { host: "127.0.0.1" },
})
