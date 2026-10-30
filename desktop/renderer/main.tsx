import React from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import "./styles.css"

const root = document.querySelector("#root")
if (!root)
  throw new Error("Copilot Bridge could not find its application root.")

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
