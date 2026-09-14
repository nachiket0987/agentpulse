import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Trace, TraceStats, Run, TokenUsage, Scorer, AlertHistory } from './types.js';

const { mockStorage, MockTraceStorage } = vi.hoisted(() => {
  const mockStorage = {
    createRun: vi.fn(),
    completeRun: vi.fn(),
    createTrace: vi.fn(),
    getTrace: vi.fn(),
    getTraces: vi.fn(() => [] as Trace[]),
    getRuns: vi.fn(() => [] as Run[]),
    getRun: vi.fn(),
    getStats: vi.fn(
      (): TraceStats => ({
        totalRuns: 0,
        totalTraces: 0,
        successRate: 0,
        avgLatencyMs: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        avgTokensPerTrace: 0,
        topTools: [],
        topErrors: [],
      }),
    ),
    cleanup: vi.fn(() => 0),
    close: vi.fn(),
    createScore: vi.fn(),
    getScores: vi.fn(() => []),
    getRetentionPolicy: vi.fn(() => ({ retentionDays: 30, cleanupIntervalHours: 24 })),
    setRetentionPolicy: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    getWebhooks: vi.fn(() => []),
  };

  return {
    mockStorage,
    MockTraceStorage: vi.fn(function MockTraceStorage(_dbPath?: string, _tenantId?: string) {
      return mockStorage;
    }),
  };
});

vi.mock('./storage.js', () => ({
  TraceStorage: MockTraceStorage,
}));

import { AgentTrace, init, PACKAGE_NAME, VERSION, score, alert } from './index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    id: 'trace-1',
    runId: 'run-1',
    name: 'test-op',
    status: 'success',
    input: null,
    output: 'hello',
    tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    toolCalls: [],
    latencyMs: 12,
    costUsd: 0.001,
    metadata: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function lastCreatedTrace(): Omit<Trace, 'createdAt' | 'updatedAt'> {
  const call = mockStorage.createTrace.mock.calls.at(-1);
  if (!call) throw new Error('createTrace was not called');
  return call[0];
}

describe('@agenttrace-io/sdk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.getTraces.mockReturnValue([]);
    mockStorage.getStats.mockReturnValue({
      totalRuns: 0,
      totalTraces: 0,
      successRate: 0,
      avgLatencyMs: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      avgTokensPerTrace: 0,
      topTools: [],
      topErrors: [],
    });
    mockStorage.createTrace.mockImplementation((trace) => ({
      ...trace,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
  });

  it('exports the package version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('@agenttrace-io/sdk');
  });
});

describe('cost calculation (defaultCostCalculator)', () => {
  let agent: AgentTrace;

  beforeEach(() => {
    agent = new AgentTrace({ silent: true });
    agent.startRun('cost-run');
  });

  it('calculates cost for a known model (gpt-4o)', async () => {
    await agent.trace('priced-op', async () => 'ok', {
      tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      model: 'gpt-4o',
    });

    // (1000 * 0.0025 + 500 * 0.01) / 1000 = 0.0075
    expect(lastCreatedTrace().costUsd).toBeCloseTo(0.0075, 6);
  });

  it('uses default rates for unknown models', async () => {
    await agent.trace('unknown-model-op', async () => 'ok', {
      tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      model: 'unknown-model-v99',
    });

    // (100 * 0.001 + 50 * 0.002) / 1000 = 0.0002
    expect(lastCreatedTrace().costUsd).toBeCloseTo(0.0002, 6);
  });

  it('returns zero cost for zero tokens', async () => {
    await agent.trace('free-op', async () => 'ok', {
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: 'gpt-4o',
    });

    expect(lastCreatedTrace().costUsd).toBe(0);
  });

  it('honors a custom costCalculator from config', async () => {
    const custom = vi.fn((_tokens: TokenUsage) => 42);
    const customAgent = new AgentTrace({ costCalculator: custom, silent: true });
    customAgent.startRun('custom-cost-run');

    await customAgent.trace('custom-op', async () => 'ok', {
      tokens: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      model: 'gpt-4o',
    });

    expect(custom).toHaveBeenCalled();
    expect(lastCreatedTrace().costUsd).toBe(42);
    customAgent.close();
  });
});

