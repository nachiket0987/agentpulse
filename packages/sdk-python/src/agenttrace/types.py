"""
AgentTrace -- Core Types
Open source AI agent observability
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional, Union


Status = Literal["success", "failure", "error", "timeout"]
RunStatus = Literal["running", "success", "failure", "error"]
ExportFormat = Literal["json", "csv", "otel"]


@dataclass
class ToolCall:
    """A single tool call within an agent run."""

    id: str
    name: str
    input: Any = None
    output: Any = None
    latency_ms: int = 0
    success: bool = True
    error: Optional[str] = None
    timestamp: int = 0


@dataclass
class TokenUsage:
    """Token usage for a single LLM call."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    model: Optional[str] = None
    provider: Optional[str] = None


@dataclass
class Trace:
    """A single trace (one operation within an agent run)."""

    id: str
    run_id: str
    name: str
    status: Status
    input: Any = None
    output: Any = None
    tokens: TokenUsage = field(default_factory=TokenUsage)
    tool_calls: list[ToolCall] = field(default_factory=list)
    latency_ms: int = 0
    cost_usd: float = 0.0
    error: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: int = 0
    updated_at: int = 0


@dataclass
class Run:
    """Summary of an agent run (collection of traces)."""

    id: str
    name: str
    status: RunStatus = "running"
    trace_count: int = 0
    total_tokens: TokenUsage = field(default_factory=TokenUsage)
    total_tool_calls: int = 0
    total_latency_ms: int = 0
    total_cost_usd: float = 0.0
    error_count: int = 0
    started_at: int = 0
    completed_at: Optional[int] = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class TraceConfig:
    """Configuration for the trace collector."""

    db_path: Optional[str] = None
    max_traces: Optional[int] = None
    auto_cleanup: Optional[bool] = None
    cost_calculator: Optional[Callable[[TokenUsage, Optional[str]], float]] = None
    hallucination_detector: Optional[Callable[[Any, Optional[Any]], bool]] = None
    silent: Optional[bool] = None


@dataclass
class TraceFilter:
    """Filter options for querying traces."""

    run_id: Optional[str] = None
    status: Optional[list[Status]] = None
    name: Optional[str] = None
    from_date: Optional[int] = None
    to_date: Optional[int] = None
    min_cost: Optional[float] = None
    max_cost: Optional[float] = None
    min_latency: Optional[int] = None
    max_latency: Optional[int] = None
    limit: Optional[int] = None
    offset: Optional[int] = None


@dataclass
class TraceStats:
    """Summary statistics."""

    total_runs: int = 0
    total_traces: int = 0
    success_rate: float = 0.0
    avg_latency_ms: float = 0.0
    total_cost_usd: float = 0.0
    total_tokens: int = 0
    avg_tokens_per_trace: float = 0.0
    top_tools: list[dict[str, Any]] = field(default_factory=list)
    top_errors: list[dict[str, Any]] = field(default_factory=list)


# For type hints on cost calc etc.
CostCalculator = Callable[[TokenUsage, Optional[str]], float]
HallucinationDetector = Callable[[Any, Optional[Any]], bool]


@dataclass
class Scorer:
    """Scorer function that evaluates a trace and returns a numeric score."""

    name: str
    fn: Callable[[Trace], Any]


@dataclass
class ScorerResult:
    """Result of running scorers against a trace."""

    trace_id: str
    scores: dict[str, float] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)


@dataclass
class EvaluateOptions:
    """Options for running evaluations (mirrors TS)."""

    scorers: list[Scorer]
    run_id: Optional[str] = None
    trace_ids: Optional[list[str]] = None
    concurrency: Optional[int] = None


UsageStatus = Literal["success", "failure", "timeout"]


@dataclass
class AgentUsageRecord:
    """Record of agent usage / action for the agent_usage tracking system (mirrors TS)."""

    id: str
    agent_name: str
    agent_type: Optional[str] = None
    session_id: Optional[str] = None
    action: str = ""
    target: Optional[str] = None
    tokens_used: int = 0
    cost_usd: float = 0.0
    duration_ms: int = 0
    status: UsageStatus = "success"
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: int = 0


@dataclass
class AgentUsageFilter:
    """Filter for querying agent usage records (mirrors TS, plus session_id for Python convenience)."""

    agent_name: Optional[str] = None
    agent_type: Optional[str] = None
    action: Optional[str] = None
    status: Optional[Union[UsageStatus, list[UsageStatus]]] = None
    from_date: Optional[int] = None
    to_date: Optional[int] = None
    limit: Optional[int] = None
    offset: Optional[int] = None
    session_id: Optional[str] = None


@dataclass
class UsageStats:
    """Aggregated usage statistics (mirrors TS)."""

    total_agents: int = 0
    total_actions: int = 0
    total_tokens: int = 0
    total_cost_usd: float = 0.0
    avg_duration_ms: float = 0.0
    actions_by_type: dict[str, int] = field(default_factory=dict)
    top_agents: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class CostBreakdown:
    """Cost breakdown by model and by day."""

    total_cost_usd: float = 0.0
    cost_by_model: dict[str, float] = field(default_factory=dict)
    cost_by_day: dict[str, float] = field(default_factory=dict)
