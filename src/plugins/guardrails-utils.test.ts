import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  appendWarningToToolResult,
  buildToolCallSummary,
  createGuardrailRunId,
  extractMessagesContent,
  extractTextFromContent,
  extractToolResultText,
  generateSessionId,
  isGuardrailRunId,
  isStageEnabled,
  replaceToolResultWithWarning,
  resolveBlockMode,
  resolveStageConfig,
  safeJsonStringify,
} from "./guardrails-utils.js";

describe("extractTextFromContent", () => {
  it("extracts text from string content", () => {
    expect(extractTextFromContent("hello world")).toBe("hello world");
  });

  it("extracts text from content array with text blocks", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    expect(extractTextFromContent(content)).toBe("first\nsecond");
  });

  it("filters out non-text blocks", () => {
    const content = [
      { type: "text", text: "text content" },
      { type: "image", url: "http://example.com/img.png" },
      { type: "text", text: "more text" },
    ];
    expect(extractTextFromContent(content)).toBe("text content\nmore text");
  });

  it("returns empty string for non-array, non-string content", () => {
    expect(extractTextFromContent(null)).toBe("");
    expect(extractTextFromContent(undefined)).toBe("");
    expect(extractTextFromContent(123)).toBe("");
    expect(extractTextFromContent({})).toBe("");
  });

  it("handles empty array", () => {
    expect(extractTextFromContent([])).toBe("");
  });

  it("handles array with invalid items", () => {
    const content = [null, undefined, "not an object", { type: "text", text: "valid" }];
    expect(extractTextFromContent(content)).toBe("valid");
  });
});

describe("extractToolResultText", () => {
  it("extracts text from content field", () => {
    const result = {
      content: [{ type: "text" as const, text: "tool output" }],
      details: {},
    };
    expect(extractToolResultText(result)).toBe("tool output");
  });

  it("falls back to details field as JSON", () => {
    const result = { content: [], details: { key: "value" } };
    expect(extractToolResultText(result)).toBe('{"key":"value"}');
  });

  it("falls back to stringifying entire result", () => {
    const result = { content: [], someField: "data", details: {} };
    expect(extractToolResultText(result)).toBe('{"content":[],"someField":"data","details":{}}');
  });

  it("handles null/undefined result", () => {
    expect(extractToolResultText(null as unknown as AgentToolResult<unknown>)).toBe("");
    expect(extractToolResultText(undefined as unknown as AgentToolResult<unknown>)).toBe("");
  });
});

describe("extractMessagesContent", () => {
  it("extracts user and assistant messages", () => {
    const messages = [
      { role: "user" as const, content: "Hello", timestamp: Date.now() },
      { role: "assistant" as const, content: "Hi there", timestamp: Date.now() },
      { role: "user" as const, content: "How are you?", timestamp: Date.now() },
    ] as AgentMessage[];
    expect(extractMessagesContent(messages)).toBe(
      "User: Hello\nAgent: Hi there\nUser: How are you?",
    );
  });

  it("skips non-user/assistant roles", () => {
    const messages = [
      { role: "system" as const, content: "System prompt", timestamp: Date.now() },
      { role: "user" as const, content: "Hello", timestamp: Date.now() },
      { role: "tool" as const, content: "Tool result", timestamp: Date.now() },
    ] as AgentMessage[];
    expect(extractMessagesContent(messages)).toBe("User: Hello");
  });

  it("skips messages with empty content", () => {
    const messages = [
      { role: "user" as const, content: "Hello", timestamp: Date.now() },
      { role: "assistant" as const, content: "", timestamp: Date.now() },
      { role: "user" as const, content: "Another message", timestamp: Date.now() },
    ] as AgentMessage[];
    expect(extractMessagesContent(messages)).toBe("User: Hello\nUser: Another message");
  });

  it("handles empty array", () => {
    expect(extractMessagesContent([])).toBe("");
  });
});

describe("appendWarningToToolResult", () => {
  it("appends warning to existing content array", () => {
    const result = {
      content: [{ type: "text" as const, text: "original" }],
      details: {},
    };
    const modified = appendWarningToToolResult(result, "warning message");
    expect(modified.content).toEqual([
      { type: "text", text: "original" },
      { type: "text", text: "warning message" },
    ]);
  });

  it("creates content array if not present", () => {
    const result = { content: undefined as unknown, details: {} } as AgentToolResult<unknown>;
    const modified = appendWarningToToolResult(result, "warning");
    expect(modified.content).toEqual([{ type: "text", text: "warning" }]);
  });

  it("does not mutate original result", () => {
    const original = {
      content: [{ type: "text" as const, text: "original" }],
      details: {},
    };
    appendWarningToToolResult(original, "warning");
    expect(original.content).toHaveLength(1);
  });
});

