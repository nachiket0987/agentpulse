"""
AgentTrace + Discord Bot Example
=================================

A Discord bot using `discord.py` with AgentTrace tracing on every command.
Shows async context-manager usage, decorator usage, manual token/metadata
attachment, run-level grouping, and error tracking.

Run (from this directory):
    pip install -r requirements.txt
    DISCORD_TOKEN=your_token_here python bot.py

Local dev (monorepo, editable SDK):
    pip install -e ../../packages/sdk-python
    pip install -r requirements.txt
    DISCORD_TOKEN=your_token_here python bot.py

Public install:
    pip install agenttrace-io discord.py
    DISCORD_TOKEN=your_token_here python bot.py
"""

import asyncio
import os
import random
import time
from typing import Optional

import discord
from discord.ext import commands

from agenttrace import init, trace, score, evaluate_trace, TokenUsage

# ---------------------------------------------------------------------------
# 1. Initialise AgentTrace
# ---------------------------------------------------------------------------
DB_PATH = os.environ.get("AGENTTRACE_DB_PATH", "./agenttrace.db")

agent = init(
    db_path=DB_PATH,
    max_traces=50_000,
    auto_cleanup=True,
)

# ---------------------------------------------------------------------------
# 2. Bot setup
# ---------------------------------------------------------------------------
intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(command_prefix="!", intents=intents)

# Track the current run id so all traces in a session share a run
_current_run_id: Optional[str] = None


@bot.event
async def on_ready() -> None:
    """Called when the bot connects to Discord."""
    global _current_run_id
    _current_run_id = agent.start_run(
        "discord-bot-session",
        metadata={"bot_user": str(bot.user), "guild_count": len(bot.guilds)},
    )
    print(f"Bot online as {bot.user}  |  run_id={_current_run_id}")
    print(f"AgentTrace DB: {DB_PATH}")


