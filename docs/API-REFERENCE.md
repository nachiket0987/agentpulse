# AgentTrace API Reference

**Version:** 0.1.0
**Packages:** `@agenttrace-io/sdk` (TypeScript) | `agenttrace-io` (Python)

Both SDKs share the same SQLite schema and are functionally equivalent. Where they
differ in naming or API shape, both are documented side by side.

---

## Table of Contents

1.  [Installation](#1-installation)
2.  [TypeScript SDK -- `AgentTrace`](#2-typescript-sdk--agenttrace)
    - [Constructor & TraceConfig](#constructor--traceconfig)
    - [Run Management: `startRun` / `completeRun`](#run-management)
    - [Tracing: `trace()`](#tracing-trace)
    - [Tool Calls: `recordToolCall`](#tool-calls)
    - [Querying: `getTraces`, `getTrace`, `getRuns`, `getRun`](#querying)
    - [Statistics: `getStats`, `getCostBreakdown`, `getHealth`, `getStorageStats`, `getDroppedTraces`](#statistics)
    - [Agent Usage Tracking: `recordAgentUsage`, `getAgentUsage`, `getUsageStats`, `getActiveAgents`, `getAgentWho`, `getAgentSessions`](#agent-usage-tracking)
    - [API Keys: `createApiKey`, `listApiKeys`, `revokeApiKey`, `validateApiKey`](#api-key-management)
    - [Webhooks: `addWebhook`, `getWebhooks`, `removeWebhook`, `triggerWebhook`, `testWebhook`](#webhook-management)
    - [Multi-Agent Tracing: `createChild`, `linkTraces`, `getTraceTree`](#multi-agent-tracing)
    - [Alerts: `registerAlert`, `checkAlerts`, `getAlerts`, `getAlertHistory`](#alerting)
    - [Export: `export()`](#export)
    - [Evaluation: `evaluate`, `evaluateTrace`](#evaluation)
    - [Lifecycle: `close`, cleanup, retention](#lifecycle)
    - [Events: `onUsage`, `offUsage`](#events)
3.  [TypeScript SDK -- `TraceStorage`](#3-typescript-sdk--tracestorage)
4.  [TypeScript SDK -- `SelfTracker`](#4-typescript-sdk--selftracker)
5.  [TypeScript SDK -- `TraceContext`](#5-typescript-sdk--tracecontext)
6.  [TypeScript SDK -- `TokenBucketRateLimiter`](#6-typescript-sdk--tokenbucketratelimiter)
7.  [TypeScript SDK -- Singleton Helpers](#7-typescript-sdk--singleton-helpers)
8.  [TypeScript SDK -- Migration Utilities](#8-typescript-sdk--migration-utilities)
9.  [TypeScript Types & Interfaces](#9-typescript-types--interfaces)
    - [Trace](#trace)
    - [Run](#run-1)
    - [TokenUsage](#tokenusage)
    - [ToolCall](#toolcall)
    - [TraceConfig](#traceconfig)
    - [TraceFilter](#tracefilter)
    - [TraceStats](#tracestats)
    - [CostBreakdown](#costbreakdown)
    - [Scorer / ScorerResult / EvaluateOptions](#scorer--scorerresult--evaluateoptions)
    - [AlertCondition / AlertHistory](#alertcondition--alerthistory)
    - [TraceContext / TraceTreeNode](#tracecontext--treetreenode)
    - [HealthReport](#healthreport)
    - [AgentUsageRecord](#agentusagerecord)
    - [AgentUsageFilter](#agentusagefilter)
    - [UsageStats](#usagestats)
    - [AgentWho / AgentSession](#agentwho--agentsession)
    - [WebhookConfig / WebhookEvent / WebhookDelivery](#webhookconfig--webhookevent--webhookdelivery)
    - [ApiKey / CreatedApiKey / Project](#apikey--createdapikey--project)
    - [DashboardConfig / FrameworkIntegration / ExportFormat](#dashboardconfig--frameworkintegration--exportformat)
10. [Python SDK -- `AgentTrace`](#10-python-sdk--agenttrace)
    - [Constructor & TraceConfig](#python-constructor--traceconfig)
    - [Run Management](#python-run-management)
    - [Tracing: `trace()`](#python-tracing)
    - [Querying / Stats / Export / Eval](#python-querying--stats--export--eval)
    - [Agent Usage Tracking](#python-agent-usage-tracking)
    - [Lifecycle](#python-lifecycle)
11. [Python SDK -- `TraceStorage`](#11-python-sdk--tracestorage)
12. [Python SDK -- `AgentUsageTracker`](#12-python-sdk--agentusagetracker)
13. [Python SDK -- Singleton Helpers](#13-python-sdk--singleton-helpers)
14. [Python Types (Dataclasses)](#14-python-types-dataclasses)
15. [CLI Commands Reference](#15-cli-commands-reference)
    - [init / dashboard / version](#init--dashboard--version)
    - [runs / traces](#runs--traces)
    - [stats / costs](#stats--costs)
    - [export / tree](#export-cmd--tree)
    - [alerts / health](#alerts--health)
    - [self-stats / who / cost / sessions / activity](#self-stats--who--cost--sessions--activity)
    - [cleanup / retention](#cleanup--retention)
    - [benchmark](#benchmark)
16. [Database Schema](#16-database-schema)

---

## 1. Installation

```bash
# TypeScript / Node
npm install @agenttrace-io/sdk

# Python
pip install agenttrace-io
```

---

## 2. TypeScript SDK -- `AgentTrace`

**Module:** `@agenttrace-io/sdk`

The main entry point. Wraps `TraceStorage` and provides the high-level tracing,
querying, alerting, and export API.

### Constructor & TraceConfig

```typescript
import { AgentTrace } from '@agenttrace-io/sdk';

const agent = new AgentTrace(config?: TraceConfig);
```

**`TraceConfig` fields (all optional):**

| Field                   | Type                                               | Default             | Description                                       |
| ----------------------- | -------------------------------------------------- | ------------------- | ------------------------------------------------- |
| `dbPath`                | `string`                                           | `'./agenttrace.db'` | SQLite database file path                         |
| `maxTraces`             | `number`                                           | `10000`             | Max traces retained; oldest deleted when exceeded |
| `autoCleanup`           | `boolean`                                          | `true`              | Auto-cleanup after each `trace()` call            |
| `costCalculator`        | `(tokens: TokenUsage, model?: string) => number`   | built-in            | Custom USD cost function                          |
| `hallucinationDetector` | `(output: unknown, expected?: unknown) => boolean` | `() => false`       | Custom hallucination check                        |
| `silent`                | `boolean`                                          | `false`             | Suppress console output                           |
| `retentionDays`         | `number`                                           | `30`                | Data retention in days (0 = forever)              |
| `cleanupIntervalHours`  | `number`                                           | `24`                | How often to run retention cleanup                |
| `tenantId`              | `string`                                           | `''`                | Multi-tenant scoping                              |
| `maxTracesPerSecond`    | `number`                                           | `0`                 | Rate limit per second (0 = disabled)              |
| `maxTracesPerMinute`    | `number`                                           | `0`                 | Rate limit per minute (0 = disabled)              |
| `burstAllowance`        | `number`                                           | `10`                | Extra burst tokens above sustained rate           |

### Run Management

#### `startRun`

```typescript
startRun(name: string, metadata?: Record<string, unknown>): string
```

Starts a new agent run. Returns a UUID `runId`. All subsequent `trace()` calls
are associated with this run until `completeRun()`.

```typescript
const runId = agent.startRun('data-pipeline', { version: '1.0' });
```

#### `completeRun`

```typescript
completeRun(status?: 'success' | 'failure' | 'error'): void
```

Marks the current run as completed. Defaults to `'success'`.

```typescript
agent.completeRun('success');
```

### Tracing: `trace()`

```typescript
async trace<T>(
  name: string,
  fn: () => Promise<T>,
  options?: {
    input?: unknown;
    tokens?: TokenUsage;
    model?: string;
    provider?: string;
    metadata?: Record<string, unknown>;
    parentId?: string;
    context?: TraceContext;
  }
): Promise<T>
```

Wraps an async function, recording a trace on completion or error. Returns the
function's return value. Re-throws any error after recording.

```typescript
const result = await agent.trace(
  'llm-call',
  async () => {
    return await openai.chat.completions.create({ model: 'gpt-4o', messages });
  },
  {
    input: { messages },
    tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    model: 'gpt-4o',
    provider: 'openai',
  },
);
```

### Tool Calls

#### `recordToolCall`

```typescript
recordToolCall(call: Omit<ToolCall, 'id' | 'timestamp'>): string
```

Records a tool call. Returns a UUID. (Tool calls are also stored when passed
via `trace()` options.)

### Querying

#### `getTraces`

```typescript
getTraces(filter?: TraceFilter): Trace[]
```

Query traces with optional filtering.

```typescript
const errors = agent.getTraces({ status: ['error'], limit: 10 });
const recent = agent.getTraces({ fromDate: Date.now() - 3600000, limit: 100 });
```

#### `getTrace`

```typescript
getTrace(id: string): Trace | null
```

Get a single trace by ID.

#### `getRuns`

```typescript
getRuns(limit?: number): Run[]
```

Get recent runs, most recent first. Default limit: 100.

#### `getRun`

```typescript
getRun(id: string): Run | null
```

Get a single run by ID.

### Statistics

#### `getStats`

```typescript
getStats(): TraceStats
```

Returns aggregate statistics across all traces and runs.

#### `getCostBreakdown`

```typescript
getCostBreakdown(filter?: { runId?: string }): CostBreakdown
```

Returns cost breakdown by model and by day, optionally filtered to a specific run.

#### `getHealth`

```typescript
getHealth(): HealthReport
```

Returns a health report including version, uptime, DB path, trace count, DB size,
and integrity check.

#### `getStorageStats`

```typescript
getStorageStats(): {
  totalSizeBytes: number;
  traceCount: number;
  runCount: number;
  oldestTrace: number | null;
  newestTrace: number | null;
}
```

#### `getDroppedTraces`

```typescript
getDroppedTraces(): number
```

Returns the number of traces dropped due to rate limiting (0 if rate limiting
is not configured).

### Agent Usage Tracking

#### `recordAgentUsage`

```typescript
recordAgentUsage(
  record: Omit<AgentUsageRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: number }
): void
```

Records an agent action/usage event for self-tracking. Emits a `'usage'` event.

```typescript
agent.recordAgentUsage({
  agentName: 'my-agent',
  agentType: 'ai-agent',
  action: 'file-edit',
  target: 'src/index.ts',
  tokensUsed: 500,
  costUsd: 0.01,
  durationMs: 2500,
  status: 'success',
});
```

#### `getAgentUsage`

```typescript
getAgentUsage(filter?: AgentUsageFilter): AgentUsageRecord[]
```

Query agent usage records with filters.

#### `getUsageStats`

```typescript
getUsageStats(agentName?: string, fromDate?: number, toDate?: number): UsageStats
```

Aggregated statistics across agent actions.

#### `getActiveAgents`

```typescript
getActiveAgents(): { agentName: string; lastActive: string; totalActions: number }[]
```

List agents with their last active time (ISO string) and total action count.

#### `getAgentWho`

```typescript
getAgentWho(filter?: { activeOnly?: boolean; agentType?: string; limit?: number }): AgentWho[]
```

Active agents overview. `activeOnly` filters to agents active in the last
30 minutes.

#### `getAgentSessions`

```typescript
getAgentSessions(filter?: { agentName?: string; activeOnly?: boolean; limit?: number }): AgentSession[]
```

Session-level summaries grouped by agent + session ID.

### API Key Management

#### `createApiKey`

```typescript
createApiKey(name: string): CreatedApiKey
```

Creates a new API key for dashboard authentication. Returns the full secret key
(shown only once) plus metadata. The secret is never stored -- only its SHA-256
hash is persisted.

```typescript
const key = agent.createApiKey('dashboard');
console.log(key.key); // at_abc123... (show once)
console.log(key.preview); // at_abc123****
```

#### `listApiKeys`

```typescript
listApiKeys(): { id: string; name: string; createdAt: number; lastUsedAt: number | null; enabled: boolean }[]
```

List all API keys (masked previews only, no secrets).

#### `revokeApiKey`

```typescript
revokeApiKey(id: string): void
```

Delete an API key by ID.

#### `validateApiKey`

```typescript
validateApiKey(key: string): { valid: boolean; permissions: string[] }
```

Validate a raw API key string. Returns `{ valid: true, permissions: [...] }` or
`{ valid: false, permissions: [] }`. Updates `lastUsedAt` on success.

### Webhook Management

#### `addWebhook` / `registerWebhook`

```typescript
addWebhook(url: string, events: WebhookEvent[], secret?: string): string
registerWebhook(url: string, events: WebhookEvent[], secret?: string): string  // alias
```

Register a new webhook. Returns the webhook ID.

```typescript
const id = agent.addWebhook(
  'https://hooks.slack.com/...',
  ['trace.error', 'run.complete'],
  'my-signing-secret',
);
```

#### `getWebhooks`

```typescript
getWebhooks(): WebhookConfig[]
```

List all configured webhooks.

#### `removeWebhook` / `deleteWebhook`

```typescript
removeWebhook(id: string): void
deleteWebhook(id: string): void  // alias
```

Remove a webhook by ID.

#### `triggerWebhook`

```typescript
async triggerWebhook(
  event: WebhookEvent,
  payload: Record<string, unknown>
): Promise<WebhookDelivery[]>
```

Trigger webhooks for a given event. Finds all enabled webhooks registered for
the event, builds the payload, signs it if a secret is configured, and POSTs to
each URL. Returns delivery results.

#### `testWebhook`

```typescript
async testWebhook(id: string): Promise<{ ok: boolean; status?: number; error?: string }>
```

Send a test payload to a specific webhook.

### Multi-Agent Tracing

#### `createChild`

```typescript
createChild(context: TraceContext): TraceContext
```

Creates a child `TraceContext` linked to the parent. Use the returned context in
`trace()` options for multi-agent hierarchical tracing.

```typescript
const parentCtx = new TraceContext(parentTraceId);
const childCtx = agent.createChild(parentCtx);

await agent.trace('child-op', async () => { ... }, { context: childCtx });
```

#### `linkTraces`

```typescript
linkTraces(traceIds: string[]): void
```

Manually link a set of trace IDs as related (cross-agent collaboration without
strict parent/child).

#### `getTraceTree`

```typescript
getTraceTree(traceId: string): TraceTreeNode
```

Returns the full trace tree rooted at the ultimate ancestor of the given trace,
including children and linked traces.

### Alerting

#### `registerAlert`

```typescript
registerAlert(alert: AlertCondition): void
```

Register an alert condition. Persists config and enables auto-checks after each
`trace()` call.

```typescript
agent.registerAlert({
  name: 'high-error-rate',
  condition: (stats) => stats.successRate < 0.9 && stats.totalTraces > 10,
  webhook: 'https://hooks.slack.com/...',
  cooldown: 300, // seconds
});
```

#### `checkAlerts`

```typescript
async checkAlerts(): Promise<AlertHistory[]>
```

Manually check all registered alerts against current stats. Returns triggered
alert history entries. (Also called automatically after each `trace()` call.)

#### `getAlerts`

```typescript
getAlerts(): AlertCondition[]
```

Get currently registered alerts (in-memory + persisted).

#### `getAlertHistory`

```typescript
getAlertHistory(): AlertHistory[]
```

Get alert firing history from storage.

### Export

#### `export`

```typescript
export(format?: 'json' | 'csv' | 'otel', filter?: TraceFilter): string
```

Export traces in JSON, CSV, or OpenTelemetry OTLP JSON format.

```typescript
const json = agent.export('json', { limit: 100 });
const csv = agent.export('csv', { status: ['error'] });
const otel = agent.export('otel');
```

### Evaluation

#### `evaluate`

```typescript
async evaluate(options: EvaluateOptions): Promise<ScorerResult[]>
```

Run scorers against traces. If `traceIds` provided, scores only those; if `runId`,
scores traces in that run; otherwise all traces.

```typescript
const results = await agent.evaluate({
  scorers: [
    { name: 'output-length', fn: (trace) => String(trace.output).length },
    { name: 'success', fn: (trace) => (trace.status === 'success' ? 1 : 0) },
  ],
  runId: 'some-run-id',
  concurrency: 5,
});
```

#### `evaluateTrace`

```typescript
async evaluateTrace(traceId: string, scorers: Scorer[]): Promise<ScorerResult>
```

Score a single trace by ID.

### Lifecycle

#### `close`

```typescript
close(): void
```

Close the database connection and stop any scheduled cleanup timers.

#### Cleanup methods

```typescript
cleanupOldTraces(before: number): number
cleanupOldRuns(before: number): number
cleanupOldAgentUsage(before: number): number
```

Delete records older than the given timestamp (ms). Returns the count of deleted
records.

#### Retention policy

```typescript
getRetentionPolicy(): { retentionDays: number; cleanupIntervalHours: number }
setRetentionPolicy(retentionDays: number, cleanupIntervalHours?: number): void
```

Get/set the data retention policy. Persisted to the database.

### Events

#### `onUsage` / `offUsage`

```typescript
onUsage(listener: (record: AgentUsageRecord) => void): void
offUsage(listener: (record: AgentUsageRecord) => void): void
```

Subscribe/unsubscribe to agent usage events (for live dashboards / SSE).

---

## 3. TypeScript SDK -- `TraceStorage`

**Module:** `@agenttrace-io/sdk` (re-exported)

Low-level SQLite storage layer. Used internally by `AgentTrace` but can be used
directly for custom tooling.

```typescript
import { TraceStorage } from '@agenttrace-io/sdk';

const storage = new TraceStorage('./agenttrace.db');
```

### Constructor

```typescript
constructor(dbPath?: string)  // default: './agenttrace.db'
```

Opens (or creates) the SQLite database, initializes the schema, and runs any
pending migrations.

### Run Operations

| Method                                                         | Returns       | Description                                        |
| -------------------------------------------------------------- | ------------- | -------------------------------------------------- |
| `createRun(run: Partial<Run> & { id, name, startedAt })`       | `Run`         | Insert a new run (status: `'running'`)             |
| `getRun(id: string)`                                           | `Run \| null` | Get a run by ID                                    |
| `getRuns(limit?: number)`                                      | `Run[]`       | Recent runs, most recent first                     |
| `completeRun(id: string, status: Run['status'])`               | `void`        | Mark a run as completed                            |
| `updateRunStats(runId, tokens, toolCalls, latencyMs, costUsd)` | `void`        | Incremental stats update (called by `createTrace`) |

### Trace Operations

| Method                                                        | Returns         | Description                                    |
| ------------------------------------------------------------- | --------------- | ---------------------------------------------- |
| `createTrace(trace: Omit<Trace, 'createdAt' \| 'updatedAt'>)` | `Trace`         | Insert a trace + tool calls + update run stats |
| `getTrace(id: string)`                                        | `Trace \| null` | Get a trace by ID                              |
| `getTraces(filter?: TraceFilter)`                             | `Trace[]`       | Query traces with filtering                    |

### Score Operations

| Method                                                                  | Returns                                          | Description               |
| ----------------------------------------------------------------------- | ------------------------------------------------ | ------------------------- |
| `createScore(id: string, traceId: string, name: string, value: number)` | `void`                                           | Store a score for a trace |
| `getScores(traceId?: string)`                                           | `Array<{ id, traceId, name, value, createdAt }>` | Retrieve stored scores    |

### Agent Usage Operations

| Method                                          | Returns                                      | Description                                    |
| ----------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| `recordAgentUsage(record: AgentUsageRecord)`    | `void`                                       | Insert an agent usage record                   |
| `getAgentUsage(filter?: AgentUsageFilter)`      | `AgentUsageRecord[]`                         | Query agent usage with filters                 |
| `getUsageStats(agentName?, fromDate?, toDate?)` | `UsageStats`                                 | Aggregated usage statistics                    |
| `getActiveAgents()`                             | `{ agentName, lastActive, totalActions }[]`  | All agents overview                            |
| `getAgentWho(filter?)`                          | `AgentWho[]`                                 | Active agents overview (supports `activeOnly`) |
| `getAgentSessions(filter?)`                     | `AgentSession[]`                             | Session-level summaries                        |
| `getAgentCostSummary(filter?)`                  | `{ totalCostUsd, costByAgent, costByModel }` | Cost breakdown from agent_usage                |

### Alert Operations

| Method                                                     | Returns                              | Description                        |
| ---------------------------------------------------------- | ------------------------------------ | ---------------------------------- |
| `saveAlert(name: string, config: Record<string, unknown>)` | `void`                               | Persist alert config (no function) |
| `getStoredAlerts()`                                        | `Array<{ name, config, createdAt }>` | Load persisted alert configs       |
| `insertAlertHistory(entry: AlertHistory)`                  | `void`                               | Record an alert firing             |
| `getAlertHistory()`                                        | `AlertHistory[]`                     | Alert firing history               |

### Multi-Agent Tracing Operations

| Method                                              | Returns          | Description                               |
| --------------------------------------------------- | ---------------- | ----------------------------------------- |
| `setTraceParent(traceId: string, parentId: string)` | `void`           | Set parent_id on a trace                  |
| `getTraceParentId(traceId: string)`                 | `string \| null` | Get parent_id for a trace                 |
| `getChildTraceIds(parentId: string)`                | `string[]`       | Direct children of a trace                |
| `getLinkedTraceIds(traceId: string)`                | `string[]`       | Traces linked via `trace_links` table     |
| `linkTraces(traceIds: string[])`                    | `void`           | Create pairwise links between traces      |
| `getTraceTree(traceId: string)`                     | `TraceTreeNode`  | Full tree (ancestor -> children + linked) |

### Webhook Operations

| Method                                                                  | Returns           | Description                 |
| ----------------------------------------------------------------------- | ----------------- | --------------------------- |
| `registerWebhook(url: string, events: WebhookEvent[], secret?: string)` | `string`          | Create webhook, returns ID  |
| `getWebhooks()`                                                         | `WebhookConfig[]` | All webhooks                |
| `getEnabledWebhooksForEvent(event: WebhookEvent)`                       | `WebhookConfig[]` | Filtered by event + enabled |
| `deleteWebhook(id: string)`                                             | `void`            | Remove a webhook            |
| `resetWebhookFailures(id: string)`                                      | `void`            | Reset failure count to 0    |
| `incrementWebhookFailures(id: string)`                                  | `void`            | Increment failure count     |

### API Key Operations

| Method                        | Returns                                     | Description                                 |
| ----------------------------- | ------------------------------------------- | ------------------------------------------- |
| `createApiKey(name: string)`  | `ApiKey`                                    | Create (stores hash only), returns metadata |
| `getApiKeys()`                | `ApiKey[]`                                  | List all keys (no secrets)                  |
| `revokeApiKey(id: string)`    | `void`                                      | Delete a key                                |
| `validateApiKey(key: string)` | `{ valid: boolean; permissions: string[] }` | Validate a raw key string                   |

### Stats & Health

| Method                             | Returns                                                              | Description                                     |
| ---------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| `getStats(tenantId?: string)`      | `TraceStats`                                                         | Aggregate statistics (optionally tenant-scoped) |
| `getCostBreakdown(runId?: string)` | `CostBreakdown`                                                      | Cost by model + by day                          |
| `getStorageStats()`                | `{ totalSizeBytes, traceCount, runCount, oldestTrace, newestTrace }` | DB stats                                        |
| `getHealthInfo()`                  | `{ dbPath, traceCount, dbSize, integrity }`                          | Health + integrity check                        |

### Cleanup & Retention

| Method                                                     | Returns                                   | Description                             |
| ---------------------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| `cleanup(maxTraces?: number)`                              | `number`                                  | Delete oldest traces exceeding max      |
| `cleanupOldTraces(before: number)`                         | `number`                                  | Delete traces older than timestamp      |
| `cleanupOldRuns(before: number)`                           | `number`                                  | Delete runs older than timestamp        |
| `cleanupOldAgentUsage(before: number)`                     | `number`                                  | Delete agent_usage older than timestamp |
| `getRetentionPolicy()`                                     | `{ retentionDays, cleanupIntervalHours }` | From settings table                     |
| `setRetentionPolicy(retentionDays, cleanupIntervalHours?)` | `void`                                    | Persist retention settings              |

### Settings

| Method                                   | Returns          | Description            |
| ---------------------------------------- | ---------------- | ---------------------- |
| `getSetting(key: string)`                | `string \| null` | Read a settings value  |
| `setSetting(key: string, value: string)` | `void`           | Write a settings value |

### Lifecycle

| Method    | Returns | Description                   |
| --------- | ------- | ----------------------------- |
| `close()` | `void`  | Close the database connection |

---

## 4. TypeScript SDK -- `SelfTracker`

**Module:** `@agenttrace-io/sdk` (re-exported)

Thin wrapper for AI agents to automatically track their own
operations via AgentTrace storage + JSONL log for external consumption.

```typescript
import { SelfTracker } from '@agenttrace-io/sdk';

const tracker = new SelfTracker({
  agentName: 'my-agent',
  agentType: 'ai-agent',
  dbPath: './agenttrace.db',
});
```

### `SelfTrackerConfig`

| Field       | Type     | Default             | Description              |
| ----------- | -------- | ------------------- | ------------------------ |
| `agentName` | `string` | (required)          | Name of the agent        |
| `agentType` | `string` | (required)          | Type (e.g. `'ai-agent'`) |
| `dbPath`    | `string` | `'./agenttrace.db'` | SQLite database path     |

### Methods

| Method                                                                                  | Returns  | Description                                   |
| --------------------------------------------------------------------------------------- | -------- | --------------------------------------------- |
| `startSession(): string`                                                                | `string` | Start a new session, returns sessionId (UUID) |
| `trackAction(action: string, target: string, metadata?: Record<string, unknown>): void` | `void`   | Record a generic action                       |
| `trackDelegation(targetAgent: string, task: string): void`                              | `void`   | Record delegation to another agent            |
| `trackResearch(query: string, results: number): void`                                   | `void`   | Record a research step                        |
| `trackImplementation(files: string[], linesOfCode: number): void`                       | `void`   | Record an implementation step                 |
| `trackReview(prNumber: string, status: string): void`                                   | `void`   | Record a code review step                     |
| `endSession(): void`                                                                    | `void`   | Complete the current session                  |
| `getSessionStats(): { sessionId, actions, duration, tokens, cost }`                     | `object` | Current session stats                         |
| `close(): void`                                                                         | `void`   | Close underlying storage                      |

Each method writes both to the SQLite database (as a trace in the `traces` table
with `selfTracked: true` metadata) and appends a JSONL line to
`~/.config/agenttrace/usage.jsonl` (configurable via `AGENTTRACE_USAGE_LOG` env).

---

## 5. TypeScript SDK -- `TraceContext`

**Module:** `@agenttrace-io/sdk` (re-exported class)

Passed between collaborating agents to link their traces into a parent/child
hierarchy.

```typescript
import { TraceContext } from '@agenttrace-io/sdk';

const ctx = new TraceContext(traceId: string, parentSpanId?: string, metadata?: Record<string, unknown>);
```

### Properties

| Field          | Type                      | Description                  |
| -------------- | ------------------------- | ---------------------------- |
| `traceId`      | `string`                  | The trace/span ID            |
| `parentSpanId` | `string \| undefined`     | Parent's trace ID (if child) |
| `metadata`     | `Record<string, unknown>` | Arbitrary metadata           |

---

## 6. TypeScript SDK -- `TokenBucketRateLimiter`

**Module:** `@agenttrace-io/sdk` (re-exported)

Prevents trace flooding by enforcing per-second and per-minute rate limits using
a token bucket algorithm.

```typescript
import { TokenBucketRateLimiter } from '@agenttrace-io/sdk';

const limiter = new TokenBucketRateLimiter({
  maxTracesPerSecond: 10,
  maxTracesPerMinute: 100,
  burstAllowance: 20,
});
```

### `RateLimiterConfig`

| Field                | Type     | Description                               |
| -------------------- | -------- | ----------------------------------------- |
| `maxTracesPerSecond` | `number` | Sustained rate per second (0 = disabled)  |
| `maxTracesPerMinute` | `number` | Sustained rate per minute (0 = disabled)  |
| `burstAllowance`     | `number` | Extra tokens allowed above sustained rate |

### Methods

| Method                       | Returns   | Description                                                               |
| ---------------------------- | --------- | ------------------------------------------------------------------------- |
| `tryConsume(): boolean`      | `boolean` | Try to consume one token. Returns true if allowed, false if rate-limited. |
| `getDroppedTraces(): number` | `number`  | Total traces dropped due to rate limiting                                 |
| `resetDroppedTraces(): void` | `void`    | Reset the dropped counter to 0                                            |

---

## 7. TypeScript SDK -- Singleton Helpers

**Module:** `@agenttrace-io/sdk`

Convenience functions for a global `AgentTrace` instance.

```typescript
import { init, getAgentTrace, score, alert } from '@agenttrace-io/sdk';

// Initialize the global instance
init({ dbPath: './agenttrace.db' });

// Get (or lazily create) the global instance
const agent = getAgentTrace();

// Helper to create a Scorer
const myScorer = score('output-length', (trace) => String(trace.output).length);

// Helper to create an AlertCondition
const myAlert = alert({
  name: 'high-error-rate',
  condition: (stats) => stats.successRate < 0.9,
  webhook: 'https://hooks.slack.com/...',
  cooldown: 300,
});
```

| Export              | Signature                                                                     | Description                                         |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `init`              | `(config?: TraceConfig) => AgentTrace`                                        | Create and return the global instance               |
| `getAgentTrace`     | `() => AgentTrace`                                                            | Get (or lazily create) the global instance          |
| `score`             | `(name: string, fn: Scorer['fn']) => Scorer`                                  | Create a Scorer object                              |
| `alert`             | `(config: Omit<AlertCondition, 'lastTriggered'>) => AlertCondition`           | Create an AlertCondition                            |
| `VERSION`           | `string` (value: `'0.1.0'`)                                                   | SDK version constant                                |
| `PACKAGE_NAME`      | `string` (value: `'@agenttrace-io/sdk'`)                                      | Package name constant                               |
| `registerModelRate` | `(model: string, promptRatePerK: number, completionRatePerK: number) => void` | Add/override pricing in the default cost calculator |

---

## 8. TypeScript SDK -- Migration Utilities

**Module:** `@agenttrace-io/sdk` (from internal `migrations.ts`)

```typescript
import { runPendingMigrations, getSchemaVersion } from '@agenttrace-io/sdk';
// Note: these are internal utilities; not part of the public re-export surface.
// Documented here for contributors.
```

| Export                 | Signature                                                  | Description                                  |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| `runPendingMigrations` | `(dbPath: string) => { applied: number; version: number }` | Run any pending migrations against a DB file |
| `getSchemaVersion`     | `(dbPath: string) => number`                               | Return current schema version (0 if none)    |
| `getCurrentVersion`    | `(db: Database) => number`                                 | Read version from an open DB handle          |

**Migration history:**

| Version | Name                                         |
| ------- | -------------------------------------------- |
| 1       | Initial schema (runs, traces, tool_calls)    |
| 2       | Multi-agent tracing (parent_id, trace_links) |
| 3       | Multi-tenant (projects, tenant_id columns)   |
| 4       | Trace context (parent_id on traces)          |
| 5       | Webhooks table                               |
| 6       | API keys and rate limiting tables            |

---

## 9. TypeScript Types & Interfaces

All types are exported from `@agenttrace-io/sdk`.

### `Trace`

A single trace (one operation within an agent run).

```typescript
interface Trace {
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
  parentId?: string;
  tenantId?: string;
}
```

### `Run`

Summary of an agent run (collection of traces).

```typescript
interface Run {
  id: string;
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
```

### `TokenUsage`

Token usage for a single LLM call.

```typescript
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
  provider?: string;
}
```

### `ToolCall`

A single tool call within an agent run.

```typescript
interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  latencyMs: number;
  success: boolean;
  error?: string;
  timestamp: number;
}
```

### `TraceConfig`

Configuration for the trace collector.

```typescript
interface TraceConfig {
  dbPath?: string;
  maxTraces?: number;
  autoCleanup?: boolean;
  costCalculator?: (tokens: TokenUsage, model?: string) => number;
  hallucinationDetector?: (output: unknown, expected?: unknown) => boolean;
  silent?: boolean;
  retentionDays?: number;
  cleanupIntervalHours?: number;
  tenantId?: string;
  maxTracesPerSecond?: number;
  maxTracesPerMinute?: number;
  burstAllowance?: number;
}
```

### `TraceFilter`

Filter options for querying traces.

```typescript
interface TraceFilter {
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
```

### `TraceStats`

Summary statistics.

```typescript
interface TraceStats {
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
  droppedTraces: number;
}
```

### `CostBreakdown`

Cost breakdown returned by `getCostBreakdown`.

```typescript
interface CostBreakdown {
  totalCostUsd: number;
  costByModel: Record<string, number>;
  costByDay: Record<string, number>;
}
```

### `Scorer` / `ScorerResult` / `EvaluateOptions`

Evaluation framework types.

```typescript
interface Scorer {
  name: string;
  fn: (trace: Trace) => number | Promise<number>;
}

interface ScorerResult {
  traceId: string;
  scores: Record<string, number>;
  errors: Record<string, string>;
}

interface EvaluateOptions {
  scorers: Scorer[];
  runId?: string;
  traceIds?: string[];
  concurrency?: number;
}
```

### `AlertCondition` / `AlertHistory`

Alerting types.

```typescript
interface AlertCondition {
  name: string;
  condition: (stats: TraceStats) => boolean;
  webhook?: string;
  email?: string;
  cooldown: number; // seconds
  lastTriggered?: number;
}

interface AlertHistory {
  id: string;
  alertName: string;
  triggeredAt: number;
  stats: Record<string, number>;
  delivered: boolean;
  error?: string;
}
```

### `TraceContext` / `TraceTreeNode`

Multi-agent tracing types.

```typescript
class TraceContext {
  traceId: string;
  parentSpanId?: string;
  metadata: Record<string, unknown>;
  constructor(traceId: string, parentSpanId?: string, metadata?: Record<string, unknown>);
}

interface TraceTreeNode {
  trace: Trace;
  children: TraceTreeNode[];
}
```

### `HealthReport`

Health report for database + process.

```typescript
interface HealthReport {
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
```

### `AgentUsageRecord`

Record of agent usage / action for the agent_usage tracking system.

```typescript
interface AgentUsageRecord {
  id: string;
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
```

### `AgentUsageFilter`

Filter for querying agent usage records.

```typescript
interface AgentUsageFilter {
  agentName?: string;
  agentType?: string;
  action?: string;
  status?: AgentUsageRecord['status'] | AgentUsageRecord['status'][];
  fromDate?: number;
  toDate?: number;
  limit?: number;
  offset?: number;
}
```

### `UsageStats`

Aggregated usage statistics.

```typescript
interface UsageStats {
  totalAgents: number;
  totalActions: number;
  totalTokens: number;
  totalCostUsd: number;
  avgDurationMs: number;
  actionsByType: Record<string, number>;
  topAgents: Array<{ agentName: string; actions: number; tokens: number; costUsd: number }>;
}
```

### `AgentWho` / `AgentSession`

Agent overview types.

```typescript
interface AgentWho {
  agentName: string;
  agentType?: string;
  sessionId?: string;
  lastAction: string;
  actions: number;
  tokens: number;
  costUsd: number;
}

interface AgentSession {
  sessionId: string;
  agentName: string;
  startedAt: number;
  durationMs: number;
  actions: number;
  tokens: number;
  costUsd: number;
  status: 'success' | 'failure' | 'timeout';
}
```

### `WebhookConfig` / `WebhookEvent` / `WebhookDelivery`

Webhook types.

```typescript
type WebhookEvent =
  | 'trace.complete'
  | 'trace.error'
  | 'run.complete'
  | 'run.error'
  | 'cost.threshold'
  | 'agent.inactive';

interface WebhookConfig {
  id: string;
  url: string;
  secret?: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: number;
  lastTriggeredAt?: number;
  failureCount: number;
}

interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payload: string;
  status: 'success' | 'failure';
  httpStatus?: number;
  error?: string;
  createdAt: number;
}
```

### `ApiKey` / `CreatedApiKey` / `Project`

API key types.

```typescript
interface ApiKey {
  id: string;
  name: string;
  preview: string; // e.g. 'at_abc123****' (never the full secret)
  createdAt: number;
  lastUsedAt?: number;
}

interface CreatedApiKey extends ApiKey {
  key: string; // full secret, shown only once at creation time
}

interface Project {
  id: string;
  name: string;
  apiKey: string;
  createdAt: number;
}
```

### `DashboardConfig` / `FrameworkIntegration` / `ExportFormat`

Misc types.

```typescript
interface DashboardConfig {
  port?: number;
  host?: string;
  openBrowser?: boolean;
  dbPath?: string;
}

type AgentFramework = 'langgraph' | 'crewai' | 'autogen' | 'custom';

interface FrameworkIntegration {
  framework: AgentFramework;
  version?: string;
  autoTrace?: boolean;
  traceTools?: boolean;
  traceTokens?: boolean;
}

type ExportFormat = 'json' | 'csv' | 'otel';
```

---

## 10. Python SDK -- `AgentTrace`

**Module:** `agenttrace`

Python port of the TypeScript SDK. Uses snake_case naming. All methods mirror the
TypeScript API unless noted.

### Python Constructor & TraceConfig

```python
from agenttrace import AgentTrace

agent = AgentTrace(config=None)
```

`config` can be a `TraceConfig` dataclass or a dict. Supported keys:
`db_path`, `max_traces`, `auto_cleanup`, `cost_calculator`,
`hallucination_detector`, `silent`.

```python
from agenttrace import TraceConfig

config = TraceConfig(db_path='./agenttrace.db', max_traces=5000)
agent = AgentTrace(config)
```

### Python Run Management

```python
run_id = agent.start_run(name: str, metadata: Optional[dict] = None) -> str
agent.complete_run(status: RunStatus = "success") -> None
```

### Python Tracing

Three usage patterns supported:

```python
# 1. Direct call
result = agent.trace("my-op", lambda: do_work(), input=data, tokens=token_usage)

# 2. Decorator
@agent.trace("my-op")
def my_work():
    return "hello"

# 3. Context manager
with agent.trace("my-op") as t:
    val = do_work()
    t.set_output(val)
    t.set_tokens({"promptTokens": 100, "completionTokens": 50, "totalTokens": 150})
    t.set_metadata({"key": "value"})
```

### Python Querying / Stats / Export / Eval

| Method (Python)                                                                          | TypeScript Equivalent             | Notes                                      |
| ---------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------ |
| `get_traces(filter={}) -> list[Trace]`                                                   | `getTraces(filter?)`              | Accepts dict or `TraceFilter` dataclass    |
| `get_trace(id) -> Trace \| None`                                                         | `getTrace(id)`                    |                                            |
| `get_runs(limit=100) -> list[Run]`                                                       | `getRuns(limit?)`                 |                                            |
| `get_run(id) -> Run \| None`                                                             | `getRun(id)`                      |                                            |
| `get_stats() -> TraceStats`                                                              | `getStats()`                      |                                            |
| `get_cost_breakdown(run_id=None) -> CostBreakdown`                                       | `getCostBreakdown(filter?)`       |                                            |
| `export(format='json', filter={}) -> str`                                                | `export(format?, filter?)`        | `format`: `'json'` or `'csv'` (no OTel)    |
| `evaluate(scorers, run_id=None, trace_ids=None, concurrency=None) -> list[ScorerResult]` | `evaluate(options)`               | Accepts bare callables or `Scorer` objects |
| `evaluate_trace(trace_id, scorers) -> ScorerResult`                                      | `evaluateTrace(traceId, scorers)` |                                            |
| `get_scores(trace_id=None) -> list[dict]`                                                | (via `TraceStorage.getScores`)    |                                            |
| `record_tool_call(call) -> str`                                                          | `recordToolCall(call)`            | Stub; tool calls stored at trace time      |

### Python Agent Usage Tracking

| Method (Python)                                                                | TypeScript Equivalent      |
| ------------------------------------------------------------------------------ | -------------------------- |
| `record_agent_usage(record) -> void`                                           | `recordAgentUsage(record)` |
| `get_agent_usage(filter={}) -> list[AgentUsageRecord]`                         | `getAgentUsage(filter?)`   |
| `get_usage_stats(agent_name=None, from_date=None, to_date=None) -> UsageStats` | `getUsageStats(...)`       |

### Python Lifecycle

```python
agent.close()  # Close the underlying DB connection
```

---

## 11. Python SDK -- `TraceStorage`

**Module:** `agenttrace.TraceStorage`

Low-level SQLite storage. Mirrors the TypeScript `TraceStorage` API with
snake_case naming.

```python
from agenttrace import TraceStorage

storage = TraceStorage('./agenttrace.db')
```

### Key Methods (Python)

| Method                                                                         | Returns                  |
| ------------------------------------------------------------------------------ | ------------------------ |
| `create_run(run: dict \| Run) -> Run`                                          | `Run`                    |
| `get_run(id: str) -> Run \| None`                                              | `Run \| None`            |
| `get_runs(limit=100) -> list[Run]`                                             | `list[Run]`              |
| `complete_run(id: str, status: str) -> None`                                   | `None`                   |
| `update_run_stats(run_id, tokens, tool_calls, latency_ms, cost_usd) -> None`   | `None`                   |
| `create_trace(trace: Trace \| dict) -> Trace`                                  | `Trace`                  |
| `get_trace(id: str) -> Trace \| None`                                          | `Trace \| None`          |
| `get_traces(filter={}) -> list[Trace]`                                         | `list[Trace]`            |
| `create_score(id, trace_id, name, value) -> None`                              | `None`                   |
| `get_scores(trace_id=None) -> list[dict]`                                      | `list[dict]`             |
| `get_stats() -> TraceStats`                                                    | `TraceStats`             |
| `get_cost_breakdown(run_id=None) -> CostBreakdown`                             | `CostBreakdown`          |
| `cleanup(max_traces=10000) -> int`                                             | `int` (deleted count)    |
| `record_agent_usage(record) -> None`                                           | `None`                   |
| `get_agent_usage(filter={}) -> list[AgentUsageRecord]`                         | `list[AgentUsageRecord]` |
| `get_usage_stats(agent_name=None, from_date=None, to_date=None) -> UsageStats` | `UsageStats`             |
| `get_active_agents() -> list[dict]`                                            | `list[dict]`             |
| `close() -> None`                                                              | `None`                   |

---

## 12. Python SDK -- `AgentUsageTracker`

**Module:** `agenttrace.AgentUsageTracker`

Thin tracker for agent usage / actions. Records into the dedicated `agent_usage`
table for usage analytics. Supports session grouping.

```python
from agenttrace import AgentUsageTracker

tracker = AgentUsageTracker(agent_name="my-agent", agent_type="ai-agent")
```

### Methods

| Method                                                               | Returns                                          |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| `start_session() -> str`                                             | `str` (session ID)                               |
| `track_action(action: str, target: str, metadata=None) -> None`      | `None`                                           |
| `track_delegation(target_agent: str, task: str) -> None`             | `None`                                           |
| `track_research(query: str, results: int) -> None`                   | `None`                                           |
| `track_implementation(files: list[str], lines_of_code: int) -> None` | `None`                                           |
| `end_session() -> None`                                              | `None`                                           |
| `get_session_stats() -> dict`                                        | `{ sessionId, actions, duration, tokens, cost }` |
| `close() -> None`                                                    | `None`                                           |

---

## 13. Python SDK -- Singleton Helpers

**Module:** `agenttrace`

```python
from agenttrace import init, get_agent_trace, trace, score, evaluate, evaluate_trace, VERSION, PACKAGE_NAME

# Initialize the global instance
init({'db_path': './agenttrace.db'})

# Get (or lazily create) the global instance
agent = get_agent_trace()

# Top-level trace (same 3 patterns as AgentTrace.trace)
result = trace("my-op", lambda: do_work())

@trace("my-op")
def my_work():
    return "hello"

# Helper to create a Scorer
s = score('output-len', lambda t: len(str(t or '')) / 1000)

# Top-level evaluate
results = evaluate([s], run_id='some-run-id')
result = evaluate_trace('trace-id', [s])

print(VERSION)       # '0.1.0'
print(PACKAGE_NAME)  # 'agenttrace-io'
```

---

## 14. Python Types (Dataclasses)

All types are exported from `agenttrace.types`.

| Python Dataclass   | TypeScript Interface | Key Fields (snake_case)                                                                                                                                                  |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Trace`            | `Trace`              | `id`, `run_id`, `name`, `status`, `input`, `output`, `tokens`, `tool_calls`, `latency_ms`, `cost_usd`, `error`, `metadata`, `created_at`, `updated_at`                   |
| `Run`              | `Run`                | `id`, `name`, `status`, `trace_count`, `total_tokens`, `total_tool_calls`, `total_latency_ms`, `total_cost_usd`, `error_count`, `started_at`, `completed_at`, `metadata` |
| `TokenUsage`       | `TokenUsage`         | `prompt_tokens`, `completion_tokens`, `total_tokens`, `model`, `provider`                                                                                                |
| `ToolCall`         | `ToolCall`           | `id`, `name`, `input`, `output`, `latency_ms`, `success`, `error`, `timestamp`                                                                                           |
| `TraceConfig`      | `TraceConfig`        | `db_path`, `max_traces`, `auto_cleanup`, `cost_calculator`, `hallucination_detector`, `silent`                                                                           |
| `TraceFilter`      | `TraceFilter`        | `run_id`, `status`, `name`, `from_date`, `to_date`, `min_cost`, `max_cost`, `min_latency`, `max_latency`, `limit`, `offset`                                              |
| `TraceStats`       | `TraceStats`         | `total_runs`, `total_traces`, `success_rate`, `avg_latency_ms`, `total_cost_usd`, `total_tokens`, `avg_tokens_per_trace`, `top_tools`, `top_errors`                      |
| `CostBreakdown`    | `CostBreakdown`      | `total_cost_usd`, `cost_by_model`, `cost_by_day`                                                                                                                         |
| `Scorer`           | `Scorer`             | `name`, `fn`                                                                                                                                                             |
| `ScorerResult`     | `ScorerResult`       | `trace_id`, `scores`, `errors`                                                                                                                                           |
| `EvaluateOptions`  | `EvaluateOptions`    | `scorers`, `run_id`, `trace_ids`, `concurrency`                                                                                                                          |
| `AgentUsageRecord` | `AgentUsageRecord`   | `id`, `agent_name`, `agent_type`, `session_id`, `action`, `target`, `tokens_used`, `cost_usd`, `duration_ms`, `status`, `metadata`, `created_at`                         |
| `AgentUsageFilter` | `AgentUsageFilter`   | `agent_name`, `agent_type`, `action`, `status`, `from_date`, `to_date`, `limit`, `offset`, `session_id`                                                                  |
| `UsageStats`       | `UsageStats`         | `total_agents`, `total_actions`, `total_tokens`, `total_cost_usd`, `avg_duration_ms`, `actions_by_type`, `top_agents`                                                    |

**Type aliases:**

```python
Status = Literal["success", "failure", "error", "timeout"]
RunStatus = Literal["running", "success", "failure", "error"]
ExportFormat = Literal["json", "csv"]
UsageStatus = Literal["success", "failure", "timeout"]
CostCalculator = Callable[[TokenUsage, Optional[str]], float]
HallucinationDetector = Callable[[Any, Optional[Any]], bool]
```

---

## 15. CLI Commands Reference

**Package:** `@agenttrace-io/cli`
**Binary:** `agenttrace-io` (alias: `agenttrace`)

```bash
agenttrace-io <command> [options]
```

### init / dashboard / version

| Command     | Description                                 |
| ----------- | ------------------------------------------- |
| `init`      | Create empty `agenttrace.db` in current dir |
| `dashboard` | Start the local dashboard server            |
| `version`   | Show CLI version                            |

```bash
agenttrace init
agenttrace dashboard
agenttrace version
```

### runs / traces

| Command  | Options                                       | Description                          |
| -------- | --------------------------------------------- | ------------------------------------ |
| `runs`   | `--limit N`, `--status FILTER`                | List recent runs (most recent first) |
| `traces` | `--limit N`, `--status FILTER`, `--run-id ID` | List traces (most recent first)      |

```bash
agenttrace runs --limit 5 --status success,running
agenttrace traces --run-id 123e4567 --json
```

### stats / costs

| Command | Options                  | Description                            |
| ------- | ------------------------ | -------------------------------------- |
| `stats` |                          | Show summary statistics                |
| `costs` | `--daily`, `--run-id ID` | Cost breakdown by model (or `--daily`) |

```bash
agenttrace stats
agenttrace costs
agenttrace costs --daily --json
agenttrace costs --run-id abc123
```

### export / tree

| Command  | Options                    | Description                          |
| -------- | -------------------------- | ------------------------------------ | ---------------------------- |
| `export` | `--format json             | csv`, `--output FILE`, `--run-id ID` | Export traces to JSON or CSV |
| `tree`   | `--trace-id ID` (required) | Show parent/child/related trace tree |

```bash
agenttrace export --format csv --output out.csv --run-id abc
agenttrace tree --trace-id abc123def
```

### alerts / health

| Command  | Options                               | Description                            |
| -------- | ------------------------------------- | -------------------------------------- |
| `alerts` | `list`, `test --name NAME`, `history` | Manage alerts                          |
| `health` |                                       | Check health of gateway, dashboard, DB |

```bash
agenttrace alerts list
agenttrace alerts test --name high-error-rate
agenttrace alerts history
agenttrace health
```

### self-stats / who / cost / sessions / activity

| Command      | Options                                                            | Description                    |
| ------------ | ------------------------------------------------------------------ | ------------------------------ |
| `self-stats` | `--json`                                                           | Show self-tracked agent usage  |
| `who`        | `--active`, `--type TYPE`, `--limit N`                             | Show active agents             |
| `cost`       | `--from DATE`, `--to DATE`, `--agent NAME`, `--format json\|table` | Agent cost breakdown           |
| `sessions`   | `--agent NAME`, `--active`, `--limit N`                            | List agent sessions            |
| `activity`   | `--agent NAME`, `--type ACTION`, `--limit N`, `--since DUR`        | Recent agent activity timeline |

```bash
agenttrace self-stats
agenttrace self-stats --json
agenttrace who --active --limit 10
agenttrace-io cost --format table
agenttrace-io cost --agent researcher-1 --from 2026-01-01
agenttrace sessions --active
agenttrace activity --since 2h --limit 20
```

### cleanup / retention

| Command     | Options                             | Description                         |
| ----------- | ----------------------------------- | ----------------------------------- |
| `cleanup`   | `--days N`, `--dry-run`             | Manually run data retention cleanup |
| `retention` | `show`, `set <days> [--interval H]` | Manage data retention policy        |

```bash
agenttrace cleanup
agenttrace cleanup --days 7 --dry-run
agenttrace retention show
agenttrace retention set 60
agenttrace retention set 90 --interval 12
```

### benchmark

| Command     | Options | Description                                           |
| ----------- | ------- | ----------------------------------------------------- |
| `benchmark` |         | Run performance benchmark suite (prints JSON results) |

```bash
agenttrace benchmark
```

### Global Options

| Option   | Description                                                                     |
| -------- | ------------------------------------------------------------------------------- |
| `--json` | Emit machine-readable JSON (for runs, traces, stats, costs, export, self-stats) |
| `--help` | Show help                                                                       |

### Environment Variables

| Variable               | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `AGENTTRACE_DB_PATH`   | Override default database path (`./agenttrace.db`) |
| `AGENTTRACE_USAGE_LOG` | Override self-tracker JSONL log path               |

---

## 16. Database Schema

AgentTrace uses a single SQLite database with WAL mode and foreign keys enabled.

### Tables

| Table                | Description                                 |
| -------------------- | ------------------------------------------- |
| `runs`               | Agent runs (collections of traces)          |
| `traces`             | Individual traced operations                |
| `tool_calls`         | Tool calls associated with traces           |
| `scores`             | Evaluation scores for traces                |
| `alerts`             | Alert condition configs (serialized)        |
| `alert_history`      | Alert firing history                        |
| `trace_links`        | Manual links between traces (cross-agent)   |
| `agent_usage`        | Agent self-tracking usage records           |
| `webhooks`           | Webhook configurations                      |
| `webhook_deliveries` | Webhook delivery records                    |
| `api_keys`           | API key hashes (secrets never stored)       |
| `rate_limit_log`     | Rate-limited trace records                  |
| `projects`           | Multi-tenant projects                       |
| `settings`           | Key-value settings (retention policy, etc.) |
| `version`            | Schema migration version tracking           |
| `meta`               | Migration metadata                          |

### Schema Version

The current schema version is **6**. Migrations are applied automatically when
the database is opened.

### Key Indexes

- `idx_traces_run_id` on `traces(run_id)`
- `idx_traces_status` on `traces(status)`
- `idx_traces_created_at` on `traces(created_at)`
- `idx_traces_cost` on `traces(cost_usd)`
- `idx_traces_parent_id` on `traces(parent_id)`
- `idx_tool_calls_trace_id` on `tool_calls(trace_id)`
- `idx_tool_calls_name` on `tool_calls(name)`
- `idx_scores_trace_id` on `scores(trace_id)`
- `idx_scores_name` on `scores(name)`
- `idx_agent_usage_agent_name` on `agent_usage(agent_name)`
- `idx_agent_usage_session_id` on `agent_usage(session_id)`
- `idx_agent_usage_action` on `agent_usage(action)`
- `idx_agent_usage_status` on `agent_usage(status)`
- `idx_agent_usage_created_at` on `agent_usage(created_at)`
- `idx_trace_links_source` on `trace_links(source_trace_id)`
- `idx_trace_links_target` on `trace_links(target_trace_id)`
- `idx_alerts_name` on `alerts(name)`
- `idx_alert_history_alert_name` on `alert_history(alert_name)`
- `idx_alert_history_triggered_at` on `alert_history(triggered_at)`
- `idx_webhooks_enabled` on `webhooks(enabled)`
- `idx_api_keys_key_hash` on `api_keys(key_hash)`
