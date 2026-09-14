"""
AgentTrace + Slack Bot Example
==============================

A Slack bot using the Bolt framework (slack_bolt) with AgentTrace tracing
on every command. Shows async context-manager usage, decorator usage,
manual token/metadata attachment, and run-level grouping.

Run (from this directory):
    pip install -r requirements.txt
    SLACK_BOT_TOKEN=xoxb-*** SLACK_SIGNING_SECRET=*** python bot.py

Local dev (monorepo, editable SDK):
    pip install -e ../../packages/sdk-python
    pip install -r requirements.txt
    SLACK_BOT_TOKEN=xoxb-*** SLACK_SIGNING_SECRET=*** python bot.py

Public install:
    pip install agenttrace-io slack_bolt slack_sdk
    SLACK_BOT_TOKEN=xoxb-*** SLACK_SIGNING_SECRET=*** python bot.py
"""

import os
import time
from typing import Optional

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from slack_sdk import WebClient

from agenttrace import init, trace, TokenUsage

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
# 2. Bolt app setup
# ---------------------------------------------------------------------------
app = App(
    token=os.environ.get("SLACK_BOT_TOKEN"),
    signing_secret=os.environ.get("SLACK_SIGNING_SECRET"),
)

# Track the current run id so all traces in a session share a run
_current_run_id: Optional[str] = None


