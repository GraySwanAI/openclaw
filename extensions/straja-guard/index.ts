/**
 * OpenClaw Straja Guardrail Plugin
 *
 * Integrates Straja Guard API + Toolgate with OpenClaw guardrail hooks.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import crypto from "node:crypto";
import {
  emptyPluginConfigSchema,
  type BaseStageConfig,
  type GuardrailBaseConfig,
  type OpenClawPluginApi,
  extractTextFromContent,
  isStageEnabled,
  resolveStageConfig,
} from "openclaw/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

type StrajaStageConfig = BaseStageConfig;

type StrajaGuardConfig = GuardrailBaseConfig & {
  /** Straja base URL (defaults to http://localhost:8080). */
  baseUrl?: string;
  /** Straja project API key (optional for local dev). */
  apiKey?: string;
  /** Timeout for Straja requests (ms). */
  timeoutMs?: number;
  stages?: {
    beforeRequest?: StrajaStageConfig;
    beforeToolCall?: StrajaStageConfig;
    afterResponse?: StrajaStageConfig;
  };
};

type GuardApiResponse = {
  request_id?: string;
  decision?: string;
  action?: string;
  sanitized_text?: string | null;
  reasons?: Array<{ category?: string; rule?: string }>;
  policy_hits?: Array<{ category?: string; action?: string; details?: string }>;
};

type ToolgateResponse = {
  request_id?: string;
  decision?: string;
  hits?: Array<{ rule_id?: string; category?: string; action?: string }>;
};

