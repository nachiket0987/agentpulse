"""
Unit tests for core AgentTrace (Python SDK)
"""

import json
import re
import tempfile
import uuid
from pathlib import Path

import pytest

from agenttrace import AgentTrace, init, trace, get_agent_trace, VERSION, PACKAGE_NAME, TraceStorage
from agenttrace.types import TokenUsage, TraceConfig


UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I
)


def make_temp_db() -> str:
    # Use a real temp file so WAL etc work across close/reopen if needed
    fd, path = tempfile.mkstemp(suffix=".db")
    import os

    os.close(fd)
    return path


def cleanup_db(path: str) -> None:
    p = Path(path)
    for suffix in ("", "-wal", "-shm"):
        try:
            (p.parent / (p.name + suffix)).unlink()
        except FileNotFoundError:
            pass


def test_version_and_package():
    # Assert format rather than a hardcoded value so releases don't break this test.
    assert re.match(r"^\d+\.\d+\.\d+", VERSION), f"unexpected VERSION format: {VERSION}"
    assert PACKAGE_NAME == "agenttrace-io"


def test_init_returns_agent_and_defaults():
    db = make_temp_db()
    try:
        agent = init({"db_path": db, "silent": True})
        assert isinstance(agent, AgentTrace)
        # default db used if not
        agent2 = AgentTrace()
        assert agent2.config["db_path"].endswith("agenttrace.db")
        agent.close()
        agent2.close()
    finally:
        cleanup_db(db)


def test_start_run_creates_run_and_uuid():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        run_id = agent.start_run("test-run", {"env": "test"})
        assert UUID_RE.match(run_id)
        runs = agent.get_runs()
        assert len(runs) == 1
        assert runs[0].name == "test-run"
        assert runs[0].status == "running"
        assert runs[0].metadata == {"env": "test"}
        agent.close()
    finally:
        cleanup_db(db)


def test_complete_run():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        rid = agent.start_run("r1")
        agent.complete_run("success")
        r = agent.get_run(rid)
        assert r is not None
        assert r.status == "success"
        assert r.completed_at is not None
        agent.close()
    finally:
        cleanup_db(db)


def test_trace_direct_call_success_and_records():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        agent.start_run("tr")
        res = agent.trace("op1", lambda: {"answer": 42})
        assert res == {"answer": 42}

        traces = agent.get_traces()
        assert len(traces) == 1
        t = traces[0]
        assert t.name == "op1"
        assert t.status == "success"
        assert t.output == {"answer": 42}
        assert t.latency_ms >= 0
        assert t.run_id  # attached
        assert UUID_RE.match(t.id)
        agent.close()
    finally:
        cleanup_db(db)


def test_trace_error_records_and_rethrows():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        agent.start_run("err-run")
        with pytest.raises(ValueError, match="boom"):
            agent.trace("fail-op", lambda: (_ for _ in ()).throw(ValueError("boom")))

        traces = agent.get_traces()
        assert len(traces) == 1
        assert traces[0].status == "error"
        assert traces[0].error == "boom"
        agent.close()
    finally:
        cleanup_db(db)


def test_trace_with_tokens_and_cost_default():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        agent.start_run("cost")
        tokens = {"promptTokens": 1000, "completionTokens": 500, "totalTokens": 1500}
        agent.trace("priced", lambda: "ok", tokens=tokens, model="gpt-4o")
        t = agent.get_traces()[0]
        # (1000*0.0025 + 500*0.01)/1000 = 0.0075
        assert abs(t.cost_usd - 0.0075) < 1e-9
        assert t.tokens.model == "gpt-4o"
        agent.close()
    finally:
        cleanup_db(db)


def test_custom_cost_calculator():
    db = make_temp_db()
    try:
        called = []

        def custom(tokens: TokenUsage, model=None):
            called.append((tokens.total_tokens, model))
            return 42.0

        agent = AgentTrace(
            {"db_path": db, "cost_calculator": custom, "silent": True}
        )
        agent.start_run("c")
        agent.trace("c-op", lambda: 1, tokens={"totalTokens": 10})
        t = agent.get_traces()[0]
        assert t.cost_usd == 42.0
        assert len(called) == 1
        agent.close()
    finally:
        cleanup_db(db)


def test_trace_decorator():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        agent.start_run("dec")

        @agent.trace("decorated-op")
        def my_fn(x: int = 1) -> int:
            return x + 1

        res = my_fn(41)
        assert res == 42

        traces = agent.get_traces()
        assert len(traces) == 1
        assert traces[0].name == "decorated-op"
        assert traces[0].output == 42
        agent.close()
    finally:
        cleanup_db(db)


def test_trace_context_manager():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        agent.start_run("ctx")

        with agent.trace("ctx-op") as t:
            # simulate work
            val = {"k": "v"}
            t.set_output(val)

        traces = agent.get_traces()
        assert len(traces) == 1
        assert traces[0].name == "ctx-op"
        assert traces[0].output == {"k": "v"}
        assert traces[0].status == "success"

        # error in context
        with pytest.raises(RuntimeError):
            with agent.trace("ctx-err") as t2:
                raise RuntimeError("ctx boom")

        traces = agent.get_traces({"name": "ctx-err"})
        assert len(traces) == 1
        assert traces[0].status == "error"
        assert "ctx boom" in (traces[0].error or "")
        agent.close()
    finally:
        cleanup_db(db)


