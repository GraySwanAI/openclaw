# Gray Swan Cygnal Guardrail

Runs the Gray Swan Cygnal `/cygnal/monitor` endpoint across guardrail stages to
inspect and optionally block inputs, tool calls, tool results, and outputs.

## What this does

This plugin sends a message list to Cygnal for evaluation and applies a
threshold-based decision. It can:

- Block before model calls (`before_request`)
- Block tool calls (`before_tool_call`)
- Mutate or replace tool results (`after_tool_call`)
- Replace assistant responses (`after_response`)
- Run in `monitor` mode to only log violations

## Configuration

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
          "cygnalBypass": false,
          "failOpen": true,
          "guardrailPriority": 80,
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

## Notes

- `apiKey` can be omitted if `GRAYSWAN_API_KEY` is set.
- `apiBase` defaults to `https://api.grayswan.ai` (or `GRAYSWAN_API_BASE`).
- `policyId` is optional and maps to `policy_id` in the monitor request.
- `categories` and `reasoningMode` are forwarded to Cygnal.
- `cygnalBypass: true` sets `metadata.cygnal_bypass=true` in requests so Cygnal runs in monitor-only bypass mode (returns violation score `0`).
- Monitor requests also include `metadata.openclaw_model_provider` and `metadata.openclaw_model_id` so Cygnal can attribute traffic to the runtime model/provider used by OpenClaw.
- `violationThreshold` can be set globally or per stage.
- `blockOnMutation` and `blockOnIpi` default to `true` only for `afterToolCall`.
- `guardrailPriority` controls execution order when multiple guardrails run.
