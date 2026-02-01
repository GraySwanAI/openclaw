/**
 * Example Guardrail Plugin
 *
 * Demonstrates how to use the guardrail abstraction layer to build
 * a simple keyword-based content filter using the unified model.
 */

import {
  createGuardrailPlugin,
  extractContent,
  type GuardrailConfig,
} from "../../src/plugins/guardrails.js";

/** Configuration for the keyword guardrail. */
type KeywordGuardrailConfig = GuardrailConfig & {
  /** Keywords to block. Defaults to ["forbidden", "restricted", "blocked"]. */
  blockedKeywords?: string[];
  /** Whether to match case-sensitively. Defaults to false. */
  caseSensitive?: boolean;
};

const DEFAULT_KEYWORDS = ["forbidden", "restricted", "blocked"];

export default createGuardrailPlugin<KeywordGuardrailConfig>({
  id: "guardrail-example",
  name: "Keyword Guardrail",
  description: "Blocks content containing specified keywords",

  async evaluate(ctx, config) {
    const keywords = config.blockedKeywords ?? DEFAULT_KEYWORDS;
    const caseSensitive = config.caseSensitive ?? false;
    const content = extractContent(ctx.messages, ctx.prompt);
    const normalizedContent = caseSensitive ? content : content.toLowerCase();

    const matched = keywords.filter((kw) => {
      const keyword = caseSensitive ? kw : kw.toLowerCase();
      return normalizedContent.includes(keyword);
    });

    if (matched.length === 0) {
      return { safe: true };
    }

    const stageLabel = ctx.stage === "before" ? "input" : "output";
    return {
      safe: false,
      reason: `Content blocked: found keywords [${matched.join(", ")}] in ${stageLabel}`,
      details: { matchedKeywords: matched },
    };
  },

  onRegister(api, config) {
    const keywords = config.blockedKeywords ?? DEFAULT_KEYWORDS;
    api.logger.info(`Keyword Guardrail enabled with ${keywords.length} keywords`);
  },
});