describe('AgentTrace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs TraceStorage with default dbPath', () => {
    new AgentTrace();
    expect(MockTraceStorage).toHaveBeenCalledWith('./agenttrace.db', '');
  });

  it('applies constructor options', () => {
    const agent = new AgentTrace({
      dbPath: '/tmp/custom.db',
      maxTraces: 500,
      autoCleanup: false,
      silent: true,
    });

    expect(MockTraceStorage).toHaveBeenCalledWith('/tmp/custom.db', '');
    agent.close();
  });

  it('close() shuts down storage', () => {
    const agent = new AgentTrace({ silent: true });
    agent.close();
    expect(mockStorage.close).toHaveBeenCalledTimes(1);
  });
});

describe('init()', () => {
  it('returns an AgentTrace instance wired to storage', () => {
    const instance = init({ dbPath: '/tmp/init.db', silent: true });
    expect(instance).toBeInstanceOf(AgentTrace);
    expect(MockTraceStorage).toHaveBeenCalledWith('/tmp/init.db', '');
    instance.close();
  });
});

describe('startRun()', () => {
  it('returns a valid UUID', () => {
    const agent = new AgentTrace({ silent: true });
    const runId = agent.startRun('my-run');
    expect(runId).toMatch(UUID_RE);
    agent.close();
  });

  it('persists the run via storage', () => {
    const agent = new AgentTrace({ silent: true });
    const metadata = { env: 'test' };
    const runId = agent.startRun('named-run', metadata);

    expect(mockStorage.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: runId,
        name: 'named-run',
        metadata,
      }),
    );
    agent.close();
  });
});

describe('trace()', () => {
  let agent: AgentTrace;

  beforeEach(() => {
    agent = new AgentTrace({ silent: true });
    agent.startRun('trace-run');
  });

  it('returns the function result on success', async () => {
    const result = await agent.trace('success-op', async () => ({ answer: 42 }));
    expect(result).toEqual({ answer: 42 });
    expect(lastCreatedTrace().status).toBe('success');
    expect(lastCreatedTrace().output).toEqual({ answer: 42 });
  });

  it('records error traces and rethrows', async () => {
    await expect(
      agent.trace('fail-op', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const trace = lastCreatedTrace();
    expect(trace.status).toBe('error');
    expect(trace.error).toBe('boom');
  });

  it('stores custom input and token usage', async () => {
    const input = { query: 'hello' };
    const tokens: TokenUsage = {
      promptTokens: 200,
      completionTokens: 80,
      totalTokens: 280,
      model: 'claude-sonnet-4',
      provider: 'anthropic',
    };

    await agent.trace('token-op', async () => 'done', { input, tokens, model: 'claude-sonnet-4' });

    const trace = lastCreatedTrace();
    expect(trace.input).toEqual(input);
    expect(trace.tokens).toEqual(tokens);
    expect(trace.name).toBe('token-op');
  });

  it('collects tool calls recorded via recordToolCall inside trace fn', async () => {
    const toolInput = { q: 'weather' };
    const toolOutput = { temp: 72 };
    const result = await agent.trace(
      'with-tools',
      async () => {
        const id1 = agent.recordToolCall({
          name: 'getWeather',
          input: toolInput,
          output: toolOutput,
          latencyMs: 42,
          success: true,
        });
        const id2 = agent.recordToolCall({
          name: 'format',
          input: { raw: toolOutput },
          output: '72F',
          latencyMs: 5,
          success: true,
        });
        expect(id1).toMatch(UUID_RE);
        expect(id2).toMatch(UUID_RE);
        return 'done';
      },
      { input: { city: 'sf' } },
    );
    expect(result).toBe('done');

    const trace = lastCreatedTrace();
    expect(trace.name).toBe('with-tools');
    expect(trace.toolCalls).toHaveLength(2);
    expect(trace.toolCalls[0]).toMatchObject({
      name: 'getWeather',
      input: toolInput,
      output: toolOutput,
      latencyMs: 42,
      success: true,
    });
    expect(trace.toolCalls[0].id).toMatch(UUID_RE);
    expect(typeof trace.toolCalls[0].timestamp).toBe('number');
    expect(trace.toolCalls[1].name).toBe('format');
  });

  it('collects tool calls even on error traces (partial execution)', async () => {
    await expect(
      agent.trace('tool-fail', async () => {
        agent.recordToolCall({
          name: 'failingTool',
          input: { x: 1 },
          output: null,
          latencyMs: 10,
          success: false,
          error: 'timeout',
        });
        throw new Error('agent boom');
      }),
    ).rejects.toThrow('agent boom');

    const trace = lastCreatedTrace();
    expect(trace.status).toBe('error');
    expect(trace.toolCalls).toHaveLength(1);
    expect(trace.toolCalls[0].name).toBe('failingTool');
    expect(trace.toolCalls[0].success).toBe(false);
  });

  it('warns (but returns id) when recordToolCall called outside active trace', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nonSilent = new AgentTrace({ silent: false });
    nonSilent.startRun('outside-run');

    const id = nonSilent.recordToolCall({
      name: 'orphan',
      input: {},
      output: null,
      latencyMs: 1,
      success: true,
    });

    expect(id).toMatch(UUID_RE);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('recordToolCall("orphan") called outside an active trace()'),
    );

    // No trace created for orphan
    expect(mockStorage.createTrace).not.toHaveBeenCalledWith(
      expect.objectContaining({
        toolCalls: expect.arrayContaining([expect.objectContaining({ name: 'orphan' })]),
      }),
    );

    warnSpy.mockRestore();
    nonSilent.close();
  });

  it('runs cleanup when autoCleanup is enabled', async () => {
    mockStorage.cleanup.mockClear();
    const cleanupAgent = new AgentTrace({ maxTraces: 100, silent: true });
    cleanupAgent.startRun('cleanup-run');

    await cleanupAgent.trace('op', async () => 'x');

    expect(mockStorage.cleanup).toHaveBeenCalledWith(100);
    cleanupAgent.close();
  });

  it('skips cleanup when autoCleanup is disabled', async () => {
    mockStorage.cleanup.mockClear();
    const noCleanupAgent = new AgentTrace({ autoCleanup: false, silent: true });
    noCleanupAgent.startRun('no-cleanup-run');

    await noCleanupAgent.trace('op', async () => 'x');

    expect(mockStorage.cleanup).not.toHaveBeenCalled();
    noCleanupAgent.close();
  });
});

