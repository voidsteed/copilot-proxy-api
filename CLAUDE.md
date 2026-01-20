# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A reverse-engineered proxy for GitHub Copilot API that exposes it as an OpenAI and Anthropic compatible service. Allows using GitHub Copilot with tools that support OpenAI Chat Completions API (`/v1/chat/completions`), OpenAI Responses API (`/v1/responses`), or Anthropic Messages API (`/v1/messages`), including Claude Code and Codex CLI.

## Common Commands

```bash
bun run dev          # Development with hot reload
bun run start        # Production
bun run build        # Build for distribution (uses tsdown)
bun run typecheck    # Type checking
bun run lint         # Lint staged files
bun run lint:all     # Lint all files
bun test             # Run all tests
bun test tests/anthropic-request.test.ts  # Run a specific test
```

## Architecture

### Entry Points & CLI Structure
- `src/main.ts` - CLI entry point using `citty` for subcommand structure
- Subcommands: `start` (server), `auth` (authentication), `check-usage`, `debug`
- `src/start.ts` - Main server startup logic
- `src/server.ts` - Hono HTTP server with route mounting

### Request Flow
1. **OpenAI endpoints** (`/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/embeddings`) - pass through to Copilot API directly
2. **Anthropic endpoints** (`/v1/messages`) - translate Anthropic format to OpenAI, call Copilot, translate response back

### Route Structure
```
src/routes/
├── chat-completions/   # OpenAI compatible - direct passthrough
├── responses/          # OpenAI Responses API - translates to Chat Completions
│   ├── handler.ts              # Main request handler with streaming
│   ├── translation.ts          # Responses <-> Chat Completions conversion
│   └── types.ts                # Type definitions
├── messages/           # Anthropic compatible - requires translation
│   ├── handler.ts              # Main request handler
│   ├── non-stream-translation.ts  # Anthropic <-> OpenAI payload/response conversion
│   ├── stream-translation.ts      # Streaming chunk translation
│   └── anthropic-types.ts         # Type definitions
├── models/             # Model listing
├── embeddings/         # Embedding generation
├── usage/              # Copilot usage statistics
└── token/              # Token endpoint
```

### Key Translation Logic
`src/routes/messages/non-stream-translation.ts` is the core file for Anthropic API compatibility:
- `translateToOpenAI()` - converts Anthropic request payload to OpenAI format
- `translateToAnthropic()` - converts OpenAI response to Anthropic format
- `translateModelName()` - maps Claude Code model names to GitHub Copilot model names (critical for model compatibility)

### Shared State
`src/lib/state.ts` - Global mutable state object holding:
- GitHub/Copilot tokens
- Account type (individual/business/enterprise)
- Cached models
- Rate limiting configuration

### Copilot API Services
```
src/services/
├── copilot/
│   ├── create-chat-completions.ts  # Main completion endpoint
│   ├── create-embeddings.ts
│   └── get-models.ts
└── github/
    ├── get-copilot-token.ts  # Token refresh logic
    ├── get-device-code.ts    # OAuth device flow
    └── poll-access-token.ts
```

### Configuration
- `src/lib/api-config.ts` - Copilot API URLs, headers, and version constants
- Base URL varies by account type: `api.githubcopilot.com` (individual) vs `api.{type}.githubcopilot.com`

## Path Aliases

Uses `~/` to reference `src/` directory (configured in tsconfig.json):
```typescript
import { state } from "~/lib/state"
```

## Testing

Tests use `bun:test` and focus on translation logic validation:
- `tests/anthropic-request.test.ts` - Anthropic to OpenAI payload translation
- `tests/anthropic-response.test.ts` - OpenAI to Anthropic response translation
- Uses Zod schemas to validate translated payloads match OpenAI spec

## Detailed Architecture

