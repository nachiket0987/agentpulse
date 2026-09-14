/**
 * AgentTrace Auto-Instrument
 *
 * Zero-code auto-instrumentation for AI agents.
 *
 * Usage (import before any agent framework):
 *   import '@agenttrace-io/auto-instrument';
 *
 * Or via CLI:
 *   agenttrace-instrument node my-agent.js
 *   agenttrace-instrument --scan
 *
 * Environment variables:
 *   AGENTTRACE_DB_PATH       Database path (default: ~/.agenttrace/agenttrace.db)
 *   AGENTTRACE_SERVICE_NAME  Service name (default: from package.json)
 *   AGENTTRACE_AUTO_INIT     Auto-init on import (true/false)
 *   AGENTTRACE_DEBUG         Enable debug output (true/false)
 */

import Module from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { TraceStorage } from '@agenttrace-io/sdk';

let initialized = false;
let shutdownHandlersRegistered = false;

export interface AutoInstrumentConfig {
  dbPath?: string;
  serviceName?: string;
  console?: boolean;
  scanIntervalMs?: number;
}

/** Minimal structural types for the third-party SDK shapes we patch. */
type AsyncFn = (...args: unknown[]) => Promise<unknown>;

interface LangChainModule {
  BaseChain?: { prototype?: { _call?: AsyncFn } };
}

interface OpenAIModule {
  OpenAI?: { prototype?: { chat?: { completions?: { create?: AsyncFn } } } };
}

interface AnthropicModule {
  Anthropic?: { prototype?: { messages?: { create?: AsyncFn } } };
}

