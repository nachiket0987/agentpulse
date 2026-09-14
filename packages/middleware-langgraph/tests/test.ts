import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentTraceMiddleware, VERSION, PACKAGE_NAME } from '../src/index.js';
import { AgentTrace } from '@agenttrace-io/sdk';

function makeTempDb(): { path: string; cleanup: () => void } {
  const path = `/tmp/agenttrace-mw-langgraph-${randomUUID()}.db`;
  const cleanup = () => {
    try {
      // best effort remove; storage will handle
      void 0;
    } catch (_) {
      /* ignore */
    }
  };
  return { path, cleanup };
}

describe('@agenttrace-io/middleware-langgraph', () => {
  it('exports version and package name', () => {
    // Assert format rather than a hardcoded value so releases don't break this test.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(PACKAGE_NAME).toBe('@agenttrace-io/middleware-langgraph');
  });
});

describe('AgentTraceMiddleware', () => {
  let mw: AgentTraceMiddleware;
  let dbPath: string;
  let cleanup: () => void;
  let inspector: AgentTrace;

  beforeEach(() => {
    const t = makeTempDb();
    dbPath = t.path;
    cleanup = t.cleanup;
    mw = new AgentTraceMiddleware({ dbPath, silent: true });
    inspector = new AgentTrace({ dbPath, silent: true });
  });

  afterEach(() => {
    try {
      mw.close();
    } catch (_) {
      /* ignore */
    }
    try {
      inspector.close();
    } catch (_) {
      /* ignore */
    }
    cleanup();
  });

  it('traces a successful node via before/after', () => {
    mw.beforeNode('research', { query: 'foo' });
    mw.afterNode('research', { query: 'foo' }, { answer: 'bar' });

    const traces = inspector.getTraces();
    expect(traces.length).toBe(1);
    const t = traces[0];
    expect(t.name).toBe('research');
    expect(t.status).toBe('success');
    expect(t.input).toEqual({ query: 'foo' });
    expect(t.output).toEqual({ answer: 'bar' });
    expect(t.metadata.framework).toBe('langgraph');
    expect(typeof t.latencyMs).toBe('number');
  });

  it('records error via onError', () => {
    mw.beforeNode('bad-node', { x: 1 });
    mw.onError('bad-node', { x: 1 }, new Error('node failed'));

    const traces = inspector.getTraces({ status: ['error'] });
    expect(traces.length).toBe(1);
    expect(traces[0].status).toBe('error');
    expect(traces[0].error).toBe('node failed');
  });

  it('extracts tokens from common LangGraph/LangChain message shapes', () => {
    mw.beforeNode('llm', {});
    const resultWithUsage = {
      content: 'hi',
      usage_metadata: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
      response_metadata: { model_name: 'gpt-4o-mini' },
    };
    mw.afterNode('llm', {}, resultWithUsage);

    const traces = inspector.getTraces();
    expect(traces[0].tokens).toMatchObject({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19,
      model: 'gpt-4o-mini',
    });
  });

  it('supports nested calls to same node name via stack', () => {
    mw.beforeNode('step', { i: 0 });
    mw.beforeNode('step', { i: 1 });
    mw.afterNode('step', { i: 1 }, { o: 1 });
    mw.afterNode('step', { i: 0 }, { o: 0 });

    const traces = inspector.getTraces().sort((a, b) => a.createdAt - b.createdAt);
    expect(traces.length).toBe(2);
    expect(traces[0].input).toEqual({ i: 0 });
    expect(traces[1].input).toEqual({ i: 1 });
  });

  it('getAgentTrace returns the internal agent and supports startRun', () => {
    const agent = mw.getAgentTrace();
    expect(agent).toBeInstanceOf(AgentTrace);
    const rid = agent.startRun('lg-run');
    expect(typeof rid).toBe('string');
    // run recorded
    expect(agent.getRuns().length).toBe(1);
  });

  it('close shuts down storage', () => {
    const agent = mw.getAgentTrace();
    mw.close();
    // calling again is safe
    expect(() => agent.close()).not.toThrow();
  });

  it('captures a traced call via before/after (integration)', () => {
    mw.beforeNode('search', { q: 'hello' });
    mw.afterNode('search', { q: 'hello' }, { results: 3 });

    const traces = inspector.getTraces({ name: 'search' });
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0].status).toBe('success');
    expect(traces[0].metadata.framework).toBe('langgraph');
  });

  it('works with parent/child context via shared run', () => {
    const agent = mw.getAgentTrace();
    const runId = agent.startRun('parent-child-run');
    mw.beforeNode('parent', { step: 1 });
    mw.afterNode('parent', { step: 1 }, { out: 1 });
    mw.beforeNode('child', { step: 2 });
    mw.afterNode('child', { step: 2 }, { out: 2 });

    const traces = inspector.getTraces({ runId });
    expect(traces.length).toBeGreaterThanOrEqual(2);
    const names = traces.map((t) => t.name);
    expect(names).toContain('parent');
    expect(names).toContain('child');
    // all share the explicit run
    expect(traces.every((t) => t.runId === runId)).toBe(true);
  });

  // Task 2c addition: explicit integration capture + context propagation
  it('middleware captures a traced call and propagates parent run context (integration)', () => {
    const agent = mw.getAgentTrace();
    const rid = agent.startRun('mw-integration-run');
    mw.beforeNode('search', { q: 'hello' });
    mw.afterNode('search', { q: 'hello' }, { results: 3 });
    mw.beforeNode('summarize', { text: '...' });
    mw.afterNode('summarize', { text: '...' }, { summary: 'short' });

    const traces = inspector.getTraces({ runId: rid });
    expect(traces.length).toBeGreaterThanOrEqual(2);
    expect(traces.some((t) => t.name === 'search' && t.status === 'success')).toBe(true);
    expect(traces.some((t) => t.name === 'summarize' && t.status === 'success')).toBe(true);
    expect(traces.every((t) => t.runId === rid)).toBe(true);
    expect(traces.every((t) => t.metadata && t.metadata.framework === 'langgraph')).toBe(true);
  });
});