describe('getTraces()', () => {
  it('delegates runId filter to storage', () => {
    const agent = new AgentTrace({ silent: true });
    const traces = [makeTrace({ runId: 'run-a' })];
    mockStorage.getTraces.mockReturnValue(traces);

    const result = agent.getTraces({ runId: 'run-a' });

    expect(mockStorage.getTraces).toHaveBeenCalledWith({ runId: 'run-a' });
    expect(result).toBe(traces);
    agent.close();
  });

  it('delegates limit to storage', () => {
    const agent = new AgentTrace({ silent: true });
    agent.getTraces({ limit: 5, offset: 10 });

    expect(mockStorage.getTraces).toHaveBeenCalledWith({ limit: 5, offset: 10 });
    agent.close();
  });
});

describe('getStats()', () => {
  it('returns empty stats when storage has no data', () => {
    const agent = new AgentTrace({ silent: true });
    const empty: TraceStats = {
      totalRuns: 0,
      totalTraces: 0,
      successRate: 0,
      avgLatencyMs: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      avgTokensPerTrace: 0,
      topTools: [],
      topErrors: [],
    };
    mockStorage.getStats.mockReturnValue(empty);

    expect(agent.getStats()).toEqual(empty);
    agent.close();
  });

  it('returns stats for runs with mixed success and failure', () => {
    const agent = new AgentTrace({ silent: true });
    const mixed: TraceStats = {
      totalRuns: 1,
      totalTraces: 4,
      successRate: 0.5,
      avgLatencyMs: 120,
      totalCostUsd: 0.05,
      totalTokens: 900,
      avgTokensPerTrace: 225,
      topTools: [],
      topErrors: [{ error: 'boom', count: 2 }],
    };
    mockStorage.getStats.mockReturnValue(mixed);

    expect(agent.getStats()).toEqual(mixed);
    agent.close();
  });
});

describe('export()', () => {
  it('exports traces as JSON', () => {
    const agent = new AgentTrace({ silent: true });
    const traces = [makeTrace({ name: 'export-op' })];
    mockStorage.getTraces.mockReturnValue(traces);

    const json = agent.export('json', { runId: 'run-1' });
    const parsed = JSON.parse(json);

    expect(mockStorage.getTraces).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(parsed).toEqual(traces);
    agent.close();
  });

  it('exports traces as CSV with header and data row', () => {
    const agent = new AgentTrace({ silent: true });
    const traces = [
      makeTrace({
        id: 't-1',
        runId: 'r-1',
        name: 'csv-op',
        status: 'success',
        latencyMs: 99,
        costUsd: 0.01,
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        createdAt: 1234567890,
      }),
    ];
    mockStorage.getTraces.mockReturnValue(traces);

    const csv = agent.export('csv');
    const lines = csv.split('\n');

    expect(lines[0]).toBe('id,runId,name,status,latencyMs,costUsd,totalTokens,createdAt');
    expect(lines[1]).toBe('t-1,r-1,csv-op,success,99,0.01,15,1234567890');
    agent.close();
  });
});

