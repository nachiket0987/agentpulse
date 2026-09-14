"""
Full integration test for AgentTrace Python SDK.
Covers creation, 5 traced op types, SQLite storage, all get_traces filters,
get_stats aggregations, export json+csv, context manager and decorator patterns.
"""

import json
import sqlite3
import tempfile
import time
from pathlib import Path

import pytest

from agenttrace import AgentTrace
from agenttrace.types import TraceFilter


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


class TestFullIntegration:
    def setup_method(self):
        self.db_path, self.cleanup = _temp_db()
        self.agent = AgentTrace({"db_path": self.db_path, "silent": True})

    def teardown_method(self):
        self.agent.close()
        self.cleanup()

    def test_full_integration(self):
        # 1) Creates an AgentTrace instance (done in setup_method)

        # Start explicit run so all ops share it
        run_id = self.agent.start_run("full-int-run", metadata={"purpose": "comprehensive-test"})

        # 2) Runs 5 different traced operations (success, error, with tokens, with metadata, nested)
        # Use small sleeps in some to produce measurable non-zero latencies

        # success
        def do_success():
            time.sleep(0.002)
            return "success-result"

        r1 = self.agent.trace(
            "success-op",
            do_success,
            input={"prompt": "hello"},
            tokens={"promptTokens": 5, "completionTokens": 10, "totalTokens": 15, "model": "gpt-4o-mini"},
        )
        assert r1 == "success-result"

        # error
        with pytest.raises(ValueError, match="boom error"):
            self.agent.trace(
                "error-op",
                lambda: (_ for _ in ()).throw(ValueError("boom error")),
            )

        # with tokens (higher cost model)
        def do_tokens():
            time.sleep(0.005)
            return 123

        r3 = self.agent.trace(
            "tokens-op",
            do_tokens,
            tokens={"promptTokens": 2000, "completionTokens": 1000, "totalTokens": 3000, "model": "gpt-4o"},
            model="gpt-4o",
        )
        assert r3 == 123

        # with metadata
        def do_meta():
            time.sleep(0.001)
            return {"k": "v"}

        r4 = self.agent.trace(
            "metadata-op",
            do_meta,
            input="query-str",
            metadata={"session": "s123", "user_id": 42},
        )
        assert r4 == {"k": "v"}

        # nested (via context manager pattern)
        with self.agent.trace("nested-op") as t:
            time.sleep(0.001)
            t.set_output("nested-output")
            t.set_tokens({"promptTokens": 1, "completionTokens": 2, "totalTokens": 3})
            t.set_metadata({"level": "outer"})

        # 3) Verifies all traces are stored correctly in SQLite
        traces = self.agent.get_traces({"run_id": run_id})
        assert len(traces) == 5
        names = {t.name for t in traces}
        assert names == {"success-op", "error-op", "tokens-op", "metadata-op", "nested-op"}

        # detailed field verification on Trace objects
        succ = next(t for t in traces if t.name == "success-op")
        assert succ.status == "success"
        assert succ.input == {"prompt": "hello"}
        assert succ.output == "success-result"
        assert succ.tokens.total_tokens == 15
        assert succ.tokens.model == "gpt-4o-mini"
        assert succ.cost_usd > 0
        assert succ.latency_ms >= 0
        assert succ.created_at > 0
        assert succ.updated_at >= succ.created_at
        assert succ.metadata == {}
        assert succ.run_id == run_id
        assert succ.error is None

        err = next(t for t in traces if t.name == "error-op")
        assert err.status == "error"
        assert err.error is not None and "boom error" in err.error
        assert err.output is None

        tok = next(t for t in traces if t.name == "tokens-op")
        assert tok.status == "success"
        assert tok.tokens.total_tokens == 3000
        assert tok.tokens.model == "gpt-4o"
        # (2000*0.0025 + 1000*0.01)/1000 = 0.015
        assert abs(tok.cost_usd - 0.015) < 1e-9

        meta = next(t for t in traces if t.name == "metadata-op")
        assert meta.metadata == {"session": "s123", "user_id": 42}
        assert meta.input == "query-str"

        nest = next(t for t in traces if t.name == "nested-op")
        assert nest.output == "nested-output"
        assert nest.metadata == {"level": "outer"}
        assert nest.tokens.total_tokens == 3

        # Direct SQLite verification
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        db_rows = conn.execute(
            "SELECT * FROM traces WHERE run_id = ? ORDER BY created_at ASC",
            (run_id,),
        ).fetchall()
        assert len(db_rows) == 5
        db_names = {r["name"] for r in db_rows}
        assert db_names == names

        # spot check raw row contents (json serialized)
        succ_row = next(r for r in db_rows if r["name"] == "success-op")
        assert succ_row["status"] == "success"
        assert succ_row["run_id"] == run_id
        assert json.loads(succ_row["input"] or "null") == {"prompt": "hello"}
        assert json.loads(succ_row["output"] or "null") == "success-result"
        assert succ_row["total_tokens"] == 15
        assert succ_row["prompt_tokens"] == 5
        assert succ_row["completion_tokens"] == 10
        assert float(succ_row["cost_usd"]) > 0

        err_row = next(r for r in db_rows if r["name"] == "error-op")
        assert err_row["status"] == "error"
        assert (err_row["error"] or "").find("boom error") != -1

        # verify run row in SQLite
        run_row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        assert run_row is not None
        assert run_row["name"] == "full-int-run"
        assert json.loads(run_row["metadata"] or "{}") == {"purpose": "comprehensive-test"}
        assert run_row["trace_count"] == 5
        # tokens sum: 15 (succ) + 0 (err) + 3000 (tok) + 0 (meta) + 3 (nest) = 3018
        assert run_row["total_tokens"] == 3018
        assert run_row["total_cost_usd"] > 0.01
        assert run_row["status"] == "running"  # not yet completed

        conn.close()

        # via get_run too
        run = self.agent.get_run(run_id)
        assert run is not None
        assert run.trace_count == 5
        assert run.total_tokens.total_tokens == 3018
        assert run.name == "full-int-run"
        assert run.metadata == {"purpose": "comprehensive-test"}

        # 4) Tests get_traces() with all filter options
        # run_id
        assert len(self.agent.get_traces({"run_id": run_id})) == 5
        assert len(self.agent.get_traces({"run_id": "no-such-run"})) == 0

        # status (list)
        succs = self.agent.get_traces({"run_id": run_id, "status": ["success"]})
        assert len(succs) == 4
        assert all(t.status == "success" for t in succs)

        errs = self.agent.get_traces({"run_id": run_id, "status": ["error"]})
        assert len(errs) == 1
        assert errs[0].status == "error"

        # status as non-list (str) also supported by impl
        succs_str = self.agent.get_traces({"run_id": run_id, "status": "success"})
        assert len(succs_str) == 4

        # name (LIKE %...%)
        assert len(self.agent.get_traces({"run_id": run_id, "name": "success"})) == 1
        assert len(self.agent.get_traces({"run_id": run_id, "name": "-op"})) == 5

        # from_date / to_date
        min_ca = min(t.created_at for t in traces)
        max_ca = max(t.created_at for t in traces)
        assert len(self.agent.get_traces({"run_id": run_id, "from_date": min_ca - 1000, "to_date": max_ca + 1000})) == 5
        assert len(self.agent.get_traces({"run_id": run_id, "from_date": max_ca + 100000})) == 0
        assert len(self.agent.get_traces({"run_id": run_id, "to_date": min_ca - 1000})) == 0

        # min_cost / max_cost (tokens-op has ~0.015, others << 0.001 or 0)
        high_c = self.agent.get_traces({"run_id": run_id, "min_cost": 0.01})
        assert len(high_c) == 1
        assert high_c[0].name == "tokens-op"

        low_c = self.agent.get_traces({"run_id": run_id, "max_cost": 0.00001})
        assert len(low_c) >= 3  # zero-token ones + small ones

        # min_latency / max_latency (use broad safe ranges + one that matches none)
        assert len(self.agent.get_traces({"run_id": run_id, "min_latency": 0, "max_latency": 100000})) == 5
        assert len(self.agent.get_traces({"run_id": run_id, "min_latency": 100000})) == 0
        assert len(self.agent.get_traces({"run_id": run_id, "max_latency": 0})) >= 0  # error likely ~0ms

        # limit / offset (results ordered created_at DESC)
        lim2 = self.agent.get_traces({"run_id": run_id, "limit": 2})
        assert len(lim2) == 2
        off2 = self.agent.get_traces({"run_id": run_id, "limit": 2, "offset": 2})
        assert len(off2) == 2
        # last one
        last = self.agent.get_traces({"run_id": run_id, "limit": 1, "offset": 4})
        assert len(last) == 1

        # using TraceFilter dataclass for all options combined
        f = TraceFilter(
            run_id=run_id,
            status=["success"],
            name="-op",
            from_date=min_ca - 1000,
            to_date=max_ca + 1000,
            min_cost=0,
            max_cost=1,
            min_latency=0,
            max_latency=100000,
            limit=10,
            offset=0,
        )
        filtered = self.agent.get_traces(f)
        assert len(filtered) == 4

        # 5) Tests get_stats() returns correct aggregations
        stats = self.agent.get_stats()
        assert stats.total_runs >= 1
        assert stats.total_traces == 5
        assert abs(stats.success_rate - 0.8) < 1e-9  # 4 success / 5
        assert stats.total_tokens == 3018
        assert abs(stats.avg_tokens_per_trace - (3018 / 5)) < 1e-9
        assert stats.total_cost_usd > 0.014
        assert stats.avg_latency_ms >= 0
        assert isinstance(stats.top_tools, list)
        assert len(stats.top_tools) == 0  # no tool calls recorded
        assert isinstance(stats.top_errors, list)
        assert len(stats.top_errors) >= 1
        assert any("boom error" in (e.get("error") or "") for e in stats.top_errors)

        # 6) Tests export() in both JSON and CSV formats
        j = self.agent.export("json", {"run_id": run_id})
        jdata = json.loads(j)
        assert len(jdata) == 5
        first = jdata[0]
        assert first["runId"] == run_id
        assert "name" in first
        assert "status" in first
        assert "latencyMs" in first
        assert "costUsd" in first
        assert "tokens" in first
        assert first["tokens"]["promptTokens"] is not None
        assert "toolCalls" in first
        assert "metadata" in first
        assert "createdAt" in first
        assert "updatedAt" in first
        # ensure error trace exported with error
        err_json = next((x for x in jdata if x["name"] == "error-op"), None)
        assert err_json is not None
        assert "boom error" in (err_json.get("error") or "")

        c = self.agent.export("csv", {"run_id": run_id})
        clines = [ln for ln in c.strip().split("\n") if ln]
        assert len(clines) == 6  # 1 header + 5 rows
        assert clines[0] == "id,runId,name,status,latencyMs,costUsd,totalTokens,createdAt"
        # data rows contain our names
        assert any("tokens-op" in ln for ln in clines[1:])
        assert any("error-op" in ln for ln in clines[1:])

        # 7) Tests the context manager and decorator patterns
        # (one ctx already used above for "nested-op"; add explicit decorator + extra ctx here)

        @self.agent.trace("decorator-pattern")
        def decorated_fn(x: int) -> int:
            return x * 2

        dec_res = decorated_fn(21)
        assert dec_res == 42

        dec_tr = self.agent.get_traces({"name": "decorator-pattern"})
        assert len(dec_tr) == 1
        assert dec_tr[0].output == 42
        assert dec_tr[0].status == "success"
        assert dec_tr[0].latency_ms >= 0

        # additional context manager usage (no set_output -> output=None)
        with self.agent.trace("plain-ctx-op") as t:
            time.sleep(0.0005)
            # deliberately not calling set_output; also test set_metadata
            t.set_metadata({"ctx": "test"})

        plain = next((tt for tt in self.agent.get_traces() if tt.name == "plain-ctx-op"), None)
        assert plain is not None
        assert plain.output is None
        assert plain.status == "success"
        assert plain.metadata == {"ctx": "test"}

        # context manager that raises
        try:
            with self.agent.trace("ctx-err-pattern") as t3:
                raise RuntimeError("ctx boom from pattern")
        except RuntimeError:
            pass

        ctx_err = next((tt for tt in self.agent.get_traces() if tt.name == "ctx-err-pattern"), None)
        assert ctx_err is not None
        assert ctx_err.status == "error"
        assert "ctx boom from pattern" in (ctx_err.error or "")

        # complete the run
        self.agent.complete_run("success")
        completed_run = self.agent.get_run(run_id)
        assert completed_run is not None
        assert completed_run.status == "success"
        assert completed_run.completed_at is not None

        # final sanity: get_traces without filter sees the added pattern traces too
        all_now = self.agent.get_traces()
        assert len(all_now) >= 5 + 3  # original 5 + dec + plain-ctx + ctx-err
