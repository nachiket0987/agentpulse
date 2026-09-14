# AgentTrace + Slack Bot

A Slack bot (Bolt framework) instrumented with the AgentTrace Python SDK.
Demonstrates sync tracing on slash commands with context managers, decorators,
inline lambdas, score/evaluate, and multi-step workflows.

## Quick Start

### Socket Mode (recommended for dev)

```bash
pip install -r requirements.txt
SLACK_BOT_TOKEN=xoxb-*** SLACK_APP_TOKEN=xapp-*** SLACK_SIGNING_SECRET=*** python bot.py
```

### Flask adapter (production)

```bash
pip install -r requirements.txt flask
SLACK_BOT_TOKEN=xoxb-*** SLACK_SIGNING_SECRET=*** python bot.py
```

### Monorepo (editable SDK)

```bash
pip install -e ../../packages/sdk-python
pip install -r requirements.txt
SLACK_BOT_TOKEN=xoxb-*** SLACK_APP_TOKEN=xapp-*** SLACK_SIGNING_SECRET=*** python bot.py
```

## Slash Commands

| Command             | Tracing pattern             | What it does                                                 |
| ------------------- | --------------------------- | ------------------------------------------------------------ |
| `/ask <question>`   | Context manager             | Sends a question to an LLM, attaches tokens + metadata       |
| `/ping`             | Decorator (`@trace`)        | Wraps the inner function in a trace automatically            |
| `/stats`            | Inline lambda               | Queries and displays AgentTrace stats                        |
| `/research <topic>` | Nested context managers     | Multi-step workflow with inner traces for search + summarise |
| `/evaluate <text>`  | Context manager + `score()` | Traced LLM call with quality scoring                         |

## Interactions

| Trigger             | Tracing pattern                  | What it does                                      |
| ------------------- | -------------------------------- | ------------------------------------------------- |
| `@bot <text>`       | Context manager (lazy run start) | Fallback mention handler with traced LLM response |
| `trace_info` button | Inline lambda                    | Shows session trace count, cost, and tokens       |

## Tracing Patterns Shown

**Pattern A — Context manager** (`/ask`):

```python
with trace("ask-command", input={"question": q}, model="gpt-4o-mini") as t:
    answer = call_llm(q)
    t.set_tokens(TokenUsage(prompt_tokens=..., completion_tokens=...))
    t.set_metadata({"channel_id": command["channel_id"]})
    t.set_output(answer)
```

Best when you need to attach tokens/metadata _after_ a call completes.

**Pattern B — Decorator** (`/ping`):

```python
@trace("ping-decorator")
def _do_ping(command: dict) -> str:
    return "Pong!"
```

Cleanest for simple functions where you don't need runtime token data.

**Pattern C — Inline lambda** (`/stats`):

```python
stats = agent.trace("stats-query", lambda: agent.get_stats(), input={...})
```

Good for synchronous one-liners where the return value is the trace output.

**Pattern D — Nested workflows** (`/research`):

```python
with trace("research-workflow") as outer:
    with trace("research-search") as step1:
        ...
    with trace("research-summarise") as step2:
        ...
```

Parent trace groups child traces under one run for end-to-end visibility.

**Pattern E — Score + Evaluate** (`/evaluate`):

```python
with trace("evaluate-command", ...) as t:
    answer = call_llm(text)
    t.set_output(answer)
    s = score("relevance", 4.0, reason="...")
```

Attach quality scores to traces for evaluation dashboards.

## Run Grouping

All traces in a bot session share a run via `start_run()` / `complete_run()`.
The run is lazily started on the first slash command or bot mention.
This lets you query everything for a session with:

```python
traces = agent.get_traces(filter={"run_id": run_id})
```

## Inspect Traces

```bash
cd examples/slack-bot

# Stats summary
npx agenttrace stats --db ./agenttrace.db

# Web dashboard
npx agenttrace dashboard --db ./agenttrace.db

# JSON export
npx agenttrace export json --db ./agenttrace.db
```

## Config

| Env var                | Default           | Description                                         |
| ---------------------- | ----------------- | --------------------------------------------------- |
| `SLACK_BOT_TOKEN`      | _(required)_      | Slack bot OAuth token (`xoxb-...`)                  |
| `SLACK_SIGNING_SECRET` | _(required)_      | Slack app signing secret                            |
| `SLACK_APP_TOKEN`      | _(optional)_      | Socket Mode token (`xapp-...`); enables Socket Mode |
| `AGENTTRACE_DB_PATH`   | `./agenttrace.db` | SQLite database file                                |

## Dependencies

- `agenttrace-io` — AgentTrace Python SDK (zero cloud, local SQLite)
- `slack_bolt` — Slack Bolt for Python (app framework)
- `slack_sdk` — Slack Web API client

## Slack App Setup

1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode (recommended) and note the App-Level Token
3. Add bot scopes: `commands`, `chat:write`, `app_mentions:read`
4. Create slash commands: `/ask`, `/ping`, `/stats`, `/research`, `/evaluate`
5. Install the app to your workspace
6. Copy Bot Token, Signing Secret, and App Token into env vars
