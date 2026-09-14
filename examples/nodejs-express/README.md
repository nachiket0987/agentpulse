# Node.js Express + AgentTrace

Express.js server instrumented with AgentTrace for full request observability: every HTTP request is traced, AI calls are cost-tracked, and errors are captured automatically.

## What this demonstrates

- **Request tracing middleware** — every incoming request starts an AgentTrace run, records latency and status, and completes the run on response finish
- **Traced route handlers** — AI/agent endpoints use `at.trace()` to record LLM calls with model, provider, and token counts
- **Nested tracing** — the `/api/agent/run` endpoint traces planning, tool execution, and synthesis as a parent-child chain
- **Error tracking** — unhandled errors are caught by the error middleware and recorded as failed traces with stack traces
- **Cost-aware alerts** — a runaway-cost guard alerts if lifetime spend exceeds $5
- **Trace evaluation** — score traces for latency and cost-efficiency
- **Export** — download traces as JSON, CSV, or OpenTelemetry (OTLP JSON)

## Quick Start

```bash
cd examples/nodejs-express
npm install
npm run build
npm start
```

Server starts on http://localhost:3000 (or set PORT).

## Example requests

```bash
# Health check (shows AgentTrace status)
curl http://localhost:3000/health

# Traced LLM completion
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is observability?","model":"gpt-4o-mini"}'

# Traced multi-tool agent run
curl -X POST http://localhost:3000/api/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"task":"Research agent tracing","tools":["web_search","code_interpreter"]}'

# Score traces
curl -X POST http://localhost:3000/api/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"traceIds":[]}'

# Get stats
curl http://localhost:3000/stats

# Get usage
curl http://localhost:3000/usage

# Export as JSON
curl http://localhost:3000/api/export/json

# Export as OpenTelemetry
curl http://localhost:3000/api/export/otel

# Export as CSV
curl http://localhost:3000/api/export/csv
```

## How it works

### Middleware chain

```
Request → agentTraceMiddleware (starts run, sets res.on('finish')) → routes → errorTracingMiddleware
```

`agentTraceMiddleware`:

1. Calls `at.startRun()` with method + path
2. Attaches `traceRunId` to `req` so handlers can enrich the run
3. On `res.finish()`: records agent usage (latency, status), completes the run

`errorTracingMiddleware`:

1. Records the error via `at.recordAgentUsage()` with error metadata
2. Responds with 500 + the `traceRunId` for debugging

### Traced routes

Each AI endpoint wraps its async work in `at.trace(name, fn, { model, tokens, input })`:

- `tokens` enables automatic cost calculation via built-in model rates
- `model` + `provider` are stored for per-model cost breakdowns
- Nested `at.trace()` calls create a parent-child trace hierarchy

### Cost alerts

```typescript
at.registerAlert(
  alert({
    name: 'express-cost-guard',
    condition: (stats) => (stats.totalCostUsd || 0) > 5,
    cooldown: 300,
  }),
);
```

Alerts are auto-checked after each trace. Set `webhook` to receive Slack/Discord notifications.

## Inspect data

```bash
# CLI stats
npx agenttrace stats --db ./agenttrace-express.db

# Runs
npx agenttrace runs --db ./agenttrace-express.db

# Dashboard
npx agenttrace dashboard --db ./agenttrace-express.db
```

## Clean up

```bash
npm run clean
```

## Adapting for production

- Replace simulated LLM calls with real OpenAI/Anthropic/etc. SDK calls
- Set `webhook` in alert config for external notifications
- Add `maxTracesPerSecond` / `maxTracesPerMinute` for rate limiting
- Set `AGENTTRACE_DB_PATH` env var to override the DB location
- Use `at.export('otel')` to ship traces to your OTLP collector (Jaeger, Grafana Tempo, etc.)

## See also

- `../agent-usage-tracking/node-basic/` — basic Node.js agent self-tracking
- `../agent-usage-tracking/python-basic/` — Python equivalent
- See the main README for the full SDK documentation
