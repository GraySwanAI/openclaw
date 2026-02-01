/**
 * Llama Guard Guardrail Plugin
 *
 * Uses Llama Guard 3 model via an embedded Pi agent to evaluate content safety.
 * Supports configurable safety categories based on the MLCommons taxonomy.
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
  toModelKey,
} from "../../src/plugins/guardrails-utils.js";

// ============================================================================
// Types
// ============================================================================

/** Llama Guard safety category. */
export type LlamaGuardCategory = {
  /** Category code (e.g., "S1", "S2"). */
  code: string;
  /** Category name. */
  name: string;
  /** Category description. */
  description?: string;
};

/** Configuration for the Llama Guard guardrail. */
export type LlamaGuardConfig = GuardrailConfig & {
  /** Provider for running Llama Guard. Defaults to "ollama". */
  provider?: string;
  /** Model ID. Defaults to "llama-guard3:8b". */
  model?: string;
  /** Auth profile ID for the provider. */
  authProfileId?: string;
  /** Custom safety categories. If not provided, uses default S1-S14 categories. */
  categories?: LlamaGuardCategory[];
  /** Request timeout in milliseconds. Defaults to 60000. */
  timeoutMs?: number;
  /** Maximum tokens for response. Defaults to 100. */
  maxTokens?: number;
};

// ============================================================================
// Default Categories (MLCommons AI Safety Taxonomy)
// ============================================================================

const DEFAULT_CATEGORIES: LlamaGuardCategory[] = [
  { code: "S1", name: "Violent Crimes", description: "Enabling, encouraging, or enduring violence" },
  { code: "S2", name: "Non-Violent Crimes", description: "Non-violent illegal activities" },
  { code: "S3", name: "Sex-Related Crimes", description: "Sexual exploitation and abuse" },
  { code: "S4", name: "Child Sexual Exploitation", description: "CSAM and related content" },
  { code: "S5", name: "Defamation", description: "False statements harming reputation" },
  { code: "S6", name: "Specialized Advice", description: "Unqualified professional advice" },
  { code: "S7", name: "Privacy", description: "Privacy violations and data exposure" },
  { code: "S8", name: "Intellectual Property", description: "IP infringement" },
  { code: "S9", name: "Indiscriminate Weapons", description: "CBRNE and mass-casualty weapons" },
  { code: "S10", name: "Hate", description: "Hate speech and discrimination" },
  { code: "S11", name: "Suicide & Self-Harm", description: "Content promoting self-harm" },
  { code: "S12", name: "Sexual Content", description: "Explicit sexual material" },
  { code: "S13", name: "Elections", description: "Election misinformation" },
  { code: "S14", name: "Code Interpreter Abuse", description: "Malicious code execution" },
];

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_PROVIDER = "ollama";
const DEFAULT_MODEL = "llama-guard3:8b";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 100;

// ============================================================================
// Prompt Builder
// ============================================================================

function buildLlamaGuardPrompt(params: {
  role: "User" | "Agent";
  content: string;
  categories: LlamaGuardCategory[];
}): string {
  const { role, content, categories } = params;

  // Build category list
  const categoryList = categories
    .map((cat) => {
      const desc = cat.description ? `: ${cat.description}` : "";
      return `${cat.code}: ${cat.name}${desc}`;
    })
    .join("\n");

  // Llama Guard 3 prompt format
  return `<|begin_of_text|><|start_header_id|>user<|end_header_id|>

Task: Check if there is unsafe content in '${role}' messages in conversations according to our safety policy with the below categories.

<BEGIN UNSAFE CONTENT CATEGORIES>
${categoryList}
<END UNSAFE CONTENT CATEGORIES>

<BEGIN CONVERSATION>

${role}: ${content}

<END CONVERSATION>

Provide your safety assessment for ONLY THE LAST ${role} message in the above conversation:
- First line must read 'safe' or 'unsafe'.
- If unsafe, a second line must include a comma-separated list of violated categories.<|eot_id|><|start_header_id|>assistant<|end_header_id|>`;
}

// ============================================================================
// Response Parser
// ============================================================================

type ParsedResponse = {
  safe: boolean;
  categories: string[];
};

function parseLlamaGuardResponse(response: string): ParsedResponse {
  const lines = response.trim().split("\n");
  const firstLine = lines[0]?.trim().toLowerCase() ?? "";

  if (firstLine === "safe") {
    return { safe: true, categories: [] };
  }

  if (firstLine === "unsafe" || firstLine.startsWith("unsafe")) {
    // Parse violated categories from second line
    const secondLine = lines[1]?.trim() ?? "";
    const categories = secondLine
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^S\d+$/.test(s));

    return { safe: false, categories };
  }

  // Default to unsafe if response is unclear
  return { safe: false, categories: [] };
}

// ============================================================================
// Plugin
// ============================================================================

export default createGuardrailPlugin<LlamaGuardConfig>({
  id: "llamaguard",
  name: "Llama Guard",
  description: "Content safety guardrail using Llama Guard 3 model",

  async evaluate(ctx: GuardrailEvaluationContext, config: LlamaGuardConfig) {
    const provider = config.provider?.trim() || DEFAULT_PROVIDER;
    const model = config.model?.trim() || DEFAULT_MODEL;
    const authProfileId = config.authProfileId?.trim();
    const categories = config.categories?.length ? config.categories : DEFAULT_CATEGORIES;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Validate model key
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
    const role = ctx.stage === "before" ? "User" : "Agent";

    // Build the prompt
    const prompt = buildLlamaGuardPrompt({ role, content, categories });

    // Run embedded Pi agent
    let tmpDir: string | null = null;
    try {
      tmpDir = await createGuardrailTempDir("llamaguard");
      const sessionId = `llamaguard-${Date.now()}`;
      const sessionFile = `${tmpDir}/session.json`;

      const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();

      const result = await runEmbeddedPiAgent({
        sessionId,
        sessionFile,
        workspaceDir: tmpDir,
        prompt,
        timeoutMs,
        runId: `llamaguard-${Date.now()}`,
        provider,
        model,
        authProfileId,
        authProfileIdSource: authProfileId ? "user" : "auto",
        streamParams: { maxTokens },
        disableTools: true,
      });

      const responseText = collectPayloadText((result as any).payloads);
      if (!responseText) {
        throw new Error("Llama Guard returned empty response");
      }

      const parsed = parseLlamaGuardResponse(responseText);

      if (parsed.safe) {
        return { safe: true };
      }

      // Map category codes to names
      const categoryNames = parsed.categories
        .map((code) => {
          const cat = categories.find((c) => c.code === code);
          return cat ? `${code} (${cat.name})` : code;
        })
        .join(", ");

      const stageLabel = ctx.stage === "before" ? "input" : "output";

      return {
        safe: false,
        reason: `Content blocked in ${stageLabel}: unsafe categories [${categoryNames}]`,
        details: {
          categories: parsed.categories,
          categoryNames,
          rawResponse: responseText,
        },
      };
    } finally {
      if (tmpDir) {
        await cleanupGuardrailTempDir(tmpDir);
      }
    }
  },

  onRegister(api, config) {
    const provider = config.provider?.trim() || DEFAULT_PROVIDER;
    const model = config.model?.trim() || DEFAULT_MODEL;
    const categoryCount = config.categories?.length ?? DEFAULT_CATEGORIES.length;
    api.logger.info(`Llama Guard guardrail enabled (${provider}/${model}, ${categoryCount} categories)`);
  },
});
