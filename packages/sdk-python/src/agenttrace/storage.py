"""
AgentTrace -- SQLite Storage Layer
Local storage for agent traces with zero cloud dependency
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

from .types import (
    AgentUsageFilter,
    AgentUsageRecord,
    CostBreakdown,
    Run,
    RunStatus,
    TokenUsage,
    ToolCall,
    Trace,
    TraceFilter,
    TraceStats,
    UsageStats,
)


class TraceStorage:
    """SQLite-backed storage for traces and runs. Matches TypeScript SDK schema."""

    def __init__(self, db_path: str = "./agenttrace.db") -> None:
        self.db_path = str(Path(db_path).expanduser().resolve())
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_pragmas()
        self._init_schema()

    def _init_pragmas(self) -> None:
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.commit()

    def _init_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                trace_count INTEGER DEFAULT 0,
                total_prompt_tokens INTEGER DEFAULT 0,
                total_completion_tokens INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                total_tool_calls INTEGER DEFAULT 0,
                total_latency_ms INTEGER DEFAULT 0,
                total_cost_usd REAL DEFAULT 0,
                error_count INTEGER DEFAULT 0,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                metadata TEXT DEFAULT '{}',
                tenant_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS traces (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                input TEXT,
                output TEXT,
                prompt_tokens INTEGER DEFAULT 0,
                completion_tokens INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                model TEXT,
                provider TEXT,
                latency_ms INTEGER DEFAULT 0,
                cost_usd REAL DEFAULT 0,
                error TEXT,
                metadata TEXT DEFAULT '{}',
                parent_id TEXT,
                tenant_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS tool_calls (
                id TEXT PRIMARY KEY,
                trace_id TEXT NOT NULL,
                name TEXT NOT NULL,
                input TEXT,
                output TEXT,
                latency_ms INTEGER DEFAULT 0,
                success INTEGER DEFAULT 1,
                error TEXT,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_traces_run_id ON traces(run_id);
            CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
            CREATE INDEX IF NOT EXISTS idx_traces_created_at ON traces(created_at);
            CREATE INDEX IF NOT EXISTS idx_traces_cost ON traces(cost_usd);
            CREATE INDEX IF NOT EXISTS idx_tool_calls_trace_id ON tool_calls(trace_id);
            CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(name);

            CREATE TABLE IF NOT EXISTS scores (
                id TEXT PRIMARY KEY,
                trace_id TEXT NOT NULL REFERENCES traces(id),
                name TEXT NOT NULL,
                value REAL NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_scores_trace_id ON scores(trace_id);
            CREATE INDEX IF NOT EXISTS idx_scores_name ON scores(name);

            CREATE TABLE IF NOT EXISTS agent_usage (
                id TEXT PRIMARY KEY,
                agent_name TEXT NOT NULL,
                agent_type TEXT,
                session_id TEXT,
                action TEXT NOT NULL,
                target TEXT,
                tokens_used INTEGER DEFAULT 0,
                cost_usd REAL DEFAULT 0,
                duration_ms INTEGER DEFAULT 0,
                status TEXT DEFAULT 'success',
                metadata TEXT DEFAULT '{}',
                tenant_id TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_agent_usage_agent_name ON agent_usage(agent_name);
            CREATE INDEX IF NOT EXISTS idx_agent_usage_session_id ON agent_usage(session_id);
            CREATE INDEX IF NOT EXISTS idx_agent_usage_action ON agent_usage(action);
            CREATE INDEX IF NOT EXISTS idx_agent_usage_status ON agent_usage(status);
            CREATE INDEX IF NOT EXISTS idx_agent_usage_created_at ON agent_usage(created_at);

            CREATE TABLE IF NOT EXISTS version (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        self.conn.commit()

        # Migration tracking + additive schema upgrades (parent_id, tenant_id on relevant tables)
        row = self.conn.execute(
            "SELECT value FROM version WHERE key = ?", ("schema_version",)
        ).fetchone()
        current_version = int(row[0]) if row else 0
        if current_version < 1:
            self.conn.execute(
                "INSERT OR REPLACE INTO version (key, value) VALUES (?, ?)", ("schema_version", "1")
            )
            self.conn.commit()
            current_version = 1

        # v2 adds tenant_id (and ensures parent_id) via ALTER for existing DBs; new DBs get them from CREATE
        if current_version < 2:
            self._ensure_column("runs", "tenant_id", "TEXT")
            self._ensure_column("traces", "parent_id", "TEXT")
            self._ensure_column("traces", "tenant_id", "TEXT")
            self._ensure_column("agent_usage", "tenant_id", "TEXT")
            self.conn.execute(
                "INSERT OR REPLACE INTO version (key, value) VALUES (?, ?)", ("schema_version", "2")
            )
            self.conn.commit()

    # ---- Run operations ----

    def _ensure_column(self, table: str, col: str, decl: str) -> None:
        """Add column to table if it does not already exist (idempotent migration helper).
        Uses string concatenation for the ALTER to avoid any brace interpolation issues.
        """
        try:
            info = self.conn.execute("PRAGMA table_info(" + table + ")").fetchall()
            cols = [r[1] for r in info]
            if col not in cols:
                sql = "ALTER TABLE " + table + " ADD COLUMN " + col + " " + decl
                self.conn.execute(sql)
                self.conn.commit()
        except Exception:
            # Best effort; column may already exist or DB is read-only etc.
            pass

    def create_run(
        self, run: dict[str, Any] | Run
    ) -> Run:
        if isinstance(run, Run):
            run_dict = {
                "id": run.id,
                "name": run.name,
                "startedAt": run.started_at or int(time.time() * 1000),
                "metadata": run.metadata or {},
            }
        else:
            run_dict = run

        now = int(time.time() * 1000)
        stmt = self.conn.execute(
            """
            INSERT INTO runs (id, name, status, started_at, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_dict["id"],
                run_dict["name"],
                "running",
                run_dict.get("startedAt") or now,
                json.dumps(run_dict.get("metadata") or {}),
                now,
                now,
            ),
        )
        self.conn.commit()
        got = self.get_run(run_dict["id"])
        if got is None:
            raise RuntimeError("Failed to retrieve created run")
        return got

    def get_run(self, id: str) -> Run | None:
        row = self.conn.execute("SELECT * FROM runs WHERE id = ?", (id,)).fetchone()
        if not row:
            return None
        return self._row_to_run(row)

    def get_runs(self, limit: int = 100) -> list[Run]:
        rows = self.conn.execute(
            "SELECT * FROM runs ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [self._row_to_run(r) for r in rows]

    def complete_run(self, id: str, status: RunStatus) -> None:
        now = int(time.time() * 1000)
        self.conn.execute(
            "UPDATE runs SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?",
            (status, now, now, id),
        )
        self.conn.commit()

    def update_run_stats(
        self,
        run_id: str,
        tokens: TokenUsage,
        tool_calls: int,
        latency_ms: int,
        cost_usd: float,
    ) -> None:
        now = int(time.time() * 1000)
        self.conn.execute(
            """
            UPDATE runs SET
                total_prompt_tokens = total_prompt_tokens + ?,
                total_completion_tokens = total_completion_tokens + ?,
                total_tokens = total_tokens + ?,
                total_tool_calls = total_tool_calls + ?,
                total_latency_ms = total_latency_ms + ?,
                total_cost_usd = total_cost_usd + ?,
                trace_count = trace_count + 1,
                updated_at = ?
            WHERE id = ?
            """,
            (
                tokens.prompt_tokens,
                tokens.completion_tokens,
                tokens.total_tokens,
                tool_calls,
                latency_ms,
                cost_usd,
                now,
                run_id,
            ),
        )
        self.conn.commit()

    # ---- Trace operations ----

    def create_trace(
        self, trace: Trace | dict[str, Any]
    ) -> Trace:
        if isinstance(trace, dict):
            # allow dict for internal
            t = trace
            tokens = t.get("tokens") or {}
            tool_calls = t.get("toolCalls") or t.get("tool_calls") or []
        else:
            t = {
                "id": trace.id,
                "runId": trace.run_id,
                "name": trace.name,
                "status": trace.status,
                "input": trace.input,
                "output": trace.output,
                "tokens": trace.tokens,
                "toolCalls": trace.tool_calls,
                "latencyMs": trace.latency_ms,
                "costUsd": trace.cost_usd,
                "error": trace.error,
                "metadata": trace.metadata,
            }
            tokens = trace.tokens
            tool_calls = trace.tool_calls

        now = int(time.time() * 1000)
        run_id = t["runId"] if "runId" in t else t.get("run_id")

        # Ensure the referenced run exists (create stub run for traces without explicit startRun)
        if run_id and not self.get_run(run_id):
            self.create_run(
                {
                    "id": run_id,
                    "name": f"run-{run_id[:8]}",
                    "startedAt": now,
                    "metadata": {},
                }
            )

        # Serialize
        input_json = self._safe_json(t.get("input"))
        output_json = self._safe_json(t.get("output"))
        meta_json = self._safe_json(t.get("metadata") or {})
        tok = tokens if isinstance(tokens, dict) else {
            "promptTokens": getattr(tokens, "prompt_tokens", 0),
            "completionTokens": getattr(tokens, "completion_tokens", 0),
            "totalTokens": getattr(tokens, "total_tokens", 0),
            "model": getattr(tokens, "model", None),
            "provider": getattr(tokens, "provider", None),
        }

        self.conn.execute(
            """
            INSERT INTO traces (
                id, run_id, name, status, input, output,
                prompt_tokens, completion_tokens, total_tokens, model, provider,
                latency_ms, cost_usd, error, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                t["id"],
                run_id,
                t["name"],
                t["status"],
                input_json,
                output_json,
                tok.get("promptTokens") or tok.get("prompt_tokens", 0),
                tok.get("completionTokens") or tok.get("completion_tokens", 0),
                tok.get("totalTokens") or tok.get("total_tokens", 0),
                tok.get("model"),
                tok.get("provider"),
                t.get("latencyMs") or t.get("latency_ms", 0),
                t.get("costUsd") or t.get("cost_usd", 0.0),
                t.get("error"),
                meta_json,
                now,
                now,
            ),
        )

        # Insert tool calls (support both camel and snake from input)
        tool_stmt = self.conn.execute  # for loop
        for tc in tool_calls:
            if isinstance(tc, dict):
                tc_id = tc.get("id")
                tc_name = tc.get("name")
                tc_input = tc.get("input")
                tc_output = tc.get("output")
                tc_lat = tc.get("latencyMs") or tc.get("latency_ms", 0)
                tc_succ = 1 if tc.get("success", True) else 0
                tc_err = tc.get("error")
                tc_ts = tc.get("timestamp") or now
            else:
                tc_id = tc.id
                tc_name = tc.name
                tc_input = tc.input
                tc_output = tc.output
                tc_lat = tc.latency_ms
                tc_succ = 1 if tc.success else 0
                tc_err = tc.error
                tc_ts = tc.timestamp or now
            self.conn.execute(
                """
                INSERT INTO tool_calls (id, trace_id, name, input, output, latency_ms, success, error, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tc_id,
                    t["id"],
                    tc_name,
                    self._safe_json(tc_input),
                    self._safe_json(tc_output),
                    tc_lat,
                    tc_succ,
                    tc_err,
                    tc_ts,
                ),
            )

        self.conn.commit()

        # Update run stats (only if run exists)
        if run_id:
            self.update_run_stats(
                run_id,
                TokenUsage(
                    prompt_tokens=tok.get("promptTokens") or tok.get("prompt_tokens", 0),
                    completion_tokens=tok.get("completionTokens") or tok.get("completion_tokens", 0),
                    total_tokens=tok.get("totalTokens") or tok.get("total_tokens", 0),
                ),
                len(tool_calls),
                t.get("latencyMs") or t.get("latency_ms", 0),
                float(t.get("costUsd") or t.get("cost_usd", 0.0)),
            )

        got = self.get_trace(t["id"])
        if got is None:
            raise RuntimeError("Failed to retrieve created trace")
        return got

    def get_trace(self, id: str) -> Trace | None:
        row = self.conn.execute("SELECT * FROM traces WHERE id = ?", (id,)).fetchone()
        if not row:
            return None
        return self._row_to_trace(row)

    def get_traces(self, filter: TraceFilter | dict[str, Any] | int = {}) -> list[Trace]:
        if isinstance(filter, int):
            filter = {"limit": filter}
        if isinstance(filter, dict):
            f = filter
        else:
            f = {
                "run_id": filter.run_id,
                "status": filter.status,
                "name": filter.name,
                "from_date": filter.from_date,
                "to_date": filter.to_date,
                "min_cost": filter.min_cost,
                "max_cost": filter.max_cost,
                "min_latency": filter.min_latency,
                "max_latency": filter.max_latency,
                "limit": filter.limit,
                "offset": filter.offset,
            }

        sql = "SELECT * FROM traces WHERE 1=1"
        params: list[Any] = []

        if f.get("run_id"):
            sql += " AND run_id = ?"
            params.append(f["run_id"])
        if f.get("status"):
            statuses = f["status"]
            if isinstance(statuses, str):
                statuses = [statuses]
            placeholders = ",".join("?" for _ in statuses)
            sql += f" AND status IN ({placeholders})"
            params.extend(statuses)
        if f.get("name"):
            sql += " AND name LIKE ?"
            params.append(f"%{f['name']}%")
        if f.get("from_date") is not None:
            sql += " AND created_at >= ?"
            params.append(f["from_date"])
        if f.get("to_date") is not None:
            sql += " AND created_at <= ?"
            params.append(f["to_date"])
        if f.get("min_cost") is not None:
            sql += " AND cost_usd >= ?"
            params.append(f["min_cost"])
        if f.get("max_cost") is not None:
            sql += " AND cost_usd <= ?"
            params.append(f["max_cost"])
        if f.get("min_latency") is not None:
            sql += " AND latency_ms >= ?"
            params.append(f["min_latency"])
        if f.get("max_latency") is not None:
            sql += " AND latency_ms <= ?"
            params.append(f["max_latency"])

        sql += " ORDER BY created_at DESC"

        if f.get("limit") is not None:
            sql += " LIMIT ?"
            params.append(f["limit"])
        if f.get("offset") is not None:
            sql += " OFFSET ?"
            params.append(f["offset"])

        rows = self.conn.execute(sql, params).fetchall()
        return [self._row_to_trace(r) for r in rows]

    # ---- Stats ----

    def get_stats(self) -> TraceStats:
        total_runs = self.conn.execute("SELECT COUNT(*) as c FROM runs").fetchone()["c"]
        total_traces = self.conn.execute("SELECT COUNT(*) as c FROM traces").fetchone()["c"]
        success_count = self.conn.execute(
            "SELECT COUNT(*) as c FROM traces WHERE status = 'success'"
        ).fetchone()["c"]
        avg_latency = self.conn.execute("SELECT AVG(latency_ms) as v FROM traces").fetchone()["v"]
        total_cost = self.conn.execute("SELECT SUM(cost_usd) as v FROM traces").fetchone()["v"]
        total_tokens = self.conn.execute("SELECT SUM(total_tokens) as v FROM traces").fetchone()["v"]

        top_tools_rows = self.conn.execute(
            """
            SELECT name, COUNT(*) as count, AVG(latency_ms) as avgLatencyMs
            FROM tool_calls GROUP BY name ORDER BY count DESC LIMIT 10
            """
        ).fetchall()

        top_errors_rows = self.conn.execute(
            """
            SELECT error, COUNT(*) as count FROM traces
            WHERE error IS NOT NULL AND error != ''
            GROUP BY error ORDER BY count DESC LIMIT 10
            """
        ).fetchall()

        return TraceStats(
            total_runs=total_runs or 0,
            total_traces=total_traces or 0,
            success_rate=(success_count / total_traces) if total_traces > 0 else 0.0,
            avg_latency_ms=avg_latency or 0.0,
            total_cost_usd=total_cost or 0.0,
            total_tokens=total_tokens or 0,
            avg_tokens_per_trace=(total_tokens / total_traces) if total_traces > 0 else 0.0,
            top_tools=[
                {
                    "name": r["name"],
                    "count": r["count"],
                    "avgLatencyMs": r["avgLatencyMs"] or 0,
                }
                for r in top_tools_rows
            ],
            top_errors=[
                {"error": r["error"], "count": r["count"]} for r in top_errors_rows
            ],
        )

    # ---- Cleanup ----

    def cleanup(self, max_traces: int = 10000) -> int:
        count_row = self.conn.execute("SELECT COUNT(*) as c FROM traces").fetchone()
        count = count_row["c"] if count_row else 0
        if count <= max_traces:
            return 0

        to_delete = count - max_traces
        self.conn.execute(
            """
            DELETE FROM traces WHERE id IN (
                SELECT id FROM traces ORDER BY created_at ASC LIMIT ?
            )
            """,
            (to_delete,),
        )
        self.conn.commit()
        return to_delete

    # ---- Scores (for evaluation) ----

    def create_score(self, id: str, trace_id: str, name: str, value: float) -> None:
        """Store a score for a trace (called by evaluate)."""
        now = int(time.time() * 1000)
        self.conn.execute(
            "INSERT INTO scores (id, trace_id, name, value, created_at) VALUES (?, ?, ?, ?, ?)",
            (id, trace_id, name, value, now),
        )
        self.conn.commit()

    def get_scores(
        self, trace_id: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """Retrieve scores, optionally for a specific trace. Matches TS shape (camelCase keys in dict)."""
        sql = "SELECT * FROM scores"
        params: list[Any] = []
        if trace_id:
            sql += " WHERE trace_id = ?"
            params.append(trace_id)
        sql += " ORDER BY created_at DESC"
        rows = self.conn.execute(sql, params).fetchall()
        return [
            {
                "id": r["id"],
                "traceId": r["trace_id"],
                "name": r["name"],
                "value": float(r["value"]),
                "createdAt": r["created_at"],
            }
            for r in rows
        ]

    # ---- Agent usage tracking (mirrors TS) ----

    def record_agent_usage(self, params: AgentUsageRecord | dict[str, Any]) -> None:
        """Insert an agent usage record."""
        if isinstance(params, dict):
            p = params
        else:
            p = {
                "id": params.id,
                "agentName": params.agent_name,
                "agentType": params.agent_type,
                "sessionId": params.session_id,
                "action": params.action,
                "target": params.target,
                "tokensUsed": params.tokens_used,
                "costUsd": params.cost_usd,
                "durationMs": params.duration_ms,
                "status": params.status,
                "metadata": params.metadata,
                "createdAt": params.created_at,
            }
        now = int(time.time() * 1000)
        self.conn.execute(
            """
            INSERT INTO agent_usage (id, tenant_id, agent_name, agent_type, session_id, action, target, tokens_used, cost_usd, duration_ms, status, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                p.get("id") or str(__import__("uuid").uuid4()),
                p.get("tenantId") or p.get("tenant_id"),
                p.get("agentName") or p.get("agent_name"),
                p.get("agentType") or p.get("agent_type"),
                p.get("sessionId") or p.get("session_id"),
                p.get("action"),
                p.get("target") or p.get("target"),
                p.get("tokensUsed") or p.get("tokens_used", 0),
                p.get("costUsd") or p.get("cost_usd", 0),
                p.get("durationMs") or p.get("duration_ms", 0),
                p.get("status") or "success",
                self._safe_json(p.get("metadata") or {}),
                p.get("createdAt") or p.get("created_at") or now,
            ),
        )
        self.conn.commit()

    def get_agent_usage(
        self, filter: AgentUsageFilter | dict[str, Any] = {}
    ) -> list[AgentUsageRecord]:
        """Query agent usage records with optional filters."""
        if isinstance(filter, dict):
            f = filter
        else:
            f = {
                "agent_name": filter.agent_name,
                "agent_type": filter.agent_type,
                "action": filter.action,
                "status": filter.status,
                "from_date": filter.from_date,
                "to_date": filter.to_date,
                "limit": filter.limit,
                "offset": filter.offset,
                "session_id": getattr(filter, "session_id", None),
            }

        sql = "SELECT * FROM agent_usage WHERE 1=1"
        params: list[Any] = []

        if f.get("agent_name"):
            sql += " AND agent_name = ?"
            params.append(f["agent_name"])
        if f.get("agent_type"):
            sql += " AND agent_type = ?"
            params.append(f["agent_type"])
        if f.get("action"):
            sql += " AND action = ?"
            params.append(f["action"])
        if f.get("status"):
            statuses = f["status"]
            if isinstance(statuses, str):
                statuses = [statuses]
            placeholders = ",".join("?" for _ in statuses)
            sql += f" AND status IN ({placeholders})"
            params.extend(statuses)
        if f.get("from_date") is not None:
            sql += " AND created_at >= ?"
            params.append(f["from_date"])
        if f.get("to_date") is not None:
            sql += " AND created_at <= ?"
            params.append(f["to_date"])
        if f.get("session_id"):
            sql += " AND session_id = ?"
            params.append(f["session_id"])

        sql += " ORDER BY created_at DESC"

        if f.get("limit") is not None:
            sql += " LIMIT ?"
            params.append(f["limit"])
        if f.get("offset") is not None:
            sql += " OFFSET ?"
            params.append(f["offset"])

        rows = self.conn.execute(sql, params).fetchall()
        return [self._row_to_agent_usage(r) for r in rows]

    def get_usage_stats(
        self, agent_name: Optional[str] = None, from_date: Optional[int] = None, to_date: Optional[int] = None
    ) -> UsageStats:
        """Return aggregated usage stats, optionally filtered by agent and date range."""
        where_parts: list[str] = []
        params: list[Any] = []
        if agent_name:
            where_parts.append("agent_name = ?")
            params.append(agent_name)
        if from_date is not None:
            where_parts.append("created_at >= ?")
            params.append(from_date)
        if to_date is not None:
            where_parts.append("created_at <= ?")
            params.append(to_date)
        where = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""

        total_actions_row = self.conn.execute(
            f"SELECT COUNT(*) as c FROM agent_usage{where}", params
        ).fetchone()
        total_actions = total_actions_row["c"] if total_actions_row else 0

        total_agents_row = self.conn.execute(
            f"SELECT COUNT(DISTINCT agent_name) as c FROM agent_usage{where}", params
        ).fetchone()
        total_agents = total_agents_row["c"] if total_agents_row else 0

        totals_row = self.conn.execute(
            f"""SELECT 
                  COALESCE(SUM(tokens_used), 0) as tokens,
                  COALESCE(SUM(cost_usd), 0) as cost,
                  COALESCE(AVG(duration_ms), 0) as avg_dur
                 FROM agent_usage{where}""",
            params,
        ).fetchone()
        total_tokens = totals_row["tokens"] if totals_row else 0
        total_cost_usd = totals_row["cost"] if totals_row else 0.0
        avg_duration_ms = totals_row["avg_dur"] if totals_row else 0.0

        by_type_rows = self.conn.execute(
            f"SELECT action, COUNT(*) as count FROM agent_usage{where} GROUP BY action ORDER BY count DESC",
            params,
        ).fetchall()
        actions_by_type: dict[str, int] = {}
        for r in by_type_rows:
            actions_by_type[r["action"]] = r["count"]

        top_rows = self.conn.execute(
            f"""SELECT 
                  agent_name,
                  COUNT(*) as actions,
                  COALESCE(SUM(tokens_used), 0) as tokens,
                  COALESCE(SUM(cost_usd), 0) as cost
                 FROM agent_usage{where} 
                 GROUP BY agent_name 
                 ORDER BY actions DESC, cost DESC 
                 LIMIT 10""",
            params,
        ).fetchall()
        top_agents: list[dict[str, Any]] = [
            {
                "agentName": r["agent_name"],
                "actions": r["actions"],
                "tokens": r["tokens"],
                "costUsd": r["cost"],
            }
            for r in top_rows
        ]

        return UsageStats(
            total_agents=total_agents or 0,
            total_actions=total_actions or 0,
            total_tokens=total_tokens or 0,
            total_cost_usd=total_cost_usd or 0.0,
            avg_duration_ms=avg_duration_ms or 0.0,
            actions_by_type=actions_by_type,
            top_agents=top_agents,
        )

    def get_cost_breakdown(self, run_id: Optional[str] = None) -> CostBreakdown:
        """Get total + by-model + by-day cost breakdown (matches TS)."""
        where = " WHERE run_id = ?" if run_id else ""
        params: list[Any] = [run_id] if run_id else []

        total_row = self.conn.execute(
            f"SELECT COALESCE(SUM(cost_usd), 0) as v FROM traces{where}", params
        ).fetchone()
        total = float(total_row["v"]) if total_row else 0.0

        model_rows = self.conn.execute(
            f"SELECT COALESCE(model, 'unknown') as model, COALESCE(SUM(cost_usd), 0) as cost FROM traces{where} GROUP BY model",
            params,
        ).fetchall()
        cost_by_model: dict[str, float] = {}
        for r in model_rows:
            cost_by_model[str(r["model"])] = float(r["cost"] or 0)

        day_rows = self.conn.execute(
            f"""SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') as day, COALESCE(SUM(cost_usd), 0) as cost
                FROM traces{where} GROUP BY day ORDER BY day""",
            params,
        ).fetchall()
        cost_by_day: dict[str, float] = {}
        for r in day_rows:
            if r["day"]:
                cost_by_day[str(r["day"])] = float(r["cost"] or 0)

        return CostBreakdown(
            total_cost_usd=total,
            cost_by_model=cost_by_model,
            cost_by_day=cost_by_day,
        )

    def get_active_agents(self) -> list[dict[str, Any]]:
        """Return list of agents with last active time (ISO) and total actions, most recent first."""
        rows = self.conn.execute(
            """
            SELECT agent_name, MAX(created_at) as last_ts, COUNT(*) as total
            FROM agent_usage
            GROUP BY agent_name
            ORDER BY last_ts DESC
            """
        ).fetchall()
        result: list[dict[str, Any]] = []
        import datetime
        for r in rows:
            last_ts = r["last_ts"] or int(time.time() * 1000)
            dt = datetime.datetime.fromtimestamp(last_ts / 1000, tz=datetime.timezone.utc)
            iso = dt.isoformat()
            if iso.endswith("+00:00"):
                iso = iso[:-6] + "Z"
            result.append(
                {
                    "agentName": r["agent_name"],
                    "lastActive": iso,
                    "totalActions": r["total"],
                }
            )
        return result

    # ---- Helpers ----

    def _safe_json(self, obj: Any) -> str | None:
        if obj is None:
            return None
        try:
            return json.dumps(obj)
        except (TypeError, ValueError):
            # Fallback to string repr for non-serializable
            return json.dumps(str(obj))

    def _row_to_run(self, row: sqlite3.Row) -> Run:
        meta = json.loads(row["metadata"] or "{}")
        return Run(
            id=row["id"],
            name=row["name"],
            status=row["status"],
            trace_count=row["trace_count"] or 0,
            total_tokens=TokenUsage(
                prompt_tokens=row["total_prompt_tokens"] or 0,
                completion_tokens=row["total_completion_tokens"] or 0,
                total_tokens=row["total_tokens"] or 0,
            ),
            total_tool_calls=row["total_tool_calls"] or 0,
            total_latency_ms=row["total_latency_ms"] or 0,
            total_cost_usd=row["total_cost_usd"] or 0.0,
            error_count=row["error_count"] or 0,
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            metadata=meta,
        )

    def _row_to_trace(self, row: sqlite3.Row) -> Trace:
        tool_rows = self.conn.execute(
            "SELECT * FROM tool_calls WHERE trace_id = ? ORDER BY timestamp",
            (row["id"],),
        ).fetchall()

        tool_calls = [
            ToolCall(
                id=tc["id"],
                name=tc["name"],
                input=json.loads(tc["input"] or "null"),
                output=json.loads(tc["output"] or "null"),
                latency_ms=tc["latency_ms"] or 0,
                success=(tc["success"] == 1),
                error=tc["error"],
                timestamp=tc["timestamp"],
            )
            for tc in tool_rows
        ]

        return Trace(
            id=row["id"],
            run_id=row["run_id"],
            name=row["name"],
            status=row["status"],
            input=json.loads(row["input"] or "null"),
            output=json.loads(row["output"] or "null"),
            tokens=TokenUsage(
                prompt_tokens=row["prompt_tokens"] or 0,
                completion_tokens=row["completion_tokens"] or 0,
                total_tokens=row["total_tokens"] or 0,
                model=row["model"],
                provider=row["provider"],
            ),
            tool_calls=tool_calls,
            latency_ms=row["latency_ms"] or 0,
            cost_usd=row["cost_usd"] or 0.0,
            error=row["error"],
            metadata=json.loads(row["metadata"] or "{}"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _row_to_agent_usage(self, row: sqlite3.Row) -> AgentUsageRecord:
        return AgentUsageRecord(
            id=row["id"],
            agent_name=row["agent_name"],
            agent_type=row["agent_type"],
            session_id=row["session_id"],
            action=row["action"],
            target=row["target"],
            tokens_used=row["tokens_used"] or 0,
            cost_usd=row["cost_usd"] or 0.0,
            duration_ms=row["duration_ms"] or 0,
            status=row["status"] or "success",
            metadata=json.loads(row["metadata"] or "{}"),
            created_at=row["created_at"],
        )

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass
