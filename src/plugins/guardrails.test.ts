import { describe, expect, it, vi } from "vitest";

import {
  createGuardrailPlugin,
  extractContent,
  extractTextFromMessages,
  extractToolCallsText,
  type GuardrailConfig,
  type GuardrailDefinition,
  type GuardrailEvaluation,
} from "./guardrails.js";
import type { OpenClawPluginApi, PluginLogger, GuardrailOutput } from "./types.js";

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
    id: "test-guardrail",
    name: "Test Guardrail",
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

describe("createGuardrailPlugin", () => {
  it("does not register hooks when not enabled", () => {
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate() {
        return { safe: true };
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({ enabled: false });

    plugin.register?.(api);

    expect(api.on).not.toHaveBeenCalled();
  });

  it("registers both hooks by default when enabled", () => {
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate() {
        return { safe: true };
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({ enabled: true });

    plugin.register?.(api);

    expect(api.on).toHaveBeenCalledWith("before_llm_call", expect.any(Function), { priority: 50 });
    expect(api.on).toHaveBeenCalledWith("after_llm_call", expect.any(Function), { priority: 50 });
  });

  it("only registers before hook when after is disabled", () => {
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate() {
        return { safe: true };
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({
      enabled: true,
      stages: {
        after: { enabled: false },
      },
    });

    plugin.register?.(api);

    expect(api.on).toHaveBeenCalledWith("before_llm_call", expect.any(Function), { priority: 50 });
    expect(api.on).not.toHaveBeenCalledWith(
      "after_llm_call",
      expect.any(Function),
      expect.anything(),
    );
  });

  it("calls onRegister with config", () => {
    const onRegister = vi.fn();
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate() {
        return { safe: true };
      },
      onRegister,
    };

    const plugin = createGuardrailPlugin(definition);
    const config = { enabled: true, customOption: "value" };
    const api = createMockApi(config);

    plugin.register?.(api);

    expect(onRegister).toHaveBeenCalledWith(api, config);
  });

  it("returns block action when evaluate returns safe: false", async () => {
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate(): Promise<GuardrailEvaluation> {
        return { safe: false, reason: "test reason", details: { key: "value" } };
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({ enabled: true });

    plugin.register?.(api);

    const handlers = api._handlers.get("before_llm_call");
    expect(handlers).toHaveLength(1);

    const result = (await handlers![0].handler(
      { prompt: "test prompt", messages: [], turnNumber: 1 },
      { stage: "before", turnNumber: 1 },
    )) as GuardrailOutput;

    expect(result.action).toBe("block");
    expect(result.reason).toBe("test reason");
    expect(result.details).toEqual({ key: "value" });
  });

  it("returns allow action when evaluate returns safe: true", async () => {
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate() {
        return { safe: true };
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({ enabled: true });

    plugin.register?.(api);

    const handlers = api._handlers.get("before_llm_call");
    const result = (await handlers![0].handler(
      { prompt: "test prompt", messages: [], turnNumber: 1 },
      { stage: "before", turnNumber: 1 },
    )) as GuardrailOutput;

    expect(result.action).toBe("allow");
  });

  it("uses log action when defaultAction is log", async () => {
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate() {
        return { safe: false, reason: "issue detected" };
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({
      enabled: true,
      stages: {
        before: { defaultAction: "log" },
      },
    });

    plugin.register?.(api);

    const handlers = api._handlers.get("before_llm_call");
    const result = (await handlers![0].handler(
      { prompt: "test prompt", messages: [], turnNumber: 1 },
      { stage: "before", turnNumber: 1 },
    )) as GuardrailOutput;

    expect(result.action).toBe("log");
    expect(api.logger.warn).toHaveBeenCalledWith("[guardrail:test-guardrail] issue detected");
  });

  it("allows evaluation to override default action", async () => {
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate(): Promise<GuardrailEvaluation> {
        return { safe: false, action: "approval", reason: "needs approval" };
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({ enabled: true }); // default would be "block"

    plugin.register?.(api);

    const handlers = api._handlers.get("before_llm_call");
    const result = (await handlers![0].handler(
      { prompt: "test prompt", messages: [], turnNumber: 1 },
      { stage: "before", turnNumber: 1 },
    )) as GuardrailOutput;

    expect(result.action).toBe("approval");
  });

  it("handles evaluate errors with failOpen=false", async () => {
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate() {
        throw new Error("Evaluation failed");
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({ enabled: true, failOpen: false });

    plugin.register?.(api);

    const handlers = api._handlers.get("before_llm_call");
    const result = (await handlers![0].handler(
      { prompt: "test prompt", messages: [], turnNumber: 1 },
      { stage: "before", turnNumber: 1 },
    )) as GuardrailOutput;

    expect(result.action).toBe("block");
    expect(result.reason).toBe("Test Guardrail evaluation error");
    expect(api.logger.error).toHaveBeenCalled();
  });

  it("handles evaluate errors with failOpen=true", async () => {
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate() {
        throw new Error("Evaluation failed");
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({ enabled: true, failOpen: true });

    plugin.register?.(api);

    const handlers = api._handlers.get("before_llm_call");
    const result = (await handlers![0].handler(
      { prompt: "test prompt", messages: [], turnNumber: 1 },
      { stage: "before", turnNumber: 1 },
    )) as GuardrailOutput;

    expect(result.action).toBe("allow");
    expect(api.logger.error).toHaveBeenCalled();
  });

  it("passes toolCalls to evaluate in after stage", async () => {
    const evaluateFn = vi.fn().mockResolvedValue({ safe: true });
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      evaluate: evaluateFn,
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({ enabled: true });

    plugin.register?.(api);

    const handlers = api._handlers.get("after_llm_call");
    const toolCalls = [{ name: "bash", params: { command: "ls" } }];
    await handlers![0].handler(
      {
        messages: [],
        newMessages: [{ role: "assistant", content: "test" }],
        toolCalls,
        turnNumber: 1,
      },
      { stage: "after", turnNumber: 1 },
    );

    expect(evaluateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "after",
        toolCalls,
      }),
      expect.any(Object),
    );
  });

  it("preserves message modifications in output", async () => {
    const modifiedMessages = [{ role: "user" as const, content: "modified", timestamp: 0 }];
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate(): Promise<GuardrailEvaluation> {
        return { safe: true, messages: modifiedMessages };
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({ enabled: true });

    plugin.register?.(api);

    const handlers = api._handlers.get("before_llm_call");
    const result = (await handlers![0].handler(
      { prompt: "test prompt", messages: [], turnNumber: 1 },
      { stage: "before", turnNumber: 1 },
    )) as GuardrailOutput;

    expect(result.action).toBe("allow");
    expect(result.messages).toEqual(modifiedMessages);
  });

  it("preserves prompt modifications in output", async () => {
    const definition: GuardrailDefinition = {
      id: "test-guardrail",
      name: "Test Guardrail",
      async evaluate(): Promise<GuardrailEvaluation> {
        return { safe: true, prompt: "sanitized prompt" };
      },
    };

    const plugin = createGuardrailPlugin(definition);
    const api = createMockApi({ enabled: true });

    plugin.register?.(api);

    const handlers = api._handlers.get("before_llm_call");
    const result = (await handlers![0].handler(
      { prompt: "original prompt", messages: [], turnNumber: 1 },
      { stage: "before", turnNumber: 1 },
    )) as GuardrailOutput;

    expect(result.action).toBe("allow");
    expect(result.prompt).toBe("sanitized prompt");
  });
});

describe("extractContent", () => {
  it("extracts prompt when provided", () => {
    const result = extractContent([], "test prompt");
    expect(result).toBe("test prompt");
  });

  it("extracts string content from messages", () => {
    const messages = [
      { role: "user" as const, content: "Hello", timestamp: 0 },
      { role: "assistant" as const, content: "Hi there", timestamp: 0 },
    ];
    const result = extractContent(messages as any);
    expect(result).toBe("Hello\nHi there");
  });

  it("extracts text parts from array content", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text", text: "Part 1" },
          { type: "image", data: "..." },
          { type: "text", text: "Part 2" },
        ],
        timestamp: 0,
      },
    ];
    const result = extractContent(messages as any);
    expect(result).toBe("Part 1\nPart 2");
  });

  it("combines prompt and message content", () => {
    const messages = [{ role: "user" as const, content: "Hello", timestamp: 0 }];
    const result = extractContent(messages as any, "Prompt");
    expect(result).toBe("Prompt\nHello");
  });
});

describe("extractTextFromMessages", () => {
  it("extracts text from messages", () => {
    const messages = [{ role: "user" as const, content: "Test message", timestamp: 0 }];
    const result = extractTextFromMessages(messages as any);
    expect(result).toBe("Test message");
  });
});

describe("extractToolCallsText", () => {
  it("returns empty string for undefined", () => {
    expect(extractToolCallsText(undefined)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractToolCallsText([])).toBe("");
  });

  it("formats tool calls as text", () => {
    const toolCalls = [
      { name: "bash", params: { command: "ls -la" } },
      { name: "read", params: { path: "/test" } },
    ];
    const result = extractToolCallsText(toolCalls);
    expect(result).toContain("Tool: bash");
    expect(result).toContain('"command":"ls -la"');
    expect(result).toContain("Tool: read");
    expect(result).toContain('"path":"/test"');
  });
});
