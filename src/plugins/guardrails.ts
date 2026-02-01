/**
 * Guardrail Abstraction Layer
 *
 * High-level API for building guardrail plugins that hook into LLM boundaries.
 * Provides a declarative way to define content safety checks using a unified model.
 *
 * A guardrail is a pure function:
 *   (conversationHistory, context) → (action, modifiedConversationHistory)
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type {
  GuardrailAction,
  GuardrailApprovalContext,
  GuardrailOutput,
  GuardrailStage,
  GuardrailToolCall,
  OpenClawPluginApi,
  OpenClawPluginDefinition,
} from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** Configuration for a specific guardrail stage. */
export type GuardrailStageConfig = {
  enabled?: boolean;
  /** Default action when guardrail detects an issue. Defaults to "block". */
  defaultAction?: GuardrailAction;
};

/** Base configuration for all guardrail plugins. */
export type GuardrailConfig = {
  enabled?: boolean;
  /** If true, allow content through when guardrail evaluation fails (default: false). */
  failOpen?: boolean;
  stages?: {
    before?: GuardrailStageConfig;
    after?: GuardrailStageConfig;
  };
};

/** Result of a guardrail evaluation. */
export type GuardrailEvaluation = {
  /** Whether the content passed the guardrail check. */
  safe: boolean;
  /** Suggested action to take. If not provided, uses stage's defaultAction when unsafe. */
  action?: GuardrailAction;
  /** Modified messages (optional - if not provided, original messages are used). */
  messages?: AgentMessage[];
  /** Modified prompt (optional - if not provided, original prompt is used). */
  prompt?: string;
  /** Human-readable reason for the action. */
  reason?: string;
  /** Additional details about the evaluation (e.g., matched categories, scores). */
  details?: Record<string, unknown>;
  /** Context for approval requests (when action is "approval"). */
  approvalContext?: GuardrailApprovalContext;
};

/** Context passed to the guardrail evaluate function. */
export type GuardrailEvaluationContext = {
  /** The stage at which the evaluation is occurring. */
  stage: GuardrailStage;
  /** The messages to evaluate. */
  messages: AgentMessage[];
  /** The prompt (before stage only). */
  prompt?: string;
  /** The current turn number in the conversation. */
  turnNumber: number;
  /** Tool calls made in this turn (after stage only). */
  toolCalls?: GuardrailToolCall[];
  /** Duration of the LLM call in ms (after stage only). */
  durationMs?: number;
  /** Agent ID. */
  agentId?: string;
  /** Session key. */
  sessionKey?: string;
  /** LLM provider. */
  provider?: string;
  /** Model ID. */
  modelId?: string;
};

/** Definition for a guardrail plugin. */
export type GuardrailDefinition<TConfig extends GuardrailConfig = GuardrailConfig> = {
  /** Unique identifier for the guardrail plugin. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Optional description. */
  description?: string;

  /**
   * Core evaluation logic.
   * Returns an evaluation result that determines the action and any modifications.
   */
  evaluate: (ctx: GuardrailEvaluationContext, config: TConfig) => Promise<GuardrailEvaluation>;

  /**
   * Optional: Custom initialization when the plugin is registered.
   */
  onRegister?: (api: OpenClawPluginApi, config: TConfig) => void;
};

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a guardrail plugin from a definition.
 * This factory function transforms a high-level GuardrailDefinition into
 * a full OpenClawPluginDefinition that hooks into the LLM boundary hooks.
 */