type GuardErrorBody = {
  error?: { message?: string; code?: string; category?: string; request_id?: string };
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_BASE_URL = "http://localhost:8080";
const DEFAULT_TIMEOUT_MS = 15_000;

// ============================================================================
// Helpers
// ============================================================================

function resolveBaseUrl(cfg: StrajaGuardConfig): string {
  const base =
    cfg.baseUrl?.trim() ||
    process.env.STRAJA_GUARD_BASE_URL?.trim() ||
    process.env.STRAJA_BASE_URL?.trim() ||
    DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
}

function resolveApiKey(cfg: StrajaGuardConfig): string | undefined {
  const key = cfg.apiKey?.trim();
  if (key) {
    return key;
  }
  return (
    process.env.STRAJA_GUARD_API_KEY?.trim() ||
    process.env.STRAJA_API_KEY?.trim() ||
    process.env.STRAJA_KEY?.trim() ||
    undefined
  );
}

function resolveTimeoutMs(cfg: StrajaGuardConfig): number {
  return typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0
    ? cfg.timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

function toGuardRole(role: unknown): string | null {
  if (role === "tool" || role === "toolResult") {
    return "tool";
  }
  if (
    role === "system" ||
    role === "developer" ||
    role === "user" ||
    role === "assistant"
  ) {
    return role;
  }
  return null;
}

function toGuardMessages(messages: AgentMessage[]): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (const message of messages) {
    const role = toGuardRole((message as { role?: unknown }).role);
    if (!role) {
      continue;
    }
    const content = extractTextFromContent((message as { content?: unknown }).content).trim();
    if (!content) {
      continue;
    }
    out.push({ role, content });
  }
  return out;
}

function getSessionKey(ctx: { sessionKey?: string } | undefined): {
  key: string;
  persistent: boolean;
} {
  const key = ctx?.sessionKey?.trim();
  if (key) {
    return { key, persistent: true };
  }
  return { key: crypto.randomUUID(), persistent: false };
}

function resolveAction(resp: GuardApiResponse): "allow" | "block" | "modify" {
  const action = resp.action?.trim();
  if (action === "allow" || action === "block" || action === "modify") {
    return action;
  }
  const decision = resp.decision?.trim();
  if (decision === "redact") {
    return "modify";
  }
  if (decision === "block") {
    return "block";
  }
  return "allow";
}

function summarizeDecision(resp: GuardApiResponse): string {
  const reason = resp.reasons?.find((r) => (r.rule ?? "").trim());
  if (reason?.rule) {
    return reason.rule;
  }
  const hit = resp.policy_hits?.find((h) => (h.details ?? "").trim());
  if (hit?.details) {
    return hit.details;
  }
  return resp.decision ?? "blocked";
}

function parseGuardError(body: GuardErrorBody | null): string | null {
  const message = body?.error?.message?.trim();
  return message || null;
}

async function postJson<T>(params: {
  url: string;
  apiKey?: string;
  timeoutMs: number;
  body: Record<string, unknown>;
}): Promise<{ status: number; ok: boolean; data: T | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (params.apiKey) {
      headers.Authorization = `Bearer ${params.apiKey}`;
    }
    const response = await fetch(params.url, {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

function updateLastUserMessage(messages: AgentMessage[], text: string): AgentMessage[] | undefined {
  let updated = false;
  const out = messages.map((message) => ({ ...message } as AgentMessage));
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const msg = out[i] as AgentMessage & { role?: unknown };
    if (msg.role !== "user") {
      continue;
    }
    out[i] = {
      ...msg,
      content: [{ type: "text", text }],
    } as AgentMessage;
    updated = true;
    break;
  }
  return updated ? out : undefined;
}

// ============================================================================
// Plugin Definition
// ============================================================================

const plugin = {
  id: "straja-guard",
  name: "Straja Guard",
  description: "Straja Guard API + Toolgate guardrail integration",

  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as StrajaGuardConfig;
    const baseUrl = resolveBaseUrl(config);
    const apiKey = resolveApiKey(config);
    const timeoutMs = resolveTimeoutMs(config);
    const requestIdBySession = new Map<string, string>();

    const guardrailPriority =
      typeof config.guardrailPriority === "number" && Number.isFinite(config.guardrailPriority)
        ? config.guardrailPriority
        : 50;

    const failOpen = config.failOpen !== false;

    const logWarning = (message: string) => api.logger.warn(`straja-guard: ${message}`);

    const callGuardRequest = async (params: {
      prompt: string;
      messages: AgentMessage[];
      sessionKey?: string;
    }) => {
      const payload: Record<string, unknown> = {
        input_text: params.prompt,
        messages: toGuardMessages(params.messages),
        metadata: {
          source: "openclaw",
          ...(params.sessionKey ? { session_id: params.sessionKey } : {}),
        },
      };

      const result = await postJson<GuardApiResponse>({
        url: `${baseUrl}/v1/guard/request`,
        apiKey,
        timeoutMs,
        body: payload,
      });

      if (result.status === 403) {
        const reason = parseGuardError(result.data as GuardErrorBody) || "Request blocked.";
        return { action: "block" as const, reason };
      }

      if (!result.ok || !result.data) {
        throw new Error(`Guard request failed (${result.status})`);
      }

      const action = resolveAction(result.data);
      const reason = summarizeDecision(result.data);
      const sanitized = result.data.sanitized_text ?? null;
      const requestId = result.data.request_id?.trim() || "";
      return { action, reason, sanitized, requestId, decision: result.data.decision };
    };

    const callGuardResponse = async (params: {
      requestId: string;
      outputText: string;
      sessionKey?: string;
      streaming?: boolean;
    }) => {
      const payload: Record<string, unknown> = {
        request_id: params.requestId,
        output_text: params.outputText,
        metadata: {
          source: "openclaw",
          ...(params.sessionKey ? { session_id: params.sessionKey } : {}),
          ...(typeof params.streaming === "boolean" ? { streaming: params.streaming } : {}),
        },
      };

      const result = await postJson<GuardApiResponse>({
        url: `${baseUrl}/v1/guard/response`,
        apiKey,
        timeoutMs,
        body: payload,
      });

      if (result.status === 403) {
        const reason = parseGuardError(result.data as GuardErrorBody) || "Response blocked.";
        return { action: "block" as const, reason };
      }

      if (!result.ok || !result.data) {
        throw new Error(`Guard response failed (${result.status})`);
      }

      const action = resolveAction(result.data);
      const reason = summarizeDecision(result.data);
      const sanitized = result.data.sanitized_text ?? null;
      return { action, reason, sanitized, decision: result.data.decision };
    };

    const callToolgate = async (params: { toolName: string; args: Record<string, unknown> }) => {
      const payload: Record<string, unknown> = {
        tool_name: params.toolName,
        args: params.args,
        context: {
          source: "openclaw",
        },
      };

      const result = await postJson<ToolgateResponse | GuardErrorBody>({
        url: `${baseUrl}/v1/toolgate/check`,
        apiKey,
        timeoutMs,
        body: payload,
      });

      if (result.status === 403) {
        const reason = parseGuardError(result.data as GuardErrorBody) || "Tool blocked.";
        return { decision: "block" as const, reason };
      }

      if (!result.ok || !result.data) {
        throw new Error(`Toolgate check failed (${result.status})`);
      }

      const response = result.data as ToolgateResponse;
      const decision = response.decision?.trim() || "allow";
      return { decision, reason: "" };
    };

    const beforeRequestCfg = resolveStageConfig(config.stages, "before_request");
    if (isStageEnabled(beforeRequestCfg)) {
      api.on(
        "before_request",
        async (event, ctx) => {
          const prompt = event.prompt.trim();
          if (!prompt) {
            return;
          }
          const sessionKey = ctx.sessionKey?.trim();
          const session = getSessionKey(ctx);

          try {
            const result = await callGuardRequest({
              prompt,
              messages: event.messages ?? [],
              sessionKey,
            });

            if (result.action === "block") {
              if (session.persistent) {
                requestIdBySession.delete(session.key);
              }
              return { block: true, blockResponse: result.reason };
            }

            if (result.requestId) {
              if (session.persistent) {
                requestIdBySession.set(session.key, result.requestId);
              }
            }

            if (result.action === "modify") {
              const sanitized = result.sanitized ?? prompt;
              const updatedMessages = updateLastUserMessage(event.messages ?? [], sanitized);
              return {
                prompt: sanitized,
                messages: updatedMessages ?? event.messages,
              };
            }

            if (result.decision === "warn") {
              logWarning(`pre-model warning: ${result.reason}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logWarning(`pre-model check failed: ${msg}`);
            if (!failOpen) {
              return { block: true, blockResponse: "Request blocked by guardrail failure." };
            }
          }

          return;
        },
        { priority: guardrailPriority },
      );
    }

    const beforeToolCallCfg = resolveStageConfig(config.stages, "before_tool_call");
    if (isStageEnabled(beforeToolCallCfg)) {
      api.on(
        "before_tool_call",
        async (event) => {
          try {
            const result = await callToolgate({
              toolName: event.toolName,
              args: event.params,
            });

            if (result.decision === "block") {
              return { block: true, blockReason: result.reason || "Tool call blocked." };
            }

            if (result.decision === "warn") {
              logWarning(`toolgate warning: tool=${event.toolName}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logWarning(`toolgate check failed: ${msg}`);
            if (!failOpen) {
              return { block: true, blockReason: "Tool call blocked by guardrail failure." };
            }
          }
          return;
        },
        { priority: guardrailPriority },
      );
    }

    const afterResponseCfg = resolveStageConfig(config.stages, "after_response");
    if (isStageEnabled(afterResponseCfg)) {
      api.on(
        "after_response",
        async (event, ctx) => {
          const outputText =
            event.assistantTexts.join("\n").trim() ||
            (event.lastAssistant
              ? extractTextFromContent(event.lastAssistant.content).trim()
              : "");
          if (!outputText) {
            return;
          }

          const sessionKey = ctx.sessionKey?.trim();
          const session = getSessionKey(ctx);
          const requestId = session.persistent ? requestIdBySession.get(session.key) || "" : "";

          try {
            const result = await callGuardResponse({
              requestId: requestId || `openclaw-${crypto.randomUUID()}`,
              outputText,
              sessionKey,
            });

            if (session.persistent) {
              requestIdBySession.delete(session.key);
            }

            if (result.action === "block") {
              return { block: true, blockResponse: result.reason };
            }

            if (result.action === "modify") {
              const sanitized = result.sanitized ?? outputText;
              return { assistantTexts: [sanitized] };
            }

            if (result.decision === "warn") {
              logWarning(`post-model warning: ${result.reason}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logWarning(`post-model check failed: ${msg}`);
            if (!failOpen) {
              return { block: true, blockResponse: "Response blocked by guardrail failure." };
            }
          }

          return;
        },
        { priority: guardrailPriority },
      );
    }
  },
};

const pluginWithSchema = {
  ...plugin,
  configSchema: emptyPluginConfigSchema(),
};

export default pluginWithSchema;
export type { StrajaGuardConfig };
