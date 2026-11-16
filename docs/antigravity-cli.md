# Use Antigravity CLI with Copilot Google models

Antigravity CLI can use the proxy's Gemini-compatible API with Google models available to your GitHub Copilot account. The proxy uses its existing Copilot account. Antigravity receives a local proxy key. This setup targets Antigravity CLI, not the standalone Antigravity IDE.

## Connect the CLI

Start a proxy gateway built from source that includes the Gemini routes. An older gateway does not gain these routes when you start a newer client. A CLI command can also attach to an older native or CLI gateway that is already running. Check the actual endpoint before use.

To keep an older gateway running, start an independent instance on another port with your existing saved Copilot login:

```sh
bun run start start --standalone --port 4143 --api-key "your-local-proxy-key"
```

`--standalone` uses the normal API server in the current process. The default start command still connects to the shared desktop gateway. Use a different port for the independent instance.

Set the gateway origin and its local API key:

```sh
export GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:4143"
export GEMINI_API_KEY="your-local-proxy-key"
```

Use a key configured through the proxy's `--api-key` option. If the gateway accepts unauthenticated loopback requests, the CLI still requires a nonempty placeholder. Do not put a GitHub access token or Google account token in this variable. The base URL has no `/v1` or `/v1beta` suffix.

Check the models available through this gateway:

```sh
curl --fail-with-body \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  "$GOOGLE_GEMINI_BASE_URL/v1beta/models"
```

The list contains actual Copilot Google models that support Chat Completions. It refreshes the upstream catalog. Copy an exact ID after `models/` from a returned model name. A 404 for the models endpoint indicates an older gateway or an incorrect base URL.

Launch Antigravity CLI with a session-only provider setting:

```sh
agy --settings '{"modelProvider":"gemini"}' --model gemini-3.8-flash
```

To select Carbon when the catalog contains `models/gemini-4-carbon`:

```sh
agy --settings '{"modelProvider":"gemini"}' --model gemini-4-carbon
```

The proxy keeps the selected model ID. It does not substitute Flash or Argon for Carbon. Model availability and provider errors follow the Copilot account.

## Supported requests

| Feature | Behavior |
| --- | --- |
| Model discovery | `GET /v1beta/models` and `GET /v1beta/models/{id}` expose Google Chat models from Copilot. |
| Text | `POST /v1beta/models/{id}:generateContent` returns Gemini candidates and known token counts. |
| Streaming | `POST /v1beta/models/{id}:streamGenerateContent?alt=sse` emits text and supplied thoughts as they arrive. |
| Output limit | The effective maximum is the smaller of the requested maximum and Copilot's advertised output limit. A lower requested ceiling stays lower. |
| Thinking | LOW, MEDIUM, and HIGH map to the same reasoning effort only when the model advertises it. |
| Tools | JSON Schema declarations, structured arguments and results, call IDs, and representable thought signatures survive continuation. |
| CLI tool history | Response-only function results work with the model role emitted by Antigravity CLI 1.5.9. |
| Images | Inline PNG, JPEG, and WebP work when the selected model advertises vision. |
| Access and history | Both proxy gateways accept `x-goog-api-key`. Existing key policies, rate limits, approval, usage, and activity recording still apply. |
| Cancellation | Client cancellation aborts the upstream request and releases the stream reader. |

Unsupported fields and lossy conversions return explicit errors. These include cached content, custom safety settings, token-based thinking budgets, remote media, multiple candidates, response-schema constraints, and multiple distinct signatures in one model turn. Streaming requires `alt=sse`. The proxy does not implement Gemini Interactions or `countTokens`. It does not invent safety ratings, signatures, or missing usage values.

## Verification

The tests cover the observed CLI request with 14 JSON Schema tool declarations, a 65,536-token output limit, and MEDIUM thinking. They also cover ordered parallel tools, opaque signatures, the CLI's model-role tool result, incremental text before the final chunk, errors, local authentication, activity, and cancellation.

```sh
bun test tests/gemini-route.test.ts tests/gemini-stream.test.ts
bun test tests/shared-transport.test.ts tests/shared-observability.test.ts tests/shared-desktop-boundary.test.ts
bun run desktop:test
```

Exact private CLI captures can be replayed with `GEMINI_CLI_HISTORY_FIXTURE`; the normal tests retain a portable regression for the same role and call semantics. A fake upstream checks protocol behavior. A live Copilot request and an actual CLI run are separate acceptance checks. Session-only `--settings` does not isolate the CLI's on-disk state.

Official references: [CLI authentication](https://antigravity.google/docs/authenticate/?tab=cli), [Antigravity models](https://antigravity.google/docs/models/?tab=cli), and [Gemini generateContent](https://aistudio.google.com/api-reference/generate-content/generate-content).