export function createGuardrailPlugin<TConfig extends GuardrailConfig>(
  definition: GuardrailDefinition<TConfig>,
): OpenClawPluginDefinition {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,

    register(api) {
      const config = api.pluginConfig as TConfig | undefined;
      if (!config?.enabled) {
        return;
      }

      // Run custom initialization
      definition.onRegister?.(api, config);

      const defaultPriority = 50;

      // Helper to check if stage is enabled
      const isStageEnabled = (stage: GuardrailStage): boolean => {
        const stageKey = stage === "before" ? "before" : "after";
        const stageConfig = config.stages?.[stageKey];
        return stageConfig?.enabled !== false;
      };

      // Helper to get default action for stage
      const getDefaultAction = (stage: GuardrailStage): GuardrailAction => {
        const stageKey = stage === "before" ? "before" : "after";
        return config.stages?.[stageKey]?.defaultAction ?? "block";
      };

      // Convert evaluation result to GuardrailOutput
      const toOutput = (
        evaluation: GuardrailEvaluation,
        stage: GuardrailStage,
      ): GuardrailOutput => {
        if (evaluation.safe) {
          return {
            action: "allow",
            messages: evaluation.messages,
            prompt: evaluation.prompt,
          };
        }

        const action = evaluation.action ?? getDefaultAction(stage);
        return {
          action,
          messages: evaluation.messages,
          prompt: evaluation.prompt,
          reason: evaluation.reason,
          details: evaluation.details,
          approvalContext: evaluation.approvalContext,
        };
      };

      // Handle errors based on failOpen setting
      const handleError = (err: unknown, stage: GuardrailStage): GuardrailOutput => {
        api.logger.error(`${definition.name} error at ${stage}: ${err}`);
        if (config.failOpen) {
          return { action: "allow" };
        }
        return {
          action: "block",
          reason: `${definition.name} evaluation error`,
        };
      };

      // before_llm_call hook (stage: "before")
      if (isStageEnabled("before")) {
        api.on(
          "before_llm_call",
          async (event, ctx) => {
            try {
              const evaluation = await definition.evaluate(
                {
                  stage: "before",
                  messages: event.messages,
                  prompt: event.prompt,
                  turnNumber: event.turnNumber,
                  agentId: ctx.agentId,
                  sessionKey: ctx.sessionKey,
                  provider: ctx.provider,
                  modelId: ctx.modelId,
                },
                config,
              );

              const output = toOutput(evaluation, "before");

              // Log if action is "log"
              if (output.action === "log") {
                api.logger.warn(
                  `[guardrail:${definition.id}] ${output.reason ?? "Issue detected at before stage"}`,
                );
              }

              return output;
            } catch (err) {
              return handleError(err, "before");
            }
          },
          { priority: defaultPriority },
        );
      }

      // after_llm_call hook (stage: "after")
      if (isStageEnabled("after")) {
        api.on(
          "after_llm_call",
          async (event, ctx) => {
            try {
              const evaluation = await definition.evaluate(
                {
                  stage: "after",
                  messages: event.newMessages,
                  turnNumber: event.turnNumber,
                  toolCalls: event.toolCalls,
                  durationMs: event.durationMs,
                  agentId: ctx.agentId,
                  sessionKey: ctx.sessionKey,
                  provider: ctx.provider,
                  modelId: ctx.modelId,
                },
                config,
              );

              const output = toOutput(evaluation, "after");

              // Log if action is "log"
              if (output.action === "log") {
                api.logger.warn(
                  `[guardrail:${definition.id}] ${output.reason ?? "Issue detected at after stage"}`,
                );
              }

              return output;
            } catch (err) {
              return handleError(err, "after");
            }
          },
          { priority: defaultPriority },
        );
      }
    },
  };
}

// ============================================================================
// Utilities (for guardrail plugin authors)
// ============================================================================

/**
 * Extract text content from messages, optionally including a prompt.
 */
export function extractContent(messages: AgentMessage[], prompt?: string): string {
  const parts: string[] = [];
  if (prompt) {
    parts.push(prompt);
  }
  for (const msg of messages) {
    // Only user/assistant messages have content field
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
  }
  return parts.join("\n");
}

/**
 * Extract text from messages only (convenience wrapper).
 */
export function extractTextFromMessages(messages: AgentMessage[]): string {
  return extractContent(messages);
}

/**
 * Convert tool calls to a readable text format for content scanning.
 */
export function extractToolCallsText(toolCalls?: GuardrailToolCall[]): string {
  if (!toolCalls?.length) {
    return "";
  }
  return toolCalls
    .map((tc) => `Tool: ${tc.name}\nParams: ${JSON.stringify(tc.params)}`)
    .join("\n\n");
}

// Re-export types for convenience
export type {
  GuardrailAction,
  GuardrailApprovalContext,
  GuardrailOutput,
  GuardrailStage,
  GuardrailToolCall,
} from "./types.js";
