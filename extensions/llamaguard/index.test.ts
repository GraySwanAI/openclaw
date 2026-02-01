import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import llamaguardGuardrail from "./index.js";
import type { GuardrailOutput, OpenClawPluginApi, PluginLogger } from "../../src/plugins/types.js";

// Mock the guardrails-utils module
vi.mock("../../src/plugins/guardrails-utils.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...(original as object),
    loadRunEmbeddedPiAgent: vi.fn(),
    createGuardrailTempDir: vi.fn().mockResolvedValue("/tmp/llamaguard-test"),
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
    id: "llamaguard",
    name: "Llama Guard",
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

describe("llamaguard guardrail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTempDir.mockResolvedValue("/tmp/llamaguard-test");
    mockCleanupTempDir.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct plugin metadata", () => {
    expect(llamaguardGuardrail.id).toBe("llamaguard");
    expect(llamaguardGuardrail.name).toBe("Llama Guard");
  });

  it("does not register when not enabled", async () => {
    const api = createMockApi({ enabled: false });
    await llamaguardGuardrail.register?.(api);
    expect(api.on).not.toHaveBeenCalled();
  });

  it("logs info message on register with defaults", async () => {
    const api = createMockApi({ enabled: true });
    await llamaguardGuardrail.register?.(api);
    expect(api.logger.info).toHaveBeenCalledWith(
      "Llama Guard guardrail enabled (ollama/llama-guard3:8b, 14 categories)",
    );
  });

  it("logs info message with custom config", async () => {
    const api = createMockApi({
      enabled: true,
      provider: "openai",
      model: "llama-guard-custom",
      categories: [{ code: "S1", name: "Test" }],
    });
    await llamaguardGuardrail.register?.(api);
    expect(api.logger.info).toHaveBeenCalledWith(
      "Llama Guard guardrail enabled (openai/llama-guard-custom, 1 categories)",
    );
  });

  describe("before_llm_call hook", () => {
    it("allows safe content", async () => {
      mockAgentResponse("safe");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Hello, how are you?", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });

    it("blocks unsafe content with categories", async () => {
      mockAgentResponse("unsafe\nS1,S10");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Some harmful content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toContain("unsafe categories");
      expect(result.reason).toContain("S1 (Violent Crimes)");
      expect(result.reason).toContain("S10 (Hate)");
      expect(result.details?.categories).toEqual(["S1", "S10"]);
    });

    it("blocks unsafe content without categories", async () => {
      mockAgentResponse("unsafe");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Some content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toContain("unsafe categories");
    });

    it("allows empty content", async () => {
      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
      expect(mockLoadRunner).not.toHaveBeenCalled();
    });

    it("uses User role for before stage", async () => {
      const mockRunner = mockAgentResponse("safe");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.prompt).toContain("User: Test content");
      expect(callArgs.prompt).toContain("ONLY THE LAST User message");
    });
  });

  describe("after_llm_call hook", () => {
    it("blocks unsafe output", async () => {
      mockAgentResponse("unsafe\nS12");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("after_llm_call")![0].handler;
      const result = (await handler(
        {
          messages: [],
          newMessages: [{ role: "assistant", content: "Some explicit content" }],
          turnNumber: 1,
        },
        { stage: "after", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toContain("output");
      expect(result.reason).toContain("S12 (Sexual Content)");
    });

    it("uses Agent role for after stage", async () => {
      const mockRunner = mockAgentResponse("safe");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("after_llm_call")![0].handler;
      await handler(
        {
          messages: [],
          newMessages: [{ role: "assistant", content: "Response content" }],
          turnNumber: 1,
        },
        { stage: "after", turnNumber: 1 },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.prompt).toContain("Agent: Response content");
      expect(callArgs.prompt).toContain("ONLY THE LAST Agent message");
    });

    it("includes tool calls in evaluation", async () => {
      const mockRunner = mockAgentResponse("safe");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("after_llm_call")![0].handler;
      await handler(
        {
          messages: [],
          newMessages: [{ role: "assistant", content: "Running command" }],
          toolCalls: [{ name: "bash", params: { command: "ls -la" } }],
          turnNumber: 1,
        },
        { stage: "after", turnNumber: 1 },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.prompt).toContain("Tool: bash");
    });
  });

  describe("configuration", () => {
    it("uses custom provider and model", async () => {
      const mockRunner = mockAgentResponse("safe");

      const api = createMockApi({
        enabled: true,
        provider: "openai",
        model: "custom-guard",
        authProfileId: "my-profile",
      });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.provider).toBe("openai");
      expect(callArgs.model).toBe("custom-guard");
      expect(callArgs.authProfileId).toBe("my-profile");
    });

    it("uses custom categories", async () => {
      const mockRunner = mockAgentResponse("unsafe\nC1");

      const api = createMockApi({
        enabled: true,
        categories: [
          { code: "C1", name: "Custom Category", description: "Custom description" },
        ],
      });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.prompt).toContain("C1: Custom Category: Custom description");

      // Note: C1 won't match the default S1-S14 regex, so it won't be parsed
      // This tests that the custom categories are included in the prompt
    });

    it("uses custom timeout and maxTokens", async () => {
      const mockRunner = mockAgentResponse("safe");

      const api = createMockApi({
        enabled: true,
        timeoutMs: 120000,
        maxTokens: 200,
      });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      );

      const callArgs = mockRunner.mock.calls[0][0];
      expect(callArgs.timeoutMs).toBe(120000);
      expect(callArgs.streamParams.maxTokens).toBe(200);
    });
  });

  describe("error handling", () => {
    it("handles empty response", async () => {
      mockAgentResponse("");

      const api = createMockApi({ enabled: true, failOpen: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
      expect(api.logger.error).toHaveBeenCalled();
    });

    it("handles runner errors with failOpen", async () => {
      mockLoadRunner.mockRejectedValue(new Error("Runner failed"));

      const api = createMockApi({ enabled: true, failOpen: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });

    it("blocks on errors with failOpen: false", async () => {
      mockLoadRunner.mockRejectedValue(new Error("Runner failed"));

      const api = createMockApi({ enabled: true, failOpen: false });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
    });

    it("cleans up temp directory on success", async () => {
      mockAgentResponse("safe");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      );

      expect(mockCleanupTempDir).toHaveBeenCalledWith("/tmp/llamaguard-test");
    });

    it("cleans up temp directory on error", async () => {
      mockLoadRunner.mockRejectedValue(new Error("Runner failed"));

      const api = createMockApi({ enabled: true, failOpen: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      );

      expect(mockCleanupTempDir).toHaveBeenCalledWith("/tmp/llamaguard-test");
    });
  });

  describe("response parsing", () => {
    it("parses 'safe' response", async () => {
      mockAgentResponse("safe");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });

    it("parses 'unsafe' with multiple categories", async () => {
      mockAgentResponse("unsafe\nS1, S3, S10");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.details?.categories).toEqual(["S1", "S3", "S10"]);
    });

    it("handles case-insensitive 'SAFE' response", async () => {
      mockAgentResponse("SAFE");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });

    it("treats unclear response as unsafe", async () => {
      mockAgentResponse("I'm not sure about this content...");

      const api = createMockApi({ enabled: true });
      await llamaguardGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Test", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
    });
  });
});
