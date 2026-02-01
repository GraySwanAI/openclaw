import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import safeguardGuardrail from "./index.js";
import type { GuardrailOutput, OpenClawPluginApi, PluginLogger } from "../../src/plugins/types.js";

// Mock the guardrails-utils module
vi.mock("../../src/plugins/guardrails-utils.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...(original as object),
    loadRunEmbeddedPiAgent: vi.fn(),
    createGuardrailTempDir: vi.fn().mockResolvedValue("/tmp/safeguard-test"),
    cleanupGuardrailTempDir: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  loadRunEmbeddedPiAgent,
  createGuardrailTempDir,
  cleanupGuardrailTempDir,
} from "../../src/plugins/guardrails-utils.js";

const mockLoadRunner = loadRunEmbeddedPiAgent as ReturnType<typeof vi.fn>;
const mockCreateTempDir = createGuardrailTempDir as ReturnType<typeof vi.fn>;
const mockCleanupTempDir = cleanupGuardrailTempDir as ReturnType<typeof vi.fn>;

function createMockApi(pluginConfig: Record<string, unknown> = {}): OpenClawPluginApi & {
  _handlers: Map<string, { handler: Function; priority: number }[]>;
} {
  const handlers: Map<string, { handler: Function; priority: number }[]> = new Map();
  const mockLogger: PluginLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    id: "gpt-oss-safeguard",
    name: "GPT-OSS Safeguard",
    source: "test",
    config: {},
    pluginConfig,
    runtime: {} as any,
    logger: mockLogger,
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (p) => p,
    on: vi.fn((hookName: string, handler: Function, opts?: { priority?: number }) => {
      const existing = handlers.get(hookName) ?? [];
      existing.push({ handler, priority: opts?.priority ?? 0 });
      handlers.set(hookName, existing);
    }),
    _handlers: handlers,
  } as OpenClawPluginApi & { _handlers: Map<string, { handler: Function; priority: number }[]> };
}

function mockAgentResponse(text: string) {
  const mockRunner = vi.fn().mockResolvedValue({
    payloads: [{ text, isError: false }],
    meta: { durationMs: 100 },
  });
  mockLoadRunner.mockResolvedValue(mockRunner);
  return mockRunner;
}

