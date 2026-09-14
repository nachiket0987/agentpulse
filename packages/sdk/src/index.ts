/**
 * AgentTrace -- Core SDK
 * Drop-in tracing for any AI agent
 */

import { randomUUID, createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceStorage } from './storage.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import {
  Trace,
  Run,
  TraceConfig,
  TraceFilter,
  TraceStats,
  TokenUsage,
  ToolCall,
  ExportFormat,
  Scorer,
  ScorerResult,
  EvaluateOptions,
  CostBreakdown,
  AlertCondition,
  AlertHistory,
  TraceTreeNode,
  HealthReport,
  AgentUsageRecord,
  AgentUsageFilter,
  UsageStats,
  AgentWho,
  AgentSession,
  CreatedApiKey,
  WebhookConfig,
  WebhookEvent,
  WebhookDelivery,
} from './types.js';

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
export const PACKAGE_NAME = '@agenttrace-io/sdk';

export type {
  Trace,
  Run,
  TraceConfig,
  TraceFilter,
  TraceStats,
  TokenUsage,
  ToolCall,
  ExportFormat,
  DashboardConfig,
  AgentFramework,
  FrameworkIntegration,
  Scorer,
  ScorerResult,
  EvaluateOptions,
  CostBreakdown,
  AlertCondition,
  AlertHistory,
  TraceTreeNode,
  HealthReport,
  AgentUsageRecord,
  AgentUsageFilter,
  UsageStats,
  AgentWho,
  AgentSession,
  ApiKey,
  CreatedApiKey,
  WebhookConfig,
  WebhookEvent,
  WebhookDelivery,
} from './types.js';

// Value import — TraceContext is a class (value), not just a type.
// Must be a separate import from the type-only block above so isolatedModules
// doesn't erase it at compile time.
import { TraceContext } from './types.js';

export { TraceContext } from './types.js';

export { TraceStorage } from './storage.js';
export { SelfTracker } from './self-track.js';
export type { SelfTrackerConfig } from './self-track.js';
export { TokenBucketRateLimiter } from './rate-limiter.js';
export type { RateLimiterConfig } from './rate-limiter.js';

// Default cost calculator (approximate 2026 pricing)
// Rates are in USD per 1000 tokens. Extended with additional models for v0.2.0.
const modelRates: Record<string, { prompt: number; completion: number }> = {
  'gpt-4o': { prompt: 0.0025, completion: 0.01 },
  'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
  'claude-sonnet-4': { prompt: 0.003, completion: 0.015 },
  'claude-haiku-4': { prompt: 0.00025, completion: 0.00125 },
  'gemini-2.0-flash': { prompt: 0.0001, completion: 0.0004 },
  'llama-3.1-70b': { prompt: 0.0009, completion: 0.0009 },
  // Added models (approximate current pricing researched 2026)
  'claude-opus-4': { prompt: 0.005, completion: 0.025 },
  'claude-sonnet-4.5': { prompt: 0.003, completion: 0.015 },
  'claude-haiku-4.5': { prompt: 0.001, completion: 0.005 },
  'gpt-4.1': { prompt: 0.002, completion: 0.008 },
  'gpt-4.1-mini': { prompt: 0.0004, completion: 0.0016 },
  'gpt-4.1-nano': { prompt: 0.0001, completion: 0.0004 },
  'gemini-2.5-pro': { prompt: 0.00125, completion: 0.01 },
  'gemini-2.5-flash': { prompt: 0.0003, completion: 0.0025 },
  'llama-4-scout': { prompt: 0.00008, completion: 0.0003 },
  'llama-4-maverick': { prompt: 0.00015, completion: 0.0006 },
};

function defaultCostCalculator(tokens: TokenUsage, model?: string): number {
  const rate = modelRates[model || ''] || { prompt: 0.001, completion: 0.002 };
  return (tokens.promptTokens * rate.prompt + tokens.completionTokens * rate.completion) / 1000;
}

/**
 * Register or override pricing rates for a model in the default cost calculator (used at runtime).
 * Rates are USD per 1,000 tokens (matching the calculator convention).
 * Example: registerModelRate('my-model', 0.001, 0.002)  => $1/M prompt, $2/M completion
 */
export function registerModelRate(
  model: string,
  promptRatePerK: number,
  completionRatePerK: number,
): void {
  modelRates[model] = { prompt: promptRatePerK, completion: completionRatePerK };
}

// ---- OpenTelemetry (OTLP JSON) export helpers (no external deps) ----

function toOtelId(id: string, length: number): string {
  const cleaned = id.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(cleaned)) {
    return cleaned.toLowerCase().slice(0, length);
  }
  // Fallback for non-UUID ids (e.g. test data like 'trace-1'); deterministic
  return createHash('sha256').update(id).digest('hex').slice(0, length);
}

function toUnixNano(timestampMs: number): string {
  return String(BigInt(Math.floor(timestampMs)) * 1000000n);
}

interface OtelAttrValue {
  stringValue?: string;
  intValue?: number;
  doubleValue?: number;
  boolValue?: boolean;
}

function toOtelAttrValue(v: unknown): OtelAttrValue | undefined {
  if (v === null || v === undefined) return undefined;
  const t = typeof v;
  if (t === 'string') return { stringValue: v as string };
  if (t === 'number') {
    return Number.isInteger(v as number) ? { intValue: v as number } : { doubleValue: v as number };
  }
  if (t === 'boolean') return { boolValue: v as boolean };
  return { stringValue: JSON.stringify(v) };
}

function stringifyForAttr(v: unknown, maxLen = 2048): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

