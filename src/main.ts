#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { debug } from "./debug"
import { start } from "./start"
import { stop } from "./stop"

const main = defineCommand({
  meta: {
    name: "copilot-proxy-api",
    description:
      "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.",
  },
  subCommands: { auth, start, stop, "check-usage": checkUsage, debug },
})

await runMain(main)
