import config from "@echristian/eslint-config"

export default [
  {
    // Git worktrees live inside the repo, so a bare `eslint .` descends into
    // them and lints a second copy of every file — including build output —
    // under a path that none of this config's globs match. Each worktree lints
    // itself with its own checkout of this file.
    ignores: [".claude/worktrees/**"],
  },

  ...config({
    prettier: {
      plugins: ["prettier-plugin-packagejson"],
    },
  }),

  {
    files: ["desktop/renderer/**/*.tsx"],
    rules: {
      "max-lines-per-function": [
        "error",
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
      complexity: "off",
    },
  },

  {
    files: [
      "desktop/main/index.ts",
      "desktop/testing/preview-entry.ts",
      "desktop/testing/live-check.ts",
    ],
    rules: { "unicorn/prefer-module": "off" },
  },

  {
    files: ["desktop/main/smoke.ts"],
    rules: { "max-lines-per-function": "off" },
  },
]