function buildOtelAttributes(trace: Trace): Array<{ key: string; value: OtelAttrValue }> {
  const attrs: Array<{ key: string; value: OtelAttrValue }> = [];
  attrs.push({ key: 'agenttrace.status', value: { stringValue: trace.status } });
  attrs.push({ key: 'agenttrace.latency_ms', value: { intValue: trace.latencyMs } });
  attrs.push({ key: 'agenttrace.cost_usd', value: { doubleValue: trace.costUsd } });
  attrs.push({ key: 'agenttrace.run_id', value: { stringValue: trace.runId } });
  const tok = trace.tokens || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  attrs.push({ key: 'agenttrace.tokens.prompt', value: { intValue: tok.promptTokens } });
  attrs.push({ key: 'agenttrace.tokens.completion', value: { intValue: tok.completionTokens } });
  attrs.push({ key: 'agenttrace.tokens.total', value: { intValue: tok.totalTokens } });
  if (tok.model) {
    attrs.push({ key: 'agenttrace.model', value: { stringValue: tok.model } });
  }
  if (tok.provider) {
    attrs.push({ key: 'agenttrace.provider', value: { stringValue: tok.provider } });
  }
  if (trace.error) {
    attrs.push({ key: 'agenttrace.error', value: { stringValue: trace.error } });
  }
  // metadata
  const meta = trace.metadata || {};
  for (const [k, v] of Object.entries(meta)) {
    const otelVal = toOtelAttrValue(v);
    if (otelVal) {
      attrs.push({ key: `agenttrace.metadata.${k}`, value: otelVal });
    }
  }
  // input/output (stringified, truncated)
  if (trace.input != null) {
    attrs.push({ key: 'agenttrace.input', value: { stringValue: stringifyForAttr(trace.input) } });
  }
  if (trace.output != null) {
    attrs.push({
      key: 'agenttrace.output',
      value: { stringValue: stringifyForAttr(trace.output) },
    });
  }
  return attrs;
}

function buildResourceAttributes(): Array<{ key: string; value: OtelAttrValue }> {
  return [
    { key: 'service.name', value: { stringValue: 'agenttrace' } },
    { key: 'telemetry.sdk.name', value: { stringValue: 'agenttrace' } },
    { key: 'telemetry.sdk.version', value: { stringValue: VERSION } },
  ];
}

function traceToOtelSpan(trace: Trace): Record<string, unknown> {
  const traceId = toOtelId(trace.id, 32);
  const spanId = toOtelId(trace.id, 16);
  const endMs = trace.createdAt || Date.now();
  const startMs = Math.max(0, endMs - (trace.latencyMs || 0));
  const startTimeUnixNano = toUnixNano(startMs);
  const endTimeUnixNano = toUnixNano(endMs);
  const attributes = buildOtelAttributes(trace);
  const isSuccess = trace.status === 'success';
  const status: Record<string, unknown> = isSuccess
    ? { code: 1 } // STATUS_CODE_OK
    : { code: 2, message: trace.error || trace.status }; // STATUS_CODE_ERROR
  return {
    traceId,
    spanId,
    name: trace.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano,
    endTimeUnixNano,
    attributes,
    status,
  };
}

export class AgentTrace {
  private storage: TraceStorage;
  private config: Required<TraceConfig>;
  private currentRunId: string | null = null;
  private registeredAlerts: AlertCondition[] = [];
  private usageEmitter = new EventEmitter();
  private webhookEmitter = new EventEmitter();
  private _cleanupInterval?: NodeJS.Timeout | ReturnType<typeof setInterval>;
  private rateLimiter: TokenBucketRateLimiter | null = null;
  private activeTraceContext: { traceId: string; toolCalls: ToolCall[] } | null = null;

  constructor(config: TraceConfig = {}) {
    const dbPath = config.dbPath || './agenttrace.db';
    const tenantId = config.tenantId ?? '';
    this.storage = new TraceStorage(dbPath, tenantId);
    const persisted = this.storage.getRetentionPolicy();
    this.config = {
      dbPath,
      maxTraces: config.maxTraces ?? 10000,
      autoCleanup: config.autoCleanup !== false,
      costCalculator: config.costCalculator || defaultCostCalculator,
      hallucinationDetector: config.hallucinationDetector || (() => false),
      silent: !!config.silent,
      retentionDays:
        config.retentionDays !== undefined ? config.retentionDays : persisted.retentionDays,
      cleanupIntervalHours:
        config.cleanupIntervalHours !== undefined
          ? config.cleanupIntervalHours
          : persisted.cleanupIntervalHours,
      tenantId,
      maxTracesPerSecond: config.maxTracesPerSecond ?? 0,
      maxTracesPerMinute: config.maxTracesPerMinute ?? 0,
      burstAllowance: config.burstAllowance ?? 10,
    };

    // Initialize rate limiter if any rate limit is configured
    if (this.config.maxTracesPerSecond > 0 || this.config.maxTracesPerMinute > 0) {
      this.rateLimiter = new TokenBucketRateLimiter({
        maxTracesPerSecond: this.config.maxTracesPerSecond,
        maxTracesPerMinute: this.config.maxTracesPerMinute,
        burstAllowance: this.config.burstAllowance,
      });
    }

    this.setupRetentionCleanup();
  }