describe('export() otel format', () => {
  it('exports traces as OTLP JSON with correct top-level structure', () => {
    const agent = new AgentTrace({ silent: true });
    const traces = [makeTrace({ name: 'otel-op' })];
    mockStorage.getTraces.mockReturnValue(traces);

    const otlpJson = agent.export('otel', { runId: 'run-1' });
    const parsed = JSON.parse(otlpJson);

    expect(mockStorage.getTraces).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(parsed).toHaveProperty('resourceSpans');
    expect(Array.isArray(parsed.resourceSpans)).toBe(true);
    expect(parsed.resourceSpans.length).toBe(1);
    expect(parsed.resourceSpans[0]).toHaveProperty('resource');
    expect(parsed.resourceSpans[0]).toHaveProperty('scopeSpans');
    expect(Array.isArray(parsed.resourceSpans[0].scopeSpans)).toBe(true);
    expect(parsed.resourceSpans[0].scopeSpans.length).toBe(1);
    expect(parsed.resourceSpans[0].scopeSpans[0].scope.name).toBe('agenttrace');
    expect(Array.isArray(parsed.resourceSpans[0].scopeSpans[0].spans)).toBe(true);
    agent.close();
  });

  it('maps trace to OTLP span with traceId/spanId (UUID normalized), kind, times, name', () => {
    const agent = new AgentTrace({ silent: true });
    const traceUuid = '12345678-1234-5678-9abc-123456789def';
    const traces = [
      makeTrace({
        id: traceUuid,
        name: 'span-name',
        status: 'success',
        latencyMs: 42,
        createdAt: 1_700_000_000_042,
      }),
    ];
    mockStorage.getTraces.mockReturnValue(traces);

    const otlpJson = agent.export('otel');
    const parsed = JSON.parse(otlpJson);
    const span = parsed.resourceSpans[0].scopeSpans[0].spans[0];

    expect(span.traceId).toBe('12345678123456789abc123456789def'); // 32 hex, dashes removed
    expect(span.spanId).toBe('1234567812345678'); // first 16 hex chars
    expect(span.name).toBe('span-name');
    expect(span.kind).toBe(1); // SPAN_KIND_INTERNAL
    // start = createdAt - latencyMs (both in ms) then *1e6 for unix nano
    expect(span.startTimeUnixNano).toBe(String(BigInt(1_700_000_000_000) * 1000000n));
    expect(span.endTimeUnixNano).toBe(String(BigInt(1_700_000_000_042) * 1000000n));
    agent.close();
  });

  it('sets STATUS_CODE_OK (1) for success, STATUS_CODE_ERROR (2) for errors with message', () => {
    const agent = new AgentTrace({ silent: true });
    const successTraces = [makeTrace({ id: 's-uuid', status: 'success' })];
    const errorTraces = [makeTrace({ id: 'e-uuid', status: 'error', error: 'boom' })];
    mockStorage.getTraces.mockReturnValue(successTraces);
    let otlp = JSON.parse(agent.export('otel'));
    let span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status).toEqual({ code: 1 });

    mockStorage.getTraces.mockReturnValue(errorTraces);
    otlp = JSON.parse(agent.export('otel'));
    span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status).toEqual({ code: 2, message: 'boom' });
    agent.close();
  });

  it('includes attributes for metadata, tokens, cost, status', () => {
    const agent = new AgentTrace({ silent: true });
    const traces = [
      makeTrace({
        id: 'attr-uuid',
        status: 'success',
        costUsd: 0.123,
        latencyMs: 10,
        tokens: {
          promptTokens: 11,
          completionTokens: 22,
          totalTokens: 33,
          model: 'gpt-x',
          provider: 'openai',
        },
        metadata: { user: 'u1', count: 5, ok: true, obj: { a: 1 } },
      }),
    ];
    mockStorage.getTraces.mockReturnValue(traces);

    const otlp = JSON.parse(agent.export('otel'));
    const attrs = otlp.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    const get = (k: string) => attrs.find((a: { key: string }) => a.key === k)?.value;

    expect(get('agenttrace.status')?.stringValue).toBe('success');
    expect(get('agenttrace.cost_usd')?.doubleValue).toBe(0.123);
    expect(get('agenttrace.latency_ms')?.intValue).toBe(10);
    expect(get('agenttrace.tokens.prompt')?.intValue).toBe(11);
    expect(get('agenttrace.tokens.completion')?.intValue).toBe(22);
    expect(get('agenttrace.tokens.total')?.intValue).toBe(33);
    expect(get('agenttrace.model')?.stringValue).toBe('gpt-x');
    expect(get('agenttrace.provider')?.stringValue).toBe('openai');
    expect(get('agenttrace.metadata.user')?.stringValue).toBe('u1');
    expect(get('agenttrace.metadata.count')?.intValue).toBe(5);
    expect(get('agenttrace.metadata.ok')?.boolValue).toBe(true);
    expect(get('agenttrace.metadata.obj')?.stringValue).toBe('{"a":1}');
    // also run_id etc
    expect(get('agenttrace.run_id')).toBeTruthy();
    agent.close();
  });

  it('includes resource attributes and handles empty traces', () => {
    const agent = new AgentTrace({ silent: true });
    mockStorage.getTraces.mockReturnValue([]);
    const otlp = JSON.parse(agent.export('otel'));
    expect(otlp.resourceSpans[0].resource.attributes.length).toBeGreaterThan(0);
    const svc = otlp.resourceSpans[0].resource.attributes.find(
      (a: { key: string }) => a.key === 'service.name',
    );
    expect(svc.value.stringValue).toBe('agenttrace');
    expect(otlp.resourceSpans[0].scopeSpans[0].spans).toEqual([]);
    agent.close();
  });

  it('handles non-UUID trace ids via hash fallback for traceId/spanId', () => {
    const agent = new AgentTrace({ silent: true });
    const traces = [makeTrace({ id: 'trace-xyz-123' })];
    mockStorage.getTraces.mockReturnValue(traces);
    const otlp = JSON.parse(agent.export('otel'));
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    // length checks
    expect(span.traceId.length).toBe(32);
    expect(span.spanId.length).toBe(16);
    agent.close();
  });
});

