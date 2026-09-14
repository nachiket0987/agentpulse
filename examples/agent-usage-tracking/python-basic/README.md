# Python Basic - AgentTrace Self-Usage Tracking

Python example of an agent using `agenttrace-io` to trace its steps, record self-usage via the `agent_usage` table, guard costs, and query its own stats.

## Install (public)

```bash
pip install agenttrace-io
python main.py
```

## Local development / monorepo

```bash
pip install -e ../../../../packages/sdk-python
python main.py
```

Or:

```bash
PYTHONPATH=packages/sdk-python/src python examples/agent-usage-tracking/python-basic/main.py
```

## What it shows

- `init()` + `trace()` (function, and you can also use decorator / context manager forms)
- Explicit `model` + `tokens=...` (snake_case in Python) for accurate costing
- `record_agent_usage()` for high-level actions the agent performed
- `get_usage_stats()`, `get_agent_usage()`, `get_cost_breakdown()`, `get_stats()`
- Run grouping with `start_run` / `complete_run`
- Simple runtime cost guard (Python full alert registration coming soon)

## Run output highlights

You will see trace stats, usage aggregates, filtered records, and per-run cost breakdown.

## Inspect

```bash
npx agenttrace stats --db ./agenttrace.db
npx agenttrace dashboard --db ./agenttrace.db
```

See the sibling `node-basic/` for the TypeScript version. See the main README for the full guide.