### High-Level System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT APPLICATIONS                             │
│         (Claude Code, Codex CLI, OpenAI-compatible tools, Anthropic-compatible tools)   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
                    ▼                                   ▼
        ┌───────────────────────┐           ┌───────────────────────┐
        │  /v1/chat/completions │           │     /v1/messages      │
        │  /v1/responses        │           │   (Anthropic format)  │
        │    (OpenAI format)    │           └───────────────────────┘
        └───────────────────────┘                       │
                    │                                   ▼
                    │                       ┌───────────────────────┐
                    │                       │   translateToOpenAI() │
                    │                       │  (Anthropic → OpenAI) │
                    │                       └───────────────────────┘
                    │                                   │
                    └─────────────────┬─────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │         COPILOT API PROXY           │
                    │  ┌───────────────────────────────┐  │
                    │  │     Rate Limiting Check       │  │
                    │  │     Token Management          │  │
                    │  │     Header Construction       │  │
                    │  └───────────────────────────────┘  │
                    └─────────────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │       GITHUB COPILOT API            │
                    │   api.githubcopilot.com             │
                    │   api.business.githubcopilot.com    │
                    │   api.enterprise.githubcopilot.com  │
                    └─────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
                    ▼                                   ▼
        ┌───────────────────────┐           ┌───────────────────────┐
        │   OpenAI Response     │           │ translateToAnthropic()│
        │   (direct return)     │           │  (OpenAI → Anthropic) │
        └───────────────────────┘           └───────────────────────┘
```

### Authentication Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    User      │     │  copilot-api │     │   GitHub     │     │ Copilot API  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │                    │
       │  copilot-api auth  │                    │                    │
       │───────────────────>│                    │                    │
       │                    │                    │                    │
       │                    │ POST /login/device/code                 │
       │                    │───────────────────>│                    │
       │                    │                    │                    │
       │                    │ {device_code, user_code, verification_uri}
       │                    │<───────────────────│                    │
       │                    │                    │                    │
       │ "Enter code XXXX   │                    │                    │
       │  at github.com/..." │                    │                    │
       │<───────────────────│                    │                    │
       │                    │                    │                    │
       │ User enters code   │                    │                    │
       │─────────────────────────────────────────>                    │
       │                    │                    │                    │
       │                    │ POST /login/oauth/access_token (poll)   │
       │                    │───────────────────>│                    │
       │                    │                    │                    │
       │                    │ {access_token}     │                    │
       │                    │<───────────────────│                    │
       │                    │                    │                    │
       │                    │ Save to ~/.local/share/copilot-api/github_token
       │                    │                    │                    │
       │                    │ GET /copilot_internal/v2/token          │
       │                    │───────────────────>│                    │
       │                    │                    │                    │
       │                    │ {token, refresh_in, expires_at}         │
       │                    │<───────────────────│                    │
       │                    │                    │                    │
       │                    │ Start refresh interval (refresh_in - 60s)
       │                    │                    │                    │
       │  Ready!            │                    │                    │
       │<───────────────────│                    │                    │
```

### Request Flow: Anthropic Messages Endpoint

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         POST /v1/messages                                   │
│                        (Anthropic Format)                                   │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  1. Parse AnthropicMessagesPayload                                          │
│     - model, messages, system, max_tokens, tools, stream                    │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  2. translateToOpenAI()                                                     │
│     ┌────────────────────────────────────────────────────────────────────┐ │
│     │ • translateModelName() - Map Claude names to Copilot names          │ │
│     │ • translateAnthropicMessagesToOpenAI() - Convert message format     │ │
│     │ • translateAnthropicToolsToOpenAI() - Convert tool definitions      │ │
│     │ • translateAnthropicToolChoiceToOpenAI() - Convert tool_choice      │ │
│     └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  3. Rate Limit Check                                                        │
│     - If exceeded and !rateLimitWait → HTTP 429                             │
│     - If exceeded and rateLimitWait → sleep until allowed                   │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  4. createChatCompletions(openAIPayload)                                    │
│     - Add Copilot headers (Authorization, editor-version, etc.)             │
│     - POST to api.githubcopilot.com/chat/completions                        │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
            stream: false                    stream: true
                    │                               │
                    ▼                               ▼
┌─────────────────────────────┐   ┌─────────────────────────────────────────┐
│  5a. Non-Streaming          │   │  5b. Streaming                          │
│  translateToAnthropic()     │   │  translateChunkToAnthropicEvents()      │
│  - Map text/tool_use blocks │   │  - Emit message_start                   │
│  - Map stop_reason          │   │  - Emit content_block_start/delta/stop  │
│  - Calculate token usage    │   │  - Emit message_delta                   │
│  → Return JSON              │   │  - Emit message_stop                    │
└─────────────────────────────┘   │  → Return SSE stream                    │
                                  └─────────────────────────────────────────┘
