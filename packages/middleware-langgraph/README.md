# @agenttrace-io/middleware-langgraph

LangGraph middleware for AgentTrace. Automatically traces every node execution (start, complete, errors) and extracts token usage from LangGraph/LangChain built-in tracking.

## Installation

```bash
npm install @agenttrace-io/middleware-langgraph
# peer: you already have LangGraph + @agenttrace-io/sdk (workspace or npm)
```

The middleware re-exports/depends on `@agenttrace-io/sdk` as a workspace dependency.

## Usage

```ts
import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { AgentTraceMiddleware } from '@agenttrace-io/middleware-langgraph';

const AgentState = Annotation.Root({
  messages: Annotation<string[]>({ reducer: (x, y) => x.concat(y) }),
  result: Annotation<string>(),
});

async function researchNode(state: typeof AgentState.State) {
  // your node logic (LLM calls etc)
  return { result: 'research done' };
}

const middleware = new AgentTraceMiddleware({ dbPath: './traces.db' });

// Start an explicit run if desired (optional)
middleware.getAgentTrace().startRun('langgraph-demo');

// Build graph as usual
const graph = new StateGraph(AgentState)
  .addNode('research', researchNode)
  .addEdge(START, 'research')
  .addEdge('research', END);

// Compile with middleware (exact option name depends on your @langchain/langgraph version;
// the class implements the NodeMiddleware hooks LangGraph expects: beforeNode, afterNode, onError)
const app = graph.compile({
  // middleware support example (adapt to your LangGraph version):
  // middleware: [middleware],
});

// Run
const result = await app.invoke({ messages: ['What is observability?'] });

// Cleanup
middleware.close();
```

### Manual hook usage (for custom wiring)

```ts
middleware.beforeNode('my-node', currentState);
try {
  const out = await runNode(currentState);
  middleware.afterNode('my-node', currentState, out);
  return out;
} catch (e) {
  middleware.onError('my-node', currentState, e as Error);
  throw e;
}
```

## What gets traced

- Every node: name = node name in graph
- Input/output = state snapshot at boundaries
- Tokens: auto-extracted from `usage_metadata`, `response_metadata.tokenUsage`, `tokenUsage`, etc. (LangChain message conventions)
- Latency, cost (using SDK defaults), status, errors
- Metadata includes `{ framework: 'langgraph' }`

## Config

Constructor accepts the same `TraceConfig` as `AgentTrace` (from `@agenttrace-io/sdk`):

```ts
new AgentTraceMiddleware({
  dbPath: './my-traces.db',
  maxTraces: 5000,
  // costCalculator, etc.
});
```

## Viewing traces

Use the AgentTrace CLI/dashboard as usual:

```bash
npx agenttrace dashboard --db ./traces.db
```

## License

MIT
