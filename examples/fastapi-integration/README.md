# AgentTrace + FastAPI Integration

Example showing how to integrate AgentTrace tracing into a FastAPI web application.
Every HTTP request is traced with inputs, outputs, latency, token usage, and cost.

## Quick Start

### Option A: From the monorepo (editable SDK install)

```bash
cd /path/to/agenttrace

# Install the SDK in editable mode + FastAPI deps
pip install -e packages/sdk-python
pip install fastapi uvicorn pydantic

# Run from this directory
cd examples/fastapi-integration
uvicorn app:app --reload --port 8000
```

### Option B: Public PyPI install (standalone copy)

```bash
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

### Option C: PYTHONPATH (no install)

```bash
PYTHONPATH=packages/sdk-python/src python app.py
```

## Endpoints

| Method | Path        | Description                              |
| ------ | ----------- | ---------------------------------------- |
| GET    | `/`         | Health check                             |
| POST   | `/chat`     | Traced chat endpoint (LLM simulation)    |
| POST   | `/search`   | Traced search endpoint (tool-call style) |
| GET    | `/stats`    | Aggregate trace statistics               |
| GET    | `/runs`     | List recent agent runs                   |
| GET    | `/traces`   | List traces (filter by `?run_id=...`)    |
| GET    | `/usage`    | Agent usage stats from usage tracker     |
| POST   | `/evaluate` | Run quality scorers against traces       |

Interactive API docs are available at `http://localhost:8000/docs` (Swagger UI).

## Example requests

```bash
# Chat (traced with tokens + cost)
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello agent", "model": "gpt-4o-mini"}'

# Search (context-manager style trace)
curl -X POST http://localhost:8000/search \
  -H "Content-Type: application/json" \
  -d '{"query": "agent observability", "max_results": 3}'

# View trace stats
curl http://localhost:8000/stats

# List runs
curl http://localhost:8000/runs

# List traces for a run
curl "http://localhost:8000/traces?run_id=<run-id>&limit=20"

# Run evaluation scorers
curl -X POST http://localhost:8000/evaluate
```

## What gets traced

```
Request  -->  /chat
               |
               +-- trace("llm-call")          [model, tokens, cost]
               |
               +-- trace("generate-response") [model, tokens, cost]
               |
               +-- agent_usage.track_action("chat")
```

Each `trace()` call writes a row to the SQLite DB (`./agenttrace.db`) with:

- input / output
- status (success / error)
- latency_ms
- token counts (prompt, completion, total)
- computed cost_usd
- model name
- timestamp

## Inspect the traces

```bash
# Using the AgentTrace CLI
npx agenttrace stats --db ./agenttrace.db
npx agenttrace runs --db ./agenttrace.db --limit 10
npx agenttrace export --db ./agenttrace.db --format json

# Launch the dashboard
npx agenttrace dashboard --db ./agenttrace.db
```

## Integration patterns demonstrated

1. **Function-trace pattern** -- `agent.trace("name", fn, ...)`: wraps a callable,
   records input/output/tokens/cost automatically. Best for LLM calls.

2. **Context-manager pattern** -- `with agent.trace("name") as ctx:`: manually
   set output, tokens, or metadata. Best for multi-step or conditional logic.

3. **Decorator pattern** -- `@agent.trace("name")`: works as a decorator too
   (not used here, but supported).

4. **Run grouping** -- `start_run()` / `complete_run()` groups traces under a
   logical session (mapped to HTTP request in this example).

5. **Agent usage tracker** -- `AgentUsageTracker` records high-level actions
   (chat, search, delegation, etc.) in a separate usage table for analytics.

6. **Evaluation** -- `agent.evaluate(scorers)` runs quality scorers against
   stored traces for automated assessment.

## Replacing the simulated LLM

Edit `fake_llm_call()` to call your actual provider:

```python
import openai

def fake_llm_call(message: str, model: str = "gpt-4o-mini") -> dict[str, Any]:
    client = openai.OpenAI()
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": message}],
    )
    return {
        "text": resp.choices[0].message.content,
        "prompt_tokens": resp.usage.prompt_tokens,
        "completion_tokens": resp.usage.completion_tokens,
        "model": model,
    }
```

## Configuration

The `init()` call at the top of `app.py` accepts the following options:

```python
agent = init({
    "db_path": "./agenttrace.db",   # SQLite file path
    "max_traces": 50000,            # max traces before auto-cleanup
    "auto_cleanup": True,           # enable automatic old-trace cleanup
    "silent": False,                # suppress console output
    "cost_calculator": my_fn,       # custom cost function(tokens, model) -> float
})

# Or use the class directly:
from agenttrace import AgentTrace
agent = AgentTrace({"db_path": "./my-traces.db"})
```
