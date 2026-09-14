"""
LangChain Integration Example for AgentTrace

Demonstrates:
- A tiny reusable "middleware" style wrapper you can use around LangChain LLMs / Chains / Tools
- Manual + context manager tracing of steps that look like LangChain nodes
- Recording agent usage for higher level "LangChain agent actions"
- Self querying costs and usage

This example runs with ONLY agenttrace-io (no LangChain installed).
For real LangChain, install langchain + your LLM package and replace the dummies.

Run:
    pip install -e ../../../../packages/sdk-python
    python example.py
"""

import time
from typing import Any, Callable, Optional
from agenttrace import init, trace


class AgentTraceLangChain:
    """
    Minimal "middleware" / instrumentation helper for LangChain-style code.

    Usage:
        mw = AgentTraceLangChain(db_path="./traces.db")
        llm = ChatOpenAI(...)
        resp = mw.trace_llm_call(llm, prompt, model="gpt-4o-mini")
    """

    def __init__(self, db_path: str = "./traces.db") -> None:
        self.at = init(db_path=db_path)
        self._run_id: Optional[str] = None

    def start_run(self, name: str) -> str:
        self._run_id = self.at.start_run(name, {"framework": "langchain"})
        return self._run_id

    def close(self) -> None:
        self.at.close()

    def trace_llm_call(
        self,
        llm: Any,
        prompt: str,
        *,
        model: Optional[str] = None,
        # In real code you would pull usage from response.response_metadata or .usage
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
    ) -> Any:
        def _call():
            # Dummy or real: if llm has .invoke, call it; else simulate
            if hasattr(llm, "invoke") or hasattr(llm, "ainvoke"):
                # Would be: return llm.invoke(prompt) or await
                time.sleep(0.01)
                return f"[LLM:{model or 'unknown'}] response to: {prompt[:40]}..."
            time.sleep(0.01)
            return f"[simulated] {prompt[:30]}..."

        return trace(
            "langchain-llm",
            _call,
            input={"prompt": prompt[:200]},
            model=model,
            tokens={
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
            metadata={"framework": "langchain"},
        )

    def trace_chain_step(self, name: str, fn: Callable[[], Any], **kw: Any) -> Any:
        """Wrap a custom LangChain chain step / tool / agent node."""
        return trace(
            f"langchain:{name}",
            fn,
            metadata={"framework": "langchain", **(kw.pop("metadata", {}))},
            **kw,
        )

    def record_agent_action(self, action: str, **meta: Any) -> None:
        self.at.record_agent_usage({
            "agent_name": meta.pop("agent_name", "langchain-agent"),
            "agent_type": meta.pop("agent_type", "langchain"),
            "action": action,
            "tokens_used": meta.pop("tokens_used", 0),
            "cost_usd": meta.pop("cost_usd", 0.0),
            "duration_ms": meta.pop("duration_ms", 0),
            "status": meta.pop("status", "success"),
            "metadata": meta,
        })


def main() -> None:
    print("=== LangChain + AgentTrace Integration Example ===")

    mw = AgentTraceLangChain(db_path="./agenttrace.db")
    mw.start_run("langchain-demo-run")

    # Simulate a LangChain LLM (replace with real ChatOpenAI etc.)
    class DummyLLM:
        def invoke(self, prompt: str) -> str:
            return f"dummy-response({len(prompt)} chars)"

    llm = DummyLLM()

    # 1. Trace an LLM call as if it came from LangChain
    out1 = mw.trace_llm_call(
        llm,
        "Explain agent observability in one paragraph.",
        model="gpt-4o-mini",
        prompt_tokens=95,
        completion_tokens=42,
    )
    print("LLM step 1:", out1[:60], "...")

    # 2. Trace a tool / chain step
    def retrieval_step():
        time.sleep(0.005)
        return ["doc1", "doc2", "doc3"]

    docs = mw.trace_chain_step(
        "retriever",
        retrieval_step,
        input={"query": "observability"},
        tokens={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        model="text-embedding-3-small",
    )
    print("Retrieved docs:", len(docs))

    # 3. Another LLM call with higher cost model
    out2 = mw.trace_llm_call(
        llm,
        f"Summarize these docs: {docs}",
        model="claude-sonnet-4",
        prompt_tokens=220,
        completion_tokens=85,
    )
    print("LLM step 2:", out2[:60], "...")

    # 4. Record high-level agent actions (the "agent" using the chain)
    mw.record_agent_action(
        "chain_execution",
        agent_name="langchain-research-agent",
        tokens_used=220 + 85 + 95 + 42,
        cost_usd=0.0042,
        duration_ms=120,
        step_count=3,
    )

    # Self query
    print("\n--- Self stats after LangChain-style run ---")
    print("trace_stats:", mw.at.get_stats().total_traces, "traces")
    u = mw.at.get_usage_stats()
    print("usage_stats total_actions:", u.total_actions)
    print("cost_breakdown:", mw.at.get_cost_breakdown().total_cost_usd)

    mw.close()
    print("\nDone. Use npx agenttrace dashboard --db ./agenttrace.db to explore.")


if __name__ == "__main__":
    main()