```

### Model Name Mapping

| Input (Claude Code)          | Output (GitHub Copilot) |
|------------------------------|-------------------------|
| `haiku`                      | `claude-haiku-4.5`      |
| `sonnet`                     | `claude-sonnet-4`       |
| `opus`                       | `claude-opus-4.5`       |
| `claude-3-5-sonnet-*`        | `claude-sonnet-4`       |
| `claude-3.5-sonnet-*`        | `claude-sonnet-4`       |
| `claude-3-5-haiku-*`         | `claude-haiku-4.5`      |
| `claude-3.5-haiku-*`         | `claude-haiku-4.5`      |
| `claude-3-opus-*`            | `claude-opus-4.5`       |
| `claude-sonnet-4-*`          | `claude-sonnet-4`       |
| `claude-opus-4-*`            | `claude-opus-4.5`       |
| `claude-haiku-4-*`           | `claude-haiku-4.5`      |
| `claude-opus-4`              | `claude-opus-4.5`       |
| `claude-haiku-4`             | `claude-haiku-4.5`      |

### Global State Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                        state (src/lib/state.ts)                  │
├─────────────────────────────────────────────────────────────────┤
│  Authentication                                                  │
│  ├── githubToken?: string      # GitHub OAuth token              │
│  └── copilotToken?: string     # Copilot API token (auto-refresh)│
├─────────────────────────────────────────────────────────────────┤
│  Configuration                                                   │
│  ├── accountType: string       # "individual"|"business"|"enterprise"
│  ├── vsCodeVersion?: string    # Emulated VS Code version        │
│  └── models?: ModelsResponse   # Cached available models         │
├─────────────────────────────────────────────────────────────────┤
│  Runtime Options                                                 │
│  ├── manualApprove: boolean    # Require manual request approval │
│  ├── rateLimitWait: boolean    # Wait vs reject on rate limit    │
│  ├── showToken: boolean        # Display tokens in logs          │
│  ├── rateLimitSeconds?: number # Seconds between requests        │
│  └── lastRequestTimestamp?: number                               │
└─────────────────────────────────────────────────────────────────┘
```

### Copilot API Headers

```
┌─────────────────────────────────────────────────────────────────┐
│                    copilotHeaders() Construction                 │
├─────────────────────────────────────────────────────────────────┤
│  Authorization:        Bearer ${copilotToken}                    │
│  content-type:         application/json                          │
│  copilot-integration-id: vscode-chat                             │
│  editor-version:       vscode/${vsCodeVersion}                   │
│  editor-plugin-version: copilot-chat/0.26.7                      │
│  user-agent:           GitHubCopilotChat/0.26.7                  │
│  openai-intent:        conversation-panel                        │
│  x-github-api-version: 2025-04-01                                │
│  x-request-id:         ${randomUUID()}                           │
│  X-Initiator:          user | agent                              │
│  copilot-vision-request: true (if images in payload)             │
└─────────────────────────────────────────────────────────────────┘
```

### Key Files Reference

| File | Purpose |
|------|---------|
| `src/main.ts` | CLI entry point with subcommands (auth, start, check-usage, debug) |
| `src/start.ts` | Server initialization and configuration |
| `src/server.ts` | Hono HTTP server with route mounting |
| `src/lib/state.ts` | Global mutable state for tokens and config |
| `src/lib/token.ts` | GitHub/Copilot token setup and refresh |
| `src/lib/api-config.ts` | API URLs, headers, version constants |
| `src/lib/rate-limit.ts` | Request rate limiting logic |
| `src/services/copilot/create-chat-completions.ts` | Core Copilot API call |
| `src/services/github/get-device-code.ts` | OAuth device code flow |
| `src/services/github/get-copilot-token.ts` | Copilot token retrieval |
| `src/routes/chat-completions/handler.ts` | OpenAI endpoint (passthrough) |
| `src/routes/messages/handler.ts` | Anthropic endpoint (with translation) |
| `src/routes/messages/non-stream-translation.ts` | Anthropic ↔ OpenAI payload conversion |
| `src/routes/messages/stream-translation.ts` | Streaming chunk translation |
| `src/routes/messages/anthropic-types.ts` | Anthropic API type definitions |
| `src/routes/responses/handler.ts` | OpenAI Responses API endpoint (with translation) |
| `src/routes/responses/translation.ts` | Responses ↔ Chat Completions conversion |
| `src/routes/responses/types.ts` | Responses API type definitions |
