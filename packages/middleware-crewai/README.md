# agenttrace-io-middleware-crewai

CrewAI middleware for AgentTrace. Automatically traces task execution and tool usage by hooking into CrewAI's event system. Extracts token usage from CrewAI's built-in tracking (usage / token_usage on events).

## Installation

```bash
pip install agenttrace-io-middleware-crewai
# Requires: crewai (for auto event hooks) + agenttrace-io (pulled in automatically)
pip install crewai
```

The package depends on `agenttrace-io` (the core Python SDK).

## Usage

```python
from agenttrace_middleware import AgentTraceCrewAI
from crewai import Agent, Task, Crew

mw = AgentTraceCrewAI(db_path="./traces.db")

# (optional) start a named run for grouping
mw.get_agent_trace().start_run("my-crew-run-1")

researcher = Agent(
    role="Researcher",
    goal="Research topics thoroughly",
    backstory="You are an expert researcher.",
    verbose=True,
)

task = Task(
    description="Research the latest in AI observability",
    agent=researcher,
    expected_output="Bullet list of key tools and techniques",
)

crew = Crew(agents=[researcher], tasks=[task])

result = crew.kickoff()

print(result)
mw.close()
```

The middleware subscribes (when `crewai` is importable) to:

- TaskStartedEvent / TaskCompletedEvent / TaskFailedEvent → traces named `task:<name>`
- ToolUsageStartedEvent / ToolUsageFinishedEvent → traces named `tool:<name>`

## Manual / direct hook usage

If auto-subscription doesn't fit your setup, call the hooks yourself:

```python
mw.on_task_start(source, task_started_event)
# ... run ...
mw.on_task_end(source, task_completed_event)
```

Events are duck-typed; any object with `.task_id`, `.name`, `.output`, `.usage` etc. works.

## Token extraction

Tokens are pulled from common locations CrewAI surfaces:

- `event.usage`, `event.token_usage`, `event.tokens`, `event.usage_metrics`
- Nested in `event.output.usage` etc.
- Supports both snake_case and camelCase, and our `TokenUsage` shape.

Cost and latency are computed using the core AgentTrace defaults.

## Config

```python
mw = AgentTraceCrewAI(db_path="./prod-traces.db")
```

(Internally passes through to `AgentTrace`.)

## Viewing traces

```bash
npx agenttrace dashboard --db ./traces.db
```

## License

MIT