describe('score()', () => {
  it('creates a Scorer with name and fn', () => {
    const s = score('my-score', (t: Trace) => t.latencyMs / 1000);
    expect(s.name).toBe('my-score');
    expect(typeof s.fn).toBe('function');
    const trace = makeTrace({ latencyMs: 500 });
    expect(s.fn(trace)).toBe(0.5);
  });
});

describe('evaluate() and evaluateTrace()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.getTraces.mockReturnValue([]);
    mockStorage.getTrace.mockReturnValue(null);
    mockStorage.createScore.mockClear();
    mockStorage.getScores.mockReturnValue([]);
  });

  it('evaluate() runs scorers against traces and returns results', async () => {
    const agent = new AgentTrace({ silent: true });
    const traces = [
      makeTrace({ id: 't1', output: 'hello' }),
      makeTrace({ id: 't2', output: 'world!!' }),
    ];
    mockStorage.getTraces.mockReturnValue(traces);
    mockStorage.getTrace.mockImplementation(
      (id: string) => traces.find((t) => t.id === id) || null,
    );

    const lenScorer: Scorer = {
      name: 'len',
      fn: (t: Trace) => (t.output ? String(t.output).length : 0),
    };
    const results = await agent.evaluate({ scorers: [lenScorer] });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ traceId: 't1', scores: { len: 5 }, errors: {} });
    expect(results[1]).toEqual({ traceId: 't2', scores: { len: 7 }, errors: {} });
    expect(mockStorage.createScore).toHaveBeenCalledTimes(2);
    agent.close();
  });

  it('evaluate() supports runId and traceIds filters', async () => {
    const agent = new AgentTrace({ silent: true });
    const all = [makeTrace({ id: 'a', runId: 'r1' }), makeTrace({ id: 'b', runId: 'r2' })];
    mockStorage.getTraces.mockReturnValue([all[0]]);
    mockStorage.getTrace.mockImplementation((id) => all.find((t) => t.id === id) || null);

    const s: Scorer = { name: 's', fn: () => 1 };

    const byRun = await agent.evaluate({ scorers: [s], runId: 'r1' });
    expect(byRun).toHaveLength(1);
    expect(mockStorage.getTraces).toHaveBeenCalledWith({ runId: 'r1' });

    mockStorage.getTraces.mockClear();
    const byIds = await agent.evaluate({ scorers: [s], traceIds: ['b'] });
    expect(byIds).toHaveLength(1);
    expect(byIds[0].traceId).toBe('b');
    agent.close();
  });

  it('evaluateTrace() scores a single trace', async () => {
    const agent = new AgentTrace({ silent: true });
    const t = makeTrace({ id: 'single', latencyMs: 123 });
    mockStorage.getTrace.mockReturnValue(t);

    const latScorer: Scorer = { name: 'lat', fn: (tr: Trace) => tr.latencyMs };
    const res = await agent.evaluateTrace('single', [latScorer]);

    expect(res).toEqual({ traceId: 'single', scores: { lat: 123 }, errors: {} });
    expect(mockStorage.createScore).toHaveBeenCalledWith(expect.any(String), 'single', 'lat', 123);
    agent.close();
  });

  it('Scorer errors are caught and reported in errors field', async () => {
    const agent = new AgentTrace({ silent: true });
    const t = makeTrace({ id: 'errt' });
    mockStorage.getTrace.mockReturnValue(t);

    const bad: Scorer = {
      name: 'bad',
      fn: () => {
        throw new Error('scorer boom');
      },
    };
    const ok: Scorer = { name: 'ok', fn: () => 0.9 };

    const res = await agent.evaluateTrace('errt', [bad, ok]);

    expect(res.scores).toEqual({ ok: 0.9 });
    expect(res.errors.bad).toBe('scorer boom');
    // only the ok one stored
    expect(mockStorage.createScore).toHaveBeenCalledTimes(1);
    agent.close();
  });

  it('Scores are stored in SQLite and retrievable', async () => {
    const agent = new AgentTrace({ silent: true });
    const t = makeTrace({ id: 'storet' });
    mockStorage.getTrace.mockReturnValue(t);
    mockStorage.getScores.mockReturnValue([
      { id: 'sc1', traceId: 'storet', name: 'testsc', value: 0.42, createdAt: Date.now() },
    ]);

    const sc: Scorer = { name: 'testsc', fn: () => 0.42 };
    await agent.evaluateTrace('storet', [sc]);

    expect(mockStorage.createScore).toHaveBeenCalledWith(
      expect.any(String),
      'storet',
      'testsc',
      0.42,
    );

    const retrieved = mockStorage.getScores('storet');
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].name).toBe('testsc');
    expect(retrieved[0].value).toBe(0.42);
    agent.close();
  });

  it('evaluate respects concurrency option (processes in batches)', async () => {
    const agent = new AgentTrace({ silent: true });
    const traces = Array.from({ length: 5 }, (_, i) => makeTrace({ id: `c${i}` }));
    mockStorage.getTraces.mockReturnValue(traces);
    mockStorage.getTrace.mockImplementation(
      (id: string) => traces.find((tr) => tr.id === id) || null,
    );

    const s: Scorer = { name: 'c', fn: (tr: Trace) => tr.id.length };
    const results = await agent.evaluate({ scorers: [s], concurrency: 2 });

    expect(results).toHaveLength(5);
    // called 5 times (once per trace)
    expect(mockStorage.createScore).toHaveBeenCalledTimes(5);
    agent.close();
  });
});