interface ModuleWithRequire {
  prototype: { require: (id: string) => unknown };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function getDbPath(config?: AutoInstrumentConfig): string {
  return (
    config?.dbPath ||
    process.env.AGENTTRACE_DB_PATH ||
    path.join(os.homedir(), '.agenttrace', 'agenttrace.db')
  );
}

/**
 * Initialize auto-instrumentation.
 * Patches require() to auto-detect and patch known agent frameworks.
 */
export function initAutoInstrument(config: AutoInstrumentConfig = {}): void {
  if (initialized) return;
  initialized = true;

  const dbPath = getDbPath(config);

  if (config.console || process.env.AGENTTRACE_DEBUG === 'true') {
    console.log(`[AgentTrace] Auto-instrumentation initialized`);
    console.log(`[AgentTrace] DB: ${dbPath}`);
  }

  setupProcessHooks(dbPath);
  registerShutdownHandlers();
}

function setupProcessHooks(dbPath: string): void {
  const ModuleRef = Module as unknown as ModuleWithRequire;
  const origRequire = ModuleRef.prototype.require;

  ModuleRef.prototype.require = function (this: unknown, id: string): unknown {
    const result = origRequire.call(this, id);

    try {
      // Auto-detect LangChain
      if (id.includes('langchain') || id.includes('@langchain')) {
        patchLangChain(result as LangChainModule, dbPath);
      }
      // Auto-detect OpenAI SDK
      if (id === 'openai' || id.includes('openai')) {
        patchOpenAISDK(result as OpenAIModule, dbPath);
      }
      // Auto-detect Anthropic SDK
      if (id === 'anthropic' || id.includes('@anthropic')) {
        patchAnthropic(result as AnthropicModule, dbPath);
      }
    } catch {
      /* never crash the host application */
    }

    return result;
  };
}

function patchLangChain(mod: LangChainModule, dbPath: string): void {
  const proto = mod?.BaseChain?.prototype;
  if (proto?._call) {
    const original = proto._call;
    proto._call = async function (this: { constructor: { name: string } }, ...args: unknown[]) {
      const startTime = Date.now();
      try {
        const result = await original.apply(this, args);
        const latencyMs = Date.now() - startTime;
        recordTrace(dbPath, {
          name: `langchain:${this.constructor.name}`,
          status: 'success',
          input: args[0],
          output: result,
          latencyMs,
        });
        return result;
      } catch (e: unknown) {
        const latencyMs = Date.now() - startTime;
        recordTrace(dbPath, {
          name: `langchain:${this.constructor.name}`,
          status: 'error',
          input: args[0],
          output: null,
          latencyMs,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    };
  }
}

function patchOpenAISDK(mod: OpenAIModule, dbPath: string): void {
  const proto = mod?.OpenAI?.prototype?.chat?.completions;
  if (proto?.create) {
    const original = proto.create;
    proto.create = async function (this: unknown, ...args: unknown[]) {
      const startTime = Date.now();
      const body = asRecord(args[0]);
      try {
        const result = await original.apply(this, args);
        const latencyMs = Date.now() - startTime;
        const res = asRecord(result);
        const usage = asRecord(res.usage);
        const choices = Array.isArray(res.choices) ? res.choices : [];
        recordTrace(dbPath, {
          name: `openai:${(body.model as string) || 'unknown'}`,
          status: 'success',
          input: body.messages,
          output: asRecord(choices[0]).message,
          latencyMs,
          tokens: {
            promptTokens: (usage.prompt_tokens as number) || 0,
            completionTokens: (usage.completion_tokens as number) || 0,
            totalTokens: (usage.total_tokens as number) || 0,
          },
          model: body.model as string | undefined,
        });
        return result;
      } catch (e: unknown) {
        const latencyMs = Date.now() - startTime;
        recordTrace(dbPath, {
          name: `openai:${(body.model as string) || 'unknown'}`,
          status: 'error',
          input: body.messages,
          output: null,
          latencyMs,
          error: e instanceof Error ? e.message : String(e),
          model: body.model as string | undefined,
        });
        throw e;
      }
    };
  }
}

function patchAnthropic(mod: AnthropicModule, dbPath: string): void {
  const proto = mod?.Anthropic?.prototype?.messages;
  if (proto?.create) {
    const original = proto.create;
    proto.create = async function (this: unknown, ...args: unknown[]) {
      const startTime = Date.now();
      const body = asRecord(args[0]);
      try {
        const result = await original.apply(this, args);
        const latencyMs = Date.now() - startTime;
        const res = asRecord(result);
        const usage = asRecord(res.usage);
        recordTrace(dbPath, {
          name: `anthropic:${(body.model as string) || 'unknown'}`,
          status: 'success',
          input: body.messages,
          output: res.content,
          latencyMs,
          tokens: {
            promptTokens: (usage.input_tokens as number) || 0,
            completionTokens: (usage.output_tokens as number) || 0,
            totalTokens:
              ((usage.input_tokens as number) || 0) + ((usage.output_tokens as number) || 0),
          },
          model: body.model as string | undefined,
        });
        return result;
      } catch (e: unknown) {
        const latencyMs = Date.now() - startTime;
        recordTrace(dbPath, {
          name: `anthropic:${(body.model as string) || 'unknown'}`,
          status: 'error',
          input: body.messages,
          output: null,
          latencyMs,
          error: e instanceof Error ? e.message : String(e),
          model: body.model as string | undefined,
        });
        throw e;
      }
    };
  }
}

function recordTrace(
  dbPath: string,
  data: {
    name: string;
    status: string;
    input: unknown;
    output: unknown;
    latencyMs: number;
    error?: string;
    tokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
    model?: string;
  },
): void {
  try {
    const storage = new TraceStorage(dbPath);
    const runId = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    storage.createRun({
      id: runId,
      name: data.name,
      startedAt: Date.now() - data.latencyMs,
      metadata: { autoInstrumented: true, model: data.model },
    });
    storage.createTrace({
      id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      runId,
      name: data.name,
      status: data.status === 'success' ? 'success' : 'error',
      input: data.input,
      output: data.output,
      tokens: data.tokens || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      toolCalls: [],
      latencyMs: data.latencyMs,
      costUsd: 0,
      error: data.error,
      metadata: { autoInstrumented: true },
    });
    storage.completeRun(runId, data.status === 'success' ? 'success' : 'error');
    storage.close();
  } catch {
    // Never crash the host application
  }
}

function registerShutdownHandlers(): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  const handler = () => {
    shutdown();
  };

  process.on('exit', handler);
  process.on('SIGINT', () => {
    handler();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    handler();
    process.exit(143);
  });
}

/**
 * Shut down auto-instrumentation and clean up resources.
 */
export function shutdown(): void {
  if (!initialized) return;
  initialized = false;

  if (process.env.AGENTTRACE_DEBUG === 'true') {
    console.log('[AgentTrace] Auto-instrumentation shut down');
  }
}

// Auto-init if AGENTTRACE_AUTO_INIT is set
if (process.env.AGENTTRACE_AUTO_INIT === 'true') {
  initAutoInstrument();
}

export default { initAutoInstrument, shutdown };
