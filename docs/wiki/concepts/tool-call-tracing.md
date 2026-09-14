# Tool Call Tracing Concept

Synthesized 2026-06 from web + X research (see docs/research/tool-call-tracing-observability-research-2026.md).

## Definition

Per-invocation capture of tool usage within agent execution: every call to an external tool/function/API by the agent must be recorded with:

- id (UUID)
- name (tool identifier)
- input (args/parameters, JSON serializable)
- output (result, JSON serializable)
- latencyMs (duration of the invocation)
- success (boolean)
- error (optional string)
- timestamp (ms since epoch)

Linked to a parent Trace via trace_id in storage.

## Why (from 2026 observability consensus)

- Silent failures, wrong selections, high latency, or bad outputs in tools are primary sources of agent errors.
- Enables debugging trajectories: "which tool, with what I/O, did it succeed, how long, what was returned?"
- Required for eval (tool-call accuracy), cost attribution, reliability monitoring per-tool.
- OTEL GenAI + commercial tools (LangSmith, Langfuse, Braintrust, etc.) model tool calls as first-class spans or trace children.
- Without it, public SDK trace() API is "tool-call-blind" (per improvement-plan).

## Implementation in AgentTrace (TS SDK)

- `AgentTrace.trace(name, fn, opts)` establishes an _active trace context_ for the duration of fn().
- `recordToolCall( partial: Omit<ToolCall, 'id'|'timestamp'> )` : if active context, constructs full ToolCall (adds id+ts), pushes to the context's list, returns id. Else returns id + warning (unless silent).
- On trace end (finally, incl. errors): drain the collected toolCalls array into the Trace object passed to `storage.createTrace()`.
- storage.createTrace() already handles batch INSERTs to `tool_calls` table and increments run stats (tool call count).
- Supports nesting (via prev-context restore): child traces get their own context; post-child records in parent attach to parent (matches example patterns).
- Orphan calls (no active trace) still return a synthetic id but warn -- useful for debugging mis-use.
- Middlewares (langgraph/crewai) currently populate directly in storage calls (empty [] often); future can delegate to this.

## Usage Pattern (manual)

```ts
const result = await at.trace('my-agent', async () => {
  const toolOut = await callMyTool(args);
  const tcId = at.recordToolCall({
    name: 'myTool',
    input: args,
    output: toolOut,
    latencyMs: 123,
    success: true,
  });
  return synthesize(toolOut);
}, { input: userReq, ... });
```

The top trace will have toolCalls populated in DB + queries.

Sub-traces can be used for fine-grained: `await at.trace('tool-myTool', async () => call..., {..})` -- that subtrace itself can have its toolCalls if deeper.

## Data Model

See types.ts: ToolCall, Trace { toolCalls: ToolCall[] }
storage.ts: inserts to tool_calls, rowToTrace hydrates joined.

## Related

- Hierarchical via parentId on Trace.
- OTEL export in SDK includes trace but currently no per-tool spans (future).
- Python SDK will need equivalent (not in this sprint task).

This enables "per-step tool call tracing is essential" as stated in task.
