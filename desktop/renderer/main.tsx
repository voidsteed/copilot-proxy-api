import React from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { ErrorBoundary } from "./components"
import "./styles.css"

const root = document.querySelector("#root")
if (!root) throw new Error("Copilot Proxy could not find its application root.")

createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
