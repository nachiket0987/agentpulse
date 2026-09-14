"""
Tests for agent_usage tracking system in Python SDK.
Mirrors packages/sdk/src/agent-usage.test.ts and self-track.test.ts (for the tracker part).
"""

import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from agenttrace import AgentUsageTracker
from agenttrace.storage import TraceStorage
from agenttrace.types import AgentUsageFilter, AgentUsageRecord, UsageStats


UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I
)


def make_temp_db() -> str:
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


def test_agent_usage_table_created():
    db = make_temp_db()
    try:
        storage = TraceStorage(db)
        # verify table exists
        row = storage.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_usage'"
        ).fetchone()
        assert row is not None
        assert row["name"] == "agent_usage"
        storage.close()
    finally:
        cleanup_db(db)


def test_record_and_get_agent_usage_basic():
    db = make_temp_db()
    try:
        storage = TraceStorage(db)
        now = int(__import__("time").time() * 1000)
        rec = AgentUsageRecord(
            id=str(uuid.uuid4()),
            agent_name="researcher-1",
            agent_type="researcher",
            session_id="sess-123",
            action="research",
            target="topic:climate",
            tokens_used=1200,
            cost_usd=0.024,
            duration_ms=4500,
            status="success",
            metadata={"model": "gpt-4o"},
            created_at=now,
        )
        storage.record_agent_usage(rec)

        all_recs = storage.get_agent_usage()
        assert len(all_recs) == 1
        r0 = all_recs[0]
        assert r0.agent_name == "researcher-1"
        assert r0.action == "research"
        assert r0.tokens_used == 1200
        assert r0.cost_usd == 0.024
        assert r0.duration_ms == 4500
        assert r0.status == "success"
        assert r0.metadata == {"model": "gpt-4o"}
        assert r0.created_at == now
        storage.close()
    finally:
        cleanup_db(db)


def test_get_agent_usage_all_filters():
    db = make_temp_db()
    try:
        storage = TraceStorage(db)
        now = int(__import__("time").time() * 1000)
        r1 = AgentUsageRecord(
            id="u1",
            agent_name="agent-a",
            agent_type="orchestrator",
            session_id="s1",
            action="delegate",
            target="task1",
            tokens_used=100,
            cost_usd=0.01,
            duration_ms=100,
            status="success",
            metadata={},
            created_at=now - 10000,
        )
        r2 = AgentUsageRecord(
            id="u2",
            agent_name="agent-b",
            agent_type="worker",
            session_id="s1",
            action="implement",
            target="file.ts",
            tokens_used=200,
            cost_usd=0.02,
            duration_ms=200,
            status="success",
            metadata={},
            created_at=now - 5000,
        )
        r3 = AgentUsageRecord(
            id="u3",
            agent_name="agent-a",
            agent_type="orchestrator",
            session_id="s2",
            action="review",
            target="pr-42",
            tokens_used=50,
            cost_usd=0.005,
            duration_ms=50,
            status="failure",
            metadata={"reason": "timeout"},
            created_at=now,
        )
        storage.record_agent_usage(r1)
        storage.record_agent_usage(r2)
        storage.record_agent_usage(r3)

        # no filter
        assert len(storage.get_agent_usage()) == 3

        # by agentName
        assert len(storage.get_agent_usage({"agent_name": "agent-a"})) == 2
        assert len(storage.get_agent_usage(AgentUsageFilter(agent_name="agent-a"))) == 2

        # by agentType
        orch = storage.get_agent_usage({"agent_type": "orchestrator"})
        assert len(orch) == 2

        # by action
        assert len(storage.get_agent_usage({"action": "implement"})) == 1

        # by status single
        assert len(storage.get_agent_usage({"status": "failure"})) == 1

        # by status list
        assert len(storage.get_agent_usage({"status": ["success", "failure"]})) == 3

        # date range
        mid = storage.get_agent_usage({"from_date": now - 6000, "to_date": now - 4000})
        assert len(mid) == 1
        assert mid[0].id == "u2"

        # limit/offset (desc created_at)
        limited = storage.get_agent_usage({"limit": 1})
        assert len(limited) == 1
        assert limited[0].id == "u3"

        paged = storage.get_agent_usage({"limit": 1, "offset": 1})
        assert len(paged) == 1
        assert paged[0].id == "u2"

        # session_id filter (python extension)
        sess = storage.get_agent_usage({"session_id": "s1"})
        assert len(sess) == 2
        storage.close()
    finally:
        cleanup_db(db)


