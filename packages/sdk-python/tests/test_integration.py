"""
Integration tests for AgentTrace Python SDK with real SQLite.
Mirrors the spirit of packages/sdk/src/integration.test.ts
"""

import json
import tempfile
from pathlib import Path

import pytest

from agenttrace import AgentTrace


def _temp_db() -> tuple[str, callable]:
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


class TestAgentTraceIntegration:
    def setup_method(self):
        self.db_path, self.cleanup = _temp_db()
        self.agent = AgentTrace({"db_path": self.db_path, "silent": True})

    def teardown_method(self):
        self.agent.close()
        self.cleanup()

    def test_trace_simple_function(self):
        run_id = self.agent.start_run("test-run")
        result = self.agent.trace(
            "test-op",
            lambda: "hello world",
            input={"query": "test"},
            tokens={
                "promptTokens": 100,
                "completionTokens": 50,
                "totalTokens": 150,
                "model": "gpt-4o",
            },
        )
        assert result == "hello world"

        traces = self.agent.get_traces({"run_id": run_id})
        assert len(traces) == 1
        t = traces[0]
        assert t.name == "test-op"
        assert t.status == "success"
        assert t.tokens.total_tokens == 150
        assert t.input == {"query": "test"}

    def test_trace_failures(self):
        run_id = self.agent.start_run("failing-run")
        with pytest.raises(RuntimeError, match="test error"):
            self.agent.trace("fail-op", lambda: (_ for _ in ()).throw(RuntimeError("test error")))

        traces = self.agent.get_traces({"run_id": run_id})
        assert len(traces) == 1
        assert traces[0].status == "error"
        assert traces[0].error == "test error"

    def test_calculate_stats(self):
        self.agent.start_run("stats-run")
        self.agent.trace(
            "op-1",
            lambda: "ok",
            tokens={"promptTokens": 100, "completionTokens": 50, "totalTokens": 150},
        )
        self.agent.trace(
            "op-2",
            lambda: "ok",
            tokens={"promptTokens": 200, "completionTokens": 100, "totalTokens": 300},
        )

        stats = self.agent.get_stats()
        assert stats.total_runs == 1
        assert stats.total_traces == 2
        assert stats.success_rate == 1.0
        assert stats.total_tokens == 450

    def test_export_json(self):
        self.agent.start_run("export-run")
        self.agent.trace(
            "export-op",
            lambda: "data",
            tokens={"promptTokens": 50, "completionTokens": 25, "totalTokens": 75},
        )
        j = self.agent.export("json")
        parsed = json.loads(j)
        assert len(parsed) == 1
        assert parsed[0]["name"] == "export-op"
        assert "runId" in parsed[0]

    def test_export_csv(self):
        self.agent.start_run("csv-run")
        self.agent.trace(
            "csv-op",
            lambda: "data",
            tokens={"promptTokens": 50, "completionTokens": 25, "totalTokens": 75},
        )
        csv = self.agent.export("csv")
        lines = csv.strip().split("\n")
        assert len(lines) == 2
        assert "id,runId,name,status" in lines[0]

    def test_filter_by_status(self):
        self.agent.start_run("filter-run")
        self.agent.trace(
            "success-op",
            lambda: "ok",
            tokens={"promptTokens": 10, "completionTokens": 5, "totalTokens": 15},
        )
        with pytest.raises(ZeroDivisionError):
            self.agent.trace("fail-op", lambda: 1 / 0)

        success_traces = self.agent.get_traces({"status": ["success"]})
        assert len(success_traces) == 1
        assert success_traces[0].status == "success"

        failed = self.agent.get_traces({"status": ["error"]})
        assert len(failed) == 1
        assert failed[0].status == "error"

    def test_context_manager_and_decorator_integration(self):
        self.agent.start_run("mixed")
        results = []

        @self.agent.trace("dec-op")
        def decorated():
            results.append("dec")
            return 7

        assert decorated() == 7

        with self.agent.trace("ctx-op") as t:
            results.append("ctx")
            t.set_output("from-ctx")

        traces = self.agent.get_traces()
        names = {tr.name for tr in traces}
        assert "dec-op" in names
        assert "ctx-op" in names
        ctx_t = [tr for tr in traces if tr.name == "ctx-op"][0]
        assert ctx_t.output == "from-ctx"

    def test_async_context_manager_compatibility(self):
        # Even though storage is sync, async with should work for bodies containing awaits
        import asyncio

        self.agent.start_run("async-ctx")

        async def run_async_body():
            async with self.agent.trace("async-with-op") as t:
                await asyncio.sleep(0)
                t.set_output("async-result")
                return "done"

        result = asyncio.run(run_async_body())
        assert result == "done"

        traces = self.agent.get_traces()
        assert any(tr.name == "async-with-op" and tr.output == "async-result" for tr in traces)
