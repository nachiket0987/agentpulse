"""
CrewAI Integration Example for AgentTrace

Shows two ways:
1. Using the official middleware (recommended when you have crewai installed)
2. Manual tracing + record_agent_usage when you want full control

This file runs with only agenttrace-io. The middleware path is shown in comments.

Install for real middleware usage:
    pip install agenttrace-io-middleware-crewai crewai

Run this demo:
    pip install -e ../../../../packages/sdk-python
    python example.py
"""

import time
from agenttrace import init


def simulate_crewai_task(name: str, description: str, mw_or_at: Any = None) -> str:
    """Pretend a CrewAI task ran. In reality the middleware hooks TaskStartedEvent etc."""
    time.sleep(0.02)
    return f"Task[{name}] completed: {description[:30]}..."


def main() -> None:
    print("=== CrewAI + AgentTrace Integration Example ===")

    # --- Path A: Recommended when using the middleware ---
    # from agenttrace_middleware import AgentTraceCrewAI
    # mw = AgentTraceCrewAI(db_path="./traces.db")
    # mw.get_agent_trace().start_run("crew-demo")
    #
    # # Define real CrewAI agents/tasks...
    # researcher = Agent(role=..., goal=...)
    # ...
    # crew = Crew(agents=[researcher], tasks=[task])
    # result = crew.kickoff()
    # mw.close()

    # --- Path B: Manual / no-crewai-installed demo (what this file executes) ---
    at = init(db_path="./traces.db")
    run_id = at.start_run("crewai-manual-demo", {"framework": "crewai", "mode": "manual-demo"})

    # Simulate what the middleware would trace automatically
    # (the real middleware subscribes to TaskStarted / ToolUsage etc. and extracts usage)

    def research_task():
        # In real CrewAI the event would carry .usage or .token_usage
        return simulate_crewai_task("research", "Research latest agent observability tools")

    # Use the core trace API (or context manager) around the kickoff or individual tasks
    research_result = at.trace(
        "task:research",
        research_task,
        input={"description": "Research latest..."},
        # Middleware normally populates this from CrewAI's usage dicts
        tokens={"prompt_tokens": 420, "completion_tokens": 180, "total_tokens": 600, "model": "gpt-4o"},
    )

    def writer_task(research: str):
        return simulate_crewai_task("write", "Write summary from research: " + research[:20])

    final = at.trace(
        "task:write",
        lambda: writer_task(research_result),
        input={"research_len": len(research_result)},
        tokens={"prompt_tokens": 310, "completion_tokens": 95, "total_tokens": 405, "model": "claude-sonnet-4"},
    )

    print("Crew result (sim):", final[:70])

    # Agents can also record their own higher-level actions (the "crew" as a whole)
    at.record_agent_usage({
        "agent_name": "crewai-observability-crew",
        "agent_type": "crewai",
        "session_id": run_id,
        "action": "crew_kickoff",
        "tokens_used": 600 + 405,
        "cost_usd": 0.0095,
        "duration_ms": 80,
        "status": "success",
        "metadata": {"tasks": 2, "framework": "crewai"},
    })

    # Self-query
    print("\n--- After simulated CrewAI run ---")
    print("traces:", at.get_stats().total_traces)
    u = at.get_usage_stats()
    print("agent_usage actions:", u.total_actions, "by:", list(u.actions_by_type.keys()))
    print("costs for run:", at.get_cost_breakdown(run_id).total_cost_usd)

    at.complete_run("success")
    at.close()

    print("\nTip: install agenttrace-io-middleware-crewai + crewai for automatic event hooking.")
    print("Dashboard: npx agenttrace dashboard --db ./agenttrace.db")


if __name__ == "__main__":
    # mypy / import guard for the comment
    from typing import Any  # noqa: F401
    main()
