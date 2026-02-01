/**
 * GPT-OSS-Safeguard Guardrail Plugin
 *
 * Uses a configurable LLM to evaluate content safety with custom policies.
 * Supports multiple output formats (binary, JSON, rich) for different use cases.
 */

import {
  createGuardrailPlugin,
  extractContent,
  extractToolCallsText,
  type GuardrailConfig,
  type GuardrailEvaluationContext,
} from "../../src/plugins/guardrails.js";
import {
  loadRunEmbeddedPiAgent,
  createGuardrailTempDir,
  cleanupGuardrailTempDir,
  collectPayloadText,
  stripCodeFences,
  toModelKey,
} from "../../src/plugins/guardrails-utils.js";

// ============================================================================
// Types
// ============================================================================

/** Output format for the safeguard response. */
export type SafeguardOutputFormat = "binary" | "json" | "rich";

/** Configuration for the GPT-OSS-Safeguard guardrail. */
export type SafeguardConfig = GuardrailConfig & {
  /** Provider for running the safeguard LLM. Defaults to config default. */
  provider?: string;
  /** Model ID. Defaults to config default. */
  model?: string;
  /** Auth profile ID for the provider. */
  authProfileId?: string;
  /** Custom safety policy. If not provided, uses default policy. */
  policy?: string;
  /** Reasoning effort level. Defaults to "low". */
  reasoningEffort?: "low" | "medium" | "high";
  /** Output format. Defaults to "binary". */
  outputFormat?: SafeguardOutputFormat;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /** Maximum tokens for response. Defaults to 500. */
  maxTokens?: number;
};

// ============================================================================
// Default Policy
// ============================================================================

const DEFAULT_POLICY = `You are a content safety evaluator. Analyze the provided content and determine if it violates any of the following safety guidelines:

1. Violence: Content that promotes, glorifies, or provides instructions for violence
2. Hate Speech: Content that attacks or discriminates against protected groups
3. Sexual Content: Explicit sexual content or sexual exploitation
4. Self-Harm: Content that promotes or provides instructions for self-harm
5. Illegal Activity: Content that promotes or provides instructions for illegal activities
6. Privacy Violations: Content that exposes private information without consent
7. Misinformation: Deliberately false information designed to deceive
8. Malicious Code: Content that promotes or provides malicious code or hacking instructions

Evaluate the content objectively and provide your assessment.`;

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_OUTPUT_FORMAT: SafeguardOutputFormat = "binary";
const DEFAULT_REASONING_EFFORT = "low";

// ============================================================================
// Prompt Builder
// ============================================================================

function buildSafeguardPrompt(params: {
  content: string;
  policy: string;
  outputFormat: SafeguardOutputFormat;
  role: "user" | "assistant";
}): string {
  const { content, policy, outputFormat, role } = params;

  const roleLabel = role === "user" ? "user input" : "assistant response";

  let formatInstructions: string;
  switch (outputFormat) {
    case "binary":
      formatInstructions = `Respond with exactly "0" if the content is safe, or "1" if it violates the safety policy. No other text.`;
      break;
    case "json":
      formatInstructions = `Respond with a JSON object in this exact format:
{"safe": true} or {"safe": false, "reason": "brief explanation"}
No markdown fences or other text.`;
      break;
    case "rich":
      formatInstructions = `Respond with a JSON object in this exact format:
{
  "safe": true/false,
  "reason": "explanation if unsafe",
  "categories": ["list", "of", "violated", "categories"],
  "confidence": 0.0-1.0
}
No markdown fences or other text.`;
      break;
  }

  return `${policy}

Evaluate the following ${roleLabel}:

<content>
${content}
</content>

${formatInstructions}`;
}

// ============================================================================
// Response Parser
// ============================================================================

type ParsedBinaryResponse = {
  safe: boolean;
};

type ParsedJsonResponse = {
  safe: boolean;
  reason?: string;
};

type ParsedRichResponse = {
  safe: boolean;
  reason?: string;
  categories?: string[];
  confidence?: number;
};

type ParsedResponse = ParsedBinaryResponse | ParsedJsonResponse | ParsedRichResponse;

function parseBinaryResponse(response: string): ParsedBinaryResponse {
  const trimmed = response.trim();
  if (trimmed === "0") {
    return { safe: true };
  }
  if (trimmed === "1") {
    return { safe: false };
  }
  // If not clear, default to unsafe
  return { safe: false };
}

