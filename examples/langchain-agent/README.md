# AgentTrace + LangChain Agent Example

Full LangChain ReAct agent with AgentTrace observability middleware.

## What it demonstrates

- Building a LangChain `AgentExecutor` with custom tools (calculator, search, weather)
- Wrapping the agent with AgentTrace via a `TracedAgent` middleware class
- Three tracing styles:
  - `agent.trace()` lambda wrapper for one-shot traces
  - `with agent.trace() as ctx:` context manager for multi-step spans
  - `agent.trace()` as function decorator (shown in patterns)
- Run management (`start_run` / `complete_run`) for grouping traces
- Post-run querying: stats, cost breakdown, trace listing
- Evaluation with `Scorer` functions against recorded traces
- Cost tracking across models (`gpt-4o-mini`, `gpt-4o`)

## Setup

```bash
pip install -r requirements.txt
export OPENAI_API_KEY=sk-...
python agent.py
```

For local SDK development (instead of published `agenttrace-io`):

```bash
pip install -e ../../packages/sdk-python
pip install langchain langchain-openai langchain-core
export OPENAI_API_KEY=sk-...
python agent.py
```

## Run

```bash
python agent.py
```

Example output:

```
=== AgentTrace + LangChain Agent Example ===

[Run 1] Simple math question
  Answer : 726
  Latency: 2341 ms

[Run 2] Weather + search
  Answer : Tokyo: sunny, 28C. Top attractions include...
  Latency: 4102 ms

--- Trace Stats ---
  Total runs   : 3
  Total traces : 3
  Success rate : 100.0%
  Avg latency  : 3214 ms
  Total cost   : $0.003420
  Total tokens : 2840
```

## View traces

```bash
npx agenttrace dashboard --db ./agenttrace.db
# Open http://localhost:3000
```

## Architecture

```
User Input
    |
    v
TracedAgent.invoke_traced()
    |-- agent.trace("langchain-agent")   <-- outer span
    |       |
    |       v
    |   AgentExecutor.invoke()
    |       |-- LLM calls (OpenAI)
    |       |-- Tool executions
    |       |     |-- calculator
    |       |     |-- search_web
    |       |     |-- get_weather
    |       |-- Intermediate steps
    |
    |-- agent.get_stats()
    |-- agent.evaluate([Scorers])
```

## AgentTrace API used

| API                               | Usage                                          |
| --------------------------------- | ---------------------------------------------- |
| `init(config)`                    | Global AgentTrace instance with SQLite backend |
| `agent.start_run(name, metadata)` | Begin a logical run (groups traces)            |
| `agent.complete_run(status)`      | Mark run as success/error                      |
| `agent.trace(name, fn, **opts)`   | Trace a callable (lambda wrapper)              |
| `agent.trace(name) as ctx`        | Context manager for manual output/tokens       |
| `agent.get_stats()`               | Aggregate statistics                           |
| `agent.get_cost_breakdown()`      | Cost by model and by day                       |
| `agent.get_traces(filter)`        | Query traces with filters                      |
| `agent.evaluate(scorers)`         | Run scorers against stored traces              |

## Tools defined

| Tool          | Description                                           |
| ------------- | ----------------------------------------------------- |
| `calculator`  | Safe math evaluator (uses `math` module, no builtins) |
| `search_web`  | Simulated web search (returns mock results)           |
| `get_weather` | Simulated weather lookup (deterministic per city)     |

## Related examples

- `../langgraph/README.md` -- LangGraph-specific tracing with `@agenttrace-io/middleware-langgraph`
- `../custom/README.md` -- Custom agent tracing patterns
- `../fastapi-integration/` -- FastAPI HTTP server with AgentTrace
- `../agent-usage-tracking/langchain-integration/` -- Simulated LangChain pattern (no real LangChain)
