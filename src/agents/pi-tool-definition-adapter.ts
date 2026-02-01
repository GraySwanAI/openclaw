import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import { logDebug, logError } from "../logger.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";

// biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type from pi-agent-core uses a different module instance.
type AnyAgentTool = AgentTool<any, unknown>;

/** Context passed to tool hooks */
export type ToolHookContext = {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
};

function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

export function toToolDefinitions(
  tools: AnyAgentTool[],
  hookContext?: ToolHookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      // biome-ignore lint/suspicious/noExplicitAny: TypeBox schema from pi-agent-core uses a different module instance.
      parameters: tool.parameters,
      execute: async (
        toolCallId,
        params,
        onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        _ctx,
        signal,
      ): Promise<AgentToolResult<unknown>> => {
        // KNOWN: pi-coding-agent `ToolDefinition.execute` has a different signature/order
        // than pi-agent-core `AgentTool.execute`. This adapter keeps our existing tools intact.
        const hookRunner = getGlobalHookRunner();
        const toolCtx = {
          agentId: hookContext?.agentId,
          sessionKey: hookContext?.sessionKey,
          workspaceDir: hookContext?.workspaceDir,
          messageProvider: hookContext?.messageProvider,
          toolName: normalizedName,
        };

        // Run before_tool_call hooks - may modify params or block execution
        let effectiveParams = params;
        if (hookRunner?.hasHooks("before_tool_call")) {
          try {
            const beforeResult = await hookRunner.runBeforeToolCall(
              {
                toolName: normalizedName,
                toolCallId,
                params: params as Record<string, unknown>,
              },
              toolCtx,
            );
            if (beforeResult?.block) {
              logDebug(
                `[tools] ${normalizedName} blocked by hook: ${beforeResult.blockReason ?? "no reason"}`,
              );
              return jsonResult({
                status: "blocked",
                tool: normalizedName,
                reason: beforeResult.blockReason ?? "Blocked by policy",
              });
            }
            if (beforeResult?.params) {
              effectiveParams = beforeResult.params;
            }
          } catch (hookErr) {
            logError(`[tools] before_tool_call hook failed for ${normalizedName}: ${hookErr}`);
          }
        }

        const startTime = Date.now();
        let result: AgentToolResult<unknown>;
        let execError: string | undefined;

        try {
          result = await tool.execute(toolCallId, effectiveParams, signal, onUpdate);
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const errName =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (errName === "AbortError") {
            throw err;
          }
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          logError(`[tools] ${normalizedName} failed: ${described.message}`);
          execError = described.message;
          result = jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });
        }

        // Run after_tool_call hooks - may modify result
        if (hookRunner?.hasHooks("after_tool_call")) {
          try {
            const afterResult = await hookRunner.runAfterToolCall(
              {
                toolName: normalizedName,
                toolCallId,
                params: effectiveParams as Record<string, unknown>,
                resultDetails: result.details,
                error: execError,
                durationMs: Date.now() - startTime,
              },
              toolCtx,
            );
            if (afterResult?.resultDetails !== undefined) {
              // Convert modified result back to AgentToolResult format
              result = jsonResult(afterResult.resultDetails);
            }
          } catch (hookErr) {
            logError(`[tools] after_tool_call hook failed for ${normalizedName}: ${hookErr}`);
          }
        }

        return result;
      },
    } satisfies ToolDefinition;
  });
}

// Convert client tools (OpenResponses hosted tools) to ToolDefinition format
// These tools are intercepted to return a "pending" result instead of executing
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      parameters: func.parameters as any,
      execute: async (
        toolCallId,
        params,
        _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        _ctx,
        _signal,
      ): Promise<AgentToolResult<unknown>> => {
        // Notify handler that a client tool was called
        if (onClientToolCall) {
          onClientToolCall(func.name, params as Record<string, unknown>);
        }
        // Return a pending result - the client will execute this tool
        return jsonResult({
          status: "pending",
          tool: func.name,
          message: "Tool execution delegated to client",
        });
      },
    } satisfies ToolDefinition;
  });
}
