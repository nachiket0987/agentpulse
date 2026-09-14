/**
 * AgentTrace LangGraph Middleware
 * Automatic tracing for LangGraph node executions (JS/TS)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentTrace,
  type TraceConfig,
  type TokenUsage,
  type TraceStorage,
} from '@agenttrace-io/sdk';

function readVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '..', 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.version) return pkg.version;
    }
  } catch {
    /* fallback */
  }
  return '0.0.0';
}
export const VERSION = readVersion();
export const PACKAGE_NAME = '@agenttrace-io/middleware-langgraph';

export type { TraceConfig } from '@agenttrace-io/sdk';

/**
 * LangGraph node configuration object passed around middleware hooks.
 * This is a loose bag; LangGraph populates configurable, tags, metadata etc.
 */
export interface LangGraphNodeConfig {
  [key: string]: unknown;
  configurable?: Record<string, unknown>;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Approximate NodeMiddleware interface implemented for LangGraph.
 * Implementations of beforeNode/afterNode/onError are invoked by LangGraph
 * around each node execution when registered appropriately (e.g. via compile options
 * or graph middleware support in your LangGraph version).
 */
export interface NodeMiddleware {
  beforeNode?(
    nodeName: string,
    state: unknown,
    config?: LangGraphNodeConfig,
  ): unknown | Promise<unknown>;
  afterNode?(
    nodeName: string,
    state: unknown,
    result: unknown,
    config?: LangGraphNodeConfig,
  ): unknown | Promise<unknown>;
  onError?(
    nodeName: string,
    state: unknown,
    error: Error,
    config?: LangGraphNodeConfig,
  ): void | Promise<void>;
}

/** Shape of AgentTrace's internal (required/defaulted) config. */
interface AgentTraceInternalConfig {
  dbPath: string;
  maxTraces: number;
  autoCleanup: boolean;
  costCalculator: (tokens: TokenUsage, model?: string) => number;
  hallucinationDetector: (output: unknown, expected?: unknown) => boolean;
  silent: boolean;
}

interface AgentTraceInternals {
  config: AgentTraceInternalConfig;
  storage: TraceStorage;
  currentRunId: string | null;
}

export class AgentTraceMiddleware implements NodeMiddleware {
  private agent: AgentTrace;
  // Per-node stacks to support nested/sequential invocations of same node name
  private pending: Record<string, Array<{ startTime: number; input: unknown }>> = {};

  constructor(config: TraceConfig = {}) {
    this.agent = new AgentTrace(config);
  }

  /**
   * Access the underlying AgentTrace instance (e.g. to call startRun()).
   */
  getAgentTrace(): AgentTrace {
    return this.agent;
  }

  beforeNode(
    nodeName: string,
    state: unknown,
    _config?: LangGraphNodeConfig,
  ): unknown | Promise<unknown> {
    if (!this.pending[nodeName]) {
      this.pending[nodeName] = [];
    }
    this.pending[nodeName].push({
      startTime: Date.now(),
      input: state,
    });
    return state;
  }

  afterNode(
    nodeName: string,
    state: unknown,
    result: unknown,
    _config?: LangGraphNodeConfig,
  ): unknown | Promise<unknown> {
    const stack = this.pending[nodeName] || [];
    const startInfo = stack.pop() || { startTime: Date.now(), input: state };
    if (stack.length === 0) {
      delete this.pending[nodeName];
    }

    const latencyMs = Date.now() - startInfo.startTime;
    const tokens = this.extractTokens(result, state);
    const costUsd = this.computeCost(tokens, tokens.model);

    this.recordTrace({
      name: nodeName,
      status: 'success',
      input: startInfo.input,
      output: result,
      tokens,
      latencyMs,
      costUsd,
    });

    return result;
  }

