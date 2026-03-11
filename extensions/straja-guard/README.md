# Straja Guard (OpenClaw)

Integrates Straja Guard API + Toolgate with OpenClaw guardrail hooks to enforce:

- pre-model prompt checks
- post-model response checks
- pre-execution tool checks

## Configuration

```json
{
  "plugins": {
    "entries": {
      "straja-guard": {
        "enabled": true,
        "config": {
          "baseUrl": "http://localhost:8080",
          "apiKey": "project-api-key-from-straja-config",
          "timeoutMs": 15000,
          "failOpen": true,
          "guardrailPriority": 80,
          "stages": {
            "beforeRequest": { "enabled": true, "mode": "block" },
            "beforeToolCall": { "enabled": true, "mode": "block" },
            "afterResponse": { "enabled": true, "mode": "monitor" }
          }
        }
      }
    }
  }
}
```

## Notes

- `baseUrl` defaults to `http://localhost:8080`.
- `apiKey` should match one of the `projects[].api_keys` values in your Straja config.
- `failOpen` controls whether hook failures allow traffic by default.
- Post-model blocking is skipped for streaming responses and logged as a warning.
