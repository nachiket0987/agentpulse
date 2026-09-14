# Quick Start

Get full visibility into your AI agents in under a minute. Local SQLite database. Zero cloud required.

> **Tip:** All code blocks below have a **copy** button when viewed on the docs site (or use the triple-dot menu in your markdown viewer).

## 1. Install

### CLI (recommended to explore data)

```bash
npm install -g @agenttrace-io/cli
# or without installing anything:
# npx agenttrace <command>
```

The CLI command is `agenttrace`. (`agenttrace-io` also works as an alias.)

### TypeScript / Node SDK

```bash
npm install @agenttrace-io/sdk
# peer: better-sqlite3 is required for persistence
```

### Python SDK

```bash
pip install agenttrace-io
```

## 2. Trace Your First Agent (TypeScript)

```ts
import { init } from '@agenttrace-io/sdk';

const agent = init({ dbPath: './agenttrace.db' });

// Start a logical run (groups related traces together)
agent.startRun('support-session-42');

const result = await agent.trace(
  'web-search',
  async () => {
    // Your LLM or tool call here
    const response = await callYourLLM({ prompt: 'Find pricing for X' });
    return response;
  },
  {
    input: 'Find pricing for X',
    tokens: {
      promptTokens: 142,
      completionTokens: 67,
      totalTokens: 209,
      model: 'gpt-4o-mini',
      provider: 'openai',
    },
    metadata: { userId: 'u_123' },
  },
);

// Always close when you're done
console.log(agent.getStats());
agent.close();
```

### Using the singleton helper

```ts
import { init, getAgentTrace } from '@agenttrace-io/sdk';

init({ dbPath: './my.db' });
const agent = getAgentTrace();
// ... later in your code
```

## 3. Python Example

```python
from agenttrace import init

agent = init(db_path="./agenttrace.db")

@agent.trace("research")
def research(query: str):
    # your agent logic
    return llm_call(query)

result = research("latest model benchmarks")
print(agent.get_stats())
agent.close()
```

Context manager and decorator forms are also supported:

```python
from agenttrace import init

agent = init(db_path="./agenttrace.db")

with agent.trace("analyze", input={"q": "foo"}) as t:
    out = expensive_step()
    t.record_tool_call(name="db.query", input={"sql": "..."}, output={"rows": 12})
```

## 4. View Data with the CLI

```bash
# Create a fresh DB in current directory
npx agenttrace init

# Run your instrumented code (it will write to ./agenttrace.db)

# High-level stats
npx agenttrace stats

# Cost breakdown (by model or --daily)
npx agenttrace costs --daily

# Recent traces
npx agenttrace traces --limit 30

# Full multi-agent tree for a trace
npx agenttrace tree --trace-id <trace-id>

# Self-tracked agent usage (for meta-agents and autonomous patterns)
npx agenttrace self-stats

# Export for audits or downstream tools
npx agenttrace export --format csv --output traces.csv
npx agenttrace export --format otel   # OTLP JSON (no external deps)
```

## 5. Launch the Local Dashboard

```bash
npx agenttrace dashboard
# or with options:
npx agenttrace dashboard --port 4500 --host 0.0.0.0
```

Opens a fast, private web UI at http://localhost:4317 (default). All data stays on your machine.

**Keyboard shortcuts in the dashboard:**

- `j` / `k` — navigate runs
- `Enter` — open selected trace
- `Esc` — close panels
- `r` — manual refresh

## 6. Next Steps

- Add `recordToolCall()` inside a `trace()` for detailed tool observability.
- Use `createChild(context)` + `linkTraces()` for hierarchical / multi-agent tracing.
- Register alerts that fire webhooks on cost thresholds or error rates:
  ```ts
  agent.registerAlert({
    name: 'high-cost',
    condition: (s) => s.totalCostUsd > 50,
    webhook: 'https://example.com/alerts',
    cooldown: 300,
  });
  ```
- Add the LangGraph or CrewAI middleware packages for automatic instrumentation.
- Set retention policy: `agent.setRetentionPolicy(90)` (days).
- Explore the [API Reference](./api.md) and [Enterprise & Governance](./enterprise.md).

## Environment Variable

Point every command and SDK instance at a specific database:

```bash
export AGENTTRACE_DB_PATH=/path/to/shared/agenttrace.db
```

## Troubleshooting

**"No agenttrace.db found"**  
Run `npx agenttrace init` (or set `AGENTTRACE_DB_PATH`) before using CLI commands that read data.

**Dashboard shows "Failed to load data"**  
Make sure the dashboard process is running and you are hitting the right port. The CLI prints the exact URL on start.

**Costs are zero or wrong**  
You must pass `tokens: { promptTokens, completionTokens, totalTokens, model }` (or use a middleware that does it for you). The SDK has built-in rates for common models; register custom rates with `registerModelRate(name, promptRate, completionRate)`.

**Python decorator not tracing**  
Decorators only work on functions. For async use the context manager or the `trace` method directly.

**Large files / many traces**  
Use `--limit` in the CLI and retention policies in the SDK. The dashboard virtualizes long lists.

## Full Documentation

- [API Reference](./api.md)
- [Enterprise & Governance](./enterprise.md)
- GitHub: https://github.com/Klepsiphron/agenttrace
- Main README in the repo for examples and architecture.

That's it — you're tracing. Your agents will never surprise you with a token bill again.
