/**
 * Gray Swan Cygnal Guardrail Plugin
 *
 * Uses the Gray Swan Cygnal API to monitor content for safety violations.
 * Supports configurable violation thresholds, mutation detection, and
 * injection pattern identification (IPI).
 */

import {
  createGuardrailPlugin,
  extractContent,
  extractToolCallsText,
  type GuardrailConfig,
  type GuardrailEvaluationContext,
} from "../../src/plugins/guardrails.js";

// ============================================================================
// Types
// ============================================================================

/** Stage-specific configuration for Gray Swan guardrail. */
type GraySwanStageConfig = {
  enabled?: boolean;
  defaultAction?: "allow" | "log" | "approval" | "block";
  /** Violation score threshold (0-1). Defaults to parent violationThreshold. */
  violationThreshold?: number;
  /** Block if mutation detected. Defaults to false. */
  blockOnMutation?: boolean;
  /** Block if injection pattern identified. Defaults to false. */
  blockOnIpi?: boolean;
};

/** Configuration for the Gray Swan guardrail. */
export type GraySwanConfig = GuardrailConfig & {
  /** Gray Swan API key. Required. */
  apiKey: string;
  /** API base URL. Defaults to https://api.grayswan.ai */
  apiBase?: string;
  /** Policy ID for custom policies. */
  policyId?: string;
  /** Custom category definitions. */
  categories?: Record<string, string>;
  /** Reasoning mode: "off", "hybrid", or "thinking". Defaults to "off". */
  reasoningMode?: "off" | "hybrid" | "thinking";
  /** Violation score threshold (0-1). Defaults to 0.5. */
  violationThreshold?: number;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /** Stage-specific configuration. */
  stages?: {
    before?: GraySwanStageConfig;
    after?: GraySwanStageConfig;
  };
};

/** Response from the Cygnal API. */
type CygnalResponse = {
  /** Whether the request was successful. */
  success?: boolean;
  /** Violation score (0-1). */
  violation_score?: number;
  /** Whether mutation was detected. */
  mutation_detected?: boolean;
  /** Whether injection pattern was identified. */
  ipi_detected?: boolean;
  /** Matched policy categories. */
  categories?: string[];
  /** Error message if request failed. */
  error?: string;
  /** Detailed reasoning. */
  reasoning?: string;
};

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_API_BASE = "https://api.grayswan.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_VIOLATION_THRESHOLD = 0.5;

// ============================================================================
// API Client
// ============================================================================

async function callCygnalApi(params: {
  apiKey: string;
  apiBase: string;
  content: string;
  policyId?: string;
  categories?: Record<string, string>;
  reasoningMode?: "off" | "hybrid" | "thinking";
  timeoutMs: number;
}): Promise<CygnalResponse> {
  const url = `${params.apiBase}/cygnal/monitor`;

  const body: Record<string, unknown> = {
    content: params.content,
  };

  if (params.policyId) {
    body.policy_id = params.policyId;
  }

  if (params.categories && Object.keys(params.categories).length > 0) {
    body.categories = params.categories;
  }

  if (params.reasoningMode && params.reasoningMode !== "off") {
    body.reasoning_mode = params.reasoningMode;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        success: false,
        error: `API error: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`,
      };
    }

    const data = (await response.json()) as CygnalResponse;
    return { success: true, ...data };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { success: false, error: "Request timed out" };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Plugin
// ============================================================================

export default createGuardrailPlugin<GraySwanConfig>({
  id: "grayswan",
  name: "Gray Swan Cygnal",
  description: "Content safety guardrail using Gray Swan Cygnal API",

  async evaluate(ctx: GuardrailEvaluationContext, config: GraySwanConfig) {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new Error("Gray Swan API key is required");
    }

    const apiBase = (config.apiBase?.trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Get stage-specific config
    const stageConfig = ctx.stage === "before" ? config.stages?.before : config.stages?.after;

    // Resolve thresholds (stage-specific overrides parent)
    const violationThreshold =
      stageConfig?.violationThreshold ?? config.violationThreshold ?? DEFAULT_VIOLATION_THRESHOLD;
    const blockOnMutation = stageConfig?.blockOnMutation ?? false;
    const blockOnIpi = stageConfig?.blockOnIpi ?? false;

    // Extract content to evaluate
    let content = extractContent(ctx.messages, ctx.prompt);

    // Include tool calls in after stage
    if (ctx.stage === "after" && ctx.toolCalls?.length) {
      const toolCallsText = extractToolCallsText(ctx.toolCalls);
      if (toolCallsText) {
        content = `${content}\n\n--- Tool Calls ---\n${toolCallsText}`;
      }
    }

    if (!content.trim()) {
      return { safe: true };
    }

    // Call the API
    const response = await callCygnalApi({
      apiKey,
      apiBase,
      content,
      policyId: config.policyId,
      categories: config.categories,
      reasoningMode: config.reasoningMode,
      timeoutMs,
    });

    // Handle API errors
    if (!response.success) {
      throw new Error(response.error ?? "Cygnal API request failed");
    }

    // Check violation score
    const violationScore = response.violation_score ?? 0;
    const isViolation = violationScore >= violationThreshold;

    // Check mutation detection
    const mutationDetected = blockOnMutation && response.mutation_detected === true;

    // Check injection pattern identification
    const ipiDetected = blockOnIpi && response.ipi_detected === true;

    // Determine if content is safe
    if (!isViolation && !mutationDetected && !ipiDetected) {
      return { safe: true };
    }

    // Build reason message
    const reasons: string[] = [];
    if (isViolation) {
      const categories = response.categories?.length
        ? ` (categories: ${response.categories.join(", ")})`
        : "";
      reasons.push(`violation score ${violationScore.toFixed(2)} >= ${violationThreshold}${categories}`);
    }
    if (mutationDetected) {
      reasons.push("mutation detected");
    }
    if (ipiDetected) {
      reasons.push("injection pattern identified");
    }

    const stageLabel = ctx.stage === "before" ? "input" : "output";

    return {
      safe: false,
      reason: `Content blocked in ${stageLabel}: ${reasons.join("; ")}`,
      details: {
        violationScore,
        mutationDetected: response.mutation_detected,
        ipiDetected: response.ipi_detected,
        categories: response.categories,
        reasoning: response.reasoning,
      },
    };
  },

  onRegister(api, config) {
    const apiBase = config.apiBase?.trim() || DEFAULT_API_BASE;
    api.logger.info(`Gray Swan Cygnal guardrail enabled (endpoint: ${apiBase})`);
  },
});
