---
summary: "Guardrail stages, plugin configuration, and available guardrail plugins (Gray Swan, Llama Guard, GPT-OSS-Safeguard)"
read_when:
  - Adding or tuning LLM guardrails
  - Investigating guardrail blocks
  - Configuring Gray Swan, Llama Guard, or GPT-OSS-Safeguard
title: "Guardrails"
---

# Guardrails

Guardrails run inside the OpenClaw agent loop to inspect and optionally modify or block:

- **Requests** before they reach a model
- **Tool calls** before execution
- **Tool results** before they return to the model
- **Assistant responses** before they leave the agent

Guardrails are implemented as plugins using the hook system. See [/gateway/configuration](/gateway/configuration) for config file locations.

## Stages

OpenClaw evaluates stages in this order:

1. `before_request` — inspect and optionally modify the user prompt and message history before the model call.
2. `before_tool_call` — inspect and optionally modify tool call arguments before a tool executes.
3. `after_tool_call` — inspect and optionally modify tool results before they go back to the model.
4. `after_response` — inspect and optionally modify the assistant response before it is returned.

Within a stage, hooks run by descending `priority` (default `0`).
If any hook **blocks**, later hooks do not run for that stage.

## Plugin hook interface

Guardrails are implemented using the plugin hook system. Plugins can register handlers for guardrail stages via `api.on()`:

```ts
// Example plugin registering guardrail hooks
export default {
  id: "my-guardrail",
  register(api) {
    api.on("before_request", async (event, ctx) => {
      // event: { prompt, messages, systemPrompt? }
      // Return to block or modify:
      // { block: true, blockResponse: "..." }
      // { prompt: "modified", messages: [...] }
    }, { priority: 50 });

    api.on("before_tool_call", async (event, ctx) => {
      // event: { toolName, toolCallId, params, messages, systemPrompt? }
      // Return to block or modify:
      // { block: true, blockReason: "...", toolResult?: {...} }
      // { params: { modified: true } }
    }, { priority: 50 });

    api.on("after_tool_call", async (event, ctx) => {
      // event: { toolName, toolCallId, params, result, messages, systemPrompt? }
      // Return to block or modify:
      // { block: true, result: {...} }
      // { result: modifiedResult }
    }, { priority: 50 });

    api.on("after_response", async (event, ctx) => {
      // event: { assistantTexts, messages, lastAssistant? }
      // Return to block or modify:
      // { block: true, blockResponse: "..." }
      // { assistantTexts: ["modified"] }
    }, { priority: 50 });
  }
};
```

Each handler can return a result with:

- `block: true` to stop processing and return a guardrail response
- Modified fields (`prompt`, `messages`, `params`, `result`, `assistantTexts`) to rewrite the payload
- Nothing (or `undefined`) to allow the payload unchanged

### Stage payloads

Each stage receives a different view of the conversation:

- `before_request`: history + the current **user** prompt
- `before_tool_call`: history + a synthetic **assistant** message that summarizes the tool call
- `after_tool_call`: history + a synthetic **tool** message that contains the tool result text
- `after_response`: history + the final **assistant** response text

## Built-in guardrail plugins

### Gray Swan

