/**
 * AgentTrace -- Core Types
 * Open source AI agent observability
 */

/** A single tool call within an agent run */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  latencyMs: number;
  success: boolean;
  error?: string;
  timestamp: number;
}

/** Token usage for a single LLM call */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
  provider?: string;
}

/** A single trace (one agent run) */
export interface Trace {
  id: string;
  runId: string;
  name: string;
  status: 'success' | 'failure' | 'error' | 'timeout';
  input: unknown;
  output: unknown;
  tokens: TokenUsage;
  toolCalls: ToolCall[];
  latencyMs: number;
  costUsd: number;
  error?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** Parent trace ID for multi-agent / hierarchical tracing */
  parentId?: string;
  /** Tenant/project ID for multi-tenant scoping */
  tenantId?: string;
}

/** Summary of an agent run (collection of traces) */
export interface Run {
  id: string;
  /** Tenant/project ID for multi-tenant scoping */
  tenantId?: string;
  name: string;
  status: 'running' | 'success' | 'failure' | 'error';
  traceCount: number;
  totalTokens: TokenUsage;
  totalToolCalls: number;
  totalLatencyMs: number;
  totalCostUsd: number;
  errorCount: number;
  startedAt: number;
  completedAt?: number;
  metadata: Record<string, unknown>;
}

/** Configuration for the trace collector */
export interface TraceConfig {
  /** Database file path (default: './agenttrace.db') */
  dbPath?: string;
  /** Maximum number of traces to retain (default: 10000) */
  maxTraces?: number;
  /** Enable automatic cleanup of old traces */
  autoCleanup?: boolean;
  /** Custom cost calculator (tokens -> USD) */
  costCalculator?: (tokens: TokenUsage, model?: string) => number;
  /** Custom hallucination detector */
  hallucinationDetector?: (output: unknown, expected?: unknown) => boolean;
  /** Silence console output */
  silent?: boolean;
  /** Data retention in days (default: 30, 0 = keep forever) */
  retentionDays?: number;
  /** How often (in hours) to run scheduled retention cleanup when retentionDays > 0 (default: 24) */
  cleanupIntervalHours?: number;
  /** Optional tenant/project ID to scope this AgentTrace instance (multi-tenant) */
  tenantId?: string;
  /** Maximum traces per second (rate limit). 0 = disabled. Default: 0 */
  maxTracesPerSecond?: number;
  /** Maximum traces per minute (rate limit). 0 = disabled. Default: 0 */
  maxTracesPerMinute?: number;
  /** Burst allowance: extra tokens allowed above the sustained rate. Default: 10 */
  burstAllowance?: number;
}

/** Webhook configuration */
export interface WebhookConfig {
  id: string;
  url: string;
  secret?: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: number;
  lastTriggeredAt?: number;
  failureCount: number;
}

/** Webhook event types */
export type WebhookEvent =
  | 'trace.complete'
  | 'trace.error'
  | 'run.complete'
  | 'run.error'
  | 'cost.threshold'
  | 'agent.inactive';

/** Webhook delivery record */
export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payload: string;
  status: 'success' | 'failure';
  httpStatus?: number;
  error?: string;
  createdAt: number;
}

/** Filter options for querying traces */
export interface TraceFilter {
  runId?: string;
  status?: Trace['status'][];
  name?: string;
  fromDate?: number;
  toDate?: number;
  minCost?: number;
  maxCost?: number;
  minLatency?: number;
  maxLatency?: number;
  limit?: number;
  offset?: number;
}

/** Summary statistics */
export interface TraceStats {
  totalRuns: number;
  totalTraces: number;
  successRate: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  costByModel?: Record<string, number>;
  totalTokens: number;
  avgTokensPerTrace: number;
  topTools: { name: string; count: number; avgLatencyMs: number }[];
  topErrors: { error: string; count: number }[];
  /** Number of traces dropped due to rate limiting */
  droppedTraces: number;
}

/** Cost breakdown returned by getCostBreakdown and /api/costs */
export interface CostBreakdown {
  totalCostUsd: number;
  costByModel: Record<string, number>;
  costByDay: Record<string, number>;
}

/** Agent framework integrations */
export type AgentFramework = 'langgraph' | 'crewai' | 'autogen' | 'custom';

