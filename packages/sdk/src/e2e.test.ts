/**
 * AgentTrace E2E Integration Tests
 * Comprehensive real-SQLite end-to-end tests (no mocks).
 * Covers full workflows, errors, costs, export, stats, filters, concurrency, scale.
 */

import { describe, expect, it } from 'vitest';
import { AgentTrace, init, getAgentTrace, type Trace } from './index';
import { TraceStorage } from './storage';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';

function createTempDbPath(prefix = 'e2e'): string {
  return `./${prefix}-test-${randomUUID()}.db`;
}

function cleanupDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(dbPath + suffix);
    } catch (_) {
      /* ignore */
    }
  }
}

describe('AgentTrace E2E (real SQLite)', () => {
  // Shared helpers; each test manages its own agent + db for isolation
  function createAgent(dbPath?: string): {
    agent: AgentTrace;
    dbPath: string;
    cleanup: () => void;
  } {
    const db = dbPath || createTempDbPath();
    const agent = new AgentTrace({ dbPath: db, silent: true });
    const cleanup = () => {
      try {
        agent.close();
      } catch (_) {
        /* ignore */
      }
      cleanupDbFiles(db);
    };
    return { agent, dbPath: db, cleanup };
  }

  it('1) complete agent workflow: init → startRun → multiple traces → completeRun → verify all data in SQLite', async () => {
    const dbPath = createTempDbPath('workflow');
    // Use init() as specified
    const agent = init({ dbPath, silent: true });
    const cleanup = () => {
      try {
        agent.close();
      } catch (_) {
        /* ignore */
      }
      try {
        const ga = getAgentTrace();
        if (ga && ga !== agent) ga.close();
      } catch (_) {
        /* ignore */
      }
      cleanupDbFiles(dbPath);
    };
    try {
      // Verify singleton
      expect(getAgentTrace()).toBe(agent);

      const runId = agent.startRun('e2e-workflow-run', {
        purpose: 'comprehensive-e2e',
        env: 'test',
      });
      expect(typeof runId).toBe('string');
      expect(runId.length).toBeGreaterThan(10);

      // multiple traces (mix of inputs, outputs, tokens)
      const res1 = await agent.trace('step-llm', async () => ({ answer: 42, ok: true }), {
        input: { question: 'what is life?' },
        tokens: {
          promptTokens: 120,
          completionTokens: 60,
          totalTokens: 180,
          model: 'gpt-4o',
          provider: 'openai',
        },
        metadata: { step: 1 },
      });
      expect(res1).toEqual({ answer: 42, ok: true });

      const res2 = await agent.trace('step-tool', async () => 'tool-output-xyz', {
        input: { tool: 'search', q: 'x' },
        tokens: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
        metadata: { step: 2, tool: 'web' },
      });
      expect(res2).toBe('tool-output-xyz');

      const res3 = await agent.trace('step-final', async () => 'done', {
        input: null,
        tokens: {
          promptTokens: 5,
          completionTokens: 15,
          totalTokens: 20,
          model: 'claude-sonnet-4',
        },
      });
      expect(res3).toBe('done');

      // complete the run
      agent.completeRun('success');

      // Verify via public API
      const traces = agent.getTraces({ runId });
      expect(traces.length).toBe(3);
      // getTraces returns newest first (created_at DESC)
      const names = traces.map((t) => t.name).sort();
      expect(names).toEqual(['step-final', 'step-llm', 'step-tool'].sort());

      const t1 = traces.find((t) => t.name === 'step-llm')!;
      expect(t1.status).toBe('success');
      expect(t1.input).toEqual({ question: 'what is life?' });
      expect(t1.output).toEqual({ answer: 42, ok: true });
      expect(t1.tokens.totalTokens).toBe(180);
      expect(t1.tokens.model).toBe('gpt-4o');
      expect(t1.costUsd).toBeGreaterThan(0.0001);
      expect(t1.latencyMs).toBeGreaterThanOrEqual(0);
      expect(t1.metadata).toEqual({ step: 1 });
      expect(t1.runId).toBe(runId);
      expect(t1.error).toBeNull();
      expect(typeof t1.createdAt).toBe('number');
      expect(t1.createdAt).toBeGreaterThan(0);

      const run = agent.getRun(runId);
      expect(run).not.toBeNull();
      expect(run!.name).toBe('e2e-workflow-run');
      expect(run!.status).toBe('success');
      expect(run!.traceCount).toBe(3);
      expect(run!.totalTokens.totalTokens).toBe(180 + 40 + 20);
      expect(run!.totalCostUsd).toBeGreaterThan(0);
      expect(run!.metadata).toEqual({ purpose: 'comprehensive-e2e', env: 'test' });
      expect(run!.startedAt).toBeGreaterThan(0);
      expect(run!.completedAt).toBeGreaterThanOrEqual(run!.startedAt!);

      // Direct SQLite verification via TraceStorage
      const storage = new TraceStorage(dbPath);
      try {
        const dbTraces = storage.getTraces({ runId });
        expect(dbTraces.length).toBe(3);
        const dbRun = storage.getRun(runId);
        expect(dbRun).not.toBeNull();
        expect(dbRun!.status).toBe('success');
        expect(dbRun!.traceCount).toBe(3);
        expect(dbRun!.totalTokens.totalTokens).toBe(240);
        // spot check raw-ish via getTrace
        const t = storage.getTrace(t1.id);
        expect(t).not.toBeNull();
        expect(t!.costUsd).toBeCloseTo(t1.costUsd, 6);
      } finally {
        storage.close();
      }
    } finally {
      cleanup();
    }
  });

  it('2) error handling: trace with error → verify error recorded', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('error-run');
      await expect(
        agent.trace(
          'failing-step',
          async () => {
            throw new Error('intentional e2e failure: boom');
          },
          { input: { willFail: true } },
        ),
      ).rejects.toThrow('intentional e2e failure: boom');

      const traces = agent.getTraces({ runId });
      expect(traces.length).toBe(1);
      const t = traces[0];
      expect(t.name).toBe('failing-step');
      expect(t.status).toBe('error');
      expect(t.error).toContain('intentional e2e failure: boom');
      expect(t.output).toBeNull(); // from code: result! is not set on error path but stored as null-ish
      expect(t.input).toEqual({ willFail: true });

      // also verify via getTrace
      const direct = agent.getTrace(t.id);
      expect(direct).not.toBeNull();
      expect(direct!.status).toBe('error');
      expect(direct!.error).toBe(t.error);

      // stats should reflect error
      const stats = agent.getStats();
      expect(stats.totalTraces).toBe(1);
      expect(stats.successRate).toBe(0);
      expect(stats.topErrors.length).toBeGreaterThan(0);
      expect(stats.topErrors.some((e) => (e.error || '').includes('boom'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('3) token tracking: trace with token usage → verify cost calculated', async () => {
    const { agent, cleanup } = createAgent();
    try {
      agent.startRun('cost-run');

      // known model
      await agent.trace('priced', async () => 'ok', {
        tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, model: 'gpt-4o' },
        model: 'gpt-4o',
      });

      // unknown model (falls to default rate)
      await agent.trace('default-priced', async () => 'ok2', {
        tokens: {
          promptTokens: 200,
          completionTokens: 100,
          totalTokens: 300,
          model: 'mystery-model',
        },
        model: 'mystery-model',
      });

      // zero tokens
      await agent.trace('free', async () => 'ok3', {
        tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });

      const traces = agent.getTraces();
      expect(traces.length).toBe(3);

      const priced = traces.find((t) => t.name === 'priced')!;
      // (1000*0.0025 + 500*0.01)/1000 = 0.0075
      expect(priced.costUsd).toBeCloseTo(0.0075, 6);
      expect(priced.tokens.totalTokens).toBe(1500);

      const def = traces.find((t) => t.name === 'default-priced')!;
      // (200*0.001 + 100*0.002)/1000 = 0.0004
      expect(def.costUsd).toBeCloseTo(0.0004, 6);

      const free = traces.find((t) => t.name === 'free')!;
      expect(free.costUsd).toBe(0);

      const stats = agent.getStats();
      expect(stats.totalCostUsd).toBeCloseTo(0.0079, 5);
      expect(stats.costByModel).toBeDefined();
      expect(stats.costByModel!['gpt-4o']).toBeCloseTo(0.0075, 6);
    } finally {
      cleanup();
    }
  });

  it('4) export: export JSON and CSV → verify format', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('export-run');
      await agent.trace('exp-json', async () => ({ x: 1 }), {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await agent.trace('exp-csv', async () => 'csv-out', {
        tokens: { promptTokens: 3, completionTokens: 7, totalTokens: 10, model: 'gpt-4o-mini' },
      });

      // JSON
      const json = agent.export('json', { runId });
      const parsed = JSON.parse(json) as Trace[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      expect(parsed.some((p) => p.name === 'exp-json')).toBe(true);
      expect(parsed[0]).toHaveProperty('id');
      expect(parsed[0]).toHaveProperty('runId', runId);
      expect(parsed[0]).toHaveProperty('tokens');
      expect(parsed[0].tokens).toHaveProperty('totalTokens');
      expect(parsed[0]).toHaveProperty('costUsd');
      expect(parsed[0]).toHaveProperty('latencyMs');
      expect(parsed[0]).toHaveProperty('createdAt');

      // CSV
      const csv = agent.export('csv', { runId });
      const lines = csv.trim().split('\n');
      expect(lines.length).toBe(3); // header + 2 rows
      expect(lines[0]).toBe('id,runId,name,status,latencyMs,costUsd,totalTokens,createdAt');
      // data rows should contain our trace names and values
      expect(lines.some((ln) => ln.includes('exp-json'))).toBe(true);
      expect(lines.some((ln) => ln.includes('exp-csv'))).toBe(true);
      // CSV cells are simple (no quotes needed for our data)
      const dataLine = lines.find((ln) => ln.includes('exp-csv'))!;
      const cols = dataLine.split(',');
      expect(cols.length).toBe(8);
      expect(cols[2]).toBe('exp-csv');
    } finally {
      cleanup();
    }
  });

  it('5) stats: getStats → verify aggregations', async () => {
    const { agent, cleanup } = createAgent();
    try {
      agent.startRun('stats-run');

      await agent.trace('s1', async () => 1, {
        tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      await agent.trace('s2', async () => 2, {
        tokens: { promptTokens: 0, completionTokens: 200, totalTokens: 200 },
      });

      // error one
      await expect(
        agent.trace('s3', async () => {
          throw new Error('stats-err');
        }),
      ).rejects.toThrow();

      const stats = agent.getStats();
      expect(stats.totalRuns).toBe(1);
      expect(stats.totalTraces).toBe(3);
      expect(stats.successRate).toBeCloseTo(2 / 3, 6);
      expect(stats.totalTokens).toBe(350);
      expect(stats.avgTokensPerTrace).toBeCloseTo(350 / 3, 6);
      expect(stats.totalCostUsd).toBeGreaterThanOrEqual(0);
      expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(stats.topTools)).toBe(true);
      expect(Array.isArray(stats.topErrors)).toBe(true);
      expect(stats.topErrors.length).toBeGreaterThan(0);
      expect(stats.topErrors[0].count).toBeGreaterThan(0);
      // costByModel present (even if partial)
      expect(stats.costByModel).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('6) filtering: getTraces with various filters', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('filter-run');

      const _t1 = await agent.trace('alpha-one', async () => 'a', {
        tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
      // small delay to ensure createdAt separation if needed
      await new Promise((r) => setTimeout(r, 2));
      await expect(
        agent.trace('beta-fail', async () => {
          throw new Error('filter-err');
        }),
      ).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 2));
      const _t3 = await agent.trace('alpha-two', async () => 'c', {
        tokens: { promptTokens: 500, completionTokens: 10, totalTokens: 510, model: 'gpt-4o' },
        model: 'gpt-4o',
      });

      // by runId
      expect(agent.getTraces({ runId }).length).toBe(3);
      expect(agent.getTraces({ runId: 'nope' }).length).toBe(0);

      // by status (array)
      const successes = agent.getTraces({ runId, status: ['success'] });
      expect(successes.length).toBe(2);
      expect(successes.every((t) => t.status === 'success')).toBe(true);

      const errors = agent.getTraces({ runId, status: ['error'] });
      expect(errors.length).toBe(1);
      expect(errors[0].status).toBe('error');

      // by name (LIKE)
      expect(agent.getTraces({ runId, name: 'alpha' }).length).toBe(2);
      expect(agent.getTraces({ runId, name: 'beta' }).length).toBe(1);
      expect(agent.getTraces({ runId, name: '-one' }).length).toBe(1);

      // date range (broad)
      const allInRun = agent.getTraces({ runId });
      const minCa = Math.min(...allInRun.map((t) => t.createdAt));
      const maxCa = Math.max(...allInRun.map((t) => t.createdAt));
      expect(agent.getTraces({ runId, fromDate: minCa - 1000, toDate: maxCa + 1000 }).length).toBe(
        3,
      );
      expect(agent.getTraces({ runId, fromDate: maxCa + 100000 }).length).toBe(0);

      // cost filters (high cost one is the gpt-4o)
      const highCost = agent.getTraces({ runId, minCost: 0.001 });
      expect(highCost.length).toBe(1);
      expect(highCost[0].name).toBe('alpha-two');

      const lowCost = agent.getTraces({ runId, maxCost: 0.00001 });
      expect(lowCost.length).toBeGreaterThanOrEqual(1);

      // latency (very broad)
      expect(agent.getTraces({ runId, minLatency: 0, maxLatency: 1000000 }).length).toBe(3);

      // limit/offset (newest first)
      const lim1 = agent.getTraces({ runId, limit: 1 });
      expect(lim1.length).toBe(1);
      const lim2off1 = agent.getTraces({ runId, limit: 2, offset: 1 });
      expect(lim2off1.length).toBe(2);
      // offset beyond
      expect(agent.getTraces({ runId, limit: 10, offset: 100 }).length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('7) concurrent traces: multiple parallel trace() calls', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('concurrent-run');

      const N = 12;
      const promises: Promise<number>[] = [];
      for (let i = 0; i < N; i++) {
        promises.push(
          agent.trace(
            `conc-op-${i}`,
            async () => {
              // tiny work
              await new Promise((r) => setTimeout(r, 1));
              return i * 10;
            },
            {
              input: { idx: i },
              tokens: { promptTokens: i + 1, completionTokens: i, totalTokens: 2 * i + 1 },
              metadata: { parallel: true, idx: i },
            },
          ),
        );
      }
      const results = await Promise.all(promises);
      expect(results).toEqual(Array.from({ length: N }, (_, i) => i * 10));

      const traces = agent.getTraces({ runId });
      expect(traces.length).toBe(N);

      // all succeeded, have distinct ids, runId correct, inputs captured
      const ids = new Set(traces.map((t) => t.id));
      expect(ids.size).toBe(N);
      expect(traces.every((t) => t.runId === runId && t.status === 'success')).toBe(true);
      expect(traces.some((t) => t.metadata.idx === 5)).toBe(true);

      // stats reflect concurrency
      const stats = agent.getStats();
      expect(stats.totalTraces).toBeGreaterThanOrEqual(N);
      expect(stats.successRate).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('8) large dataset: 1000 traces → verify performance and correctness', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('large-run');

      const COUNT = 1000;
      const t0 = Date.now();
      for (let i = 0; i < COUNT; i++) {
        await agent.trace(`bulk-${i}`, async () => `out-${i}`, {
          input: i % 3 === 0 ? { i } : null,
          tokens: {
            promptTokens: (i % 7) * 10,
            completionTokens: (i % 5) * 3,
            totalTokens: (i % 7) * 10 + (i % 5) * 3,
            model: i % 4 === 0 ? 'gpt-4o-mini' : undefined,
          },
          metadata: { batch: Math.floor(i / 100) },
        });
      }
      const dur = Date.now() - t0;

      const traces = agent.getTraces({ runId, limit: COUNT + 10 });
      expect(traces.length).toBe(COUNT);

      // spot check a few
      expect(traces.some((t) => t.name === 'bulk-0')).toBe(true);
      expect(traces.some((t) => t.name === 'bulk-999')).toBe(true);
      const mid = traces.find((t) => t.name === 'bulk-500');
      expect(mid).toBeTruthy();
      expect(mid!.output).toBe('out-500');
      expect(mid!.metadata.batch).toBe(5);

      // stats
      const stats = agent.getStats();
      expect(stats.totalTraces).toBeGreaterThanOrEqual(COUNT);
      expect(stats.totalRuns).toBeGreaterThanOrEqual(1);
      expect(stats.totalTokens).toBeGreaterThan(0);

      // performance sanity (generous; real inserts are fast)
      expect(dur).toBeLessThan(15000); // 15s max even on slow CI; typically << 2s

      // also verify getTraces pagination-ish works at scale
      const page = agent.getTraces({ runId, limit: 50, offset: 100 });
      expect(page.length).toBe(50);
      expect(page[0].name).not.toBe('bulk-0'); // because DESC order
    } finally {
      cleanup();
    }
  });

  it('also supports getTraces() without filter + getRuns + export otel smoke', async () => {
    const { agent, cleanup } = createAgent();
    try {
      // must startRun to satisfy FK (traces reference a run row)
      const runId = agent.startRun('smoke-run');
      await agent.trace('smoke-1', async () => 1, {
        tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
      await agent.trace('smoke-2', async () => 2);

      // getTraces without filter returns all (including this run's)
      const all = agent.getTraces();
      expect(all.length).toBeGreaterThanOrEqual(2);

      const runs = agent.getRuns(10);
      expect(runs.some((r) => r.id === runId)).toBe(true);

      // otel export basic structure (no filter)
      const otel = agent.export('otel');
      const parsed = JSON.parse(otel);
      expect(parsed).toHaveProperty('resourceSpans');
      expect(Array.isArray(parsed.resourceSpans)).toBe(true);
      // at least our two + any prior in shared? but since per-test agent fresh, ==2
      const spans = parsed.resourceSpans[0].scopeSpans[0].spans;
      expect(spans.length).toBe(2);
    } finally {
      cleanup();
    }
  });
});