// ---- Alerting tests (added for v0.2; does not modify any prior tests) ----
describe('alert()', () => {
  it('creates an AlertCondition', () => {
    const cond = (stats: TraceStats) => stats.totalTraces > 10;
    const a = alert({
      name: 'high-volume',
      condition: cond,
      cooldown: 120,
      webhook: 'https://ex/hook',
    });
    expect(a.name).toBe('high-volume');
    expect(typeof a.condition).toBe('function');
    expect(a.condition({ totalTraces: 5 } as unknown as TraceStats)).toBe(false);
    expect(a.cooldown).toBe(120);
    expect(a.webhook).toBe('https://ex/hook');
    expect(a.lastTriggered).toBeUndefined();
  });
});

describe('registerAlert() and getAlerts()', () => {
  it('registerAlert() stores alert and getAlerts returns it', () => {
    mockStorage.saveAlert = vi.fn();
    mockStorage.getStoredAlerts = vi.fn(() => []);
    const agent = new AgentTrace({ silent: true });
    const cond = (stats: TraceStats) => (stats.totalTraces || 0) > 0;
    const al = alert({ name: 'vol', condition: cond, cooldown: 30 });
    agent.registerAlert(al);
    expect(mockStorage.saveAlert).toHaveBeenCalledWith(
      'vol',
      expect.objectContaining({ cooldown: 30 }),
    );
    const got = agent.getAlerts();
    expect(got.some((g) => g.name === 'vol')).toBe(true);
    agent.close();
  });
});

