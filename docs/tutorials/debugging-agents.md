# Debugging Agents with Traces

When an agent fails or is slow, traces tell you exactly which step, which tool, and the numbers.

## Reproduce a failing run

Run your agent (it will record even on error).

### TypeScript

```typescript
import { init, trace } from '@agenttrace-io/sdk';

const agent = init();
const runId = agent.startRun('debug-demo');

try {
  await trace('planner', async () => {
    /* ... */
  });

  await trace(
    'tool:web_search',
    async () => {
      // this one will fail in our demo
      throw new Error('rate limit from search API');
    },
    { input: { q: 'agent observability' } },
  );

  await trace('writer', async () => 'done');
} catch (e) {
  console.error('agent failed:', e);
} finally {
  agent.completeRun('error');
}
```

### Python

```python
from agenttrace import init, trace

agent = init()
rid = agent.start_run("debug-demo")

try:
    agent.trace("planner", lambda: "plan")

    def failing_tool():
        raise RuntimeError("rate limit from search API")

    agent.trace("tool:web_search", failing_tool, input={"q": "agent observability"})

    agent.trace("writer", lambda: "done")
except Exception as e:
    print("agent failed:", e)
finally:
    agent.complete_run("error")
```

## Find the failing step / tool call

### With CLI (fastest)

```bash
npx agenttrace traces --status error --limit 10
# or for a specific run
npx agenttrace traces --run-id <rid> --json
```

Look for the trace with `status: "error"` and the `error` field.

### Programmatically

#### TypeScript

```typescript
const agent = init();

// All errors
const errors = agent.getTraces({ status: ['error'] });
console.dir(errors, { depth: 2 });

// Errors in one run
const runErrors = agent.getTraces({ runId: 'run-xxx', status: ['error', 'failure'] });

// Find tool-related failures by name prefix
const toolFails = agent.getTraces({ name: 'tool:' }).filter((t) => t.status !== 'success');
```

#### Python

```python
agent = init()

# errors
errors = agent.get_traces({"status": ["error"]})
for t in errors:
    print(t.name, t.error, t.latency_ms)

# specific run
run_traces = agent.get_traces({"run_id": rid, "status": ["error"]})

# tool traces that failed
tool_fails = [t for t in agent.get_traces() if t.name.startswith("tool:") and t.status != "success"]
```

Each failing trace contains:

- `name`
- `error` (string)
- `input` / `output`
- `latencyMs`
- `toolCalls` (array of detailed tool invocations if recorded for that trace)

## Inspect tool calls that broke

If you wrap individual tool executions (recommended), each is its own trace with clear name.

For traces that embed `toolCalls` (advanced usage or certain middlewares):

```typescript
const bad = agent.getTrace('the-trace-id');
if (bad?.toolCalls?.length) {
  bad.toolCalls.forEach((tc) => {
    if (!tc.success) console.log('BROKEN TOOL:', tc.name, tc.error, tc.input);
  });
}
```

Python equivalent uses `t.tool_calls` (snake_case on the dataclass).

## Analyze latency

### CLI

```bash
npx agenttrace stats
# shows avgLatencyMs, top slow tools etc.
```

Filter slow traces:

```bash
npx agenttrace traces --min-latency 2000   # >2s
```

### Code

#### TypeScript

```typescript
const slow = agent.getTraces({ minLatency: 1500 }).sort((a, b) => b.latencyMs - a.latencyMs);

console.table(
  slow.map((t) => ({
    name: t.name,
    latency: t.latencyMs + 'ms',
    cost: t.costUsd,
    status: t.status,
  })),
);

const stats = agent.getStats();
console.log('Average latency:', stats.avgLatencyMs, 'ms');
console.log('Top slow tools:', stats.topTools);
```

#### Python

```python
slow = sorted(
    [t for t in agent.get_traces() if t.latency_ms > 1500],
    key=lambda t: t.latency_ms,
    reverse=True
)

for t in slow[:5]:
    print(f"{t.name}: {t.latency_ms}ms cost=${t.cost_usd:.4f} status={t.status}")

stats = agent.get_stats()
print("avg latency ms:", stats.avg_latency_ms)
print("top tools:", stats.top_tools)
```

## Use trace trees for complex agents

If you link steps with `createChild` (TS) or manual parentId, use the tree view:

```bash
npx agenttrace tree --trace-id <root-id>
```

#### TypeScript

```typescript
const childCtx = agent.createChild(parentCtx);
await trace('child-step', async () => {...}, { context: childCtx });
const tree = agent.getTraceTree(rootTraceId);
console.dir(tree, { depth: 3 });
```

This surfaces the exact execution path that led to the failure or the slow path.

## Tips

- Always pass `input` so you can see what arguments reached the bad tool.
- Use `metadata: { userId, session }` for filtering later.
- After a bad run, `agenttrace export --run-id X --format json` to attach to a bug report.

Next: learn how to [score traces automatically](./evaluation.md) so you can quantify "good" vs "bad" runs beyond just pass/fail.