def test_get_usage_stats():
    db = make_temp_db()
    try:
        storage = TraceStorage(db)
        now = int(__import__("time").time() * 1000)
        storage.record_agent_usage(
            {
                "id": "s1",
                "agent_name": "coder",
                "agent_type": "coder",
                "session_id": "ss",
                "action": "implement",
                "target": "a.ts",
                "tokens_used": 300,
                "cost_usd": 0.03,
                "duration_ms": 120,
                "status": "success",
                "metadata": {},
                "created_at": now,
            }
        )
        storage.record_agent_usage(
            {
                "id": "s2",
                "agent_name": "coder",
                "agent_type": "coder",
                "session_id": "ss",
                "action": "review",
                "target": "a.ts",
                "tokens_used": 100,
                "cost_usd": 0.01,
                "duration_ms": 60,
                "status": "success",
                "metadata": {},
                "created_at": now,
            }
        )
        storage.record_agent_usage(
            {
                "id": "s3",
                "agent_name": "researcher",
                "agent_type": "researcher",
                "session_id": "ss",
                "action": "research",
                "target": "x",
                "tokens_used": 500,
                "cost_usd": 0.05,
                "duration_ms": 300,
                "status": "success",
                "metadata": {},
                "created_at": now,
            }
        )

        stats: UsageStats = storage.get_usage_stats()
        assert stats.total_agents == 2
        assert stats.total_actions == 3
        assert stats.total_tokens == 900
        assert abs(stats.total_cost_usd - 0.09) < 1e-6
        assert abs(stats.avg_duration_ms - 160) < 1  # avg
        assert stats.actions_by_type["implement"] == 1
        assert stats.actions_by_type["review"] == 1
        assert stats.actions_by_type["research"] == 1
        assert len(stats.top_agents) == 2
        assert stats.top_agents[0]["agentName"] == "coder"
        assert stats.top_agents[0]["actions"] == 2
        assert stats.top_agents[0]["tokens"] == 400
        assert abs(stats.top_agents[0]["costUsd"] - 0.04) < 1e-6

        # filter by agent
        coder_stats = storage.get_usage_stats("coder")
        assert coder_stats.total_agents == 1
        assert coder_stats.total_actions == 2
        assert coder_stats.total_tokens == 400
        assert abs(coder_stats.total_cost_usd - 0.04) < 1e-6

        # future date -> 0
        future_stats = storage.get_usage_stats(None, now + 1000)
        assert future_stats.total_actions == 0

        storage.close()
    finally:
        cleanup_db(db)


def test_get_active_agents():
    db = make_temp_db()
    try:
        storage = TraceStorage(db)
        t1 = int(__import__("time").time() * 1000) - 100000
        t2 = int(__import__("time").time() * 1000) - 50000
        storage.record_agent_usage(
            AgentUsageRecord(
                id="a1",
                agent_name="orchestrator",
                agent_type="orchestrator",
                session_id="s",
                action="delegate",
                target="t",
                tokens_used=10,
                cost_usd=0.001,
                duration_ms=10,
                status="success",
                metadata={},
                created_at=t1,
            )
        )
        storage.record_agent_usage(
            AgentUsageRecord(
                id="a2",
                agent_name="orchestrator",
                agent_type="orchestrator",
                session_id="s",
                action="review",
                target="t",
                tokens_used=5,
                cost_usd=0.0005,
                duration_ms=5,
                status="success",
                metadata={},
                created_at=t2,
            )
        )
        storage.record_agent_usage(
            AgentUsageRecord(
                id="a3",
                agent_name="worker",
                agent_type="worker",
                session_id="s",
                action="implement",
                target="t",
                tokens_used=20,
                cost_usd=0.002,
                duration_ms=20,
                status="success",
                metadata={},
                created_at=t2 + 1000,
            )
        )

        active = storage.get_active_agents()
        assert len(active) == 2
        # ordered desc last
        assert active[0]["agentName"] == "worker"
        assert active[0]["totalActions"] == 1
        assert isinstance(active[0]["lastActive"], str)
        assert active[0]["lastActive"].startswith("20")  # iso year

        orch = next((a for a in active if a["agentName"] == "orchestrator"), None)
        assert orch is not None
        assert orch["totalActions"] == 2
        storage.close()
    finally:
        cleanup_db(db)