describe('checkAlerts()', () => {
  it('checkAlerts() fires when condition is met', async () => {
    mockStorage.saveAlert = vi.fn();
    mockStorage.getStoredAlerts = vi.fn(() => []);
    mockStorage.insertAlertHistory = vi.fn();
    mockStorage.getAlertHistory = vi.fn(() => []);
    const agent = new AgentTrace({ silent: true });
    const al = alert({
      name: 'always',
      condition: (_stats: TraceStats) => true,
      cooldown: 0,
    });
    agent.registerAlert(al);
    mockStorage.getStats.mockReturnValue({ totalTraces: 1 } as unknown as TraceStats);
    const fired = await agent.checkAlerts();
    expect(fired.length).toBe(1);
    expect(fired[0].alertName).toBe('always');
    expect(fired[0].delivered).toBe(false); // no webhook
    expect(mockStorage.insertAlertHistory).toHaveBeenCalled();
    agent.close();
  });

  it('Cooldown prevents rapid re-triggering', async () => {
    mockStorage.saveAlert = vi.fn();
    mockStorage.getStoredAlerts = vi.fn(() => []);
    mockStorage.insertAlertHistory = vi.fn();
    mockStorage.getAlertHistory = vi.fn(() => []);
    const agent = new AgentTrace({ silent: true });
    const al = alert({
      name: 'cd',
      condition: () => true,
      cooldown: 9999,
    });
    agent.registerAlert(al);
    mockStorage.getStats.mockReturnValue({ totalTraces: 1 } as unknown as TraceStats);
    const first = await agent.checkAlerts();
    expect(first.length).toBe(1);
    const second = await agent.checkAlerts();
    expect(second.length).toBe(0);
    agent.close();
  });

  it('Webhook delivery is attempted and logged', async () => {
    mockStorage.saveAlert = vi.fn();
    mockStorage.getStoredAlerts = vi.fn(() => []);
    mockStorage.insertAlertHistory = vi.fn((h: AlertHistory) => h);
    mockStorage.getAlertHistory = vi.fn(() => []);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const g = global as unknown as { fetch?: typeof fetch };
    const orig = g.fetch;
    g.fetch = fetchMock as unknown as typeof fetch;
    try {
      const agent = new AgentTrace({ silent: true });
      const al = alert({
        name: 'wh',
        condition: () => true,
        webhook: 'https://hooks.example/test',
        cooldown: 0,
      });
      agent.registerAlert(al);
      mockStorage.getStats.mockReturnValue({ totalTraces: 3 } as unknown as TraceStats);
      const res = await agent.checkAlerts();
      expect(res.length).toBe(1);
      expect(res[0].delivered).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://hooks.example/test',
        expect.objectContaining({ method: 'POST', headers: expect.any(Object) }),
      );
      expect(mockStorage.insertAlertHistory).toHaveBeenCalledWith(
        expect.objectContaining({ alertName: 'wh', delivered: true }),
      );
      agent.close();
    } finally {
      g.fetch = orig;
    }
  });
});

describe('auto alert check after trace', () => {
  it('triggers alert check automatically after trace() when condition met', async () => {
    mockStorage.saveAlert = vi.fn();
    mockStorage.getStoredAlerts = vi.fn(() => []);
    mockStorage.insertAlertHistory = vi.fn();
    mockStorage.getAlertHistory = vi.fn(() => []);
    mockStorage.createTrace.mockImplementation((t: unknown) => ({
      ...(t as Record<string, unknown>),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    const agent = new AgentTrace({ silent: true });
    agent.startRun('arun');
    const al = alert({ name: 'auto1', condition: (_stats: TraceStats) => true, cooldown: 0 });
    agent.registerAlert(al);
    mockStorage.getStats.mockReturnValue({ totalTraces: 1 } as unknown as TraceStats);
    await agent.trace('op', async () => 'x');
    expect(mockStorage.insertAlertHistory).toHaveBeenCalled();
    agent.close();
  });
});
