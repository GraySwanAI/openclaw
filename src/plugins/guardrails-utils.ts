/**
 * Guardrail Utilities
 *
 * Shared utilities for LLM-based guardrail plugins (llamaguard, gpt-oss-safeguard, etc.).
 * These utilities provide a common interface for running embedded Pi agents,
 * managing temporary directories, and parsing LLM responses.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Types for the embedded Pi agent runner
type EmbeddedPiAgentPayload = {
  text?: string;
  isError?: boolean;
};

type EmbeddedPiAgentResult = {
  payloads?: EmbeddedPiAgentPayload[];
  meta?: {
    durationMs?: number;
    agentMeta?: {
      sessionId?: string;
      provider?: string;
      model?: string;
    };
    error?: {
      kind: string;
      message: string;
    };
  };
};

export type RunEmbeddedPiAgentFn = (
  params: Record<string, unknown>,
) => Promise<EmbeddedPiAgentResult>;

/**
 * Dynamically load the runEmbeddedPiAgent function.
 * Works in both source checkout (dev/test) and bundled install (production).
 */
export async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  // Source checkout (tests/dev) - try src/ first
  try {
    const mod = await import("../agents/pi-embedded-runner.js");
    if (typeof (mod as any).runEmbeddedPiAgent === "function") {
      return (mod as any).runEmbeddedPiAgent;
    }
  } catch {
    // ignore - try bundled path
  }

  // Bundled install (built) - fall back to dist/ path (relative from plugins/ -> agents/)
  // Note: This path works at runtime when the built code is in dist/
  try {
    // Dynamic import with variable to prevent static analysis errors during build
    const distPath = "../agents/pi-embedded-runner.js";
    const mod = await import(/* @vite-ignore */ distPath);
    if (typeof mod.runEmbeddedPiAgent === "function") {
      return mod.runEmbeddedPiAgent as RunEmbeddedPiAgentFn;
    }
  } catch {
    // ignore
  }

  throw new Error("Internal error: runEmbeddedPiAgent not available");
}

/**
 * Create a temporary directory for guardrail operations.
 * @param prefix Prefix for the temp directory name
 * @returns Path to the created temporary directory
 */
export async function createGuardrailTempDir(prefix: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${prefix}-`));
  return tmpDir;
}

/**
 * Clean up a temporary directory created for guardrail operations.
 * @param dir Path to the temporary directory
 */
export async function cleanupGuardrailTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

/**
 * Collect text from embedded Pi agent payloads.
 * Filters out error payloads and joins text content.
 * @param payloads Array of payloads from the agent result
 * @returns Combined text content
 */
export function collectPayloadText(
  payloads: Array<{ text?: string; isError?: boolean }> | undefined,
): string {
  const texts = (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "");
  return texts.join("\n").trim();
}

/**
 * Strip markdown code fences from a string.
 * Useful for parsing LLM responses that may include JSON wrapped in fences.
 * @param s Input string
 * @returns String with code fences removed
 */
export function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) {
    return (m[1] ?? "").trim();
  }
  return trimmed;
}

/**
 * Build a model key string from provider and model.
 * @param provider Provider ID (e.g., "ollama", "openai")
 * @param model Model ID (e.g., "llama-guard3:8b")
 * @returns Combined key like "ollama/llama-guard3:8b" or undefined if invalid
 */
export function toModelKey(provider?: string, model?: string): string | undefined {
  const p = provider?.trim();
  const m = model?.trim();
  if (!p || !m) {
    return undefined;
  }
  return `${p}/${m}`;
}