  onError(
    nodeName: string,
    state: unknown,
    error: Error,
    _config?: LangGraphNodeConfig,
  ): void | Promise<void> {
    const stack = this.pending[nodeName] || [];
    const startInfo = stack.pop() || { startTime: Date.now(), input: state };
    if (stack.length === 0) {
      delete this.pending[nodeName];
    }

    const latencyMs = Date.now() - startInfo.startTime;
    const tokens = this.extractTokens(state, null);
    const costUsd = this.computeCost(tokens, tokens.model);

    this.recordTrace({
      name: nodeName,
      status: 'error',
      input: startInfo.input,
      output: null,
      tokens,
      latencyMs,
      costUsd,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Close the underlying storage connection.
   */
  close(): void {
    this.agent.close();
  }

  private extractTokens(result: unknown, state: unknown): TokenUsage {
    const search = [result, state].filter(Boolean);
    for (const cand of search) {
      if (!cand) continue;

      // Array of messages / outputs
      if (Array.isArray(cand)) {
        for (const item of cand) {
          const t = this.extractFromCandidate(item);
          if (t.totalTokens > 0) return t;
        }
      }

      const t = this.extractFromCandidate(cand);
      if (t.totalTokens > 0) return t;
    }

    // Deep scan for any usage-like object
    const deep = this.deepFindUsage([result, state]);
    if (deep) return deep;

    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  private extractFromCandidate(cand: unknown): TokenUsage {
    if (!cand || typeof cand !== 'object')
      return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    const c = cand as Record<string, unknown>;

    // Modern LangChain: usage_metadata
    const additional = c.additional_kwargs as Record<string, unknown> | undefined;
    const kw = c.kwargs as Record<string, unknown> | undefined;
    const um = c.usage_metadata || additional?.usage_metadata || kw?.usage_metadata;
    if (um != null && typeof um === 'object') {
      const u = um as Record<string, unknown>;
      if (u.total_tokens != null || u.totalTokens != null) {
        const rm = c.response_metadata as Record<string, unknown> | undefined;
        return {
          promptTokens: (u.input_tokens ?? u.prompt_tokens ?? u.promptTokens ?? 0) as number,
          completionTokens: (u.output_tokens ??
            u.completion_tokens ??
            u.completionTokens ??
            0) as number,
          totalTokens: (u.total_tokens ?? u.totalTokens ?? 0) as number,
          model: (rm?.model_name || c.name) as string | undefined,
        };
      }
    }

    // Older tokenUsage in response_metadata
    const rm = (c.response_metadata || {}) as Record<string, unknown>;
    const tuRaw =
      rm.tokenUsage ||
      rm.token_usage ||
      rm.usage ||
      c.tokenUsage ||
      c.usage ||
      (c.llmOutput as Record<string, unknown> | undefined)?.tokenUsage;
    if (tuRaw != null && typeof tuRaw === 'object') {
      const tu = tuRaw as Record<string, unknown>;
      if (tu.totalTokens != null || tu.total_tokens != null || tu.total != null) {
        return {
          promptTokens: (tu.promptTokens ??
            tu.prompt_tokens ??
            tu.input_tokens ??
            tu.inputTokens ??
            0) as number,
          completionTokens: (tu.completionTokens ??
            tu.completion_tokens ??
            tu.output_tokens ??
            tu.outputTokens ??
            0) as number,
          totalTokens: (tu.totalTokens ?? tu.total_tokens ?? tu.total ?? 0) as number,
          model: rm.model_name as string | undefined,
        };
      }
    }

    // Direct on object
    if (c.totalTokens != null || c.total_tokens != null) {
      return {
        promptTokens: (c.promptTokens ?? c.prompt_tokens ?? c.input_tokens ?? 0) as number,
        completionTokens: (c.completionTokens ??
          c.completion_tokens ??
          c.output_tokens ??
          0) as number,
        totalTokens: (c.totalTokens ?? c.total_tokens ?? 0) as number,
        model: c.model as string | undefined,
      };
    }

    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  private deepFindUsage(roots: unknown[]): TokenUsage | null {
    const seen = new Set<unknown>();
    const queue: unknown[] = [...roots];
    while (queue.length) {
      const cur = queue.shift();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);

      // check keys that look like usage
      const curObj = cur as Record<string, unknown>;
      for (const [k, v] of Object.entries(curObj)) {
        if (/usage|token/i.test(k) && v && typeof v === 'object') {
          const vo = v as Record<string, unknown>;
          const p = (vo.promptTokens ?? vo.prompt_tokens ?? vo.input_tokens ?? 0) as number;
          const c = (vo.completionTokens ??
            vo.completion_tokens ??
            vo.output_tokens ??
            0) as number;
          const t = (vo.totalTokens ?? vo.total_tokens ?? vo.total ?? 0) as number;
          if (t || p || c) {
            return {
              promptTokens: p,
              completionTokens: c,
              totalTokens: t,
              model: vo.model as string | undefined,
            };
          }
        }
        if (v && typeof v === 'object') queue.push(v);
      }
    }
    return null;
  }

  private computeCost(tokens: TokenUsage, model?: string): number {
    const internals = this.agent as unknown as AgentTraceInternals;
    const cfg = internals.config || ({} as AgentTraceInternalConfig);
    const calc = cfg.costCalculator;
    if (typeof calc === 'function') {
      return calc(tokens, model || tokens.model);
    }
    // Fallback (matches SDK defaultCostCalculator)
    const rates: Record<string, { prompt: number; completion: number }> = {
      'gpt-4o': { prompt: 0.0025, completion: 0.01 },
      'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
      'claude-sonnet-4': { prompt: 0.003, completion: 0.015 },
      'claude-haiku-4': { prompt: 0.00025, completion: 0.00125 },
      'gemini-2.0-flash': { prompt: 0.0001, completion: 0.0004 },
      'llama-3.1-70b': { prompt: 0.0009, completion: 0.0009 },
    };
    const rate = rates[model || tokens.model || ''] || { prompt: 0.001, completion: 0.002 };
    return (tokens.promptTokens * rate.prompt + tokens.completionTokens * rate.completion) / 1000;
  }

  private recordTrace(opts: {
    name: string;
    status: 'success' | 'error';
    input: unknown;
    output: unknown;
    tokens: TokenUsage;
    latencyMs: number;
    costUsd: number;
    error?: string;
  }): void {
    const internals = this.agent as unknown as AgentTraceInternals;
    const storage = internals.storage;
    const cfg = internals.config || ({} as AgentTraceInternalConfig);
    const currentRun = internals.currentRunId;
    const runId = currentRun || randomUUID();

    // Ensure a run row exists (TS storage.createTrace does not auto-create stub runs like the Python port;
    // without this, traces with ad-hoc runIds (no prior startRun) hit FK constraint).
    if (!currentRun && storage.getRun && storage.createRun) {
      if (!storage.getRun(runId)) {
        try {
          storage.createRun({
            id: runId,
            name: `langgraph-${runId.substring(0, 8)}`,
            startedAt: Date.now(),
            metadata: { auto: true, framework: 'langgraph' },
          });
        } catch (_) {
          /* ignore (race, already exists, etc.) */
        }
      }
    }

    const trace = {
      id: randomUUID(),
      runId,
      name: opts.name,
      status: opts.status,
      input: opts.input ?? null,
      output: opts.output ?? null,
      tokens: opts.tokens,
      toolCalls: [],
      latencyMs: opts.latencyMs,
      costUsd: opts.costUsd,
      error: opts.error,
      metadata: { framework: 'langgraph' as const },
    };

    try {
      storage.createTrace(trace);
      if (cfg.autoCleanup !== false) {
        storage.cleanup(cfg.maxTraces || 10000);
      }
    } catch (e) {
      if (!cfg.silent) {
        console.error('[AgentTraceMiddleware] failed to record trace:', e);
      }
    }
  }
}
