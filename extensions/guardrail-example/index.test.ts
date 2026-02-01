import { describe, expect, it, vi } from "vitest";

import keywordGuardrail from "./index.js";
import type { OpenClawPluginApi, PluginLogger, GuardrailOutput } from "../../src/plugins/types.js";

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
    id: "guardrail-example",
    name: "Keyword Guardrail",
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

describe("guardrail-example", () => {
  it("has correct plugin metadata", () => {
    expect(keywordGuardrail.id).toBe("guardrail-example");
    expect(keywordGuardrail.name).toBe("Keyword Guardrail");
  });

  it("does not register when not enabled", () => {
    const api = createMockApi({ enabled: false });
    keywordGuardrail.register?.(api);
    expect(api.on).not.toHaveBeenCalled();
  });

  it("logs info message on register", () => {
    const api = createMockApi({ enabled: true });
    keywordGuardrail.register?.(api);
    expect(api.logger.info).toHaveBeenCalledWith("Keyword Guardrail enabled with 3 keywords");
  });

  it("logs custom keyword count", () => {
    const api = createMockApi({
      enabled: true,
      blockedKeywords: ["a", "b", "c", "d", "e"],
    });
    keywordGuardrail.register?.(api);
    expect(api.logger.info).toHaveBeenCalledWith("Keyword Guardrail enabled with 5 keywords");
  });

  describe("before_llm_call hook", () => {
    it("allows content without blocked keywords", async () => {
      const api = createMockApi({ enabled: true });
      keywordGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "Hello, how are you?", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });

    it("blocks content with default keywords", async () => {
      const api = createMockApi({ enabled: true });
      keywordGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "This is forbidden content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toBe("Content blocked: found keywords [forbidden] in input");
    });

    it("blocks content with custom keywords", async () => {
      const api = createMockApi({
        enabled: true,
        blockedKeywords: ["secret", "password"],
      });
      keywordGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "What is the password?", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toBe("Content blocked: found keywords [password] in input");
    });

    it("matches case-insensitively by default", async () => {
      const api = createMockApi({ enabled: true });
      keywordGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "This is FORBIDDEN content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
    });

    it("respects caseSensitive option", async () => {
      const api = createMockApi({
        enabled: true,
        blockedKeywords: ["Forbidden"],
        caseSensitive: true,
      });
      keywordGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;

      // Lowercase should pass
      const result1 = (await handler(
        { prompt: "This is forbidden content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;
      expect(result1.action).toBe("allow");

      // Exact case should block
      const result2 = (await handler(
        { prompt: "This is Forbidden content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;
      expect(result2.action).toBe("block");
    });

    it("reports multiple matched keywords", async () => {
      const api = createMockApi({ enabled: true });
      keywordGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "This is forbidden and restricted content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.reason).toContain("forbidden");
      expect(result.reason).toContain("restricted");
    });
  });

  describe("after_llm_call hook", () => {
    it("blocks output with blocked keywords", async () => {
      const api = createMockApi({ enabled: true });
      keywordGuardrail.register?.(api);

      const handler = api._handlers.get("after_llm_call")![0].handler;
      const result = (await handler(
        {
          messages: [],
          newMessages: [{ role: "assistant", content: "Here is the forbidden information" }],
          turnNumber: 1,
        },
        { stage: "after", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("block");
      expect(result.reason).toBe("Content blocked: found keywords [forbidden] in output");
    });

    it("allows output without blocked keywords", async () => {
      const api = createMockApi({ enabled: true });
      keywordGuardrail.register?.(api);

      const handler = api._handlers.get("after_llm_call")![0].handler;
      const result = (await handler(
        {
          messages: [],
          newMessages: [{ role: "assistant", content: "Here is some helpful information" }],
          turnNumber: 1,
        },
        { stage: "after", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("allow");
    });
  });

  describe("log action mode", () => {
    it("logs warning but uses log action when defaultAction is log", async () => {
      const api = createMockApi({
        enabled: true,
        stages: {
          before: { defaultAction: "log" },
        },
      });
      keywordGuardrail.register?.(api);

      const handler = api._handlers.get("before_llm_call")![0].handler;
      const result = (await handler(
        { prompt: "This is forbidden content", messages: [], turnNumber: 1 },
        { stage: "before", turnNumber: 1 },
      )) as GuardrailOutput;

      expect(result.action).toBe("log");
      expect(api.logger.warn).toHaveBeenCalled();
    });
  });
});
