"""
AgentTrace + FastAPI Integration Example

Demonstrates how to integrate AgentTrace tracing into a FastAPI application.
Each endpoint is automatically traced with input/output, latency, and optional
token/cost tracking for LLM-powered routes.

Run (from this directory, after editable install of the sdk):
    pip install -e ../../packages/sdk-python
    pip install fastapi uvicorn
    uvicorn app:app --reload --port 8000

Or with PUBLIC install:
    pip install agenttrace-io fastapi uvicorn
    uvicorn app:app --reload --port 8000

Then open:
    http://localhost:8000/docs     -- Swagger UI
    http://localhost:8000/stats    -- trace statistics
    http://localhost:8000/runs     -- recent runs
"""

import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional, cast

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agenttrace import AgentTrace, init, AgentUsageTracker
from agenttrace import TokenUsage


# ---------------------------------------------------------------------------
# AgentTrace initialisation
# ---------------------------------------------------------------------------

agent = init({
    "db_path": "./agenttrace.db",
    "max_traces": 50000,
    "auto_cleanup": True,
})

tracker = AgentUsageTracker(
    agent_name="fastapi-agent",
    agent_type="api-server",
    db_path="./agenttrace.db",
)


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    message: str
    model: str = "gpt-4o-mini"
    session_id: Optional[str] = None


class ChatResponseBody(BaseModel):
    response: str
    tokens: dict
    cost_usd: float
    latency_ms: int


class SearchRequest(BaseModel):
    query: str
    max_results: int = 5


class SearchResponseBody(BaseModel):
    results: list[dict[str, Any]]
    count: int


# ---------------------------------------------------------------------------
# Helpers (simulated LLM / search)
# ---------------------------------------------------------------------------

def fake_llm_call(message: str, model: str = "gpt-4o-mini") -> dict[str, Any]:
    """Simulate an LLM call. Replace with your real provider."""
    time.sleep(0.05)
    return {
        "text": f"Echo from {model}: {message[::-1]}",
        "prompt_tokens": len(message.split()) * 2 + 10,
        "completion_tokens": len(message.split()) * 2,
        "model": model,
    }