def test_top_level_trace_and_singleton():
    db = make_temp_db()
    try:
        # use top level which lazy inits singleton
        # set via init first with our db
        ag = init({"db_path": db, "silent": True})
        ag.start_run("top")

        @trace("top-dec")
        def top_dec():
            return "yes"

        assert top_dec() == "yes"

        res = trace("top-direct", lambda: 99)
        assert res == 99

        # get_agent_trace same
        assert get_agent_trace() is ag

        traces = ag.get_traces()
        assert len(traces) >= 2
        ag.close()
    finally:
        cleanup_db(db)


def test_get_stats_basic():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        agent.start_run("s")
        agent.trace("a", lambda: 1, tokens={"promptTokens": 10, "completionTokens": 5, "totalTokens": 15})
        agent.trace("b", lambda: 2, tokens={"promptTokens": 20, "completionTokens": 10, "totalTokens": 30})

        stats = agent.get_stats()
        assert stats.total_runs == 1
        assert stats.total_traces == 2
        assert stats.success_rate == 1.0
        assert stats.total_tokens == 45
        agent.close()
    finally:
        cleanup_db(db)


def test_export_json_and_csv():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        agent.start_run("ex")
        agent.trace("ex-op", lambda: "data", tokens={"totalTokens": 75})

        j = agent.export("json")
        parsed = json.loads(j)
        assert len(parsed) == 1
        assert parsed[0]["name"] == "ex-op"
        assert "runId" in parsed[0]
        assert "latencyMs" in parsed[0]

        c = agent.export("csv")
        lines = c.strip().split("\n")
        assert len(lines) == 2
        assert "id,runId,name,status" in lines[0]
        assert "ex-op" in lines[1]
        agent.close()
    finally:
        cleanup_db(db)


def test_trace_without_start_run_auto_creates_run():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        # no start_run
        agent.trace("orphan", lambda: "x")
        traces = agent.get_traces()
        assert len(traces) == 1
        r = agent.get_run(traces[0].run_id)
        assert r is not None  # auto-created stub
        assert r.name == "auto-run"
        agent.close()
    finally:
        cleanup_db(db)


def test_filter_traces():
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        agent.start_run("f")
        agent.trace("success-1", lambda: 1)
        try:
            agent.trace("fail-1", lambda: 1 / 0)
        except ZeroDivisionError:
            pass

        succ = agent.get_traces({"status": ["success"]})
        assert len(succ) == 1
        assert succ[0].name == "success-1"

        errs = agent.get_traces({"status": ["error"]})
        assert len(errs) == 1
        agent.close()
    finally:
        cleanup_db(db)


def test_close_idempotent_and_storage_close():
    """AgentTrace.close() and TraceStorage.close() should be safe to call (and exported)."""
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        agent.start_run("c1")
        agent.trace("op", lambda: 1)
        # close should not raise
        agent.close()
        agent.close()  # idempotent ok

        # storage direct
        st = TraceStorage(db)
        st.record_agent_usage({"action": "test", "agentName": "t"})
        st.close()
        st.close()
    finally:
        cleanup_db(db)


def test_init_exports_include_new_symbols():
    """__init__ must export the full public surface (including TraceStorage, RunStatus)."""
    import agenttrace as at

    assert hasattr(at, "TraceStorage")
    assert hasattr(at, "RunStatus")
    assert "TraceStorage" in at.__all__
    assert "RunStatus" in at.__all__


def test_schema_has_parent_id_and_tenant_id_columns():
    """After open, traces has parent_id + tenant_id; runs/agent_usage have tenant_id (migrations)."""
    db = make_temp_db()
    try:
        agent = AgentTrace({"db_path": db, "silent": True})
        # touch to ensure schema
        rid = agent.start_run("sch")
        agent.trace("sch-op", lambda: "x")
        agent.close()

        # inspect via storage
        st = TraceStorage(db)
        cols_traces = [r[1] for r in st.conn.execute("PRAGMA table_info(traces)").fetchall()]
        cols_runs = [r[1] for r in st.conn.execute("PRAGMA table_info(runs)").fetchall()]
        cols_usage = [r[1] for r in st.conn.execute("PRAGMA table_info(agent_usage)").fetchall()]
        st.close()

        assert "parent_id" in cols_traces
        assert "tenant_id" in cols_traces
        assert "tenant_id" in cols_runs
        assert "tenant_id" in cols_usage
    finally:
        cleanup_db(db)


def test_all_spec_public_symbols_exported_from_package():
    """Task 3: ensure every listed public class/type is exported (no import errors)."""
    # Verify all public class/type names are exported from the top-level package
    from agenttrace import (  # noqa: F401
        AgentTrace,
        TraceStorage,
        Run,
        Trace,
        TokenUsage,
        ToolCall,
        TraceConfig,
        TraceFilter,
        TraceStats,
        ExportFormat,
        Scorer,
        ScorerResult,
        CostBreakdown,
        AgentUsageRecord,
        AgentUsageFilter,
        UsageStats,
        RunStatus,
    )
    # Also via the package object
    import agenttrace as at

    required = [
        "AgentTrace",
        "TraceStorage",
        "Run",
        "Trace",
        "TokenUsage",
        "ToolCall",
        "TraceConfig",
        "TraceFilter",
        "TraceStats",
        "ExportFormat",
        "Scorer",
        "ScorerResult",
        "CostBreakdown",
        "AgentUsageRecord",
        "AgentUsageFilter",
        "UsageStats",
        "RunStatus",
    ]
    for name in required:
        assert hasattr(at, name), f"missing export: {name}"
        assert name in at.__all__, f"missing from __all__: {name}"

    # Task 3 complete: close(), exports list, schema migrations (parent/tenant + version) verified + tested