Gray Swan guardrails use the [Gray Swan Cygnal API](https://grayswan.ai) for content moderation.

Configuration example:

```json
{
  "plugins": {
    "entries": {
      "grayswan-cygnal-guardrail": {
        "enabled": true,
        "config": {
          "apiKey": "${GRAYSWAN_API_KEY}",
          "apiBase": "https://api.grayswan.ai",
          "policyId": "pol_example",
          "violationThreshold": 0.5,
          "timeoutMs": 30000,
          "failOpen": true,
          "stages": {
            "beforeRequest": { "enabled": true, "mode": "block" },
            "beforeToolCall": { "enabled": true, "mode": "block" },
            "afterToolCall": {
              "enabled": true,
              "mode": "block",
              "blockMode": "append",
              "blockOnMutation": true,
              "blockOnIpi": true
            },
            "afterResponse": { "enabled": true, "mode": "block" }
          }
        }
      }
    }
  }
}
```

Notes:

- `apiKey` can be omitted if you set the `GRAYSWAN_API_KEY` environment variable.
- Config supports `${VAR_NAME}` substitution for environment variables.
- `apiBase` defaults to `https://api.grayswan.ai` (or `GRAYSWAN_API_BASE` if set).
- `policyId` maps to `policy_id` in `/cygnal/monitor` requests.
- `categories` and `reasoningMode` are forwarded as `categories` and `reasoning_mode`.

### Llama Guard

Llama Guard guardrails use local inference via Ollama or any OpenAI-compatible endpoint (e.g., OpenRouter) to run [Llama Guard 3 8B](https://github.com/meta-llama/PurpleLlama).

Configuration example:

```json
{
  "plugins": {
    "entries": {
      "llamaguard": {
        "enabled": true,
        "config": {
          "provider": "ollama",
          "model": "llama-guard3:8b",
          "timeoutMs": 30000,
          "failOpen": true,
          "stages": {
            "beforeRequest": { "enabled": true, "mode": "block" },
            "afterResponse": { "enabled": true, "mode": "monitor" }
          }
        }
      }
    }
  }
}
```

Notes:

- Requires Ollama with the model pulled: `ollama pull llama-guard3:8b`
- Local inference adds ~100-500ms latency per check
- Uses the built-in model provider system (supports any provider configured in `auth.profiles`)
- Includes all 14 default Llama Guard 3 safety categories (S1-S14)
- Custom categories can be configured via the `categories` array

### GPT-OSS-Safeguard

GPT-OSS-Safeguard guardrails use local inference via Ollama or any OpenAI-compatible endpoint (e.g., OpenRouter) to run GPT-OSS-Safeguard models.

Configuration example:

```json
{
  "plugins": {
    "entries": {
      "gpt-oss-safeguard": {
        "enabled": true,
        "config": {
          "provider": "openrouter",
          "model": "openai/gpt-oss-safeguard-120b",
          "policy": "Your custom safety policy here...",
          "reasoningEffort": "medium",
          "outputFormat": "json",
          "timeoutMs": 30000,
          "failOpen": true,
          "stages": {
            "beforeRequest": { "enabled": true, "mode": "block" },
            "afterResponse": { "enabled": true, "mode": "monitor" }
          }
        }
      }
    }
  }
}
```

Notes:

- Uses the built-in model provider system (supports any provider configured in `auth.profiles`)
- `policy`: Custom safety policy text (400-600 tokens recommended). If omitted, uses a default policy covering violence, hate speech, CSAM, illegal instructions, and PII.
- `reasoningEffort`: Controls model reasoning depth (`low`, `medium`, `high`). Default: `medium`
- `outputFormat`: Response format from the model:
  - `binary`: Returns `0` (safe) or `1` (violation)
  - `json`: Returns `{"violation": 0|1, "policy_category": "..."}`
  - `rich`: Returns JSON with additional `confidence` and `rationale` fields
- `maxTokens`: Default `500` (higher than Llama Guard to accommodate reasoning output)

## Per-stage options

Each stage can be configured with:

- `enabled`: default `true` when the stage entry exists
- `mode`: `block` or `monitor`
- `blockMode`: `replace` or `append` (defaults to `append` for `afterToolCall`, `replace` for others)
- `includeHistory`: default `true`

**Gray Swan** additionally supports:

- `violationThreshold`: override the default threshold (0.0 to 1.0)
- `blockOnMutation`: default `true` only for `afterToolCall`
- `blockOnIpi`: default `true` only for `afterToolCall`

**Llama Guard** and **GPT-OSS-Safeguard** share common options:

- `provider`: Model provider (e.g., `ollama`, `openrouter`)
- `model`: Model identifier
- `authProfileId`: Optional auth profile for the model provider
- `timeoutMs`: Request timeout in milliseconds (default: 30000)
- `failOpen`: Allow requests on model errors (default: true)
- `maxTokens`: Maximum tokens for model response

## Block behavior

When a guardrail flags a violation and `mode: "block"`:

- `before_request` blocks the model call and returns a guardrail response.
- `before_tool_call` blocks the tool call and returns a synthetic tool result with a guardrail warning.
- `after_tool_call` mutates the tool result before the model sees it:
  - `blockMode: "append"` adds a warning to the tool result content
  - `blockMode: "replace"` replaces the tool result with a guardrail warning
- `after_response` replaces the assistant response (or appends a warning if `blockMode: "append"`).

If `mode: "monitor"`, OpenClaw only logs the evaluation and leaves the payload unchanged.

## Troubleshooting

- Use `openclaw gateway run --verbose` and `openclaw logs --follow` to see guardrail events.
- Guardrail errors follow `failOpen`: when `true`, errors are logged but do not block.
- If you see unexpected blocking, confirm the effective threshold and stage config.
