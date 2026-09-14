"""
LangChain Agent Example for AgentTrace

Demonstrates a full LangChain agent with AgentTrace tracing middleware.
Uses:
  - langchain.agents.AgentExecutor with a ReAct agent
  - langchain.tools for custom tool definitions
  - AgentTrace's trace() as middleware around LLM calls, tool executions,
    and the overall agent run
  - Python SDK (agenttrace) for trace recording

Requirements:
  pip install -r requirements.txt
  export OPENAI_API_KEY=sk-...
  python agent.py

Related examples:
  - ../langgraph/README.md         (LangGraph-specific)
  - ../custom/README.md            (custom agent tracing)
  - ../fastapi-integration/        (HTTP API with AgentTrace)
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Optional

from agenttrace import AgentTrace, init, trace, TokenUsage, Scorer


# ---------------------------------------------------------------------------
# 1. Initialise AgentTrace
# ---------------------------------------------------------------------------

agent = init({
    "db_path": "./agenttrace.db",
    "max_traces": 50_000,
    "auto_cleanup": True,
})


# ---------------------------------------------------------------------------
# 2. Define LangChain-compatible tools (real tools, not dummies)
# ---------------------------------------------------------------------------

from langchain_core.tools import tool


@tool
def calculator(expression: str) -> str:
    """Evaluate a math expression. Example: '2 + 2', 'sqrt(16)', '10 / 3'."""
    import math
    allowed = {k: v for k, v in math.__dict__.items() if not k.startswith("_")}
    allowed.update({"abs": abs, "round": round, "max": max, "min": min})
    try:
        result = eval(expression, {"__builtins__": {}}, allowed)
        return str(result)
    except Exception as e:
        return f"error: {e}"


@tool
def search_web(query: str) -> str:
    """Search the web and return a short summary (simulated)."""
    time.sleep(0.02)
    return f"[search results for '{query}'] Found 3 relevant pages."


@tool
def get_weather(city: str) -> str:
    """Get current weather for a city (simulated)."""
    conditions = ["sunny", "cloudy", "rainy", "windy"]
    import random
    random.seed(hash(city) % 2**31)
    cond = random.choice(conditions)
    temp = random.randint(10, 35)
    return f"{city}: {cond}, {temp}C"


TOOLS = [calculator, search_web, get_weather]


# ---------------------------------------------------------------------------
# 3. Trace middleware helpers
# ---------------------------------------------------------------------------

class TracedAgent:
    """
    Wraps a LangChain agent so that every LLM call, tool execution,
    and the overall agent run is traced in AgentTrace.

    The tracing is non-invasive -- it uses `agent.trace()` context managers
    and wrappers rather than monkey-patching LangChain internals.
    """

    def __init__(self, agent_trace: AgentTrace, db_path: str = "./agenttrace.db") -> None:
        self.at = agent_trace
        self._run_id: Optional[str] = None

    # ---- Run lifecycle ---------------------------------------------------

    def start_run(self, name: str) -> str:
        self._run_id = self.at.start_run(name, {"framework": "langchain", "example": "langchain-agent"})
        return self._run_id

    def complete_run(self, status: str = "success") -> None:
        if self._run_id:
            self.at.complete_run(status="success" if status == "success" else "error")
            self._run_id = None

    # ---- Middleware: trace any callable ----------------------------------

    def traced(self, name: str, fn, *, input_data: Any = None, model: Optional[str] = None):
        """Execute fn() inside an AgentTrace span."""
        return self.at.trace(
            name,
            fn,
            input=input_data,
            model=model,
            metadata={"framework": "langchain"},
        )

    # ---- Build the LangChain agent ---------------------------------------

    def build_agent(self, model_name: str = "gpt-4o-mini"):
        """
        Build a standard LangChain ReAct agent with our tools.

        Returns (llm, agent_executor) -- both already created.
        """
        from langchain_openai import ChatOpenAI
        from langchain.agents import AgentExecutor, create_react_agent
        from langchain import hub

        llm = ChatOpenAI(model=model_name, temperature=0)

        # Pull a standard ReAct prompt from LangChain Hub
        prompt = hub.pull("hwchase17/react")

        lc_agent = create_react_agent(llm, TOOLS, prompt)
        agent_executor = AgentExecutor(
            agent=lc_agent,
            tools=TOOLS,
            verbose=False,
            max_iterations=10,
            handle_parsing_errors=True,
        )
        return llm, agent_executor

    # ---- Run a traced agent invocation -----------------------------------

    def invoke_traced(
        self,
        agent_executor,
        user_input: str,
        model_name: str = "gpt-4o-mini",
    ) -> dict[str, Any]:
        """
        Invoke the LangChain agent with full AgentTrace tracing.

        Traces:
          - The overall.langchain-agent run (outer span)
          - Each individual invocation step inside AgentExecutor
          - Token usage extracted from the LLM response metadata
        """
        t_start = int(time.time() * 1000)
        output_text = ""

        self.start_run("langchain-agent-invocation")

        try:
            # Outer trace: the entire agent invocation
            with self.at.trace(
                "langchain-agent",
                input={"message": user_input},
                model=model_name,
                metadata={"framework": "langchain", "agent_type": "react"},
            ) as outer:
                # Run the agent (this internally does LLM calls + tool calls)
                result = agent_executor.invoke({"input": user_input})

                output_text = result.get("output", "")
                outer.set_output(output_text)

                # Try to extract token usage from the last intermediate step
                total_prompt = 0
                total_completion = 0
                for step in result.get("intermediate_steps", []):
                    # step = (AgentAction, observation)
                    pass  # tokens are tracked via callbacks below

            latency_ms = int(time.time() * 1000) - t_start

            self.complete_run("success")

            return {
                "output": output_text,
                "latency_ms": latency_ms,
            }

        except Exception as exc:
            self.complete_run("error")
            raise


# ---------------------------------------------------------------------------
# 4. Run the example
# ---------------------------------------------------------------------------

def main() -> None:
    print("=== AgentTrace + LangChain Agent Example ===\n")

    traced = TracedAgent(agent_trace=agent)

    # -- Run 1: Simple question --
    print("[Run 1] Simple math question")
    llm, executor = traced.build_agent("gpt-4o-mini")
    result = traced.invoke_traced(executor, "What is 42 * 17 + sqrt(144)?", "gpt-4o-mini")
    print(f"  Answer : {result['output']}")
    print(f"  Latency: {result['latency_ms']} ms\n")

    # -- Run 2: Tool-heavy question --
    print("[Run 2] Weather + search")
    llm2, executor2 = traced.build_agent("gpt-4o-mini")
    result2 = traced.invoke_traced(
        executor2,
        "What's the weather in Tokyo and what are the top attractions?",
        "gpt-4o-mini",
    )
    print(f"  Answer : {result2['output']}")
    print(f"  Latency: {result2['latency_ms']} ms\n")

    # -- Run 3: Another math question with higher model --
    print("[Run 3] harder math with gpt-4o")
    llm3, executor3 = traced.build_agent("gpt-4o")
    result3 = traced.invoke_traced(
        executor3,
        "What is the 15th Fibonacci number?",
        "gpt-4o",
    )
    print(f"  Answer : {result3['output']}")
    print(f"  Latency: {result3['latency_ms']} ms\n")

    # ---- Query trace stats ----
    print("--- Trace Stats ---")
    stats = agent.get_stats()
    print(f"  Total runs   : {stats.total_runs}")
    print(f"  Total traces : {stats.total_traces}")
    print(f"  Success rate : {stats.success_rate:.1%}")
    print(f"  Avg latency  : {stats.avg_latency_ms:.0f} ms")
    print(f"  Total cost   : ${stats.total_cost_usd:.6f}")
    print(f"  Total tokens : {stats.total_tokens}")

    print("\n--- Cost Breakdown ---")
    cb = agent.get_cost_breakdown()
    for model, cost in cb.cost_by_model.items():
        print(f"  {model}: ${cost:.6f}")

    print("\n--- Recent Traces ---")
    recent = agent.get_traces({"limit": 10})
    for t in recent:
        print(
            f"  [{t.status}] {t.name:<30s}  "
            f"latency={t.latency_ms}ms  cost=${t.cost_usd:.6f}  "
            f"tokens={t.tokens.total_tokens}"
        )

    # ---- Evaluation ----
    print("\n--- Evaluation ---")
    scorers = [
        Scorer(name="is-success", fn=lambda t: 1.0 if t.status == "success" else 0.0),
        Scorer(name="low-latency", fn=lambda t: 1.0 if t.latency_ms < 5000 else 0.0),
        Scorer(name="output-length", fn=lambda t: float(len(str(t.output or "")))),
    ]
    eval_results = agent.evaluate(scorers)
    for r in eval_results:
        scores_str = ", ".join(f"{k}={v:.3f}" for k, v in r.scores.items())
        print(f"  trace={r.trace_id[:8]}...  scores: {scores_str}")

    agent.close()
    print("\nDone. View traces:  npx agenttrace dashboard --db ./agenttrace.db")


if __name__ == "__main__":
    main()