function parseJsonResponse(response: string): ParsedJsonResponse {
  try {
    const cleaned = stripCodeFences(response);
    const parsed = JSON.parse(cleaned);
    return {
      safe: parsed.safe === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    // Parse failure - treat as unsafe
    return { safe: false, reason: "Failed to parse response" };
  }
}

function parseRichResponse(response: string): ParsedRichResponse {
  try {
    const cleaned = stripCodeFences(response);
    const parsed = JSON.parse(cleaned);
    return {
      safe: parsed.safe === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      categories: Array.isArray(parsed.categories) ? parsed.categories : undefined,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
    };
  } catch {
    // Parse failure - treat as unsafe
    return { safe: false, reason: "Failed to parse response" };
  }
}

function parseResponse(response: string, format: SafeguardOutputFormat): ParsedResponse {
  switch (format) {
    case "binary":
      return parseBinaryResponse(response);
    case "json":
      return parseJsonResponse(response);
    case "rich":
      return parseRichResponse(response);
  }
}

// ============================================================================
// Plugin
// ============================================================================

export default createGuardrailPlugin<SafeguardConfig>({
  id: "gpt-oss-safeguard",
  name: "GPT-OSS Safeguard",
  description: "Content safety guardrail using configurable LLM with custom policies",

  async evaluate(ctx: GuardrailEvaluationContext, config: SafeguardConfig) {
    const provider = config.provider?.trim() || ctx.provider;
    const model = config.model?.trim() || ctx.modelId;
    const authProfileId = config.authProfileId?.trim();
    const policy = config.policy?.trim() || DEFAULT_POLICY;
    const outputFormat = config.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
    const reasoningEffort = config.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Validate provider/model
    if (!provider || !model) {
      throw new Error("Provider and model must be configured or available from context");
    }

    const modelKey = toModelKey(provider, model);
    if (!modelKey) {
      throw new Error(`Invalid provider/model: ${provider}/${model}`);
    }

    // Extract content to evaluate
    let content = extractContent(ctx.messages, ctx.prompt);

    // Include tool calls in after stage
    if (ctx.stage === "after" && ctx.toolCalls?.length) {
      const toolCallsText = extractToolCallsText(ctx.toolCalls);
      if (toolCallsText) {
        content = `${content}\n\n[Tool Calls]\n${toolCallsText}`;
      }
    }

    if (!content.trim()) {
      return { safe: true };
    }

    // Determine role based on stage
    const role = ctx.stage === "before" ? "user" : "assistant";

    // Build the prompt
    const prompt = buildSafeguardPrompt({ content, policy, outputFormat, role });

    // Determine thinking level based on reasoning effort
    const thinkLevel =
      reasoningEffort === "high" ? "high" : reasoningEffort === "medium" ? "medium" : "low";

    // Run embedded Pi agent
    let tmpDir: string | null = null;
    try {
      tmpDir = await createGuardrailTempDir("safeguard");
      const sessionId = `safeguard-${Date.now()}`;
      const sessionFile = `${tmpDir}/session.json`;

      const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();

      const result = await runEmbeddedPiAgent({
        sessionId,
        sessionFile,
        workspaceDir: tmpDir,
        prompt,
        timeoutMs,
        runId: `safeguard-${Date.now()}`,
        provider,
        model,
        authProfileId,
        authProfileIdSource: authProfileId ? "user" : "auto",
        thinkLevel,
        streamParams: { maxTokens },
        disableTools: true,
      });

      const responseText = collectPayloadText((result as any).payloads);
      if (!responseText) {
        throw new Error("Safeguard LLM returned empty response");
      }

      const parsed = parseResponse(responseText, outputFormat);

      if (parsed.safe) {
        return { safe: true };
      }

      const stageLabel = ctx.stage === "before" ? "input" : "output";

      // Build reason message
      let reason = `Content blocked in ${stageLabel}`;
      if ("reason" in parsed && parsed.reason) {
        reason = `${reason}: ${parsed.reason}`;
      }
      if ("categories" in parsed && parsed.categories?.length) {
        reason = `${reason} (categories: ${parsed.categories.join(", ")})`;
      }

      return {
        safe: false,
        reason,
        details: {
          ...(("reason" in parsed && parsed.reason) ? { reason: parsed.reason } : {}),
          ...(("categories" in parsed && parsed.categories) ? { categories: parsed.categories } : {}),
          ...(("confidence" in parsed && parsed.confidence !== undefined) ? { confidence: parsed.confidence } : {}),
          rawResponse: responseText,
          outputFormat,
        },
      };
    } finally {
      if (tmpDir) {
        await cleanupGuardrailTempDir(tmpDir);
      }
    }
  },

  onRegister(api, config) {
    const provider = config.provider?.trim() || "(default)";
    const model = config.model?.trim() || "(default)";
    const format = config.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
    const hasCustomPolicy = !!config.policy?.trim();
    const policyLabel = hasCustomPolicy ? "custom policy" : "default policy";
    api.logger.info(
      `GPT-OSS Safeguard enabled (${provider}/${model}, ${format} format, ${policyLabel})`,
    );
  },
});
