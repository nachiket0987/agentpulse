/**
 * AgentTrace OpenTelemetry Export Example (TypeScript)
 *
 * Demonstrates two approaches for exporting AgentTrace spans to an
 * OpenTelemetry Collector:
 *
 *   1. OTLP JSON / HTTP  -- POST OTLP JSON to the collector's HTTP endpoint
 *   2. OTLP gRPC          -- use @opentelemetry/sdk-node for full integration
 *
 * Both approaches use AgentTrace's built-in `export('otel')` method to
 * produce OTLP-compatible JSON, then forward it to the collector.
 *
 * Prerequisites:
 *   npm install @agenttrace-io/sdk @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-grpc
 *   npm install @opentelemetry/resources @opentelemetry/semantic-conventions
 *
 * Run:
 *   # Start the collector + backends
 *   docker compose up -d
 *
 *   # Run this example
 *   npx ts-node examples/otel-export/app.ts
 *
 * View traces:
 *   Jaeger:  http://localhost:16686
 *   Zipkin:  http://localhost:9411
 */

import { init, AgentTrace } from '@agenttrace-io/sdk';

// ---------------------------------------------------------------------------
// Approach 1: OTLP JSON over HTTP (no extra deps beyond the SDK)
// ---------------------------------------------------------------------------

async function exportViaHttp(agent: AgentTrace): Promise<void> {
  // AgentTrace.export('otel') produces OTLP JSON (resourceSpans format)
  const otlpJson = agent.export('otel');

  // POST to the collector's OTLP HTTP endpoint
  const res = await fetch('http://localhost:4318/v1/traces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: otlpJson,
  });

  if (!res.ok) {
    throw new Error(`OTLP HTTP export failed: ${res.status} ${await res.text()}`);
  }

  console.log('[HTTP] Exported traces via OTLP JSON/HTTP');
}

// ---------------------------------------------------------------------------
// Approach 2: OTLP gRPC via OpenTelemetry Node SDK
// ---------------------------------------------------------------------------

async function exportViaGrpc(agent: AgentTrace): Promise<void> {
  // Dynamic import so this module still runs when @opentelemetry is not installed.
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc');
  const { Resource } = await import('@opentelemetry/resources');
  const { SEMRESATTRS_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');
  const { SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-base');

  const exporter = new OTLPTraceExporter({
    url: 'http://localhost:4317', // collector gRPC
  });

  const sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'agenttrace-example',
    }),
    spanProcessor: new SimpleSpanProcessor(exporter),
  });

  sdk.start();

  // Use AgentTrace's OTLP export and re-create spans in the OTel SDK.
  // In production you'd use a custom SpanProcessor that wraps AgentTrace.trace()
  // directly; this example shows the "export then forward" pattern.
  const traces = agent.getTraces();
  const { trace, context, SpanStatusCode } = await import('@opentelemetry/api');
  const tracer = trace.getTracer('agenttrace-example');

  for (const t of traces) {
    const startTime = t.createdAt - t.latencyMs;
    const span = tracer.startSpan(t.name, {
      startTime: [Math.floor(startTime / 1000), (startTime % 1000) * 1_000_000],
      attributes: {
        'agenttrace.trace_id': t.id,
        'agenttrace.run_id': t.runId,
        'agenttrace.status': t.status,
        'agenttrace.latency_ms': t.latencyMs,
        'agenttrace.cost_usd': t.costUsd,
        'agenttrace.tokens.prompt': t.tokens.promptTokens,
        'agenttrace.tokens.completion': t.tokens.completionTokens,
        'agenttrace.tokens.total': t.tokens.totalTokens,
        ...(t.tokens.model ? { 'agenttrace.model': t.tokens.model } : {}),
        ...(t.tokens.provider ? { 'agenttrace.provider': t.tokens.provider } : {}),
      },
    });

    if (t.status === 'error') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: t.error });
    }

    span.end([Math.floor(t.createdAt / 1000), (t.createdAt % 1000) * 1_000_000]);
  }

  await sdk.shutdown();
  console.log('[gRPC] Exported traces via OTLP gRPC');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const agent = init({ dbPath: './agenttrace.db' });

  // Simulate some agent work
  agent.startRun('otel-export-demo');

  await agent.trace(
    'research',
    async () => {
      // Simulated LLM call
      return 'Agent observability is the practice of tracing...';
    },
    {
      tokens: { promptTokens: 150, completionTokens: 200, totalTokens: 350, model: 'gpt-4o' },
      input: { query: 'What is agent observability?' },
    },
  );

  await agent.trace(
    'summarize',
    async () => {
      return 'Summary: observability = traces + metrics + logs for AI agents.';
    },
    {
      tokens: { promptTokens: 80, completionTokens: 40, totalTokens: 120, model: 'gpt-4o' },
      input: { text: 'Agent observability is the practice of tracing...' },
    },
  );

  agent.completeRun();

  // Print stats
  const stats = agent.getStats();
  console.log('AgentTrace stats:', JSON.stringify(stats, null, 2));

  // Export via HTTP (always works, no extra deps)
  await exportViaHttp(agent);

  // Export via gRPC (requires @opentelemetry packages)
  try {
    await exportViaGrpc(agent);
  } catch (err: unknown) {
    console.warn(
      '[gRPC] Skipped (install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-grpc):',
      err instanceof Error ? err.message : err,
    );
  }

  agent.close();
  console.log('Done. Check Jaeger (http://localhost:16686) and Zipkin (http://localhost:9411)');
}

main().catch(console.error);
