"""
AgentTrace -- Core SDK
Drop-in tracing for any AI agent (Python port)
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Callable
from typing import Any, Optional, TypeVar, cast

from .storage import TraceStorage
from .types import (
    AgentUsageFilter,
    AgentUsageRecord,
    CostBreakdown,
    EvaluateOptions,
    ExportFormat,
    HallucinationDetector,
    Run,
    RunStatus,
    Scorer,
    ScorerResult,
    Status,
    TokenUsage,
    ToolCall,
    Trace,
    TraceConfig,
    TraceFilter,
    TraceStats,
    UsageStats,
)

T = TypeVar("T")


# Default cost calculator (approximate 2026 pricing) -- matches TypeScript SDK
def _default_cost_calculator(tokens: TokenUsage, model: Optional[str] = None) -> float:
    rates: dict[str, dict[str, float]] = {
        "gpt-4o": {"prompt": 0.0025, "completion": 0.01},
        "gpt-4o-mini": {"prompt": 0.00015, "completion": 0.0006},
        "claude-sonnet-4": {"prompt": 0.003, "completion": 0.015},
        "claude-haiku-4": {"prompt": 0.00025, "completion": 0.00125},
        "gemini-2.0-flash": {"prompt": 0.0001, "completion": 0.0004},
        "llama-3.1-70b": {"prompt": 0.0009, "completion": 0.0009},
    }
    rate = rates.get(model or "", {"prompt": 0.001, "completion": 0.002})
    return (tokens.prompt_tokens * rate["prompt"] + tokens.completion_tokens * rate["completion"]) / 1000


def _normalize_config(c: Any) -> dict[str, Any]:
    if c is None:
        c = {}
    if isinstance(c, TraceConfig):
        c = {
            "db_path": c.db_path,
            "max_traces": c.max_traces,
            "auto_cleanup": c.auto_cleanup,
            "cost_calculator": c.cost_calculator,
            "hallucination_detector": c.hallucination_detector,
            "silent": c.silent,
        }
    if isinstance(c, dict):
        out: dict[str, Any] = {}
        for k, v in list(c.items()):
            if k == "dbPath":
                out["db_path"] = v
            elif k == "maxTraces":
                out["max_traces"] = v
            elif k == "autoCleanup":
                out["auto_cleanup"] = v
            elif k == "costCalculator":
                out["cost_calculator"] = v
            elif k == "hallucinationDetector":
                out["hallucination_detector"] = v
            else:
                out[k] = v
        return out
    return {}


class _TraceContext:
    """Internal context manager + decorator support for trace().

    Supports:
      with agent.trace("op") as t:
          ...
          t.set_output(val)
      @agent.trace("op")
      def fn(): ...
      result = agent.trace("op", lambda: compute())
    """

    def __init__(self, agent: AgentTrace, name: str, options: dict[str, Any]) -> None:
        self.agent = agent
        self.name = name
        self.options: dict[str, Any] = options
        self._start_time: int = 0
        self._result: Any = None
        self._error: Optional[str] = None
        self._status: Status = "success"
        self._output_set: bool = False
        self._trace_id: Optional[str] = None

    def __enter__(self) -> _TraceContext:
        self._start_time = int(time.time() * 1000)
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> bool:
        latency_ms = int(time.time() * 1000) - self._start_time
        if exc_val is not None:
            self._status = "error"
            self._error = str(exc_val)
        if not self._output_set:
            self._result = None if exc_val is not None else self._result
        self._record_trace(latency_ms)
        # Do not suppress exception
        return False

    async def __aenter__(self) -> _TraceContext:
        return self.__enter__()

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> bool:
        return self.__exit__(exc_type, exc_val, exc_tb)

    def set_output(self, output: Any) -> None:
        """Manually set the output for the trace (useful in context manager usage)."""
        self._result = output
        self._output_set = True

    def set_tokens(self, tokens: TokenUsage | dict[str, Any]) -> None:
        """Override tokens for this trace (before exit)."""
        self.options["tokens"] = tokens

    def set_metadata(self, metadata: dict[str, Any]) -> None:
        self.options["metadata"] = metadata

    def _record_trace(self, latency_ms: int) -> None:
        tok_raw = self.options.get("tokens") or {}
        if isinstance(tok_raw, TokenUsage):
            tokens = tok_raw
        else:
            tokens = TokenUsage(
                prompt_tokens=tok_raw.get("promptTokens", tok_raw.get("prompt_tokens", 0)),
                completion_tokens=tok_raw.get("completionTokens", tok_raw.get("completion_tokens", 0)),
                total_tokens=tok_raw.get("totalTokens", tok_raw.get("total_tokens", 0)),
                model=tok_raw.get("model") or self.options.get("model"),
                provider=tok_raw.get("provider") or self.options.get("provider"),
            )

        cost_usd = self.agent._cost_calculator(tokens, self.options.get("model"))

        trace_id = str(uuid.uuid4())
        # Auto-create a run if none is active (ensures FK constraint satisfaction)
        run_id = self.agent._current_run_id or self.agent.start_run("auto-run")

        tr = Trace(
            id=trace_id,
            run_id=run_id,
            name=self.name,
            status=self._status,
            input=self.options.get("input"),
            output=self._result,
            tokens=tokens,
            tool_calls=[],
            latency_ms=latency_ms,
            cost_usd=cost_usd,
            error=self._error,
            metadata=self.options.get("metadata") or {},
        )
        self.agent.storage.create_trace(tr)

        if self.agent.config.get("auto_cleanup", True):
            self.agent.storage.cleanup(self.agent.config.get("max_traces", 10000))

        self._trace_id = trace_id

    def __call__(self, fn: Callable[..., T]) -> Callable[..., T]:
        """Allow use as decorator when trace(name) is applied with @."""

        def wrapper(*args: Any, **kwargs: Any) -> T:
            start = int(time.time() * 1000)
            status: Status = "success"
            err: Optional[str] = None
            res: Any = None
            try:
                res = fn(*args, **kwargs)
                return res
            except Exception as e:
                err = str(e)
                status = "error"
                raise
            finally:
                latency_ms = int(time.time() * 1000) - start
                tok_raw = self.options.get("tokens") or {}
                if isinstance(tok_raw, TokenUsage):
                    tokens = tok_raw
                else:
                    tokens = TokenUsage(
                        prompt_tokens=tok_raw.get("promptTokens", tok_raw.get("prompt_tokens", 0)),
                        completion_tokens=tok_raw.get("completionTokens", tok_raw.get("completion_tokens", 0)),
                        total_tokens=tok_raw.get("totalTokens", tok_raw.get("total_tokens", 0)),
                        model=tok_raw.get("model") or self.options.get("model"),
                        provider=tok_raw.get("provider") or self.options.get("provider"),
                    )
                cost_usd = self.agent._cost_calculator(tokens, self.options.get("model"))
                trace_id = str(uuid.uuid4())
                # Auto-create a run if none is active (ensures FK constraint satisfaction)
                run_id = self.agent._current_run_id or self.agent.start_run("auto-run")
                tr = Trace(
                    id=trace_id,
                    run_id=run_id,
                    name=self.name,
                    status=status,
                    input=self.options.get("input"),
                    output=res,
                    tokens=tokens,
                    tool_calls=[],
                    latency_ms=latency_ms,
                    cost_usd=cost_usd,
                    error=err,
                    metadata=self.options.get("metadata") or {},
                )
                self.agent.storage.create_trace(tr)
                if self.agent.config.get("auto_cleanup", True):
                    self.agent.storage.cleanup(self.agent.config.get("max_traces", 10000))
                self._trace_id = trace_id

        # Preserve metadata
        wrapper.__name__ = getattr(fn, "__name__", "wrapped")
        wrapper.__doc__ = getattr(fn, "__doc__", None)
        wrapper.__module__ = getattr(fn, "__module__", None)
        return wrapper


class AgentTrace:
    """Main SDK class. Mirrors the TypeScript AgentTrace API closely."""

    def __init__(self, config: TraceConfig | dict[str, Any] | None = None) -> None:
        cfg = _normalize_config(config)
        self.config: dict[str, Any] = {
            "db_path": cfg.get("db_path") or "./agenttrace.db",
            "max_traces": cfg.get("max_traces") or 10000,
            "auto_cleanup": cfg.get("auto_cleanup", True),
            "silent": bool(cfg.get("silent", False)),
        }
        self._cost_calculator: Callable[[TokenUsage, Optional[str]], float] = (
            cfg.get("cost_calculator") or _default_cost_calculator
        )
        self._hallucination_detector: Callable[[Any, Optional[Any]], bool] = (
            cfg.get("hallucination_detector") or (lambda _o, _e: False)
        )
        self.storage = TraceStorage(self.config["db_path"])
        self._current_run_id: Optional[str] = None

    # ---- Run management ----

    def start_run(self, name: str, metadata: Optional[dict[str, Any]] = None) -> str:
        """Start a new agent run. Returns the run id (UUID)."""
        if metadata is None:
            metadata = {}
        run_id = str(uuid.uuid4())
        self.storage.create_run(
            {
                "id": run_id,
                "name": name,
                "startedAt": int(time.time() * 1000),
                "metadata": metadata,
            }
        )
        self._current_run_id = run_id
        return run_id

    def complete_run(self, status: RunStatus = "success") -> None:
        """Complete the current run."""
        if self._current_run_id:
            self.storage.complete_run(self._current_run_id, status)
            self._current_run_id = None

    # ---- Tracing (core) ----

    def trace(
        self,
        name: str,
        fn: Optional[Callable[[], T]] = None,
        **options: Any,
    ) -> T | _TraceContext:
        """Trace an operation.

        Usage:
            result = agent.trace("my-op", lambda: do_work())

            @agent.trace("my-op")
            def my_work():
                return "hello"

            with agent.trace("my-op") as t:
                val = do_work()
                t.set_output(val)
                # or let it capture if no exception

        Returns the result of fn if fn provided, else a context/decorator object.
        """
        # Normalize option keys (accept camelCase too)
        opts: dict[str, Any] = {}
        for k, v in options.items():
            kl = k.lower().replace("-", "_")
            if kl in ("input", "tokens", "model", "provider", "metadata"):
                opts[kl] = v
            else:
                opts[k] = v

        if fn is not None:
            # Execute immediately (sync), record in finally
            start = int(time.time() * 1000)
            status: Status = "success"
            err: Optional[str] = None
            res: Any = None
            try:
                res = fn()
                return res
            except Exception as e:
                err = str(e)
                status = "error"
                raise
            finally:
                latency_ms = int(time.time() * 1000) - start
                tok_raw = opts.get("tokens") or {}
                if isinstance(tok_raw, TokenUsage):
                    tokens = tok_raw
                else:
                    tokens = TokenUsage(
                        prompt_tokens=tok_raw.get("promptTokens", tok_raw.get("prompt_tokens", 0)),
                        completion_tokens=tok_raw.get("completionTokens", tok_raw.get("completion_tokens", 0)),
                        total_tokens=tok_raw.get("totalTokens", tok_raw.get("total_tokens", 0)),
                        model=tok_raw.get("model") or opts.get("model"),
                        provider=tok_raw.get("provider") or opts.get("provider"),
                    )
                cost_usd = self._cost_calculator(tokens, opts.get("model"))
                trace_id = str(uuid.uuid4())
                # Auto-create a run if none is active (ensures FK constraint satisfaction)
                run_id = self._current_run_id or self.start_run("auto-run")
                tr = Trace(
                    id=trace_id,
                    run_id=run_id,
                    name=name,
                    status=status,
                    input=opts.get("input"),
                    output=res,
                    tokens=tokens,
                    tool_calls=[],
                    latency_ms=latency_ms,
                    cost_usd=cost_usd,
                    error=err,
                    metadata=opts.get("metadata") or {},
                )
                self.storage.create_trace(tr)
                if self.config.get("auto_cleanup", True):
                    self.storage.cleanup(self.config.get("max_traces", 10000))
            # never reached
            return cast(T, res)  # type: ignore[return-value]

        # No fn: return dual context-manager / decorator object
        return _TraceContext(self, name, opts)

    # ---- Tool calls (stored at trace creation time; this is a stub per TS) ----

    def record_tool_call(self, call: dict[str, Any] | ToolCall) -> str:
        """Record a tool call (note: in current impl, tool calls are passed at trace time)."""
        return str(uuid.uuid4())

    # ---- Query ----

    def get_traces(self, filter: TraceFilter | dict[str, Any] = {}) -> list[Trace]:
        return self.storage.get_traces(filter)

    def get_trace(self, id: str) -> Trace | None:
        return self.storage.get_trace(id)

    def get_runs(self, limit: int = 100) -> list[Run]:
        return self.storage.get_runs(limit)

    def get_run(self, id: str) -> Run | None:
        return self.storage.get_run(id)

    def get_stats(self) -> TraceStats:
        return self.storage.get_stats()

    # ---- Agent usage tracking (for self-observability) ----

    def record_agent_usage(
        self, record: AgentUsageRecord | dict[str, Any]
    ) -> None:
        """Record an agent action/usage event for self-tracking (costs, actions, tokens etc)."""
        self.storage.record_agent_usage(record)

    def get_agent_usage(
        self, filter: AgentUsageFilter | dict[str, Any] = {}
    ) -> list[AgentUsageRecord]:
        """Query agent usage records with filters."""
        return self.storage.get_agent_usage(filter)

    def get_usage_stats(
        self,
        agent_name: Optional[str] = None,
        from_date: Optional[int] = None,
        to_date: Optional[int] = None,
    ) -> UsageStats:
        """Aggregated stats for agent actions."""
        return self.storage.get_usage_stats(agent_name, from_date, to_date)

    def get_cost_breakdown(self, run_id: Optional[str] = None) -> CostBreakdown:
        """Get cost breakdown by model and by day (supports run filter)."""
        return self.storage.get_cost_breakdown(run_id)

    # ---- Export ----

    def export(self, format: ExportFormat = "json", filter: TraceFilter | dict[str, Any] = {}) -> str:
        traces = self.storage.get_traces(filter)
        if format == "json":
            data: list[dict[str, Any]] = []
            for t in traces:
                data.append(
                    {
                        "id": t.id,
                        "runId": t.run_id,
                        "name": t.name,
                        "status": t.status,
                        "input": t.input,
                        "output": t.output,
                        "tokens": {
                            "promptTokens": t.tokens.prompt_tokens,
                            "completionTokens": t.tokens.completion_tokens,
                            "totalTokens": t.tokens.total_tokens,
                            "model": t.tokens.model,
                            "provider": t.tokens.provider,
                        },
                        "toolCalls": [
                            {
                                "id": tc.id,
                                "name": tc.name,
                                "input": tc.input,
                                "output": tc.output,
                                "latencyMs": tc.latency_ms,
                                "success": tc.success,
                                "error": tc.error,
                                "timestamp": tc.timestamp,
                            }
                            for tc in t.tool_calls
                        ],
                        "latencyMs": t.latency_ms,
                        "costUsd": t.cost_usd,
                        "error": t.error,
                        "metadata": t.metadata,
                        "createdAt": t.created_at,
                        "updatedAt": t.updated_at,
                    }
                )
            return json.dumps(data, indent=2)

        # CSV — properly escape fields containing commas, quotes, or newlines
        def _escape_csv(val: Any) -> str:
            s = "" if val is None else str(val)
            if "," in s or '"' in s or "\n" in s or "\r" in s:
                return '"' + s.replace('"', '""') + '"'
            return s

        headers = [
            "id",
            "runId",
            "name",
            "status",
            "latencyMs",
            "costUsd",
            "totalTokens",
            "createdAt",
        ]
        rows: list[list[Any]] = []
        for t in traces:
            rows.append(
                [
                    t.id,
                    t.run_id,
                    t.name,
                    t.status,
                    t.latency_ms,
                    t.cost_usd,
                    t.tokens.total_tokens,
                    t.created_at,
                ]
            )
        lines = [",".join(_escape_csv(h) for h in headers)]
        for r in rows:
            lines.append(",".join(_escape_csv(x) for x in r))
        return "\n".join(lines)

    # ---- Evaluation ----

    def evaluate(
        self,
        scorers: list[Scorer] | list[Callable[[Trace], Any]],
        run_id: Optional[str] = None,
        trace_ids: Optional[list[str]] = None,
        concurrency: Optional[int] = None,
    ) -> list[ScorerResult]:
        """Evaluate traces using the provided scorers.

        If traceIds provided, scores only those; if runId, scores traces in that run; otherwise all traces.
        """
        if not scorers:
            return []

        # Normalize scorers (support bare callables or Scorer objects; name from __name__ if needed)
        norm_scorers: list[Scorer] = []
        for s in scorers:
            if isinstance(s, Scorer):
                norm_scorers.append(s)
            elif callable(s):
                nm = getattr(s, "__name__", "scorer") or "scorer"
                norm_scorers.append(Scorer(name=nm, fn=s))
        if not norm_scorers:
            return []

        if trace_ids and len(trace_ids) > 0:
            traces: list[Trace] = [
                t for t in (self.get_trace(tid) for tid in trace_ids) if t is not None
            ]
        elif run_id:
            traces = self.get_traces({"run_id": run_id})
        else:
            traces = self.get_traces()

        return self._score_loop(traces, norm_scorers, concurrency)

    def evaluate_trace(
        self, trace_id: str, scorers: list[Scorer] | list[Callable[[Trace], Any]]
    ) -> ScorerResult:
        """Score a single trace by id."""
        trace = self.get_trace(trace_id)
        if not trace:
            return ScorerResult(trace_id=trace_id, scores={}, errors={})
        norm: list[Scorer] = []
        for s in scorers:
            if isinstance(s, Scorer):
                norm.append(s)
            elif callable(s):
                nm = getattr(s, "__name__", "scorer") or "scorer"
                norm.append(Scorer(name=nm, fn=s))
        if not norm:
            return ScorerResult(trace_id=trace_id)
        return self._score_trace(trace, norm)

    def get_scores(
        self, trace_id: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """Retrieve stored evaluation scores (optionally for one trace)."""
        return self.storage.get_scores(trace_id)

    def _score_loop(
        self,
        traces: list[Trace],
        scorers: list[Scorer],
        concurrency: Optional[int] = None,
    ) -> list[ScorerResult]:
        if not traces:
            return []
        limit = max(1, concurrency or 5)
        results: list[ScorerResult] = []
        for i in range(0, len(traces), limit):
            chunk = traces[i : i + limit]
            chunk_results = [self._score_trace(t, scorers) for t in chunk]
            results.extend(chunk_results)
        return results

    def _score_trace(self, trace: Trace, scorers: list[Scorer]) -> ScorerResult:
        trace_id = trace.id
        scores: dict[str, float] = {}
        errors: dict[str, str] = {}

        for scorer in scorers:
            try:
                val = scorer.fn(trace)
                # Handle possible async scorer (coroutine)
                if asyncio.iscoroutine(val):
                    try:
                        if asyncio.get_event_loop().is_running():
                            val = 0.0  # can't await safely here; user should use sync scorer
                        else:
                            val = asyncio.run(val)  # py 3.7+
                    except Exception:
                        val = 0.0
                if isinstance(val, (int, float)) and (val == val):  # finite
                    scores[scorer.name] = float(val)
                    sid = str(uuid.uuid4())
                    self.storage.create_score(sid, trace_id, scorer.name, float(val))
                else:
                    errors[scorer.name] = f"Invalid score returned: {val}"
            except Exception as e:
                errors[scorer.name] = str(e)

        return ScorerResult(trace_id=trace_id, scores=scores, errors=errors)

    # ---- Lifecycle ----

    def close(self) -> None:
        """Close the underlying DB connection."""
        self.storage.close()


class AgentUsageTracker:
    """Thin tracker for agent usage / actions.

    Mirrors SelfTracker from TS SDK but records into the dedicated agent_usage table
    (instead of traces/runs) for usage analytics. Supports session grouping.
    No JSONL side-log (Python SDK keeps it storage-focused unless requested).
    """

    def __init__(
        self, agent_name: str, agent_type: str = "custom", db_path: Optional[str] = None
    ) -> None:
        self.agent_name = agent_name
        self.agent_type = agent_type
        self.db_path = db_path or "./agenttrace.db"
        self.storage = TraceStorage(self.db_path)
        self.current_session_id: Optional[str] = None
        self.session_start_time: int = 0

    def start_session(self) -> str:
        """Start a new tracking session. Returns session id (uuid)."""
        session_id = str(uuid.uuid4())
        started_at = int(time.time() * 1000)
        self.current_session_id = session_id
        self.session_start_time = started_at
        return session_id

    def _ensure_session(self) -> str:
        if not self.current_session_id:
            self.start_session()
        return self.current_session_id  # type: ignore[return-value]

    def track_action(
        self, action: str, target: str, metadata: Optional[dict[str, Any]] = None
    ) -> None:
        """Track a generic action by this agent."""
        if metadata is None:
            metadata = {}
        session_id = self._ensure_session()
        now = int(time.time() * 1000)
        rec = AgentUsageRecord(
            id=str(uuid.uuid4()),
            agent_name=self.agent_name,
            agent_type=self.agent_type,
            session_id=session_id,
            action=action,
            target=target,
            tokens_used=0,
            cost_usd=0.0,
            duration_ms=0,
            status="success",
            metadata={
                "selfTracked": True,
                "actionType": "action",
                "action": action,
                "target": target,
                **metadata,
            },
            created_at=now,
        )
        self.storage.record_agent_usage(rec)

    def track_delegation(self, target_agent: str, task: str) -> None:
        """Track delegation to another agent."""
        session_id = self._ensure_session()
        now = int(time.time() * 1000)
        rec = AgentUsageRecord(
            id=str(uuid.uuid4()),
            agent_name=self.agent_name,
            agent_type=self.agent_type,
            session_id=session_id,
            action="delegation",
            target=target_agent,
            tokens_used=0,
            cost_usd=0.0,
            duration_ms=0,
            status="success",
            metadata={
                "selfTracked": True,
                "actionType": "delegation",
                "targetAgent": target_agent,
                "task": task,
            },
            created_at=now,
        )
        self.storage.record_agent_usage(rec)

    def track_research(self, query: str, results: int) -> None:
        """Track a research step (query + result count)."""
        session_id = self._ensure_session()
        now = int(time.time() * 1000)
        rec = AgentUsageRecord(
            id=str(uuid.uuid4()),
            agent_name=self.agent_name,
            agent_type=self.agent_type,
            session_id=session_id,
            action="research",
            target=query,
            tokens_used=0,
            cost_usd=0.0,
            duration_ms=0,
            status="success",
            metadata={
                "selfTracked": True,
                "actionType": "research",
                "query": query,
                "results": results,
            },
            created_at=now,
        )
        self.storage.record_agent_usage(rec)

    def track_implementation(self, files: list[str], lines_of_code: int) -> None:
        """Track an implementation step (files touched + loc)."""
        session_id = self._ensure_session()
        now = int(time.time() * 1000)
        rec = AgentUsageRecord(
            id=str(uuid.uuid4()),
            agent_name=self.agent_name,
            agent_type=self.agent_type,
            session_id=session_id,
            action="implementation",
            target=",".join(files) if files else None,
            tokens_used=0,
            cost_usd=0.0,
            duration_ms=0,
            status="success",
            metadata={
                "selfTracked": True,
                "actionType": "implementation",
                "files": files,
                "linesOfCode": lines_of_code,
            },
            created_at=now,
        )
        self.storage.record_agent_usage(rec)

    def end_session(self) -> None:
        """End current session (clears active session id; no run to complete since usage table)."""
        if self.current_session_id:
            self.current_session_id = None
            self.session_start_time = 0

    def get_session_stats(self) -> dict[str, Any]:
        """Return stats for the current session (mirrors TS SelfTracker.getSessionStats shape)."""
        if not self.current_session_id:
            return {"sessionId": "", "actions": 0, "duration": 0, "tokens": 0, "cost": 0}

        # Use our filter support for session
        records = self.storage.get_agent_usage({"session_id": self.current_session_id})
        actions_count = len(records)
        total_tokens = sum(r.tokens_used for r in records)
        total_cost = sum(r.cost_usd for r in records)
        now = int(time.time() * 1000)
        start = self.session_start_time or now
        duration_sec = max(0, (now - start) // 1000)
        return {
            "sessionId": self.current_session_id,
            "actions": actions_count,
            "duration": duration_sec,
            "tokens": total_tokens,
            "cost": total_cost,
        }

    def close(self) -> None:
        """Close underlying storage."""
        self.storage.close()


# ---- Singleton / module level API ----

VERSION = "0.4.24"
PACKAGE_NAME = "agenttrace-io"

_instance: Optional[AgentTrace] = None


def init(config: TraceConfig | dict[str, Any] | None = None) -> AgentTrace:
    """Initialize (and return) the global AgentTrace instance."""
    global _instance
    _instance = AgentTrace(config)
    return _instance


def get_agent_trace() -> AgentTrace:
    """Get or lazily create the global AgentTrace instance (default config)."""
    global _instance
    if _instance is None:
        _instance = AgentTrace()
    return _instance


def trace(
    name: str,
    fn: Optional[Callable[[], T]] = None,
    **options: Any,
) -> Any:
    """Top-level trace using the global agent instance.

    Supports the same forms as AgentTrace.trace:
      - trace("name", lambda: ...) -> result
      - @trace("name") def fn(): ...
      - with trace("name") as t: ...
    """
    agent = get_agent_trace()
    return agent.trace(name, fn, **options)


def score(name: str, fn: Optional[Callable[[Trace], Any]] = None) -> Any:
    """Helper to create a Scorer from name + function, or as a decorator.

    Usage:
        s = score('output-len', lambda t: len(str(t.output or '')) / 1000)

        @score('success-rate')
        def success_rate(trace):
            return 1.0 if trace.status == 'success' else 0.0

    Returns a Scorer (dataclass with .name and .fn).
    """
    if fn is not None:
        return Scorer(name=name, fn=fn)

    def decorator(f: Callable[[Trace], Any]) -> Scorer:
        return Scorer(name=name, fn=f)

    return decorator


def evaluate(
    scorers: list[Scorer] | list[Callable[[Trace], Any]],
    run_id: Optional[str] = None,
    trace_ids: Optional[list[str]] = None,
    concurrency: Optional[int] = None,
) -> list[ScorerResult]:
    """Top-level evaluate using the global agent instance (mirrors AgentTrace.evaluate)."""
    agent = get_agent_trace()
    return agent.evaluate(scorers, run_id=run_id, trace_ids=trace_ids, concurrency=concurrency)


def evaluate_trace(trace_id: str, scorers: list[Scorer] | list[Callable[[Trace], Any]]) -> ScorerResult:
    """Top-level evaluate_trace using the global agent."""
    agent = get_agent_trace()
    return agent.evaluate_trace(trace_id, scorers)
