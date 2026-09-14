# AgentTrace + Discord Bot

A Discord bot (`discord.py`) instrumented with the AgentTrace Python SDK.
Demonstrates async tracing on commands with context managers, decorators,
inline lambdas, and multi-step workflows.

## Quick Start

```bash
pip install -r requirements.txt
DISCORD_TOKEN=*** python bot.py
```

### Monorepo (editable SDK)

```bash
pip install -e ../../packages/sdk-python
pip install -r requirements.txt
DISCORD_TOKEN=*** python bot.py
```

## Commands

| Command             | Tracing pattern         | What it does                                                 |
| ------------------- | ----------------------- | ------------------------------------------------------------ |
| `!ask <question>`   | Async context manager   | Sends a question to an LLM, attaches tokens + metadata       |
| `!ping`             | Decorator (`@trace`)    | Wraps the entire command in a trace automatically            |
| `!stats`            | Inline lambda           | Queries and displays AgentTrace stats                        |
| `!research <topic>` | Nested context managers | Multi-step workflow with inner traces for search + summarise |

## Tracing Patterns Shown

**Pattern A — Async context manager** (`!ask`):

```python
async with trace("ask-command", input={"question": q}, model="gpt-4o-mini") as t:
    answer = await call_llm(q)
    t.set_tokens(TokenUsage(prompt_tokens=..., completion_tokens=...))
    t.set_metadata({"channel_id": ctx.channel.id})
    t.set_output(answer)
```

Best when you need to attach tokens/metadata _after_ an async call completes.

**Pattern B — Decorator** (`!ping`):

```python
@trace("ping-decorator")
@bot.command(name="ping")
async def ping_command(ctx):
    ...
```

Cleanest for simple commands where you don't need runtime token data.

**Pattern C — Inline lambda** (`!stats`):

```python
stats = agent.trace("stats-query", lambda: agent.get_stats(), input={...})
```

Good for synchronous one-liners where the return value is the trace output.

**Pattern D — Nested workflows** (`!research`):

```python
async with trace("research-workflow") as outer:
    async with trace("research-search") as step1:
        ...
    async with trace("research-summarise") as step2:
        ...
```

Parent trace groups child traces under one run for end-to-end visibility.

## Run Grouping

All traces in a bot session share a run via `start_run()` / `complete_run()`.
This lets you query everything for a session with:

```python
traces = agent.get_traces(filter={"run_id": run_id})
```

## Inspect Traces

```bash
cd examples/discord-bot

# Stats summary
npx agenttrace stats --db ./agenttrace.db

# Web dashboard
npx agenttrace dashboard --db ./agenttrace.db

# JSON export
npx agenttrace export json --db ./agenttrace.db
```

## Config

| Env var              | Default           | Description          |
| -------------------- | ----------------- | -------------------- |
| `DISCORD_TOKEN`      | _(required)_      | Discord bot token    |
| `AGENTTRACE_DB_PATH` | `./agenttrace.db` | SQLite database file |

## Dependencies

- `agenttrace-io` — AgentTrace Python SDK (async support, zero cloud)
- `discord.py` — Discord API wrapper
