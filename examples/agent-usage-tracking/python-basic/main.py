"""
AgentTrace Python Basic Example

An AI agent using agenttrace-io to:
- trace its own steps
- record high-level usage/actions with costs
- set up simple cost guard (via stats)
- self-query get_usage_stats / get_agent_usage / get_cost_breakdown

Run (from this directory, after editable install of the sdk):
    pip install -e ../../../../packages/sdk-python
    python main.py

Or with PYTHONPATH from repo root:
    PYTHONPATH=packages/sdk-python/src python examples/agent-usage-tracking/python-basic/main.py

Public install:
    pip install agenttrace-io
    python main.py   # (after copying this file)
"""

import os
import time
from agenttrace import init, trace


def main() -> None:
    db_path = os.environ.get("AGENTTRACE_DB_PATH", "./agenttrace.db")
    agent = init(db_path=db_path)

    print("=== AgentTrace Python Basic Example ===")
    print("DB:", db_path)

    run_id = agent.start_run("python-agent-self-demo", {"agentName": "demo-py-agent"})

    try:
        # Trace nested workflow with explicit tokens (simulated LLM calls)
        def do_research(q: str):
            time.sleep(0.02)
            return ["fact-A: growth in observability", "fact-B: local-first wins"]

        facts = agent.trace(
            "research",
            lambda: do_research("agent observability"),
            input={"query": "agent observability"},
            model="gpt-4o-mini",
            tokens={"prompt_tokens": 150, "completion_tokens": 80, "total_tokens": 230},
        )

        def do_synthesize(facts_list):
            time.sleep(0.015)
            return "Key insight: agents benefit enormously from self-tracing."

        answer = agent.trace(
            "synthesize",
            lambda: do_synthesize(facts),
            input={"facts": len(facts)},
            model="claude-sonnet-4",
            tokens={"prompt_tokens": 280, "completion_tokens": 70, "total_tokens": 350},
        )

        print("Workflow answer:", answer)

        # Record agent-level actions (self usage tracking)
        now_ms = int(time.time() * 1000)
        agent.record_agent_usage({
            "id": None,  # will be generated
            "agent_name": "demo-py-agent",
            "agent_type": "researcher",
            "session_id": run_id,
            "action": "web_research",
            "target": "agent observability",
            "tokens_used": 230,
            "cost_usd": 0.0006,
            "duration_ms": 25,
            "status": "success",
            "metadata": {"phase": "research"},
            "created_at": now_ms,
        })

        agent.record_agent_usage({
            "agent_name": "demo-py-agent",
            "agent_type": "researcher",
            "session_id": run_id,
            "action": "synthesize",
            "target": "final-answer",
            "tokens_used": 350,
            "cost_usd": 0.0053,
            "duration_ms": 20,
            "status": "success",
            "metadata": {"phase": "write"},
            "created_at": now_ms + 30,
        })

        # Simple "alert" style guard using stats (full register_alert in progress for py)
        stats = agent.get_stats()
        if stats.total_cost_usd > 10.0:
            print("!!! ALERT: runaway cost detected (demo threshold)")
        else:
            print("Cost within bounds (demo alert check passed)")

        # Self-query everything
        print("\n--- Trace Stats ---")
        print("total_traces:", stats.total_traces)
        print("total_cost_usd:", round(stats.total_cost_usd, 6))
        print("success_rate:", stats.success_rate)

        usage = agent.get_usage_stats()
        print("\n--- Usage Stats (from agent_usage table) ---")
        print("total_actions:", usage.total_actions)
        print("total_agents:", usage.total_agents)
        print("actions_by_type:", usage.actions_by_type)
        print("top_agents:", usage.top_agents)

        my_actions = agent.get_agent_usage({"agent_name": "demo-py-agent"})
        print("\n--- Filtered agent usage records ---")
        print("count:", len(my_actions))
        if my_actions:
            print("sample action:", my_actions[0].action, "cost:", my_actions[0].cost_usd)

        breakdown = agent.get_cost_breakdown(run_id)
        print("\n--- Cost Breakdown (run) ---")
        print("total:", round(breakdown.total_cost_usd, 6))
        print("by_model:", breakdown.cost_by_model)

        agent.complete_run("success")

    except Exception as e:
        print("Error in workflow:", e)
        agent.complete_run("error")
    finally:
        agent.close()
        print("\n=== Done. Inspect with CLI or dashboard ===")
        print("npx agenttrace stats --db", db_path)
        print("npx agenttrace dashboard --db", db_path)


if __name__ == "__main__":
    main()
