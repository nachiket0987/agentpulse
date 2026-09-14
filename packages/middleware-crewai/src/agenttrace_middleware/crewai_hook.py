"""
AgentTraceCrewAI - hooks into CrewAI event system for automatic tracing.

Subscribes to task and tool events when crewai is importable.
You may also call the on_* methods directly for custom integrations.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Optional

from agenttrace import AgentTrace
from agenttrace.types import TokenUsage


class AgentTraceCrewAI:
    """CrewAI integration for AgentTrace.

    Example:
        mw = AgentTraceCrewAI(db_path="./traces.db")
        # ... define crew ...
        result = crew.kickoff()
        mw.close()
    """

    def __init__(self, db_path: str = "./agenttrace.db") -> None:
        self.agent = AgentTrace({"db_path": db_path, "silent": True})
        self._task_starts: dict[str, dict[str, Any]] = {}
        self._tool_starts: dict[str, dict[str, Any]] = {}
        self._register_hooks()

    def _register_hooks(self) -> None:
        """Attempt to subscribe to CrewAI's global event bus.

        Safe if crewai is not installed; on_* methods remain callable manually.
        """
        try:
            # CrewAI event bus (structure observed in recent versions)
            from crewai.utilities.events import crewai_event_bus  # type: ignore

            # Task events
            try:
                from crewai.utilities.events.task_events import (  # type: ignore
                    TaskStartedEvent,
                    TaskCompletedEvent,
                    TaskFailedEvent,
                )

                crewai_event_bus.on(TaskStartedEvent, self.on_task_start)
                crewai_event_bus.on(TaskCompletedEvent, self.on_task_end)
                crewai_event_bus.on(TaskFailedEvent, self.on_task_error)
            except Exception:
                pass

            # Tool events
            try:
                from crewai.utilities.events.tool_events import (  # type: ignore
                    ToolUsageStartedEvent,
                    ToolUsageFinishedEvent,
                )

                crewai_event_bus.on(ToolUsageStartedEvent, self.on_tool_start)
                crewai_event_bus.on(ToolUsageFinishedEvent, self.on_tool_end)
            except Exception:
                pass

            # LLM/usage events may also be present in some versions; ignore if absent.
        except Exception:
            # crewai not present or incompatible event API - manual mode only
            pass

    # ---- Public hook methods (invoked by event bus or manually) ----

    def on_task_start(self, source: Any, event: Any) -> None:
        task_id = self._get_id(event, "task")
        name = getattr(event, "task_name", None) or getattr(event, "name", None) or "task"
        self._task_starts[task_id] = {
            "start_time": int(time.time() * 1000),
            "name": name,
            "input": getattr(event, "inputs", None)
            or getattr(event, "description", None)
            or getattr(event, "prompt", None),
        }

    def on_task_end(self, source: Any, event: Any) -> None:
        task_id = self._get_id(event, "task")
        info = self._task_starts.pop(task_id, None)
        if info is None:
            info = {"start_time": int(time.time() * 1000) - 1, "name": "task", "input": None}
        latency_ms = int(time.time() * 1000) - info["start_time"]
        tokens = self._extract_tokens(event)
        output = getattr(event, "output", None) or getattr(event, "result", None)
        self._record_trace(f"task:{info['name']}", "success", info["input"], output, tokens, latency_ms)

    def on_task_error(self, source: Any, event: Any) -> None:
        task_id = self._get_id(event, "task")
        info = self._task_starts.pop(task_id, None)
        if info is None:
            info = {"start_time": int(time.time() * 1000) - 1, "name": "task", "input": None}
        latency_ms = int(time.time() * 1000) - info["start_time"]
        err = (
            getattr(event, "error", None)
            or getattr(event, "exception", None)
            or getattr(event, "message", None)
            or "task error"
        )
        if not isinstance(err, str):
            err = str(err)
        tokens = self._extract_tokens(event)
        self._record_trace(f"task:{info['name']}", "error", info["input"], None, tokens, latency_ms, error=err)

    def on_tool_start(self, source: Any, event: Any) -> None:
        tool_id = self._get_id(event, "tool")
        name = getattr(event, "tool_name", None) or getattr(event, "name", None) or "tool"
        self._tool_starts[tool_id] = {
            "start_time": int(time.time() * 1000),
            "name": name,
            "input": getattr(event, "inputs", None)
            or getattr(event, "tool_input", None)
            or getattr(event, "input", None),
        }

    def on_tool_end(self, source: Any, event: Any) -> None:
        tool_id = self._get_id(event, "tool")
        info = self._tool_starts.pop(tool_id, None)
        if info is None:
            info = {"start_time": int(time.time() * 1000) - 1, "name": "tool", "input": None}
        latency_ms = int(time.time() * 1000) - info["start_time"]
        tokens = self._extract_tokens(event)
        output = getattr(event, "output", None) or getattr(event, "result", None)
        self._record_trace(f"tool:{info['name']}", "success", info["input"], output, tokens, latency_ms)

    # ---- Helpers ----

    def _get_id(self, event: Any, kind: str) -> str:
        if event is None:
            return str(uuid.uuid4())
        for attr in (f"{kind}_id", "id", "task_id", "tool_id", "uuid"):
            val = getattr(event, attr, None)
            if val:
                return str(val)
        return str(uuid.uuid4())

    def _extract_tokens(self, event: Any) -> TokenUsage:
        if event is None:
            return TokenUsage()
        # direct attrs commonly provided by crewai / litellm / langchain under the hood
        for key in ("usage", "token_usage", "tokens", "llm_usage", "usage_metrics", "tokenUsage"):
            val = getattr(event, key, None)
            if val:
                tu = self._normalize_to_tokens(val)
                if tu.total_tokens or tu.prompt_tokens or tu.completion_tokens:
                    return tu
        # nested in result/output
        for container_key in ("output", "result", "final_output", "data"):
            container = getattr(event, container_key, None)
            if isinstance(container, dict):
                for key in ("usage", "token_usage", "tokens"):
                    if key in container:
                        tu = self._normalize_to_tokens(container[key])
                        if tu.total_tokens or tu.prompt_tokens or tu.completion_tokens:
                            return tu
            # also check if container itself looks like usage
            if isinstance(container, dict) and any(
                k in container for k in ("prompt_tokens", "total_tokens", "promptTokens")
            ):
                return self._normalize_to_tokens(container)
        return TokenUsage()

    def _normalize_to_tokens(self, val: Any) -> TokenUsage:
        if val is None:
            return TokenUsage()
        # dataclass / object with snake_case (our TokenUsage or litellm style)
        if hasattr(val, "prompt_tokens") or hasattr(val, "promptTokens"):
            return TokenUsage(
                prompt_tokens=getattr(val, "prompt_tokens", getattr(val, "promptTokens", 0)) or 0,
                completion_tokens=getattr(val, "completion_tokens", getattr(val, "completionTokens", 0)) or 0,
                total_tokens=getattr(val, "total_tokens", getattr(val, "totalTokens", 0)) or 0,
                model=getattr(val, "model", None),
                provider=getattr(val, "provider", None),
            )
        if isinstance(val, dict):
            return TokenUsage(
                prompt_tokens=val.get("prompt_tokens") or val.get("promptTokens") or val.get("input_tokens") or 0,
                completion_tokens=val.get("completion_tokens") or val.get("completionTokens") or val.get("output_tokens") or 0,
                total_tokens=val.get("total_tokens") or val.get("totalTokens") or val.get("total") or 0,
                model=val.get("model"),
                provider=val.get("provider"),
            )
        return TokenUsage()

    def _record_trace(
        self,
        name: str,
        status: str,
        input: Any,
        output: Any,
        tokens: TokenUsage,
        latency_ms: int,
        error: Optional[str] = None,
    ) -> None:
        cost_usd = self.agent._cost_calculator(tokens, tokens.model)  # reuse internal (same monorepo package)

        trace_id = str(uuid.uuid4())
        run_id = self.agent._current_run_id or str(uuid.uuid4())

        tr = {
            "id": trace_id,
            "runId": run_id,
            "name": name,
            "status": status,
            "input": input,
            "output": output,
            "tokens": {
                "promptTokens": tokens.prompt_tokens,
                "completionTokens": tokens.completion_tokens,
                "totalTokens": tokens.total_tokens,
                "model": tokens.model,
                "provider": tokens.provider,
            },
            "toolCalls": [],
            "latencyMs": latency_ms,
            "costUsd": cost_usd,
            "error": error,
            "metadata": {"framework": "crewai"},
        }
        # storage is public on AgentTrace
        self.agent.storage.create_trace(tr)

        if self.agent.config.get("auto_cleanup", True):
            self.agent.storage.cleanup(self.agent.config.get("max_traces", 10000))

    # ---- Lifecycle ----

    def close(self) -> None:
        """Close underlying DB connection."""
        self.agent.close()

    def get_agent_trace(self) -> AgentTrace:
        """Return the underlying AgentTrace for advanced usage (startRun, queries, etc)."""
        return self.agent