# ---------------------------------------------------------------------------
# 3. Helper – simulate LLM call (replace with your real provider)
# ---------------------------------------------------------------------------
def call_llm(prompt: str, model: str = "gpt-4o-mini") -> str:
    """Placeholder for an actual LLM API call."""
    # Replace this with your real provider (openai, anthropic, etc.)
    time.sleep(0.05)  # simulate latency
    return f"[LLM response to: {prompt[:60]}...]"


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars per token)."""
    return max(len(text) // 4, 1)


# ---------------------------------------------------------------------------
# 4. App startup – start a run
# ---------------------------------------------------------------------------
@app.event("app_mention")
def handle_app_mention(event: dict, say: callable) -> None:
    """
    Fallback: any @mention that isn't a recognised subcommand gets a
    traced response. Also serves as the startup hook the first time
    the bot is mentioned (we lazily start the run here).
    """
    global _current_run_id
    if _current_run_id is None:
        _current_run_id = agent.start_run(
            "slack-bot-session",
            metadata={"bot_user": event.get("bot_id", "unknown")},
        )
        print(f"AgentTrace run started  |  run_id={_current_run_id}")
        print(f"AgentTrace DB: {DB_PATH}")

    text = event.get("text", "").strip()
    # Strip the bot mention prefix e.g. "<@U12345>"
    import re
    text = re.sub(r"^<@U\w+>\s*", "", text)

    with trace(
        "mention-fallback",
        input={"text": text, "user": event.get("user", "unknown")},
    ) as t:
        answer = call_llm(text)
        prompt_toks = estimate_tokens(text)
        completion_toks = estimate_tokens(answer)
        t.set_tokens(TokenUsage(
            prompt_tokens=prompt_toks,
            completion_tokens=completion_toks,
            total_tokens=prompt_toks + completion_toks,
            model="gpt-4o-mini",
            provider="openai",
        ))
        t.set_output(answer)
        say(answer)


# ---------------------------------------------------------------------------
# 5. Traced slash commands – three different tracing patterns
# ---------------------------------------------------------------------------

# ----- Pattern A: context manager (most flexible) -----
@app.command("/ask")
def handle_ask_command(ack: callable, command: dict, say: callable) -> None:
    """
    /ask <question>  –  Send a question to the LLM, trace the full round-trip.
    Uses the context-manager form so we can attach tokens & metadata
    after the LLM responds.
    """
    ack()

    global _current_run_id
    if _current_run_id is None:
        _current_run_id = agent.start_run(
            "slack-bot-session",
            metadata={"trigger": "slash-ask"},
        )

    question = command.get("text", "")

    with trace(
        "ask-command",
        input={"question": question, "user_id": command.get("user_id", "")},
        model="gpt-4o-mini",
    ) as t:
        answer = call_llm(question)

        prompt_tokens = estimate_tokens(question)
        completion_tokens = estimate_tokens(answer)
        t.set_tokens(TokenUsage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
            model="gpt-4o-mini",
            provider="openai",
        ))

        t.set_metadata({
            "channel_id": command.get("channel_id"),
            "team_id": command.get("team_id"),
            "command": "/ask",
        })

        t.set_output(answer)
        say(answer)


# ----- Pattern B: decorator (cleanest for simple wrappers) -----
@trace("ping-decorator")
def _do_ping(command: dict) -> str:
    """Inner function traced by decorator; outer handler calls it."""
    return "Pong! AgentTrace is watching."


@app.command("/ping")
def handle_ping_command(ack: callable, command: dict, say: callable) -> None:
    """/ping  –  Check that the bot is alive. Uses the decorator trace pattern."""
    ack()
    result = _do_ping(command)
    say(result)


# ----- Pattern C: inline lambda (synchronous one-liner) -----
@app.command("/stats")
def handle_stats_command(ack: callable, command: dict, say: callable) -> None:
    """
    /stats  –  Show AgentTrace stats for this session.
    Uses the inline-lambda form to synchronously capture a value.
    """
    ack()

    stats = agent.trace(
        "stats-query",
        lambda: agent.get_stats(),
        input={"command": "/stats"},
    )

    lines = [
        "*AgentTrace Stats*",
        f"Total traces: {stats.total_traces}",
        f"Success rate: {stats.success_rate:.1%}",
        f"Avg latency:  {stats.avg_latency_ms:.1f} ms",
        f"Total cost:   ${stats.total_cost_usd:.6f}",
        f"Total tokens: {stats.total_tokens}",
    ]
    say("\n".join(lines))


# ----- Pattern D: trace a multi-step workflow -----
@app.command("/research")
def handle_research_command(ack: callable, command: dict, say: callable) -> None:
    """
    /research <topic>  –  Multi-step research workflow.
    Demonstrates nested tracing: an outer trace wraps inner LLM calls.
    """
    ack()

    topic = command.get("text", "")

    with trace(
        "research-workflow",
        input={"topic": topic, "user_id": command.get("user_id", "")},
    ) as outer:
        # Step 1 – search
        with trace("research-search", input={"topic": topic}) as t1:
            search_results = call_llm(f"Search for: {topic}")
            t1.set_tokens(TokenUsage(
                prompt_tokens=estimate_tokens(topic),
                completion_tokens=estimate_tokens(search_results),
                total_tokens=estimate_tokens(topic + search_results),
                model="gpt-4o-mini",
            ))
            t1.set_output(search_results[:200])

        # Step 2 – summarise
        with trace("research-summarise", input={"results": search_results}) as t2:
            summary = call_llm(f"Summarise: {search_results}")
            t2.set_tokens(TokenUsage(
                prompt_tokens=estimate_tokens(search_results),
                completion_tokens=estimate_tokens(summary),
                total_tokens=estimate_tokens(search_results + summary),
                model="gpt-4o-mini",
            ))
            t2.set_output(summary[:200])

        outer.set_output({"search": search_results[:100], "summary": summary[:100]})
        outer.set_metadata({"topic": topic, "steps": 2})

        say(f"*Research on '{topic}'*\n{summary}")


# ----- Pattern E: score + evaluate on a trace -----
@app.command("/evaluate")
def handle_evaluate_command(ack: callable, command: dict, say: callable) -> None:
    """
    /evaluate <text>  –  Run a traced LLM call and score the result.
    Demonstrates the `score()` + `evaluate_trace()` API for quality tracking.
    """
    ack()

    from agenttrace import score, evaluate_trace

    text = command.get("text", "")

    with trace(
        "evaluate-command",
        input={"text": text, "user_id": command.get("user_id", "")},
        model="gpt-4o-mini",
    ) as t:
        answer = call_llm(text)

        prompt_tokens = estimate_tokens(text)
        completion_tokens = estimate_tokens(answer)
        t.set_tokens(TokenUsage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
            model="gpt-4o-mini",
            provider="openai",
        ))
        t.set_output(answer)

        # Score the output on a 1-5 scale (replace with real criteria)
        s = score(
            "relevance",
            4.0,
            reason="Simulated score — replace with your real evaluator.",
        )

    say(f"Answer: {answer}\nScore: {s.name}={s.score} ({s.reason})")


# ---------------------------------------------------------------------------
# 6. Message shortcut (button) example
# ---------------------------------------------------------------------------
@app.action("trace_info")
def handle_trace_info(ack: callable, body: dict, say: callable) -> None:
    """Button action: show trace session info."""
    ack()

    stats = agent.trace(
        "trace-info-action",
        lambda: agent.get_stats(),
        input={"action": "trace_info", "user": body.get("user", {}).get("id", "")},
    )

    say(
        f"*Session Info* (run `{_current_run_id}`)\n"
        f"Traces so far: {stats.total_traces}  |  "
        f"Cost: ${stats.total_cost_usd:.6f}  |  "
        f"Tokens: {stats.total_tokens}"
    )


# ---------------------------------------------------------------------------
# 7. Graceful shutdown
# ---------------------------------------------------------------------------
def shutdown() -> None:
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
    bot_token = os.environ.get("SLACK_BOT_TOKEN")
    app_token = os.environ.get("SLACK_APP_TOKEN")  # for Socket Mode

    if not bot_token:
        print("ERROR: Set the SLACK_BOT_TOKEN environment variable.")
        print("  SLACK_BOT_TOKEN=xoxb-*** SLACK_SIGNING_SECRET=*** python bot.py")
        raise SystemExit(1)

    try:
        if app_token:
            # Socket Mode – no public URL needed
            handler = SocketModeHandler(app, app_token)
            print("Starting Slack bot in Socket Mode...")
            handler.start()
        else:
            # OAuth / express adapter – for production deployments
            # You'd typically do: app.start(port=3000)
            # See slack_bolt docs for your preferred adapter.
            from slack_bolt.adapter.flask import SlackRequestHandler
            from flask import Flask, request

            flask_app = Flask(__name__)
            handler = SlackRequestHandler(app)

            @flask_app.route("/slack/events", methods=["POST"])
            def slack_events():
                return handler.handle(request)

            print("Starting Slack bot in Flask mode on :3000...")
            flask_app.run(port=3000)
    except KeyboardInterrupt:
        pass
    finally:
        shutdown()


if __name__ == "__main__":
    main()