describe("replaceToolResultWithWarning", () => {
  it("replaces content with warning", () => {
    const result = {
      content: [{ type: "text" as const, text: "original" }],
      details: {},
    };
    const modified = replaceToolResultWithWarning(result, "warning message");
    expect(modified.content).toEqual([{ type: "text", text: "warning message" }]);
  });

  it("includes guardrailWarning in details", () => {
    const result = { content: [], details: { existing: "data" } };
    const modified = replaceToolResultWithWarning(result, "warning");
    const details = modified.details as { guardrailWarning?: string; existing?: string };
    expect(details.guardrailWarning).toBe("warning");
    expect(details.existing).toBe("data");
  });

  it("creates details with guardrailWarning if none exists", () => {
    const result = { content: [], details: {} };
    const modified = replaceToolResultWithWarning(result, "warning");
    const details = modified.details as { guardrailWarning?: string };
    expect(details.guardrailWarning).toBe("warning");
  });
});

describe("guardrail run id helpers", () => {
  it("creates guardrail run ids with the expected prefix", () => {
    const runId = createGuardrailRunId("gpt-oss-safeguard");
    expect(runId.startsWith("guardrail:")).toBe(true);
    expect(isGuardrailRunId(runId)).toBe(true);
  });

  it("returns false for non-guardrail ids", () => {
    expect(isGuardrailRunId("session-123")).toBe(false);
    expect(isGuardrailRunId(undefined)).toBe(false);
  });
});

describe("buildToolCallSummary", () => {
  it("builds JSON summary of tool call", () => {
    const summary = buildToolCallSummary("readFile", "call-123", { path: "/test.txt" });
    expect(JSON.parse(summary)).toEqual({
      tool: "readFile",
      toolCallId: "call-123",
      params: { path: "/test.txt" },
    });
  });

  it("falls back to tool name on stringify error", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const summary = buildToolCallSummary("testTool", "id", circular);
    expect(summary).toBe("testTool");
  });
});

describe("isStageEnabled", () => {
  it("returns false for undefined stage", () => {
    expect(isStageEnabled(undefined)).toBe(false);
  });

  it("returns true for stage with enabled not set", () => {
    expect(isStageEnabled({})).toBe(true);
  });

  it("returns true for stage with enabled=true", () => {
    expect(isStageEnabled({ enabled: true })).toBe(true);
  });

  it("returns false for stage with enabled=false", () => {
    expect(isStageEnabled({ enabled: false })).toBe(false);
  });
});

describe("resolveBlockMode", () => {
  it("returns configured blockMode if set", () => {
    expect(resolveBlockMode("before_request", { blockMode: "append" })).toBe("append");
    expect(resolveBlockMode("after_tool_call", { blockMode: "replace" })).toBe("replace");
  });

  it("defaults to append for after_tool_call", () => {
    expect(resolveBlockMode("after_tool_call", {})).toBe("append");
    expect(resolveBlockMode("after_tool_call", undefined)).toBe("append");
  });

  it("defaults to replace for other stages", () => {
    expect(resolveBlockMode("before_request", {})).toBe("replace");
    expect(resolveBlockMode("after_response", undefined)).toBe("replace");
    expect(resolveBlockMode("before_tool_call", {})).toBe("replace");
  });
});

describe("resolveStageConfig", () => {
  const stages = {
    beforeRequest: { enabled: true, mode: "block" as const },
    beforeToolCall: { enabled: false },
    afterToolCall: { enabled: true, mode: "monitor" as const },
    afterResponse: { enabled: true, blockMode: "append" as const },
  };

  it("returns correct stage config for each stage", () => {
    expect(resolveStageConfig(stages, "before_request")).toEqual({
      enabled: true,
      mode: "block",
    });
    expect(resolveStageConfig(stages, "before_tool_call")).toEqual({ enabled: false });
    expect(resolveStageConfig(stages, "after_tool_call")).toEqual({
      enabled: true,
      mode: "monitor",
    });
    expect(resolveStageConfig(stages, "after_response")).toEqual({
      enabled: true,
      blockMode: "append",
    });
  });

  it("returns undefined for undefined stages", () => {
    expect(resolveStageConfig(undefined, "before_request")).toBeUndefined();
  });

  it("returns undefined for missing stage", () => {
    expect(resolveStageConfig({}, "before_request")).toBeUndefined();
  });
});

describe("generateSessionId", () => {
  it("generates session ID with prefix", () => {
    const id = generateSessionId("test");
    expect(id).toMatch(/^test-\d+-[a-z0-9]+$/);
  });

  it("generates unique IDs", () => {
    const id1 = generateSessionId("prefix");
    const id2 = generateSessionId("prefix");
    expect(id1).not.toBe(id2);
  });
});

describe("safeJsonStringify", () => {
  it("stringifies valid JSON", () => {
    expect(safeJsonStringify({ key: "value" })).toBe('{"key":"value"}');
    expect(safeJsonStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(safeJsonStringify("string")).toBe('"string"');
  });

  it("returns null for circular references", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeJsonStringify(circular)).toBeNull();
  });

  it("handles BigInt (returns null)", () => {
    expect(safeJsonStringify({ big: BigInt(123) })).toBeNull();
  });
});