# --- AgentUsageTracker tests (mirror self-track.test.ts behavior for listed API) ---


def test_tracker_constructs():
    db = make_temp_db()
    try:
        t = AgentUsageTracker("test-agent", "local-agent", db_path=db)
        assert isinstance(t, AgentUsageTracker)
        t.close()
    finally:
        cleanup_db(db)


def test_tracker_tracks_and_session_stats():
    db = make_temp_db()
    try:
        t = AgentUsageTracker("test-agent", "local-agent", db_path=db)
        sid = t.start_session()
        assert UUID_RE.match(sid)

        t.track_action("code-edit", "src/foo.ts", {"diff": 12})
        t.track_delegation("coder", "implement feature X")
        t.track_research("how to use sqlite wal", 7)
        t.track_implementation(["src/a.ts", "src/b.ts"], 142)

        stats = t.get_session_stats()
        assert stats["sessionId"] == sid
        assert stats["actions"] == 4
        assert stats["duration"] >= 0
        assert stats["tokens"] == 0
        assert stats["cost"] == 0

        # verify records went to agent_usage
        storage = TraceStorage(db)
        recs = storage.get_agent_usage({"session_id": sid})
        assert len(recs) == 4
        names = sorted([r.action for r in recs])
        assert names == ["code-edit", "delegation", "implementation", "research"]
        # check metadata tagging for one
        action_rec = next(r for r in recs if "code-edit" in r.action)
        assert action_rec.metadata.get("selfTracked") is True
        assert action_rec.metadata.get("actionType") == "action"
        assert action_rec.metadata.get("action") == "code-edit"

        storage.close()
        t.close()
    finally:
        cleanup_db(db)


def test_tracker_auto_starts_session():
    db = make_temp_db()
    try:
        t = AgentUsageTracker("test-agent", "local-agent", db_path=db)
        t.track_action("auto", "start")
        stats = t.get_session_stats()
        assert UUID_RE.match(stats["sessionId"])
        assert stats["actions"] == 1
        t.close()
    finally:
        cleanup_db(db)


def test_tracker_end_session_and_get_stats_zero_when_none():
    db = make_temp_db()
    try:
        t = AgentUsageTracker("test-agent", "local-agent", db_path=db)
        t.end_session()  # safe
        stats = t.get_session_stats()
        assert stats["sessionId"] == ""
        assert stats["actions"] == 0
        t.close()
    finally:
        cleanup_db(db)


def test_tracker_multiple_sessions_isolated():
    db = make_temp_db()
    try:
        t = AgentUsageTracker("test-agent", "local-agent", db_path=db)
        s1 = t.start_session()
        t.track_action("a1", "t1")
        t.end_session()

        s2 = t.start_session()
        t.track_action("a2", "t2")
        t.track_delegation("d", "task")

        assert s2 != s1
        stats2 = t.get_session_stats()
        assert stats2["sessionId"] == s2
        assert stats2["actions"] == 2

        storage = TraceStorage(db)
        recs1 = storage.get_agent_usage({"session_id": s1})
        recs2 = storage.get_agent_usage({"session_id": s2})
        assert len(recs1) == 1
        assert len(recs2) == 2
        storage.close()
        t.close()
    finally:
        cleanup_db(db)


def test_tracker_exposed_at_top_level():
    from agenttrace import AgentUsageTracker as A2

    assert A2 is AgentUsageTracker