# ---------------------------------------------------------------------------
# 3. Helper – simulate LLM call (replace with your real provider)
# ---------------------------------------------------------------------------
async def call_llm(prompt: str, model: str = "gpt-4o-mini") -> str:
    """Placeholder for an actual LLM API call."""
    # Replace this with your real provider (openai, anthropic, etc.)
    await asyncio.sleep(0.05)  # simulate latency
    return f"[LLM response to: {prompt[:60]}...]"


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars per token)."""
    return max(len(text) // 4, 1)


# ---------------------------------------------------------------------------
# 4. Traced commands – three different tracing patterns
# ---------------------------------------------------------------------------

# ----- Pattern A: async context manager (most flexible) -----
@bot.command(name="ask")
async def ask_command(ctx: commands.Context, *, question: str) -> None:
    """
    !ask <question>  –  Send a question to the LLM, trace the full round-trip.
    Uses the async context-manager form so we can attach tokens & metadata
    after the LLM responds.
    """
    async with trace(
        "ask-command",
        input={"question": question, "user": str(ctx.author)},
        model="gpt-4o-mini",
    ) as t:
        # Simulate LLM call
        answer = await call_llm(question)

        # Attach token usage (simulated)
        prompt_tokens = estimate_tokens(question)
        completion_tokens = estimate_tokens(answer)
        t.set_tokens(TokenUsage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
            model="gpt-4o-mini",
            provider="openai",
        ))

        # Attach extra metadata
        t.set_metadata({
            "channel_id": ctx.channel.id,
            "guild_id": ctx.guild.id if ctx.guild else None,
            "command": "ask",
        })

        t.set_output(answer)
        await ctx.send(answer)


# ----- Pattern B: decorator (cleanest for simple wrappers) -----
@trace("ping-decorator")
@bot.command(name="ping")
async def ping_command(ctx: commands.Context) -> None:
    """
    !ping  –  Check bot latency.
    Uses the decorator form – the entire function body is traced automatically.
    """
    latency_ms = round(bot.latency * 1000, 1)
    await ctx.send(f"Pong!  Latency: {latency_ms}ms")


# ----- Pattern C: synchronous-style trace with lambda (inline) -----
@bot.command(name="stats")
async def stats_command(ctx: commands.Context) -> None:
    """
    !stats  –  Show AgentTrace stats for this session.
    Uses the inline-lambda form to synchronously capture a value.
    """
    stats = agent.trace(
        "stats-query",
        lambda: agent.get_stats(),
        input={"command": "stats"},
    )

    lines = [
        "**AgentTrace Stats**",
        f"Total traces: {stats.total_traces}",
        f"Success rate: {stats.success_rate:.1%}",
        f"Avg latency:  {stats.avg_latency_ms:.1f} ms",
        f"Total cost:   ${stats.total_cost_usd:.6f}",
        f"Total tokens: {stats.total_tokens}",
    ]
    await ctx.send("\n".join(lines))


# ----- Pattern D: trace a multi-step workflow -----
@bot.command(name="research")
async def research_command(ctx: commands.Context, *, topic: str) -> None:
    """
    !research <topic>  –  Multi-step research workflow.
    Demonstrates nested tracing: an outer trace wraps inner LLM calls.
    """
    async with trace(
        "research-workflow",
        input={"topic": topic, "user": str(ctx.author)},
    ) as outer:
        # Step 1 – search
        async with trace("research-search", input={"topic": topic}) as t1:
            search_results = await call_llm(f"Search for: {topic}")
            t1.set_tokens(TokenUsage(
                prompt_tokens=estimate_tokens(topic),
                completion_tokens=estimate_tokens(search_results),
                total_tokens=estimate_tokens(topic + search_results),
                model="gpt-4o-mini",
            ))
            t1.set_output(search_results[:200])

        # Step 2 – summarise
        async with trace("research-summarise", input={"results": search_results}) as t2:
            summary = await call_llm(f"Summarise: {search_results}")
            t2.set_tokens(TokenUsage(
                prompt_tokens=estimate_tokens(search_results),
                completion_tokens=estimate_tokens(summary),
                total_tokens=estimate_tokens(search_results + summary),
                model="gpt-4o-mini",
            ))
            t2.set_output(summary[:200])

        outer.set_output({"search": search_results[:100], "summary": summary[:100]})
        outer.set_metadata({"topic": topic, "steps": 2})

        await ctx.send(f"**Research on '{topic}'**\n{summary}")


# ---------------------------------------------------------------------------
# 5. Error tracking – trace errors and failures
# -----------------------------------------------------------------------------

@bot.command(name="flaky")
async def flaky_command(ctx: commands.Context) -> None:
    """
    !flaky  –  Simulates a command that sometimes fails.
    Demonstrates error tracing: exceptions are captured in the trace
    with status="error" and the error message attached.
    """
    async with trace(
        "flaky-command",
        input={"user": str(ctx.author)},
    ) as t:
        t.set_metadata({
            "channel_id": ctx.channel.id,
            "command": "flaky",
        })

        # Simulate intermittent failure (50% chance)
        if random.random() < 0.5:
            raise RuntimeError("Simulated intermittent failure – provider timeout")

        t.set_output("Success! This time it worked.")
        await ctx.send("Operation succeeded!")


@bot.command(name="fail")
async def fail_command(ctx: commands.Context, *, input_text: str = "") -> None:
    """
    !fail [text]  –  Always fails. Demonstrates error capture + scoring.
    The trace records the error, then we score the failure for quality tracking.
    """
    async with trace(
        "fail-command",
        input={"text": input_text, "user": str(ctx.author)},
        model="gpt-4o-mini",
    ) as t:
        t.set_metadata({
            "channel_id": ctx.channel.id,
            "command": "fail",
        })

        # Simulate a provider error
        error_msg = "ProviderError: rate limit exceeded (429)"
        t.set_output(None)
        await ctx.send(f"Command failed: {error_msg}")
        raise Exception(error_msg)


@bot.command(name="errors")
async def errors_command(ctx: commands.Context) -> None:
    """
    !errors  –  Query and display recent error traces.
    Demonstrates filtering traces by status to surface failures.
    """
    error_traces = agent.trace(
        "error-query",
        lambda: agent.get_traces(filter={"status": ["error"], "limit": 10}),
        input={"command": "errors"},
    )

    if not error_traces:
        await ctx.send("No error traces recorded yet. Try `!flaky` or `!fail` first.")
        return

    lines = ["**Recent Error Traces**", "```"]
    for tr in error_traces:
        error_msg = tr.error or "(no error message)"
        lines.append(f"  [{tr.name}] {error_msg[:80]}")
    lines.append("```")

    # Also show error rate from stats
    stats = agent.get_stats()
    error_count = len(agent.get_traces(filter={"status": ["error"]}))
    lines.append(f"\nTotal errors: {error_count}  |  Success rate: {stats.success_rate:.1%}")

    await ctx.send("\n".join(lines))


# ---------------------------------------------------------------------------
# 6. Global error handler – trace unhandled command errors
# -----------------------------------------------------------------------------

@bot.event
async def on_command_error(ctx: commands.Context, error: commands.CommandError) -> None:
    """
    Global error handler that traces any unhandled command errors.
    This ensures even unexpected failures are recorded in AgentTrace.
    """
    error_name = type(error).__name__
    error_msg = str(error)

    # Trace the error
    agent.trace(
        "unhandled-command-error",
        lambda: None,  # no return value – we just want the error recorded
        input={
            "command": ctx.command.name if ctx.command else "unknown",
            "user": str(ctx.author),
            "error_type": error_name,
            "error_message": error_msg,
        },
    )

    # Send user-friendly message
    if isinstance(error, commands.CommandNotFound):
        await ctx.send(f"Unknown command. Type `!help` for available commands.")
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.send(f"Missing required argument: `{error.param.name}`")
    elif isinstance(error, commands.CommandInvokeError):
        await ctx.send(f"Command failed: {error_msg[:200]}")
    else:
        await ctx.send(f"Error ({error_name}): {error_msg[:200]}")


# ---------------------------------------------------------------------------
# 7. Graceful shutdown
# ---------------------------------------------------------------------------

async def shutdown() -> None:
    """Complete the run and close the agent."""
    global _current_run_id
    if _current_run_id:
        agent.complete_run("success")
    agent.close()
    print("AgentTrace session closed.")


# ---------------------------------------------------------------------------
# 8. Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    token = os.environ.get("DISCORD_TOKEN")
    if not token:
        print("ERROR: Set the DISCORD_TOKEN environment variable.")
        print("  DISCORD_TOKEN=your_token python bot.py")
        raise SystemExit(1)

    try:
        bot.run(token)
    except KeyboardInterrupt:
        pass
    finally:
        # discord.py doesn't give us an easy async shutdown hook without
        # restructuring into a cog, so we run the cleanup in a new loop.
        loop = asyncio.new_event_loop()
        loop.run_until_complete(shutdown())
        loop.close()


if __name__ == "__main__":
    main()