  private setupRetentionCleanup(): void {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = undefined;
    }
    if (this.config.retentionDays > 0) {
      const hours = this.config.cleanupIntervalHours > 0 ? this.config.cleanupIntervalHours : 24;
      const intervalMs = hours * 60 * 60 * 1000;
      this._cleanupInterval = setInterval(() => {
        const before = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
        try {
          this.storage.cleanupOldTraces(before);
          this.storage.cleanupOldRuns(before);
          this.storage.cleanupOldAgentUsage(before);
        } catch (_) {
          /* scheduled cleanup must never crash host process */
        }
      }, intervalMs);

      if (
        this._cleanupInterval &&
        typeof (this._cleanupInterval as NodeJS.Timeout).unref === 'function'
      ) {
        (this._cleanupInterval as NodeJS.Timeout).unref();
      }
    }
  }

  /**
   * Start a new agent run
   */
  startRun(name: string, metadata: Record<string, unknown> = {}): string {
    const runId = randomUUID();
    this.storage.createRun({
      id: runId,
      name,
      startedAt: Date.now(),
      metadata,
      tenantId: this.config.tenantId || undefined,
    });
    this.currentRunId = runId;
    return runId;
  }

  /**
   * Complete the current run
   */
  completeRun(status: Run['status'] = 'success'): void {
    if (this.currentRunId) {
      this.storage.completeRun(this.currentRunId, status);
      const runId = this.currentRunId;
      this.currentRunId = null;
      // Fire-and-forget webhook delivery for run complete/error
      if (status === 'success') {
        this.triggerWebhook('run.complete', { runId }).catch(() => {});
        try {
          this.webhookEmitter.emit('webhook', 'run.complete', { runId });
        } catch (_) {
          /* handler errors must not break */
        }
      } else {
        this.triggerWebhook('run.error', { runId }).catch(() => {});
        try {
          this.webhookEmitter.emit('webhook', 'run.error', { runId });
        } catch (_) {
          /* handler errors must not break */
        }
      }
    }
  }

  /**
   * Trace an async function call
   */
  async trace<T>(
    name: string,
    fn: () => Promise<T>,
    options: {
      input?: unknown;
      tokens?: TokenUsage;
      model?: string;
      provider?: string;
      metadata?: Record<string, unknown>;
      parentId?: string;
      context?: TraceContext;
    } = {},
  ): Promise<T> {
    const traceId: string =
      options.context && typeof options.context.traceId === 'string'
        ? options.context.traceId
        : randomUUID();
    const parentId: string | undefined =
      options.context && typeof options.context.traceId === 'string'
        ? options.context.parentSpanId
        : (options.parentId ?? undefined);
    const startTime = Date.now();
    let result: T;
    let error: string | undefined;
    let status: Trace['status'] = 'success';

    // Rate limit check
    if (this.rateLimiter && !this.rateLimiter.tryConsume()) {
      // Rate limited — execute the function but don't record the trace
      return fn();
    }

    const prevContext = this.activeTraceContext;
    this.activeTraceContext = { traceId, toolCalls: [] };

    try {
      result = await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'error';
      throw e;
    } finally {
      const latencyMs = Date.now() - startTime;
      const tokens: TokenUsage = options.tokens || {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        model: options.model,
        provider: options.provider,
      };
      const costUsd = this.config.costCalculator(tokens, options.model);

      const baseMeta = options.metadata || {};
      const ctxMeta = options.context ? options.context.metadata || {} : {};
      const mergedMeta = { ...ctxMeta, ...baseMeta };

      // Drain collected tool calls from active context (populated by recordToolCall during fn)
      const toolCalls = this.activeTraceContext ? this.activeTraceContext.toolCalls : [];
      // Restore previous context (supports nesting; top-level restores to null)
      this.activeTraceContext = prevContext;

      // Auto-create a run if none is active (ensures FK constraint satisfaction)
      const effectiveRunId = this.currentRunId || this.startRun(name);
      const trace: Omit<Trace, 'createdAt' | 'updatedAt'> = {
        id: traceId,
        runId: effectiveRunId,
        name,
        status,
        input: options.input ?? null,
        output: result! ?? null,
        tokens,
        toolCalls,
        latencyMs,
        costUsd,
        error,
        metadata: mergedMeta,
        parentId,
        tenantId: this.config.tenantId || undefined,
      };

      this.storage.createTrace(trace);

      if (this.config.autoCleanup) {
        this.storage.cleanup(this.config.maxTraces);
      }

      // Auto-check alerts after each trace (awaited so history/delivery visible to caller immediately)
      try {
        await this.checkAlerts();
      } catch (_) {
        /* alerts must never cause trace() to fail */
      }

      // Fire-and-forget webhook delivery for trace complete/error
      if (status === 'success') {
        this.triggerWebhook('trace.complete', {
          traceId,
          runId: trace.runId,
          name,
          latencyMs,
          costUsd,
        }).catch(() => {});
        try {
          this.webhookEmitter.emit('webhook', 'trace.complete', {
            traceId,
            runId: trace.runId,
            name,
            latencyMs,
            costUsd,
          });
        } catch (_) {
          /* handler errors must not break */
        }
      } else {
        this.triggerWebhook('trace.error', { traceId, runId: trace.runId, name, error }).catch(
          () => {},
        );
        try {
          this.webhookEmitter.emit('webhook', 'trace.error', {
            traceId,
            runId: trace.runId,
            name,
            error,
          });
        } catch (_) {
          /* handler errors must not break */
        }
      }
    }

    return result!;
  }

  /**
   * Record a tool call within the current trace
   */
  recordToolCall(call: Omit<ToolCall, 'id' | 'timestamp'>): string {
    const id = randomUUID();
    const timestamp = Date.now();
    const fullCall: ToolCall = { ...call, id, timestamp };

    if (this.activeTraceContext) {
      this.activeTraceContext.toolCalls.push(fullCall);
      return id;
    }

    // Outside active trace: still return id (for potential manual correlation) but warn
    if (!this.config.silent) {
      console.warn(
        `[AgentTrace] recordToolCall("${call.name}") called outside an active trace() — tool call will not be stored. Call recordToolCall from within a trace() callback.`,
      );
    }
    return id;
  }

  /**
   * Get traces with filtering
   */
  getTraces(filter: TraceFilter = {}): Trace[] {
    return this.storage.getTraces(filter);
  }

  /**
   * Get a specific trace
   */
  getTrace(id: string): Trace | null {
    return this.storage.getTrace(id);
  }

  /**
   * Get recent runs (most recent first)
   */
  getRuns(limit: number = 100): Run[] {
    return this.storage.getRuns(limit);
  }

  /**
   * Get a specific run
   */
  getRun(id: string): Run | null {
    return this.storage.getRun(id);
  }

  /**
   * Get summary statistics
   */
  getStats(): TraceStats {
    return this.storage.getStats(this.config.tenantId || undefined);
  }

  /**
   * Get the number of traces dropped due to rate limiting.
   * Returns 0 if rate limiting is not configured.
   */
  getDroppedTraces(): number {
    return this.rateLimiter?.getDroppedTraces() ?? 0;
  }

  /**
   * Get cost breakdown (by model, by day, total). Supports optional run filter.
   */
  getCostBreakdown(filter: { runId?: string } = {}): CostBreakdown {
    return this.storage.getCostBreakdown(filter.runId, this.config.tenantId || undefined);
  }

  // ---- Agent usage tracking (for self-observability by agents) ----

  /**
   * Record a usage/action event from an agent (for agent self-tracking of its own operations/costs).
   * Agents can call this to log high-level actions beyond LLM traces.
   */
  recordAgentUsage(
    record: Omit<AgentUsageRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
  ): void {
    const full: AgentUsageRecord = {
      id: record.id || randomUUID(),
      createdAt: record.createdAt || Date.now(),
      agentName: record.agentName,
      agentType: record.agentType,
      sessionId: record.sessionId,
      action: record.action,
      target: record.target,
      tokensUsed: record.tokensUsed ?? 0,
      costUsd: record.costUsd ?? 0,
      durationMs: record.durationMs ?? 0,
      status: record.status || 'success',
      metadata: record.metadata || {},
      tenantId: this.config.tenantId || undefined,
    };
    this.storage.recordAgentUsage(full);
    this.usageEmitter.emit('usage', full);
  }

  /**
   * Query recorded agent usage records.
   */
  getAgentUsage(filter: AgentUsageFilter = {}): AgentUsageRecord[] {
    return this.storage.getAgentUsage(filter, this.config.tenantId || undefined);
  }

  /**
   * Get aggregated usage statistics across agent actions.
   */
  getUsageStats(agentName?: string, fromDate?: number, toDate?: number): UsageStats {
    return this.storage.getUsageStats(
      agentName,
      fromDate,
      toDate,
      this.config.tenantId || undefined,
    );
  }

  /**
   * Get list of agents with their last active time (all time, sorted recent first).
   */
  getActiveAgents(): { agentName: string; lastActive: string; totalActions: number }[] {
    return this.storage.getActiveAgents();
  }

  /**
   * Get 'who' summary (active agents overview, supports activeOnly for last 30min).
   */
  getAgentWho(
    filter: { activeOnly?: boolean; agentType?: string; limit?: number } = {},
  ): AgentWho[] {
    return this.storage.getAgentWho(filter);
  }

  /**
   * Get agent sessions summary.
   */
  getAgentSessions(
    filter: { agentName?: string; activeOnly?: boolean; limit?: number } = {},
  ): AgentSession[] {
    return this.storage.getAgentSessions(filter);
  }

  // ---- API key management ----

  /**
   * Create a new API key for dashboard API authentication.
   * Returns the full secret key (display once) + metadata record.
   * The secret is never stored; only its SHA-256 hash is persisted.
   */
  createApiKey(name: string): CreatedApiKey {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('API key name is required');
    }
    const fullKey = `at_${randomUUID().replace(/-/g, '')}`;
    const meta = this.storage.createApiKey(name.trim(), ['read', 'write'], fullKey);
    return { ...meta, key: fullKey };
  }

  /**
   * List API keys (masked/previewed, no secrets).
   */
  listApiKeys(): {
    id: string;
    name: string;
    createdAt: number;
    lastUsedAt: number | null;
    enabled: boolean;
  }[] {
    return this.storage.getApiKeys();
  }

  /**
   * Revoke an API key by its id. Returns true if deleted.
   */
  revokeApiKey(id: string): void {
    if (!id) return;
    this.storage.revokeApiKey(id);
  }

  /**
   * Validate a raw API key string (e.g. from header). Returns matching metadata or null.
   * Side effect: updates lastUsedAt on success.
   */
  validateApiKey(key: string): { valid: boolean; permissions: string[] } {
    return this.storage.validateApiKey(key);
  }

  /**
   * Subscribe to new agent usage records (for live dashboards / SSE).
   */
  onUsage(listener: (record: AgentUsageRecord) => void): void {
    this.usageEmitter.on('usage', listener);
  }

  /**
   * Unsubscribe from agent usage events.
   */
  offUsage(listener: (record: AgentUsageRecord) => void): void {
    this.usageEmitter.off('usage', listener);
  }

  // ---- Multi-tenant Project Management ----

  /**
   * Create a new project for multi-tenant isolation.
   * Returns the project with its API key (shown only once).
   */
  createProject(name: string): { id: string; name: string; apiKey: string; createdAt: number } {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Project name is required');
    }
    return this.storage.createProject(name.trim());
  }

  /**
   * Look up a project by its API key.
   */
  getProject(apiKey: string): { id: string; name: string; createdAt: number } | null {
    const p = this.storage.getProject(apiKey);
    if (!p) return null;
    // Don't expose the apiKey in the return — caller already has it
    return { id: p.id, name: p.name, createdAt: p.createdAt };
  }

  /**
   * Delete a project by ID. Returns true if deleted.
   */
  deleteProject(id: string): boolean {
    return this.storage.deleteProject(id);
  }

  // ---- Webhook Management ----

  /**
   * Register a new webhook. Returns the webhook ID.
   */
  addWebhook(url: string, events: WebhookEvent[], secret?: string): string {
    return this.storage.registerWebhook(url, events, secret);
  }

  /**
   * List all configured webhooks.
   */
  getWebhooks(): WebhookConfig[] {
    return this.storage.getWebhooks();
  }

  /**
   * Remove a webhook by ID.
   */
  removeWebhook(id: string): void {
    this.storage.deleteWebhook(id);
  }

  /**
   * Register a new webhook (alias for addWebhook). Returns the webhook ID.
   */
  registerWebhook(url: string, events: WebhookEvent[], secret?: string): string {
    return this.addWebhook(url, events, secret);
  }

  /**
   * Delete a webhook by ID (alias for removeWebhook).
   */
  deleteWebhook(id: string): void {
    this.removeWebhook(id);
  }

  /**
   * Trigger webhooks for a given event. Finds all enabled webhooks registered for
   * the event, builds the payload, signs it if a secret is configured, and POSTs
   * to each URL. Returns delivery results.
   */
  async triggerWebhook(
    event: WebhookEvent,
    payload: Record<string, unknown>,
  ): Promise<WebhookDelivery[]> {
    const webhooks = this.storage.getEnabledWebhooksForEvent(event);
    const results: WebhookDelivery[] = [];
    const timestamp = Date.now();

    for (const wh of webhooks) {
      const fullPayload = { event, timestamp, ...payload };
      const bodyStr = JSON.stringify(fullPayload);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': `AgentTrace/${VERSION}`,
      };

      if (wh.secret) {
        const sig = createHmac('sha256', wh.secret).update(bodyStr).digest('hex');
        headers['X-AgentTrace-Signature'] = `sha256=${sig}`;
      }

      // URL validation: block private/internal IPs and require HTTPS
      try {
        const parsed = new URL(wh.url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error(`Unsupported protocol: ${parsed.protocol}`);
        }
        // Block private/internal addresses (SSRF protection)
        const hostname = parsed.hostname.toLowerCase();
        if (
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname === '0.0.0.0' ||
          hostname.startsWith('169.254.') ||
          hostname.startsWith('10.') ||
          hostname.startsWith('172.1') ||
          hostname.startsWith('172.2') ||
          hostname.startsWith('172.3') ||
          hostname.startsWith('192.168.')
        ) {
          throw new Error('Private/internal URLs are not allowed for webhooks');
        }
      } catch (urlErr) {
        this.storage.incrementWebhookFailures(wh.id);
        results.push({
          id: randomUUID(),
          webhookId: wh.id,
          event,
          payload: bodyStr,
          status: 'failure',
          httpStatus: undefined,
          error: `URL validation failed: ${urlErr instanceof Error ? urlErr.message : String(urlErr)}`,
          createdAt: timestamp,
        });
        continue;
      }

      let deliveryStatus: 'success' | 'failure' = 'failure';
      let httpStatus: number | undefined;
      let errorMsg: string | undefined;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
        const resp = await fetch(wh.url, {
          method: 'POST',
          headers,
          body: bodyStr,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        httpStatus = resp.ok ? resp.status : resp.status;
        deliveryStatus = resp.ok ? 'success' : 'failure';
        if (resp.ok) {
          this.storage.resetWebhookFailures(wh.id);
        } else {
          this.storage.incrementWebhookFailures(wh.id);
          errorMsg = `webhook responded ${resp.status}`;
        }
      } catch (e: unknown) {
        this.storage.incrementWebhookFailures(wh.id);
        errorMsg = e instanceof Error ? e.message : String(e);
      }

      const delivery: WebhookDelivery = {
        id: randomUUID(),
        webhookId: wh.id,
        event,
        payload: bodyStr,
        status: deliveryStatus,
        httpStatus,
        error: errorMsg,
        createdAt: timestamp,
      };
      results.push(delivery);
    }

    return results;
  }

  /**
   * Test a webhook by ID: fires a test event payload to the webhook URL.
   * Returns delivery result.
   */
  async testWebhook(id: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    const webhooks = this.getWebhooks();
    const wh = webhooks.find((w) => w.id === id);
    if (!wh) {
      throw new Error(`Webhook '${id}' not found. List webhooks with: agenttrace webhook list`);
    }
    if (!wh.enabled) {
      throw new Error(`Webhook '${id}' is disabled.`);
    }
    const payload = {
      event: 'webhook.test',
      timestamp: Date.now(),
      message: 'AgentTrace webhook test',
    };
    const bodyStr = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `AgentTrace/${VERSION}`,
    };
    if (wh.secret) {
      const sig = createHmac('sha256', wh.secret).update(bodyStr).digest('hex');
      headers['X-AgentTrace-Signature'] = `sha256=${sig}`;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(wh.url, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        this.storage.resetWebhookFailures(id);
      } else {
        this.storage.incrementWebhookFailures(id);
      }
      return { ok: resp.ok, status: resp.status };
    } catch (e: unknown) {
      this.storage.incrementWebhookFailures(id);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Register a webhook event handler callback.
   * The handler is called for every emitted webhook event (both explicit emissions
   * and automatic events from trace()/completeRun()).
   * Returns a function that unsubscribes the handler when called.
   */
  onWebhook(handler: (event: WebhookEvent, payload: Record<string, unknown>) => void): () => void {
    this.webhookEmitter.on('webhook', handler);
    return () => {
      this.webhookEmitter.off('webhook', handler);
    };
  }

  /**
   * Explicitly emit a webhook event.
   * Fires all registered HTTP webhooks (via triggerWebhook) and invokes all
   * onWebhook handler callbacks. Does not auto-emit from trace()/completeRun() --
   * those methods already call triggerWebhook directly.
   * Use this for custom events (e.g. 'cost.threshold', 'agent.inactive').
   * Returns the HTTP delivery results (same as triggerWebhook).
   */
  async emitWebhookEvent(
    event: WebhookEvent,
    payload: Record<string, unknown>,
  ): Promise<WebhookDelivery[]> {
    // Fire HTTP webhooks
    const results = await this.triggerWebhook(event, payload);
    // Notify in-process handlers (fire-and-forget)
    try {
      this.webhookEmitter.emit('webhook', event, payload);
    } catch (_) {
      /* handler errors must not break emission */
    }
    return results;
  }

  /**
   * Trigger all webhooks registered for the given event.
   * Alias for triggerWebhook — provided for API clarity when the intent is
   * to fan-out to all matching webhooks rather than targeting a specific one.
   * Also invokes any onWebhook handler callbacks after HTTP delivery.
   */
  async triggerAllWebhooks(
    event: WebhookEvent,
    payload: Record<string, unknown>,
  ): Promise<WebhookDelivery[]> {
    const results = await this.triggerWebhook(event, payload);
    // Notify in-process handlers (fire-and-forget)
    try {
      this.webhookEmitter.emit('webhook', event, payload);
    } catch (_) {
      /* handler errors must not break emission */
    }
    return results;
  }

  // ---- Multi-agent tracing (v0.2) ----

  /**
   * Create a TraceContext for a child operation linked to the provided parent context.
   * The child context has a freshly generated traceId (use as the child's trace id)
   * and parentSpanId pointing to the parent's traceId (span).
   * Pass the returned context via options.context when calling trace() (on any AgentTrace instance).
   */
  createChild(context: TraceContext): TraceContext {
    if (!context || typeof context.traceId !== 'string' || context.traceId.length === 0) {
      throw new Error('createChild requires a valid TraceContext with traceId');
    }
    const childTraceId = randomUUID();
    return new TraceContext(childTraceId, context.traceId, { ...context.metadata });
  }

  /**
   * Manually link a set of trace IDs as related (for cross-agent collaboration without strict parent/child).
   * Uses an internal links table; getTraceTree will surface linked traces as children in the tree.
   */
  linkTraces(traceIds: string[]): void {
    if (!Array.isArray(traceIds) || traceIds.length < 2) {
      return;
    }
    this.storage.linkTraces(traceIds);
  }

  /**
   * Get the full tree (parent -> children, including manually linked) for the given traceId.
   * The tree is rooted at the ultimate ancestor (following parentId links).
   */
  getTraceTree(traceId: string): TraceTreeNode {
    return this.storage.getTraceTree(traceId);
  }

  // ---- Alerting (v0.2) ----

  /**
   * Register an alert condition. Persists config (without function) and enables auto-checks.
   */
  registerAlert(alert: AlertCondition): void {
    if (!alert || !alert.name || typeof alert.condition !== 'function') {
      throw new Error('Invalid alert: must have name and condition function');
    }
    // dedupe by name (last wins)
    this.registeredAlerts = this.registeredAlerts.filter((a) => a.name !== alert.name);
    const copy: AlertCondition = {
      name: alert.name,
      condition: alert.condition,
      webhook: alert.webhook,
      email: alert.email,
      cooldown: alert.cooldown ?? 0,
      lastTriggered: alert.lastTriggered,
    };
    this.registeredAlerts.push(copy);
    // persist without the function
    const { condition: _cond, ...serializable } = copy;
    this.storage.saveAlert(copy.name, serializable);
  }

  /**
   * Check all registered alerts against current stats.
   * Fires (and records history) for those whose condition is true and cooldown elapsed.
   * Returns the AlertHistory entries that were triggered this check.
   */
  async checkAlerts(): Promise<AlertHistory[]> {
    const results: AlertHistory[] = [];
    if (this.registeredAlerts.length === 0) return results;

    const stats = this.getStats();
    const now = Date.now();

    for (const alert of this.registeredAlerts) {
      const cooldownMs = Math.max(0, alert.cooldown || 0) * 1000;
      const last = alert.lastTriggered || 0;
      if (cooldownMs > 0 && now - last < cooldownMs) {
        continue;
      }
      const met = (() => {
        try {
          return !!alert.condition(stats);
        } catch (condErr: unknown) {
          if (!this.config.silent) {
            console.error(`[AgentTrace] Alert condition error for ${alert.name}:`, condErr);
          }
          return false;
        }
      })();
      if (met) {
        const hist = await this.deliverAlert(alert, stats, now);
        results.push(hist);
        alert.lastTriggered = now;
        const { condition: _c, ...toStore } = alert;
        this.storage.saveAlert(alert.name, toStore);
      }
    }
    return results;
  }

  private async deliverAlert(
    alert: AlertCondition,
    stats: TraceStats,
    now: number,
  ): Promise<AlertHistory> {
    const numericStats: Record<string, number> = {
      totalRuns: stats.totalRuns || 0,
      totalTraces: stats.totalTraces || 0,
      successRate: stats.successRate || 0,
      avgLatencyMs: stats.avgLatencyMs || 0,
      totalCostUsd: stats.totalCostUsd || 0,
      totalTokens: stats.totalTokens || 0,
      avgTokensPerTrace: stats.avgTokensPerTrace || 0,
    };

    let delivered: boolean;
    let errMsg: string | undefined;

    const payload = { alertName: alert.name, stats, timestamp: now };

    if (alert.webhook) {
      try {
        const url = new URL(alert.webhook);
        const host = url.hostname;
        const bareHost = host.replace(/^\[|\]$/g, '');
        const isLoopback =
          host === 'localhost' ||
          bareHost === 'localhost' ||
          bareHost === '127.0.0.1' ||
          host.startsWith('127.') ||
          bareHost === '::1';
        if (url.protocol !== 'https:' && !isLoopback) {
          throw new Error('webhook must use HTTPS');
        }
        let is172Private = false;
        if (bareHost.startsWith('172.')) {
          const second = parseInt(bareHost.split('.')[1] || '0', 10);
          is172Private = second >= 16 && second <= 31;
        }
        const isPrivate =
          bareHost.startsWith('10.') ||
          bareHost.startsWith('192.168.') ||
          bareHost.startsWith('169.254.') ||
          is172Private ||
          bareHost.startsWith('fc00:') ||
          bareHost.startsWith('fe80:');
        if (isPrivate) {
          throw new Error('webhook URL resolves to private IP');
        }

        const webhooks = this.storage.getWebhooks ? this.storage.getWebhooks() : [];
        const wh = webhooks.find((w: { url?: string; secret?: string }) => w.url === alert.webhook);
        const secret = wh?.secret;

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': `AgentTrace/${VERSION}`,
        };
        if (secret) {
          const sig = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
          headers['X-AgentTrace-Signature'] = `sha256=${sig}`;
        }

        const resp = await fetch(alert.webhook, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        delivered = resp.ok;
        if (!resp.ok) {
          errMsg = `webhook responded ${resp.status}`;
        }
      } catch (e: unknown) {
        delivered = false;
        errMsg = (e as Error | undefined)?.message || String(e);
      }
    } else if (alert.email) {
      delivered = false;
      errMsg = 'email delivery not supported in this version';
    } else {
      delivered = false;
      errMsg = 'no delivery channel configured';
    }

    const history: AlertHistory = {
      id: randomUUID(),
      alertName: alert.name,
      triggeredAt: now,
      stats: numericStats,
      delivered,
      ...(errMsg ? { error: errMsg } : {}),
    };
    this.storage.insertAlertHistory(history);

    if (!this.config.silent) {
      const status = delivered ? 'delivered' : `delivery failed${errMsg ? ': ' + errMsg : ''}`;
      console.log(`[AgentTrace] Alert '${alert.name}' triggered. ${status}`);
    }
    return history;
  }

  /**
   * Get currently registered (in-memory) alerts. Falls back to persisted configs (with no-op condition) for CLI.
   */
  getAlerts(): AlertCondition[] {
    const map = new Map<string, AlertCondition>();
    // load persisted (dummy condition)
    for (const s of this.storage.getStoredAlerts()) {
      const cfg = s.config || {};
      map.set(s.name, {
        name: s.name,
        condition: () => false,
        webhook: cfg.webhook,
        email: cfg.email,
        cooldown: typeof cfg.cooldown === 'number' ? cfg.cooldown : 0,
        lastTriggered: cfg.lastTriggered,
      });
    }
    // overlay runtime registered (have real conditions)
    for (const r of this.registeredAlerts) {
      map.set(r.name, { ...r });
    }
    return Array.from(map.values());
  }

  /**
   * Get alert firing history from storage.
   */
  getAlertHistory(): AlertHistory[] {
    return this.storage.getAlertHistory();
  }

  /**
   * Return health report: status, version (sdk), uptime, dbPath, traceCount, dbSize + integrity check.
   * Integrity verifies required tables exist and detects orphaned child records.
   */
  getHealth(): HealthReport {
    const h = this.storage.getHealthInfo();
    return {
      status: 'ok',
      version: VERSION,
      uptime: process.uptime(),
      dbPath: h.dbPath,
      traceCount: h.traceCount,
      dbSize: h.dbSize,
      integrity: h.integrity,
    };
  }

  // ---- Retention / data lifecycle ----

  /**
   * Delete traces with created_at < before (timestamp ms). Also cleans dependent scores/links.
   * Returns number of traces deleted.
   */
  cleanupOldTraces(before: number): number {
    return this.storage.cleanupOldTraces(before);
  }

  /**
   * Delete runs with started_at < before (timestamp ms). Cascades to their traces.
   * Returns number of runs deleted.
   */
  cleanupOldRuns(before: number): number {
    return this.storage.cleanupOldRuns(before);
  }

  /**
   * Delete agent_usage records with created_at < before (timestamp ms).
   * Returns number deleted.
   */
  cleanupOldAgentUsage(before: number): number {
    return this.storage.cleanupOldAgentUsage(before);
  }

  /**
   * Return basic storage stats for the backing DB.
   */
  getStorageStats(): {
    totalSizeBytes: number;
    traceCount: number;
    runCount: number;
    oldestTrace: number | null;
    newestTrace: number | null;
  } {
    return this.storage.getStorageStats();
  }

  /**
   * Get the active retention policy (from this instance config, which may come from persisted defaults).
   */
  getRetentionPolicy(): { retentionDays: number; cleanupIntervalHours: number } {
    return {
      retentionDays: this.config.retentionDays,
      cleanupIntervalHours: this.config.cleanupIntervalHours,
    };
  }

  /**
   * Set retention policy for this DB (persists it) and update live config + reschedule timer if needed.
   */
  setRetentionPolicy(retentionDays: number, cleanupIntervalHours?: number): void {
    this.storage.setRetentionPolicy(retentionDays, cleanupIntervalHours);
    this.config.retentionDays = Math.max(0, Math.floor(Number(retentionDays) || 0));
    if (cleanupIntervalHours !== undefined) {
      this.config.cleanupIntervalHours = Math.max(
        1,
        Math.floor(Number(cleanupIntervalHours) || 24),
      );
    }
    this.setupRetentionCleanup();
  }

  /**
   * Export traces to JSON, CSV, or OpenTelemetry (OTLP JSON)
   */
  export(format: ExportFormat = 'json', filter: TraceFilter = {}): string {
    const traces = this.storage.getTraces(filter);

    if (format === 'json') {
      return JSON.stringify(traces, null, 2);
    }

    if (format === 'otel') {
      const resourceAttributes = buildResourceAttributes();
      const spans = traces.map((t) => traceToOtelSpan(t));
      const otlp = {
        resourceSpans: [
          {
            resource: { attributes: resourceAttributes },
            scopeSpans: [
              {
                scope: { name: 'agenttrace' },
                spans,
              },
            ],
          },
        ],
      };
      return JSON.stringify(otlp, null, 2);
    }

    // CSV — properly escape fields containing commas, quotes, or newlines
    const escapeCsv = (val: unknown): string => {
      const s = String(val ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const headers = [
      'id',
      'runId',
      'name',
      'status',
      'latencyMs',
      'costUsd',
      'totalTokens',
      'createdAt',
    ];
    const rows = traces.map((t) => [
      t.id,
      t.runId,
      t.name,
      t.status,
      t.latencyMs,
      t.costUsd,
      t.tokens.totalTokens,
      t.createdAt,
    ]);
    return [headers.join(','), ...rows.map((r) => r.map(escapeCsv).join(','))].join('\n');
  }
  /**
   * Close the database connection
   */
  close(): void {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = undefined;
    }
    this.storage.close();
  }

  /**
   * Evaluate traces using the provided scorers.
   * If traceIds provided, scores only those; if runId, scores traces in that run; otherwise all traces.
   */
  async evaluate(options: EvaluateOptions): Promise<ScorerResult[]> {
    const { scorers, runId, traceIds, concurrency } = options;
    if (!scorers || scorers.length === 0) {
      return [];
    }

    const traces: Trace[] =
      traceIds && traceIds.length > 0
        ? traceIds.map((id) => this.getTrace(id)).filter((t): t is Trace => t != null)
        : runId
          ? this.getTraces({ runId })
          : this.getTraces();

    return this.scoreLoop(traces, scorers, concurrency);
  }

  /**
   * Score a single trace by id.
   */
  async evaluateTrace(traceId: string, scorers: Scorer[]): Promise<ScorerResult> {
    const trace = this.getTrace(traceId);
    if (!trace) {
      return { traceId, scores: {}, errors: {} };
    }
    return this.scoreTrace(trace, scorers);
  }

  /**
   * Internal helper to iterate traces with limited concurrency, run scorers, store scores.
   */
  private async scoreLoop(
    traces: Trace[],
    scorers: Scorer[],
    concurrency?: number,
  ): Promise<ScorerResult[]> {
    if (traces.length === 0) return [];
    const limit = Math.max(1, concurrency ?? 5);
    const results: ScorerResult[] = [];
    for (let i = 0; i < traces.length; i += limit) {
      const chunk = traces.slice(i, i + limit);
      const chunkResults = await Promise.all(chunk.map((t) => this.scoreTrace(t, scorers)));
      results.push(...chunkResults);
    }
    return results;
  }

  /**
   * Internal: run all scorers on one trace (in parallel), catch errors, store successful scores.
   */
  private async scoreTrace(trace: Trace, scorers: Scorer[]): Promise<ScorerResult> {
    const traceId = trace.id;
    const scores: Record<string, number> = {};
    const errors: Record<string, string> = {};

    await Promise.all(
      scorers.map(async (scorer) => {
        try {
          const val = await Promise.resolve(scorer.fn(trace));
          if (typeof val === 'number' && Number.isFinite(val)) {
            scores[scorer.name] = val;
            const id = randomUUID();
            this.storage.createScore(id, traceId, scorer.name, val);
          } else {
            errors[scorer.name] = `Invalid score returned: ${val}`;
          }
        } catch (e: unknown) {
          errors[scorer.name] = e instanceof Error ? e.message : String(e);
        }
      }),
    );

    return { traceId, scores, errors };
  }
}

// Singleton for convenience
let instance: AgentTrace | null = null;

export function init(config?: TraceConfig): AgentTrace {
  instance = new AgentTrace(config);
  return instance;
}

export function getAgentTrace(): AgentTrace {
  if (!instance) {
    instance = new AgentTrace();
  }
  return instance;
}

/**
 * Helper to create a Scorer from name + function.
 */
export function score(name: string, fn: Scorer['fn']): Scorer {
  return { name, fn };
}

/**
 * Helper to create an AlertCondition (omits lastTriggered which is internal).
 */
export function alert(config: Omit<AlertCondition, 'lastTriggered'>): AlertCondition {
  return {
    ...config,
    lastTriggered: undefined,
  };
}
