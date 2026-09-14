"""
Tests for CrewAI middleware (direct hook invocation; no crewai runtime required).
"""

import tempfile
from pathlib import Path

import pytest

from agenttrace_middleware import AgentTraceCrewAI
from agenttrace import AgentTrace
from agenttrace.types import TokenUsage


def make_temp_db() -> tuple[str, callable]:
    fd, path = tempfile.mkstemp(suffix=".db")
    import os

    os.close(fd)

    def cleanup():
        p = Path(path)
        for s in ("", "-wal", "-shm"):
            try:
                (p.parent / (p.name + s)).unlink(missing_ok=True)
            except Exception:
                pass

    return path, cleanup


class _FakeTaskStart:
    def __init__(self, task_id="t1", name="research", description="do research"):
        self.task_id = task_id
        self.name = name
        self.description = description


class _FakeTaskEnd:
    def __init__(self, task_id="t1", output="done", usage=None):
        self.task_id = task_id
        self.output = output
        self.usage = usage  # simulate crewai usage attr


class _FakeTaskError:
    def __init__(self, task_id="t1", error="boom"):
        self.task_id = task_id
        self.error = error


class _FakeToolStart:
    def __init__(self, tool_id="tool1", name="search", tool_input={"q": "x"}):
        self.tool_id = tool_id
        self.name = name
        self.tool_input = tool_input


class _FakeToolEnd:
    def __init__(self, tool_id="tool1", output="result", usage=None):
        self.tool_id = tool_id
        self.output = output
        self.usage = usage


def test_version_exports():
    import re
    from agenttrace_middleware import VERSION, PACKAGE_NAME

    # Assert format rather than a hardcoded value so releases don't break this test.
    assert re.match(r"^\d+\.\d+\.\d+", VERSION), f"unexpected VERSION format: {VERSION}"
    assert PACKAGE_NAME == "agenttrace-io-middleware-crewai"


def test_task_and_tool_tracing_and_token_extraction():
    db, cleanup = make_temp_db()
    try:
        mw = AgentTraceCrewAI(db_path=db)
        inspector = AgentTrace({"db_path": db, "silent": True})

        # task start -> end with tokens
        mw.on_task_start(None, _FakeTaskStart(task_id="t1", name="research"))
        mw.on_task_end(
            None,
            _FakeTaskEnd(
                task_id="t1",
                output="research complete",
                usage={"prompt_tokens": 40, "completion_tokens": 10, "total_tokens": 50, "model": "gpt-4o-mini"},
            ),
        )

        # tool
        mw.on_tool_start(None, _FakeToolStart(tool_id="u1", name="web_search"))
        mw.on_tool_end(None, _FakeToolEnd(tool_id="u1", output={"hits": 3}))

        traces = inspector.get_traces()
        names = [t.name for t in traces]
        assert "task:research" in names
        assert "tool:web_search" in names

        task_trace = next(t for t in traces if t.name == "task:research")
        assert task_trace.status == "success"
        assert task_trace.tokens.prompt_tokens == 40
        assert task_trace.tokens.completion_tokens == 10
        assert task_trace.metadata["framework"] == "crewai"

        tool_trace = next(t for t in traces if t.name == "tool:web_search")
        assert tool_trace.status == "success"
        assert tool_trace.input == {"q": "x"}

        mw.close()
        inspector.close()
    finally:
        cleanup()


def test_task_error_recording():
    db, cleanup = make_temp_db()
    try:
        mw = AgentTraceCrewAI(db_path=db)
        inspector = AgentTrace({"db_path": db, "silent": True})

        mw.on_task_start(None, _FakeTaskStart(task_id="te", name="failing"))
        mw.on_task_error(None, _FakeTaskError(task_id="te", error="crew failed"))

        traces = inspector.get_traces()
        err_tr = next((t for t in traces if t.name == "task:failing"), None)
        assert err_tr is not None
        assert err_tr.status == "error"
        assert "crew failed" in (err_tr.error or "")

        mw.close()
        inspector.close()
    finally:
        cleanup()


def test_get_agent_and_close():
    db, cleanup = make_temp_db()
    try:
        mw = AgentTraceCrewAI(db_path=db)
        ag = mw.get_agent_trace()
        assert isinstance(ag, AgentTrace)
        rid = ag.start_run("crew-test")
        assert isinstance(rid, str)
        mw.close()
    finally:
        cleanup()


def test_middleware_captures_traced_call_and_run_context():
    """Integration style: start run then task/tool produce traces sharing the run (context propagation)."""
    db, cleanup = make_temp_db()
    try:
        mw = AgentTraceCrewAI(db_path=db)
        inspector = AgentTrace({"db_path": db, "silent": True})

        rid = mw.get_agent_trace().start_run("crew-ctx")
        mw.on_task_start(None, _FakeTaskStart(task_id="tctx", name="plan"))
        mw.on_task_end(None, _FakeTaskEnd(task_id="tctx", output="planned"))

        traces = inspector.get_traces()
        assert any(t.name == "task:plan" for t in traces)
        run_traces = [t for t in traces if t.run_id == rid]
        assert len(run_traces) >= 1

        mw.close()
        inspector.close()
    finally:
        cleanup()


def test_middleware_integration_captures_task_and_tool_with_run_propagation():
    """Task 2c addition: verify capture of calls + shared run context (no real crewai)."""
    db, cleanup = make_temp_db()
    try:
        mw = AgentTraceCrewAI(db_path=db)
        inspector = AgentTrace({"db_path": db, "silent": True})

        rid = mw.get_agent_trace().start_run("crew-int")
        mw.on_task_start(None, _FakeTaskStart(task_id="ti1", name="research"))
        mw.on_task_end(None, _FakeTaskEnd(task_id="ti1", output="researched", usage={"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}))
        mw.on_tool_start(None, _FakeToolStart(tool_id="to1", name="web"))
        mw.on_tool_end(None, _FakeToolEnd(tool_id="to1", output="ok"))

        traces = inspector.get_traces()
        names = [t.name for t in traces]
        assert "task:research" in names
        assert "tool:web" in names
        run_traces = [t for t in traces if t.run_id == rid]
        assert len(run_traces) >= 2
        for t in run_traces:
            assert t.run_id == rid

        mw.close()
        inspector.close()
    finally:
        cleanup()
