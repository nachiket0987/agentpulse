# Node Basic - AgentTrace Self-Usage Tracking

Basic TypeScript example of an AI agent using AgentTrace to trace its own operations, track costs across models, log high-level actions, configure alerts, and query its own usage statistics at runtime.

## Why this matters for agents

Agents that can see their own spend and behavior can:

- Choose cheaper models when budget is low
- Detect loops or expensive paths
- Report summaries to operators or long-term memory
- Trigger self-protection (halt, downgrade)

## Quick Start (from this directory)

```bash
npm install
npm start
```

This installs the SDK (via local workspace link for the monorepo) and runs the example.

## From anywhere (public install)

```bash
npm install @agenttrace-io/sdk
# then copy index.ts and adapt the import
npx tsx index.ts   # or compile + node
```

## What the example demonstrates

- `init()` + `trace(name, fn, {model, tokens})` for nested LLM-style work
- `startRun` / `completeRun` for session grouping
- `recordAgentUsage()` for agent-level actions (research, implement, delegate, etc.)
- `registerAlert()` + `checkAlerts()` for runaway cost protection
- Self-query: `getStats()`, `getUsageStats()`, `getAgentUsage({agentName})`, `getCostBreakdown()`
- Automatic cost calculation using built-in model rates

## Expected output (abridged)

```
=== AgentTrace Node Basic Example ===
...
--- Trace Stats ---
Total traces: 2
Total cost USD: 0.006800
...

--- Agent Usage Stats (self-reported actions) ---
Total actions logged: 2
...
```

## View results

```bash
# From repo root or this dir (adjust --db)
npx agenttrace stats --db ./agenttrace.db
npx agenttrace runs --db ./agenttrace.db
npx agenttrace dashboard --db ./agenttrace.db
```

## Clean up

```bash
rm -f agenttrace.db agenttrace.db-*
```

## Next

- See `python-basic/` for the Python equivalent
- See `langchain-integration/` and `crewai-integration/` for framework wiring
- See the main README for the full integration guide
