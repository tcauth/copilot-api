# Codex provider compatibility

This opt-in provider keeps the normal Codex CLI and `@openai/codex-sdk`
harness. Only model traffic changes:

```text
application -> Codex SDK/CLI harness -> copilot-api /v1/responses
            -> GitHub Copilot Chat Completions
```

The compatibility target was recorded on 2026-11-19:

- `@openai/codex-sdk` and `@openai/codex` `0.171.0-alpha.1`
- `openai/codex` commit
  `ffa05c8bfb7572f1b4139e775324bfd284f1cbe5`
- Codex custom-provider wire protocol: HTTP `POST /v1/responses` with
  `wire_api = "responses"` and SSE Responses events

## Codex CLI configuration

Start `copilot-api`, then choose a model returned by its `GET /v1/models`
endpoint. Add the following to `~/.codex/config.toml`:

```toml
model = "gpt-5.3-codex"
model_provider = "github-copilot-proxy"

[model_providers.github-copilot-proxy]
name = "GitHub Copilot through copilot-api"
base_url = "http://127.0.0.1:4141/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 1
stream_max_retries = 1
```

Replace `gpt-5.3-codex` if it is not in `GET /v1/models`. Model names are
validated against the current Copilot catalog.

`requires_openai_auth = false` means Codex sends no OpenAI credential to the
local proxy. `copilot-api` continues to obtain and refresh its GitHub Copilot
token through its existing authentication flow. The Responses route does not
accept or persist provider credentials. Bind the proxy only to a trusted
interface.

For `@openai/codex-sdk`, the CLI reads the same `config.toml`. An isolated
configuration can also be passed without replacing the Codex harness:

```ts
import { Codex } from "@openai/codex-sdk"

const codex = new Codex({
  config: {
    model: "gpt-5.3-codex",
    model_provider: "github-copilot-proxy",
  },
  configOverrides: [
    'model_providers.github-copilot-proxy={name="GitHub Copilot through copilot-api",base_url="http://127.0.0.1:4141/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}',
  ],
})
```

Do not use the SDK `baseUrl` convenience option for this setup. It overrides
the built-in OpenAI provider rather than defining this explicit custom
provider.

## Supported subset

The adapter supports full-history message input, developer/system/user and
assistant messages, URL/data-URL images, function declarations, function
calls and results, parallel function calls, structured JSON-schema output,
reasoning effort, verbosity, streaming text/tool-call events, request
cancellation, response IDs, and token usage.

The following Responses features cannot be represented faithfully by
Copilot's Chat Completions surface:

- `store=true`, `previous_response_id`, service tiers, and automatic
  truncation are rejected.
- Provider-hosted tools such as `web_search` and custom/freeform tools are
  rejected. Codex local function tools continue to work.
- Reasoning summaries and encrypted reasoning content are not returned.
  Codex's usual `summary = "auto"` and
  `include = ["reasoning.encrypted_content"]` requests are accepted so the
  harness remains usable, but the response contains no reasoning item.
- File-ID images and audio input are rejected; use image URLs or data URLs.
- WebSocket Responses transport is not supported.

Upstream Copilot HTTP status codes and error bodies are forwarded through the
existing proxy error path. SSE writes are awaited for backpressure, and an
aborted Codex request aborts the upstream Copilot fetch.
