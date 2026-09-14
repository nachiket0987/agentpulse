# Getting Started

Trace your first agent operation in under a minute. AgentTrace stores everything in a local SQLite file (`agenttrace.db`) with zero cloud calls.

## Installation

### TypeScript

```bash
npm install @agenttrace-io/sdk
# CLI (for dashboard + export commands)
npm install -g @agenttrace-io/cli
# or use npx
```

### Python

```bash
pip install agenttrace-io
# CLI is Node-based: use npx agenttrace ... (or npm i -g @agenttrace-io/cli ; alias npx agenttrace also works)
```

## Trace your first function

### TypeScript

```typescript
import { init, trace } from '@agenttrace-io/sdk';

const agent = init(); // uses ./agenttrace.db

async function researchAgent(query: string) {
  return await trace('research-agent', async () => {
    // Step 1: retrieval
    const docs = await trace(
      'retrieve',
      async () => {
        // ... call your retriever
        return ['doc1', 'doc2'];
      },
      { input: query },
    );

    // Step 2: LLM call with tokens for accurate cost
    const answer = await trace(
      'synthesize',
      async () => {
        const res = await callLLM({ model: 'gpt-4o-mini', prompt: query + docs.join() });
        return res;
      },
      {
        input: { query, docs },
        tokens: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
        model: 'gpt-4o-mini',
      },
    );

    return answer;
  });
}

const result = await researchAgent('What is observability?');
console.log(result);
```

### Python

```python
from agenttrace import init, trace

agent = init(db_path="./agenttrace.db")

def research_agent(query: str):
    # 1. Using the function form
    def _retrieve():
        return ["doc1", "doc2"]

    docs = agent.trace("retrieve", _retrieve, input=query)

    # 2. Decorator form
    @agent.trace("synthesize")
    def _synthesize(q, d):
        # call your LLM here
        return "answer based on " + q

    answer = _synthesize(query, docs)
    return answer

# 3. Context manager form (great for manual set_output / set_tokens)
with agent.trace("research-agent") as t:
    docs = agent.trace("retrieve", lambda: ["doc1", "doc2"])
    t.set_metadata({"query": "What is observability?"})
    # ... do LLM work ...
    final = "the answer"
    t.set_output(final)
    t.set_tokens({"prompt_tokens": 120, "completion_tokens": 45, "model": "gpt-4o-mini"})

result = research_agent("What is observability?")
print(result)
```

Nest as deeply as you like — every `trace()` call becomes a row you can inspect.

## View the dashboard

After running your code (which populates `agenttrace.db`):

```bash
# From project root
npx agenttrace dashboard
# or
npx @agenttrace-io/cli dashboard --port 3000
# (the package is @agenttrace-io/cli on npm; the CLI command itself is `agenttrace`)
```

Open http://localhost:3000 — you'll see runs, traces, latency, costs, tool calls, and errors.

Use the CLI to inspect without the UI:

```bash
npx agenttrace runs --limit 5
npx agenttrace traces --limit 20
npx agenttrace stats
```

## Export traces

### Via CLI

```bash
# All traces as JSON
npx agenttrace export --format json --output traces.json

# Just one run
npx agenttrace export --format csv --run-id <run-uuid> --output run.csv

# OpenTelemetry format (OTLP JSON)
npx agenttrace export --format otel --output otel.json
```

### Via SDK code

#### TypeScript

```typescript
import { init } from '@agenttrace-io/sdk';
const agent = init();

const json = agent.export('json', { runId: 'optional-run-id' });
const csv = agent.export('csv');
const otel = agent.export('otel');

console.log(json);
agent.close();
```

#### Python

```python
from agenttrace import init
agent = init()

json_str = agent.export("json", {"run_id": "optional-run-id"})
csv_str = agent.export("csv")
# otel not yet in py export but json/csv work

print(json_str[:200])
agent.close()
```

## Next steps

- Read the [debugging tutorial](./debugging-agents.md) to locate failing tool calls and high-latency steps.
- Read the [evaluation tutorial](./evaluation.md) to score your traces with custom logic.
- See full options in `docs-site/api.html` or the source types.

Tip: call `agent.start_run("my-experiment")` / `agent.complete_run()` to group related traces under one named run.
