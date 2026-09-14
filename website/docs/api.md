# AgentTrace API Reference

This document covers the public API of the TypeScript SDK (`@agenttrace-io/sdk`) v0.1.0. The Python SDK mirrors the same concepts with Pythonic naming.

**Package:** `@agenttrace-io/sdk`  
**Source:** [packages/sdk/src/index.ts](../../packages/sdk/src) and [packages/sdk/src/types.ts](../../packages/sdk/src)

> **Note:** When viewed on the docs site, all code blocks have copy buttons and this page has a sticky table of contents.

---

## Table of Contents

- [Installation](#installation)
- [Initialization](#initialization)
- [Core Tracing](#core-tracing)
- [Query Methods](#query-methods)
- [Agent Self-Tracking](#agent-self-tracking)
- [Multi-Agent / Hierarchical Tracing](#multi-agent--hierarchical-tracing)
- [Alerts](#alerts)
- [Webhooks](#webhooks)
- [Export & Evaluation](#export--evaluation)
- [Cost Calculator & Model Rates](#cost-calculator--model-rates)
- [Python SDK Parity](#python-sdk-parity)
- [CLI Surface](#cli-surface)

---

## Installation

```bash
npm install @agenttrace-io/sdk
# peer dependency (required for persistence):
npm install better-sqlite3
```

**Python**

```bash
pip install agenttrace-io
```

---

## Initialization

### `init(config?: TraceConfig): AgentTrace`

Convenience singleton creator. Recommended for most apps.

```ts
import { init } from '@agenttrace-io/sdk';

const agent = init({ dbPath: './agenttrace.db' });
```

**Python**

```python
from agenttrace import init
agent = init(db_path="./agenttrace.db")
```

### `new AgentTrace(config?: TraceConfig)`

Direct constructor.

```ts
import { AgentTrace } from '@agenttrace-io/sdk';

const agent = new AgentTrace({
  dbPath: './traces.db',
  maxTraces: 50000,
  retentionDays: 90,
  silent: false,
});
```

**Python**

```python
from agenttrace import AgentTrace
agent = AgentTrace(db_path="./traces.db", max_traces=50000, retention_days=90)
```

### `getAgentTrace(): AgentTrace`

Returns the current singleton (creates a default one if none exists).

---

## TraceConfig

```ts
interface TraceConfig {
  dbPath?: string; // default: './agenttrace.db'
  maxTraces?: number; // default: 10000
  autoCleanup?: boolean; // default: true
  costCalculator?: (tokens: TokenUsage, model?: string) => number;
  hallucinationDetector?: (output: unknown, expected?: unknown) => boolean;
  silent?: boolean; // suppress console warnings
  retentionDays?: number; // 0 = forever
  cleanupIntervalHours?: number; // default 24
  tenantId?: string;
  maxTracesPerSecond?: number;
  maxTracesPerMinute?: number;
  burstAllowance?: number; // default 10
}
```

---

## Core Tracing

### `startRun(name: string, metadata?: Record<string, unknown>): string`

Creates a new run (logical session) and sets it as current. Returns the generated `runId`.

```ts
const runId = agent.startRun('customer-support-42', { userId: 'u_123' });
```

**Python**

```python
run_id = agent.start_run("customer-support-42", metadata={"userId": "u_123"})
```

### `completeRun(status?: 'success' | 'failure' | 'error' | 'running'): void`

Completes the current run. Fires webhooks automatically.

```ts
agent.completeRun('success');
```

### `async trace<T>(name: string, fn: () => Promise<T>, options?: TraceOptions): Promise<T>`

The primary tracing primitive.

```ts
const result = await agent.trace(
  'web-search',
  async () => {
    return await myLLMCall(prompt);
  },
  {
    input: prompt,
    tokens: { promptTokens: 120, completionTokens: 48, totalTokens: 168, model: 'gpt-4o' },
    metadata: { userId: 'u_123' },
  },
);
```

**Python**

```python
result = await agent.trace("web-search", my_llm_call, input=prompt, tokens={...})
# or decorator
@agent.trace("web-search")
async def my_fn(...): ...
```

**TraceOptions**

```ts
{
  input?: unknown;
  tokens?: TokenUsage;
  model?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
  parentId?: string;
  context?: TraceContext;
}
```

### `recordToolCall(call: Omit<ToolCall, 'id' | 'timestamp'>): string`

Record a tool call from inside an active `trace()`.

```ts
agent.recordToolCall({
  name: 'db.query',
  input: { sql: 'SELECT ...' },
  output: { rows: 12 },
  success: true,
  latencyMs: 18,
});
```

**Python**

```python
t.record_tool_call(name="db.query", input={...}, output={...}, success=True)
```

---

## Query Methods

### `getTraces(filter?: TraceFilter): Trace[]`

### `getTrace(id: string): Trace | null`

### `getRuns(limit?: number): Run[]`

### `getRun(id: string): Run | null`

### `getStats(): TraceStats`

Returns aggregate statistics including `totalRuns`, `totalTraces`, `successRate`, `avgLatencyMs`, `totalCostUsd`, `costByModel`, `totalTokens`, `topTools`, `topErrors`, etc.

### `getCostBreakdown(filter?: { runId?: string }): CostBreakdown`

```ts
const bd = agent.getCostBreakdown();
console.log(bd.totalCostUsd, bd.costByModel, bd.costByDay);
```

---

## Agent Self-Tracking (usage beyond LLM traces)

Useful for meta-agents, research agents, or any process that wants to log high-level actions.

```ts
agent.recordAgentUsage({
  agentName: 'researcher-1',
  action: 'web.search',
  target: 'pricing',
  tokensUsed: 1840,
  costUsd: 0.0041,
  status: 'success',
});
```

**CLI surfaces:** `self-stats`, `who`, `cost`, `sessions`, `activity`.

**Python**

```python
agent.record_agent_usage(agent_name="researcher-1", action="web.search", ...)
```

---

## Multi-Agent / Hierarchical Tracing

### `createChild(context: TraceContext): TraceContext`

Creates a fresh child context (new traceId, parentSpanId set to parent's traceId).

```ts
const childCtx = agent.createChild(parentContext);
await agent.trace('sub-task', fn, { context: childCtx });
```

### `linkTraces(traceIds: string[]): void`

Manually declare a set of traces as related.

### `getTraceTree(traceId: string): TraceTreeNode`

Returns the full parent → children tree.

```ts
interface TraceTreeNode {
  trace: Trace;
  children: TraceTreeNode[];
}
```

---

## Alerts

### `registerAlert(alert: AlertCondition): void`

```ts
agent.registerAlert({
  name: 'high-cost',
  condition: (stats) => stats.totalCostUsd > 100,
  webhook: 'https://hooks.example.com/xxx',
  cooldown: 300,
});
```

Alerts are checked automatically after every `trace()`.

### `getAlerts(): AlertCondition[]`

### `getAlertHistory(): AlertHistory[]`

### `async checkAlerts(): Promise<AlertHistory[]>`

---

## Webhooks

- `addWebhook(url: string, events: WebhookEvent[], secret?: string): string`
- `getWebhooks(): WebhookConfig[]`
- `removeWebhook(id: string): void`
- `async testWebhook(id: string): Promise<{ok, status?, error?}>`

**Events:** `'trace.complete' | 'trace.error' | 'run.complete' | 'run.error' | 'cost.threshold' | 'agent.inactive'`

Deliveries are signed with `X-AgentTrace-Signature: sha256=...` when a secret is configured.

---

## Export & Evaluation

### `export(format: 'json' | 'csv' | 'otel' = 'json', filter?: TraceFilter): string`

- `json`: full fidelity
- `csv`: flat columns
- `otel`: OTLP JSON resourceSpans (no external OpenTelemetry SDK required)

### `async evaluate(options: EvaluateOptions): Promise<ScorerResult[]>`

```ts
const results = await agent.evaluate({
  runId: 'xxx',
  scorers: [{ name: 'latency-ok', fn: (t) => ((t.latencyMs || 0) < 2000 ? 1 : 0) }],
});
```

Helper: `score(name, fn)` creates a scorer.

---

## Cost Calculator & Model Rates

Built-in rates for gpt-4o, gpt-4o-mini, claude-_, gemini-_, llama-\* (and more). Rates are USD per 1 000 tokens.

```ts
import { registerModelRate } from '@agenttrace-io/sdk';

registerModelRate('my-fine-tuned', 0.0015, 0.0045);
```

**Python**

```python
from agenttrace import register_model_rate
register_model_rate("my-fine-tuned", 0.0015, 0.0045)
```

---

## Python SDK Parity

The Python package provides full parity:

- `init(db_path=..., ...)`
- `agent.trace(name, fn, ...)` (sync + async)
- `@trace(name)` decorator
- `with agent.trace(...) as t: ...`
- `get_stats()`, `close()`, `export()`, `evaluate()`, alerts, webhooks, etc.
- `SelfTracker` for agent self-usage logging

See the Python package README and tests for exact surface.

---

## CLI Surface (for reference)

`agenttrace-io` (and `agenttrace`) commands:

`init`, `dashboard`, `runs`, `traces`, `stats`, `costs`, `export`, `tree`, `alerts`, `self-stats`, `who`, `cost`, `sessions`, `activity`, `webhook`, `health`, `benchmark`, `retention`, `cleanup`, `budget`, `budget-check`, `version`, `wrap`, `key`.

All major SDK query methods are exposed via the CLI with `--json` support.

---

For usage examples, see the repository `examples/` directory and the main README.