def fake_search(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Simulate a search tool. Replace with your real search backend."""
    time.sleep(0.02)
    return [
        {"title": f"Result {i + 1} for '{query[:30]}'", "url": f"https://example.com/{i + 1}"}
        for i in range(min(max_results, 3))
    ]


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    run_id = agent.start_run("fastapi-server", {"type": "http-server"})
    tracker.start_session()
    yield
    agent.complete_run("success")
    tracker.end_session()
    agent.close()


app = FastAPI(
    title="AgentTrace + FastAPI Example",
    description="Demonstrates AgentTrace tracing in FastAPI endpoints",
    version="0.4.3",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
async def root():
    """Health check."""
    return {"status": "ok", "service": "agenttrace-fastapi-example"}


@app.post("/chat", response_model=ChatResponseBody)
async def chat(req: ChatRequest):
    """
    Chat endpoint traced with AgentTrace.

    Every call creates trace records in the SQLite DB with:
    - input (the user message)
    - model name and token usage
    - computed cost
    - end-to-end latency
    """
    run_id = agent.start_run("chat-session", {"endpoint": "/chat"})
    t_start = int(time.time() * 1000)

    try:
        # Traced LLM call
        llm_result = cast(
            dict[str, Any],
            agent.trace(
                "llm-call",
                lambda: fake_llm_call(req.message, req.model),
                input={"message": req.message, "model": req.model},
                model=req.model,
                tokens={
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0,
                },
            ),
        )

        prompt_tokens = llm_result["prompt_tokens"]
        completion_tokens = llm_result["completion_tokens"]
        total_tokens = prompt_tokens + completion_tokens
        model = llm_result["model"]

        tokens = TokenUsage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            model=model,
        )

        # Traced response generation step
        response_text = cast(
            str,
            agent.trace(
                "generate-response",
                lambda: llm_result["text"],
                input={"raw": llm_result["text"]},
                tokens=tokens,
                model=model,
            ),
        )

        # Track agent-level action in the usage tracker
        tracker.track_action("chat", req.message[:50], {"model": req.model})

        agent.complete_run("success")

        latency_ms = int(time.time() * 1000) - t_start
        cost_usd = agent._cost_calculator(tokens, model)

        return ChatResponseBody(
            response=response_text,
            tokens={
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
                "model": model,
            },
            cost_usd=round(cost_usd, 6),
            latency_ms=latency_ms,
        )

    except Exception as exc:
        agent.complete_run("error")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/search", response_model=SearchResponseBody)
async def search(req: SearchRequest):
    """
    Search endpoint showing context-manager style tracing.

    `with agent.trace(...) as ctx:` is ideal for multi-step operations
    where you want to manually set output, tokens, or metadata.
    """
    results = cast(
        list[dict[str, Any]],
        agent.trace(
            "search-tool",
            lambda: fake_search(req.query, req.max_results),
            input={"query": req.query, "max_results": req.max_results},
        ),
    )

    tracker.track_action("search", req.query[:50])

    # Context-manager style: post-process the search results
    formatted: list[dict[str, Any]] = []
    with agent.trace("format-results") as ctx:
        formatted = [{"rank": i + 1, **r} for i, r in enumerate(results)]
        ctx.set_output(formatted)

    return SearchResponseBody(
        results=formatted,
        count=len(formatted),
    )


@app.get("/stats")
async def stats():
    """Return aggregate trace statistics from the SQLite DB."""
    s = agent.get_stats()
    return {
        "total_runs": s.total_runs,
        "total_traces": s.total_traces,
        "success_rate": round(s.success_rate, 4),
        "avg_latency_ms": round(s.avg_latency_ms, 2),
        "total_cost_usd": round(s.total_cost_usd, 6),
        "total_tokens": s.total_tokens,
        "avg_tokens_per_trace": round(s.avg_tokens_per_trace, 1),
        "top_tools": s.top_tools[:5],
        "top_errors": s.top_errors[:5],
    }


@app.get("/runs")
async def runs(limit: int = 20):
    """List recent agent runs."""
    runs_list = agent.get_runs(limit=limit)
    return {
        "runs": [
            {
                "id": r.id,
                "name": r.name,
                "status": r.status,
                "trace_count": r.trace_count,
                "total_tokens": r.total_tokens.total_tokens if r.total_tokens else 0,
                "total_latency_ms": r.total_latency_ms,
                "total_cost_usd": round(r.total_cost_usd, 6),
                "started_at": r.started_at,
                "completed_at": r.completed_at,
                "metadata": r.metadata,
            }
            for r in runs_list
        ]
    }


@app.get("/traces")
async def traces(run_id: Optional[str] = None, limit: int = 50):
    """List traces, optionally filtered by run_id."""
    filter_opts: dict[str, Any] = {"limit": limit}
    if run_id:
        filter_opts["run_id"] = run_id
    traces_list = agent.get_traces(filter_opts)
    return {
        "traces": [
            {
                "id": t.id,
                "run_id": t.run_id,
                "name": t.name,
                "status": t.status,
                "latency_ms": t.latency_ms,
                "cost_usd": round(t.cost_usd, 6),
                "total_tokens": t.tokens.total_tokens,
                "model": t.tokens.model,
                "error": t.error,
                "created_at": t.created_at,
            }
            for t in traces_list
        ]
    }


@app.get("/usage")
async def usage():
    """Return agent usage stats from the usage tracker table."""
    session = tracker.get_session_stats()
    overall = tracker.storage.get_usage_stats(agent_name="fastapi-agent")
    return {
        "session": session,
        "overall": {
            "total_agents": overall.total_agents,
            "total_actions": overall.total_actions,
            "total_tokens": overall.total_tokens,
            "total_cost_usd": round(overall.total_cost_usd, 6),
            "avg_duration_ms": round(overall.avg_duration_ms, 2),
            "actions_by_type": overall.actions_by_type,
            "top_agents": overall.top_agents[:5],
        },
    }


@app.post("/evaluate")
async def evaluate_traces(run_id: Optional[str] = None):
    """
    Run built-in scorers against stored traces and return scores.

    Demonstrates the evaluate() API for quality assessment of traces.
    """
    from agenttrace import Scorer

    scorers = [
        Scorer(name="output-length", fn=lambda t: float(len(str(t.output or "")))),
        Scorer(name="is-success", fn=lambda t: 1.0 if t.status == "success" else 0.0),
        Scorer(name="low-latency", fn=lambda t: 1.0 if t.latency_ms < 200 else 0.0),
    ]

    results = agent.evaluate(scorers, run_id=run_id)
    return {
        "results": [
            {
                "trace_id": r.trace_id,
                "scores": {k: round(v, 4) for k, v in r.scores.items()},
                "errors": r.errors,
            }
            for r in results
        ]
    }


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
