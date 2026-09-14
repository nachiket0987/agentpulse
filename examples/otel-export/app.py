"""
AgentTrace OpenTelemetry Export Example (Python)

Demonstrates exporting AgentTrace spans to an OpenTelemetry Collector
via OTLP JSON/HTTP and OTLP gRPC.

Prerequisites:
    pip install agenttrace-io requests opentelemetry-sdk opentelemetry-exporter-otlp

Run:
    # Start the collector + backends
    docker compose up -d

    # Run this example
    python examples/otel-export/app.py

View traces:
    Jaeger:  http://localhost:16686
    Zipkin:  http://localhost:9411
"""

import json
import time
from agenttrace import init


def export_via_http(agent) -> None:
    """Export traces via OTLP JSON over HTTP (no extra deps beyond requests)."""
    import requests  # type: ignore

    otlp_json = agent.export("otel")

    res = requests.post(
        "http://localhost:4318/v1/traces",
        headers={"Content-Type": "application/json"},
        data=otlp_json,
    )
    res.raise_for_status()
    print("[HTTP] Exported traces via OTLP JSON/HTTP")


def export_via_grpc(agent) -> None:
    """Export traces via OTLP gRPC using the OpenTelemetry Python SDK."""
    from opentelemetry import trace  # type: ignore
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter  # type: ignore
    from opentelemetry.sdk.resources import Resource  # type: ignore
    from opentelemetry.sdk.trace import TracerProvider  # type: ignore
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # type: ignore

    resource = Resource.create({"service.name": "agenttrace-example"})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint="http://localhost:4317")
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    tracer = trace.get_tracer("agenttrace-example")

    for t in agent.get_traces():
        start_ns = int((t.created_at - t.latency_ms) * 1_000_000)
        end_ns = int(t.created_at * 1_000_000)

        with tracer.start_as_current_span(
            t.name,
            start_time=start_ns,
            attributes={
                "agenttrace.trace_id": t.id,
                "agenttrace.run_id": t.run_id,
                "agenttrace.status": t.status,
                "agenttrace.latency_ms": t.latency_ms,
                "agenttrace.cost_usd": t.cost_usd,
                "agenttrace.tokens.prompt": t.tokens.prompt_tokens,
                "agenttrace.tokens.completion": t.tokens.completion_tokens,
                "agenttrace.tokens.total": t.tokens.total_tokens,
                **({"agenttrace.model": t.tokens.model} if t.tokens.model else {}),
                **({"agenttrace.provider": t.tokens.provider} if t.tokens.provider else {}),
            },
        ) as span:
            if t.status == "error":
                span.set_status(trace.StatusCode.ERROR, t.error or "")
            span.end(end_ns)

    print("[gRPC] Exported traces via OTLP gRPC")


def main() -> None:
    agent = init(db_path="./agenttrace.db")

    # Simulate some agent work
    agent.start_run("otel-export-demo")

    agent.trace(
        "research",
        lambda: "Agent observability is the practice of tracing...",
        tokens={"promptTokens": 150, "completionTokens": 200, "totalTokens": 350, "model": "gpt-4o"},
        input={"query": "What is agent observability?"},
    )

    agent.trace(
        "summarize",
        lambda: "Summary: observability = traces + metrics + logs for AI agents.",
        tokens={"promptTokens": 80, "completionTokens": 40, "totalTokens": 120, "model": "gpt-4o"},
        input={"text": "Agent observability is the practice of tracing..."},
    )

    agent.complete_run()

    # Print stats
    stats = agent.get_stats()
    print(f"AgentTrace stats: {json.dumps(stats.__dict__, indent=2, default=str)}")

    # Export via HTTP
    try:
        export_via_http(agent)
    except Exception as exc:
        print(f"[HTTP] Export failed: {exc}")

    # Export via gRPC
    try:
        export_via_grpc(agent)
    except ImportError:
        print("[gRPC] Skipped (install opentelemetry-sdk opentelemetry-exporter-otlp)")
    except Exception as exc:
        print(f"[gRPC] Export failed: {exc}")

    agent.close()
    print("Done. Check Jaeger (http://localhost:16686) and Zipkin (http://localhost:9411)")


if __name__ == "__main__":
    main()