/** Framework-specific integration config */
export interface FrameworkIntegration {
  framework: AgentFramework;
  version?: string;
  autoTrace?: boolean;
  traceTools?: boolean;
  traceTokens?: boolean;
}

/** Export format */
export type ExportFormat = 'json' | 'csv' | 'otel';

/** Dashboard server config */
export interface DashboardConfig {
  port?: number;
  host?: string;
  openBrowser?: boolean;
  dbPath?: string;
}

/** Scorer function that evaluates a trace and returns a numeric score */
export interface Scorer {
  name: string;
  fn: (trace: Trace) => number | Promise<number>;
}

/** Result of running scorers against a trace */
export interface ScorerResult {
  traceId: string;
  scores: Record<string, number>;
  errors: Record<string, string>;
}

/** Options for running evaluations */
export interface EvaluateOptions {
  scorers: Scorer[];
  runId?: string;
  traceIds?: string[];
  concurrency?: number;
}

/** Alert condition for webhook/email notifications */
export interface AlertCondition {
  name: string;
  condition: (stats: TraceStats) => boolean;
  webhook?: string;
  email?: string;
  cooldown: number; // seconds
  lastTriggered?: number;
}

/** Record of a fired alert */
export interface AlertHistory {
  id: string;
  alertName: string;
  triggeredAt: number;
  stats: Record<string, number>;
  delivered: boolean;
  error?: string;
}

/**
 * TraceContext can be passed between collaborating agents to link their traces
 * into a parent/child hierarchy.
 */
export class TraceContext {
  traceId: string;
  parentSpanId?: string;
  metadata: Record<string, unknown>;

  constructor(traceId: string, parentSpanId?: string, metadata: Record<string, unknown> = {}) {
    this.traceId = traceId;
    this.parentSpanId = parentSpanId;
    this.metadata = { ...metadata };
  }
}

/** Node in a trace tree returned by getTraceTree / GET /api/traces/:id/tree */
export interface TraceTreeNode {
  trace: Trace;
  children: TraceTreeNode[];
}

/** Health report for database + process (used by /api/health and `agenttrace health`) */
export interface HealthReport {
  status: 'ok';
  version: string;
  uptime: number;
  dbPath: string;
  traceCount: number;
  dbSize: number;
  integrity: {
    tablesExist: boolean;
    noOrphans: boolean;
    details?: string;
  };
}

/** Record of agent usage / action for the agent_usage tracking system */
export interface AgentUsageRecord {
  id: string;
  /** Tenant/project ID for multi-tenant scoping */
  tenantId?: string;
  agentName: string;
  agentType?: string;
  sessionId?: string;
  action: string;
  target?: string;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  status: 'success' | 'failure' | 'timeout';
  metadata: Record<string, unknown>;
  createdAt: number;
}

/** Filter for querying agent usage records */
export interface AgentUsageFilter {
  agentName?: string;
  agentType?: string;
  action?: string;
  status?: AgentUsageRecord['status'] | AgentUsageRecord['status'][];
  fromDate?: number;
  toDate?: number;
  limit?: number;
  offset?: number;
}

/** Aggregated usage statistics */
export interface UsageStats {
  totalAgents: number;
  totalActions: number;
  totalTokens: number;
  totalCostUsd: number;
  avgDurationMs: number;
  actionsByType: Record<string, number>;
  topAgents: Array<{ agentName: string; actions: number; tokens: number; costUsd: number }>;
}

/** Row returned for agent 'who' summary (active agents overview) */
export interface AgentWho {
  agentName: string;
  agentType?: string;
  sessionId?: string;
  lastAction: string;
  actions: number;
  tokens: number;
  costUsd: number;
}

/** Summary row for an agent session (for 'sessions' command) */
export interface AgentSession {
  sessionId: string;
  agentName: string;
  startedAt: number;
  durationMs: number;
  actions: number;
  tokens: number;
  costUsd: number;
  status: AgentUsageRecord['status'];
}

/** API key for authenticating to the dashboard API (keys are stored hashed only) */
export interface ApiKey {
  id: string;
  name: string;
  /** Short preview for display, e.g. 'at_abc123****' (never the full secret) */
  preview: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** Project for basic multi-tenant support */
export interface Project {
  id: string;
  name: string;
  apiKey: string;
  createdAt: number;
}

/** Result of creating an API key: includes the full secret (shown only once) */
export interface CreatedApiKey extends ApiKey {
  key: string;
}
