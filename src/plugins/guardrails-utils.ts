/**
 * Shared utilities for guardrail plugins.
 *
 * Provides common types, content extraction, tool result manipulation,
 * and stage configuration helpers used across guardrail implementations.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";

// ============================================================================
// Types
// ============================================================================

export type GuardrailStage =
  | "before_request"
  | "after_response"
  | "before_tool_call"
  | "after_tool_call";

export type BaseStageConfig = {
  enabled?: boolean;
  mode?: "block" | "monitor";
  blockMode?: "replace" | "append";
  includeHistory?: boolean;
};

export type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<unknown>;

export type EmbeddedAgentResult = {
  payloads?: Array<{ text?: string; isError?: boolean }>;
};

// ============================================================================
// Content Extraction
// ============================================================================

/**
 * Extract text content from various content formats (string, array of content blocks).
 */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const texts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as Record<string, unknown>;
      if (record.type && record.type !== "text") {
        return "";
      }
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);
  return texts.join("\n");
}

/**
 * Extract text from a tool result, falling back to JSON stringification.
 */
export function extractToolResultText(result: AgentToolResult<unknown>): string {
  if (result === null || result === undefined) {
    return "";
  }
  const contentText = extractTextFromContent(result?.content).trim();
  if (contentText) {
    return contentText;
  }
  if (result?.details !== undefined) {
    try {
      return JSON.stringify(result.details);
    } catch {
      return "";
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

/**
 * Extract text content from conversation messages for context.
 */
export function extractMessagesContent(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const msgObj = message as { role?: unknown; content?: unknown };
    const role = msgObj.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const content = extractTextFromContent(msgObj.content).trim();
    if (content) {
      const label = role === "user" ? "User" : "Agent";
      parts.push(`${label}: ${content}`);
    }
  }
  return parts.join("\n");
}

// ============================================================================
// Tool Result Manipulation
// ============================================================================

/**
 * Append a warning message to a tool result's content.
 */
export function appendWarningToToolResult(
  result: AgentToolResult<unknown>,
  warning: string,
): AgentToolResult<unknown> {
  const content = Array.isArray(result.content) ? [...result.content] : [];
  content.push({ type: "text", text: warning });
  return { ...result, content };
}

/**
 * Replace a tool result's content with a warning message.
 */
export function replaceToolResultWithWarning(
  result: AgentToolResult<unknown>,
  warning: string,
): AgentToolResult<unknown> {
  const baseDetails =
    result &&
    typeof result === "object" &&
    "details" in result &&
    (result as { details?: unknown }).details &&
    typeof (result as { details?: unknown }).details === "object"
      ? ((result as { details?: Record<string, unknown> }).details ?? {})
      : undefined;
  const details = baseDetails
    ? { ...baseDetails, guardrailWarning: warning }
    : { guardrailWarning: warning };
  return {
    content: [{ type: "text", text: warning }],
    details,
  };
}

/**
 * Build a JSON summary of a tool call for guardrail evaluation.
 */
export function buildToolCallSummary(
  toolName: string,
  toolCallId: string,
  params: unknown,
): string {
  try {
    return JSON.stringify({ tool: toolName, toolCallId, params });
  } catch {
    return toolName;
  }
}

// ============================================================================
// Stage Configuration
// ============================================================================

/**
 * Check if a guardrail stage is enabled.
 */
export function isStageEnabled(stage: BaseStageConfig | undefined): boolean {
  if (!stage) {
    return false;
  }
  return stage.enabled !== false;
}

/**
 * Resolve the block mode for a stage, defaulting to "append" for after_tool_call.
 */
export function resolveBlockMode(
  stage: GuardrailStage,
  stageCfg: BaseStageConfig | undefined,
): "replace" | "append" {
  if (stageCfg?.blockMode) {
    return stageCfg.blockMode;
  }
  if (stage === "after_tool_call") {
    return "append";
  }
  return "replace";
}

/**
 * Resolve stage configuration from a guardrail config object.
 */
export function resolveStageConfig<T extends BaseStageConfig>(
  stages:
    | {
        beforeRequest?: T;
        beforeToolCall?: T;
        afterToolCall?: T;
        afterResponse?: T;
      }
    | undefined,
  stage: GuardrailStage,
): T | undefined {
  if (!stages) {
    return undefined;
  }
  switch (stage) {
    case "before_request":
      return stages.beforeRequest;
    case "before_tool_call":
      return stages.beforeToolCall;
    case "after_tool_call":
      return stages.afterToolCall;
    case "after_response":
      return stages.afterResponse;
    default:
      return undefined;
  }
}

// ============================================================================
// Model Invocation Utilities (for local model-based guardrails)
// ============================================================================

/**
 * Load the embedded Pi agent runner function.
 * Tries source checkout first, then bundled install.
 */
export async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  // Source checkout (tests/dev) - from src/plugins/ to src/agents/
  try {
    const mod = (await import("../agents/pi-embedded-runner.js")) as {
      runEmbeddedPiAgent?: unknown;
    };
    if (typeof mod.runEmbeddedPiAgent === "function") {
      return mod.runEmbeddedPiAgent as RunEmbeddedPiAgentFn;
    }
  } catch {
    // ignore
  }

  throw new Error("Internal error: runEmbeddedPiAgent not available");
}

/**
 * Collect text from embedded agent payloads.
 */
export function collectText(
  payloads: Array<{ text?: string; isError?: boolean }> | undefined,
): string {
  const texts = (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "");
  return texts.join("\n").trim();
}

/**
 * Create a temporary directory for guardrail sessions.
 */
export async function createGuardrailTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${prefix}-`));
}

/**
 * Clean up a temporary directory.
 */
export async function cleanupTempDir(tmpDir: string | null): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Generate a unique session ID for guardrail calls.
 */
export function generateSessionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const GUARDRAIL_RUN_ID_PREFIX = "guardrail:";

/**
 * Generate a unique run/session ID for guardrail-internal model calls.
 */
export function createGuardrailRunId(guardrailId: string): string {
  const safeId = guardrailId.trim() || "unknown";
  return `${GUARDRAIL_RUN_ID_PREFIX}${generateSessionId(safeId)}`;
}

/**
 * Check if a run/session ID belongs to a guardrail-internal call.
 */
export function isGuardrailRunId(id?: string | null): boolean {
  if (!id) {
    return false;
  }
  return id.startsWith(GUARDRAIL_RUN_ID_PREFIX);
}

// ============================================================================
// JSON Utilities
// ============================================================================

/**
 * Safely stringify a value to JSON, returning null on failure.
 */
export function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// ============================================================================
// Guardrail Base Class / Factory
// ============================================================================

import type { AssistantMessage } from "@mariozechner/pi-ai";

import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginHookAfterResponseEvent,
  PluginHookAfterToolCallEvent,
  PluginHookBeforeRequestEvent,
  PluginHookBeforeToolCallEvent,
} from "./types.js";

/**
 * Unified evaluation result returned by guardrail implementations.
 */
export type GuardrailEvaluation = {
  /** Whether the content passed the safety check. */
  safe: boolean;
  /** Human-readable reason for the decision (used in violation messages). */
  reason?: string;
  /** Additional details for logging/debugging. */
  details?: Record<string, unknown>;
};

/**
 * Context passed to the evaluate function.
 */
export type GuardrailEvaluationContext = {
  /** The guardrail stage being evaluated. */
  stage: GuardrailStage;
  /** The primary content to evaluate. */
  content: string;
  /** Conversation history (if includeHistory is enabled). */
  history: AgentMessage[];
  /** Stage-specific metadata. */
  metadata: {
    toolName?: string;
    toolCallId?: string;
    toolParams?: unknown;
    toolResult?: unknown;
  };
};

/**
 * Base configuration shared by all guardrail plugins.
 */
export type GuardrailBaseConfig = {
  /** If true, allow content through when guardrail evaluation fails (default: true). */
  failOpen?: boolean;
  /** Hook priority for this guardrail (higher runs first, default: 50). */
  guardrailPriority?: number;
  stages?: {
    beforeRequest?: BaseStageConfig;
    beforeToolCall?: BaseStageConfig;
    afterToolCall?: BaseStageConfig;
    afterResponse?: BaseStageConfig;
  };
};

/**
 * Definition for a guardrail plugin.
 * Implement this interface to create a new guardrail.
 */
export type GuardrailDefinition<TConfig extends GuardrailBaseConfig = GuardrailBaseConfig> = {
  /** Unique identifier for the guardrail plugin. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;

  /**
   * Evaluate content for safety.
   * This is the core function that each guardrail must implement.
   */
  evaluate: (
    ctx: GuardrailEvaluationContext,
    config: TConfig,
    api: OpenClawPluginApi,
  ) => Promise<GuardrailEvaluation | null>;

  /**
   * Format a violation message for the user.
   * @param evaluation - The evaluation result
   * @param location - Human-readable location (e.g., "input query", "tool response")
   */
  formatViolationMessage: (evaluation: GuardrailEvaluation, location: string) => string;

  /**
   * Optional: Called when the plugin is registered.
   */
  onRegister?: (api: OpenClawPluginApi, config: TConfig) => void;
};

/**
 * Location labels for each guardrail stage.
 */
const STAGE_LOCATIONS: Record<GuardrailStage, string> = {
  before_request: "input query",
  before_tool_call: "tool call request",
  after_tool_call: "tool response",
  after_response: "model response",
};

/**
 * Create a guardrail plugin from a definition.
 *
 * This factory function transforms a high-level GuardrailDefinition into
 * a full OpenClawPluginDefinition that hooks into the existing 4 guardrail hooks.
 *
 * @example
 * ```ts
 * export default createGuardrailPlugin<MyConfig>({
 *   id: "my-guardrail",
 *   name: "My Guardrail",
 *   async evaluate(ctx, config, api) {
 *     const result = await checkSafety(ctx.content);
 *     return { safe: result.ok, reason: result.reason };
 *   },
 *   formatViolationMessage(evaluation, location) {
 *     return `Content blocked: ${evaluation.reason}`;
 *   },
 * });
 * ```
 */
export function createGuardrailPlugin<TConfig extends GuardrailBaseConfig>(
  definition: GuardrailDefinition<TConfig>,
): OpenClawPluginDefinition {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,

    register(api) {
      const config = (api.pluginConfig ?? {}) as TConfig;

      // Run custom initialization
      definition.onRegister?.(api, config);

      const defaultPriority = 50;
      const guardrailPriority =
        typeof config.guardrailPriority === "number" && Number.isFinite(config.guardrailPriority)
          ? config.guardrailPriority
          : defaultPriority;

      // Helper to handle evaluation errors
      const handleEvaluationError = (
        err: unknown,
        stage: GuardrailStage,
        failOpen: boolean,
      ): GuardrailEvaluation | null => {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.warn(`${definition.name} error at ${stage}: ${message}`);
        if (failOpen) {
          return null; // Allow through
        }
        return { safe: false, reason: `${definition.name} evaluation failed` };
      };

      // before_request hook
      const beforeRequestCfg = resolveStageConfig(config.stages, "before_request");
      if (isStageEnabled(beforeRequestCfg)) {
        api.on(
          "before_request",
          async (event: PluginHookBeforeRequestEvent) => {
            const content = event.prompt.trim();
            if (!content) {
              return;
            }

            const includeHistory = beforeRequestCfg?.includeHistory !== false;
            const ctx: GuardrailEvaluationContext = {
              stage: "before_request",
              content,
              history: includeHistory ? event.messages : [],
              metadata: {},
            };

            let evaluation: GuardrailEvaluation | null = null;
            try {
              evaluation = await definition.evaluate(ctx, config, api);
            } catch (err) {
              evaluation = handleEvaluationError(err, "before_request", config.failOpen !== false);
              if (!evaluation) {
                return;
              }
            }

            if (!evaluation || evaluation.safe) {
              return;
            }

            if (beforeRequestCfg?.mode === "monitor") {
              api.logger.warn(
                `[monitor] ${definition.name} flagged input: ${evaluation.reason ?? "unsafe"}`,
              );
              return;
            }

            const message = definition.formatViolationMessage(
              evaluation,
              STAGE_LOCATIONS.before_request,
            );
            return { block: true, blockResponse: message };
          },
          { priority: guardrailPriority },
        );
      }

      // before_tool_call hook
      const beforeToolCallCfg = resolveStageConfig(config.stages, "before_tool_call");
      if (isStageEnabled(beforeToolCallCfg)) {
        api.on(
          "before_tool_call",
          async (event: PluginHookBeforeToolCallEvent) => {
            const content = buildToolCallSummary(event.toolName, event.toolCallId, event.params);
            const includeHistory = beforeToolCallCfg?.includeHistory !== false;
            const ctx: GuardrailEvaluationContext = {
              stage: "before_tool_call",
              content,
              history: includeHistory ? event.messages : [],
              metadata: {
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                toolParams: event.params,
              },
            };

            let evaluation: GuardrailEvaluation | null = null;
            try {
              evaluation = await definition.evaluate(ctx, config, api);
            } catch (err) {
              evaluation = handleEvaluationError(
                err,
                "before_tool_call",
                config.failOpen !== false,
              );
              if (!evaluation) {
                return;
              }
            }

            if (!evaluation || evaluation.safe) {
              return;
            }

            if (beforeToolCallCfg?.mode === "monitor") {
              api.logger.warn(
                `[monitor] ${definition.name} flagged tool call ${event.toolName}: ${evaluation.reason ?? "unsafe"}`,
              );
              return;
            }

            const message = definition.formatViolationMessage(
              evaluation,
              STAGE_LOCATIONS.before_tool_call,
            );
            return { block: true, blockReason: message };
          },
          { priority: guardrailPriority },
        );
      }

      // after_tool_call hook
      const afterToolCallCfg = resolveStageConfig(config.stages, "after_tool_call");
      if (isStageEnabled(afterToolCallCfg)) {
        api.on(
          "after_tool_call",
          async (event: PluginHookAfterToolCallEvent) => {
            const content = extractToolResultText(event.result).trim();
            if (!content) {
              return;
            }

            const includeHistory = afterToolCallCfg?.includeHistory !== false;
            const ctx: GuardrailEvaluationContext = {
              stage: "after_tool_call",
              content,
              history: includeHistory ? event.messages : [],
              metadata: {
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                toolParams: event.params,
                toolResult: event.result,
              },
            };

            let evaluation: GuardrailEvaluation | null = null;
            try {
              evaluation = await definition.evaluate(ctx, config, api);
            } catch (err) {
              evaluation = handleEvaluationError(err, "after_tool_call", config.failOpen !== false);
              if (!evaluation) {
                return;
              }
            }

            if (!evaluation || evaluation.safe) {
              return;
            }

            if (afterToolCallCfg?.mode === "monitor") {
              api.logger.warn(
                `[monitor] ${definition.name} flagged tool result ${event.toolName}: ${evaluation.reason ?? "unsafe"}`,
              );
              return;
            }

            const message = definition.formatViolationMessage(
              evaluation,
              STAGE_LOCATIONS.after_tool_call,
            );
            const blockMode = resolveBlockMode("after_tool_call", afterToolCallCfg);
            return {
              block: true,
              result:
                blockMode === "append"
                  ? appendWarningToToolResult(event.result, message)
                  : replaceToolResultWithWarning(event.result, message),
            };
          },
          { priority: guardrailPriority },
        );
      }

      // after_response hook
      const afterResponseCfg = resolveStageConfig(config.stages, "after_response");
      if (isStageEnabled(afterResponseCfg)) {
        api.on(
          "after_response",
          async (event: PluginHookAfterResponseEvent) => {
            const content =
              event.assistantTexts.join("\n").trim() ||
              (event.lastAssistant
                ? extractTextFromContent((event.lastAssistant as AssistantMessage).content).trim()
                : "");
            if (!content) {
              return;
            }

            const includeHistory = afterResponseCfg?.includeHistory !== false;
            const ctx: GuardrailEvaluationContext = {
              stage: "after_response",
              content,
              history: includeHistory ? event.messages : [],
              metadata: {},
            };

            let evaluation: GuardrailEvaluation | null = null;
            try {
              evaluation = await definition.evaluate(ctx, config, api);
            } catch (err) {
              evaluation = handleEvaluationError(err, "after_response", config.failOpen !== false);
              if (!evaluation) {
                return;
              }
            }

            if (!evaluation || evaluation.safe) {
              return;
            }

            if (afterResponseCfg?.mode === "monitor") {
              api.logger.warn(
                `[monitor] ${definition.name} flagged response: ${evaluation.reason ?? "unsafe"}`,
              );
              return;
            }

            const message = definition.formatViolationMessage(
              evaluation,
              STAGE_LOCATIONS.after_response,
            );
            const blockMode = resolveBlockMode("after_response", afterResponseCfg);
            if (blockMode === "append") {
              return { assistantTexts: [...event.assistantTexts, message] };
            }
            return { block: true, blockResponse: message };
          },
          { priority: guardrailPriority },
        );
      }
    },
  };
}