describe("gpt-oss-safeguard guardrail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTempDir.mockResolvedValue("/tmp/safeguard-test");
    mockCleanupTempDir.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct plugin metadata", () => {
    expect(safeguardGuardrail.id).toBe("gpt-oss-safeguard");
    expect(safeguardGuardrail.name).toBe("GPT-OSS Safeguard");
  });

  it("does not register when not enabled", async () => {
    const api = createMockApi({ enabled: false });
    await safeguardGuardrail.register?.(api);
    expect(api.on).not.toHaveBeenCalled();
  });

  it("logs info message on register with defaults", async () => {
    const api = createMockApi({ enabled: true });
    await safeguardGuardrail.register?.(api);
    expect(api.logger.info).toHaveBeenCalledWith(
      "GPT-OSS Safeguard enabled ((default)/(default), binary format, default policy)",
    );
  });

  it("logs info message with custom config", async () => {
    const api = createMockApi({
      enabled: true,
      provider: "openai",
      model: "gpt-4",
      outputFormat: "json",
      policy: "Custom policy",
    });
    await safeguardGuardrail.register?.(api);
    expect(api.logger.info).toHaveBeenCalledWith(
      "GPT-OSS Safeguard enabled (openai/gpt-4, json format, custom policy)",
    );
  });

  describe("binary output format", () => {
    it("allows content with 0 response", async () => {
      mockAgentResponse("0");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Hello, how are you?", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });

    it("blocks content with 1 response", async () => {
      mockAgentResponse("1");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Harmful content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toContain("input");
    });

    it("treats unclear response as unsafe", async () => {
      mockAgentResponse("maybe");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
    });
  });

  describe("json output format", () => {
    it("allows safe content", async () => {
      mockAgentResponse('{"safe": true}');

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        outputFormat: "json",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Hello", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });

    it("blocks unsafe content with reason", async () => {
      mockAgentResponse('{"safe": false, "reason": "Contains violent content"}');

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        outputFormat: "json",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Harmful content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toContain("Contains violent content");
      expect(result.details?.reason).toBe("Contains violent content");
    });

    it("handles JSON with code fences", async () => {
      mockAgentResponse('```json\n{"safe": true}\n```');

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        outputFormat: "json",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Hello", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });

    it("handles invalid JSON as unsafe", async () => {
      mockAgentResponse("not valid json");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        outputFormat: "json",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toContain("Failed to parse response");
    });
  });

  describe("rich output format", () => {
    it("allows safe content", async () => {
      mockAgentResponse('{"safe": true, "confidence": 0.95}');

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        outputFormat: "rich",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Hello", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });

    it("blocks unsafe content with full details", async () => {
      mockAgentResponse(
        '{"safe": false, "reason": "Promotes violence", "categories": ["violence", "hate"], "confidence": 0.9}',
      );

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        outputFormat: "rich",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Harmful content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toContain("Promotes violence");
      expect(result.reason).toContain("categories: violence, hate");
      expect(result.details?.categories).toEqual(["violence", "hate"]);
      expect(result.details?.confidence).toBe(0.9);
    });
  });

  describe("before_llm_call hook", () => {
    it("uses user role for before stage", async () => {
      const mockRunner = mockAgentResponse("0");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.prompt).toContain("user input");
    });

    it("allows empty content", async () => {
      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
      expect(mockLoadRunner).not.toHaveBeenCalled();
    });
  });

  describe("after_llm_call hook", () => {
    it("uses assistant role for after stage", async () => {
      const mockRunner = mockAgentResponse("0");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("after_llm_call")![0].handler;
      await handler(
        {
          messages: [],
          newMessages: [{ role: "assistant", content: "Response content" }],
          turnNumber: 1,
        },
        { stage: "after", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.prompt).toContain("assistant response");
    });

    it("includes tool calls in evaluation", async () => {
      const mockRunner = mockAgentResponse("0");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("after_llm_call")![0].handler;
      await handler(
        {
          messages: [],
          newMessages: [{ role: "assistant", content: "Running command" }],
          toolCalls: [{ name: "bash", params: { command: "rm -rf /" } }],
          turnNumber: 1,
        },
        { stage: "after", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.prompt).toContain("Tool: bash");
      expect(callArgs.prompt).toContain("rm -rf /");
    });

    it("blocks output with unsafe response", async () => {
      mockAgentResponse("1");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("after_llm_call")![0].handler;
      const result = (await handler(
        {
          messages: [],
          newMessages: [{ role: "assistant", content: "Harmful response" }],
          turnNumber: 1,
        },
        { stage: "after", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toContain("output");
    });
  });

  describe("configuration", () => {
    it("uses custom policy", async () => {
      const mockRunner = mockAgentResponse("0");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        policy: "Custom safety policy: no cursing allowed.",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.prompt).toContain("Custom safety policy: no cursing allowed.");
    });

    it("uses context provider/model when not configured", async () => {
      const mockRunner = mockAgentResponse("0");

      const api = createMockApi({ enabled: true });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "anthropic", modelId: "claude-3" },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.provider).toBe("anthropic");
      expect(callArgs.model).toBe("claude-3");
    });

    it("uses configured provider/model over context", async () => {
      const mockRunner = mockAgentResponse("0");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "anthropic", modelId: "claude-3" },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.provider).toBe("openai");
      expect(callArgs.model).toBe("gpt-4");
    });

    it("uses custom timeout and maxTokens", async () => {
      const mockRunner = mockAgentResponse("0");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        timeoutMs: 60000,
        maxTokens: 1000,
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.timeoutMs).toBe(60000);
      expect(callArgs.streamParams.maxTokens).toBe(1000);
    });

    it("maps reasoningEffort to thinkLevel", async () => {
      const mockRunner = mockAgentResponse("0");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        reasoningEffort: "high",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.thinkLevel).toBe("high");
    });
  });

  describe("error handling", () => {
    it("throws when provider/model not available", async () => {
      const api = createMockApi({ enabled: true });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 }, // No provider/model in context
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toContain("evaluation error");
    });

    it("handles empty response", async () => {
      mockAgentResponse("");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        failOpen: true,
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
      expect(api.logger.error).toHaveBeenCalled();
    });

    it("handles runner errors with failOpen", async () => {
      mockLoadRunner.mockRejectedValue(new Error("Runner failed"));

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        failOpen: true,
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });

    it("blocks on errors with failOpen: false", async () => {
      mockLoadRunner.mockRejectedValue(new Error("Runner failed"));

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
        failOpen: false,
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
    });

    it("cleans up temp directory", async () => {
      mockAgentResponse("0");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "gpt-4",
      });
      await safeguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1, provider: "openai", modelId: "gpt-4" },
      );

      expect(mockCleanupTempDir).toHaveBeenCalledWith("/tmp/safeguard-test");
    });
  });
});
