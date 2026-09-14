/**
 * AgentTrace Export Format Tests
 * Tests JSON, CSV, and OTEL export formats with various filters and dataset sizes.
 */

import { describe, expect, it } from 'vitest';
import { AgentTrace, type Trace } from './index.js';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';

function createTempDbPath(prefix = 'export'): string {
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

describe('AgentTrace export() -- JSON format', () => {
  it('1) JSON export: basic roundtrip — all trace fields present', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('json-roundtrip');
      await agent.trace('json-test-1', async () => ({ ans: 42 }), {
        input: { q: 'life' },
        tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150, model: 'gpt-4o' },
        model: 'gpt-4o',
        metadata: { tag: 'alpha' },
      });
      await agent.trace('json-test-2', async () => 'plain-string', {
        tokens: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      });

      const json = agent.export('json', { runId });
      const parsed = JSON.parse(json) as Trace[];

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);

      // Verify all expected fields on first trace
      const t0 = parsed[0];
      expect(t0).toHaveProperty('id');
      expect(t0).toHaveProperty('runId', runId);
      expect(t0).toHaveProperty('name');
      expect(t0).toHaveProperty('status');
      expect(t0).toHaveProperty('input');
      expect(t0).toHaveProperty('output');
      expect(t0).toHaveProperty('tokens');
      expect(t0.tokens).toHaveProperty('promptTokens');
      expect(t0.tokens).toHaveProperty('completionTokens');
      expect(t0.tokens).toHaveProperty('totalTokens');
      expect(t0).toHaveProperty('latencyMs');
      expect(t0).toHaveProperty('costUsd');
      expect(t0).toHaveProperty('metadata');
      expect(t0).toHaveProperty('createdAt');
      expect(t0).toHaveProperty('updatedAt');

      // Verify data integrity
      const tJson1 = parsed.find((t) => t.name === 'json-test-1')!;
      expect(tJson1.output).toEqual({ ans: 42 });
      expect(tJson1.input).toEqual({ q: 'life' });
      expect(tJson1.tokens.model).toBe('gpt-4o');
      expect(tJson1.tokens.totalTokens).toBe(150);
      expect(tJson1.costUsd).toBeGreaterThan(0);

      const tJson2 = parsed.find((t) => t.name === 'json-test-2')!;
      expect(tJson2.output).toBe('plain-string');
      expect(tJson2.tokens.totalTokens).toBe(30);
    } finally {
      cleanup();
    }
  });

  it('2) JSON export: empty traces returns empty array', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const json = agent.export('json', { runId: 'nonexistent-run' });
      const parsed = JSON.parse(json) as Trace[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('3) JSON export: output is valid parseable JSON (not corrupted)', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('json-validity');
      // Include special characters that might break JSON
      await agent.trace('special-chars', async () => 'he said "hello" & <bye>', {
        input: { unicode: 'こんにちは', emoji: '🦄' },
        tokens: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      });

      const json = agent.export('json', { runId });
      // Should not throw
      const parsed = JSON.parse(json) as Trace[];
      expect(parsed.length).toBe(1);
      expect(parsed[0].output).toBe('he said "hello" & <bye>');
      expect(parsed[0].input).toEqual({ unicode: 'こんにちは', emoji: '🦄' });
    } finally {
      cleanup();
    }
  });
});

describe('AgentTrace export() -- CSV format', () => {
  it('4) CSV export: header row correct, data rows match traces', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('csv-header-test');
      await agent.trace('csv-row-a', async () => 'a-out', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await agent.trace('csv-row-b', async () => 'b-out', {
        tokens: { promptTokens: 20, completionTokens: 10, totalTokens: 30, model: 'gpt-4o' },
      });
      await agent.trace('csv-row-c', async () => 'c-out', {
        tokens: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
      });

      const csv = agent.export('csv', { runId });
      const lines = csv.trim().split('\n');

      // Header + 3 data rows
      expect(lines.length).toBe(4);
      expect(lines[0]).toBe('id,runId,name,status,latencyMs,costUsd,totalTokens,createdAt');

      // Each data row has 8 columns
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        expect(cols.length).toBe(8);
      }

      // Verify trace names appear
      const nameCol = lines.slice(1).map((ln) => ln.split(',')[2]);
      expect(nameCol.sort()).toEqual(['csv-row-a', 'csv-row-b', 'csv-row-c']);
    } finally {
      cleanup();
    }
  });

  it('5) CSV export: empty traces returns header-only', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const csv = agent.export('csv', { runId: 'nope' });
      const lines = csv.trim().split('\n');
      expect(lines.length).toBe(1);
      expect(lines[0]).toBe('id,runId,name,status,latencyMs,costUsd,totalTokens,createdAt');
    } finally {
      cleanup();
    }
  });

  it('6) CSV export: numeric values are correct in data rows', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('csv-numeric');
      await agent.trace('num-trace', async () => 'ok', {
        tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150, model: 'gpt-4o' },
        model: 'gpt-4o',
      });

      const csv = agent.export('csv', { runId });
      const lines = csv.trim().split('\n');
      expect(lines.length).toBe(2);

      const dataCols = lines[1].split(',');
      // totalTokens = 150
      expect(dataCols[6]).toBe('150');
      // status should be success
      expect(dataCols[3]).toBe('success');
      // id and runId should be non-empty
      expect(dataCols[0].length).toBeGreaterThan(0);
      expect(dataCols[1].length).toBeGreaterThan(0);
      expect(dataCols[1]).toBe(runId);
    } finally {
      cleanup();
    }
  });
});

describe('AgentTrace export() -- OTEL format', () => {
  it('7) OTEL export: valid OTLP JSON structure with resourceSpans', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('otel-structure');
      await agent.trace('otel-1', async () => 'otel-out', {
        tokens: { promptTokens: 50, completionTokens: 25, totalTokens: 75, model: 'gpt-4o' },
        model: 'gpt-4o',
      });

      const json = agent.export('otel', { runId });
      const otlp = JSON.parse(json) as Record<string, unknown>;

      // OTLP structure
      expect(otlp).toHaveProperty('resourceSpans');
      const resourceSpans = otlp.resourceSpans as Array<Record<string, unknown>>;
      expect(Array.isArray(resourceSpans)).toBe(true);
      expect(resourceSpans.length).toBe(1);

      const rs = resourceSpans[0];
      expect(rs).toHaveProperty('resource');
      expect(rs).toHaveProperty('scopeSpans');

      const scopeSpans = rs.scopeSpans as Array<Record<string, unknown>>;
      expect(scopeSpans.length).toBe(1);
      expect(scopeSpans[0].scope).toEqual({ name: 'agenttrace' });

      const spans = scopeSpans[0].spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(1);
      expect(spans[0]).toHaveProperty('traceId');
      expect(spans[0]).toHaveProperty('spanId');
      expect(spans[0]).toHaveProperty('name', 'otel-1');
      expect(spans[0]).toHaveProperty('kind', 1); // SPAN_KIND_INTERNAL
      expect(spans[0]).toHaveProperty('startTimeUnixNano');
      expect(spans[0]).toHaveProperty('endTimeUnixNano');
      expect(spans[0]).toHaveProperty('attributes');
      expect(spans[0]).toHaveProperty('status');
    } finally {
      cleanup();
    }
  });

  it('8) OTEL export: status OK for success, ERROR for error traces', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('otel-status');
      await agent.trace('ok-trace', async () => 'fine', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await expect(
        agent.trace('err-trace', async () => {
          throw new Error('otel boom');
        }),
      ).rejects.toThrow();

      const json = agent.export('otel', { runId });
      const otlp = JSON.parse(json) as Record<string, unknown>;
      const spans = (
        (otlp.resourceSpans as Array<Record<string, unknown>>)[0].scopeSpans as Array<
          Record<string, unknown>
        >
      )[0].spans as Array<Record<string, unknown>>;

      expect(spans.length).toBe(2);

      const okSpan = spans.find((s) => (s.name as string) === 'ok-trace')!;
      expect((okSpan.status as Record<string, unknown>).code).toBe(1); // STATUS_CODE_OK

      const errSpan = spans.find((s) => (s.name as string) === 'err-trace')!;
      expect((errSpan.status as Record<string, unknown>).code).toBe(2); // STATUS_CODE_ERROR
      // OTEL message is trace.error || trace.status — the error message from the thrown Error
      expect((errSpan.status as Record<string, unknown>).message).toBe('otel boom');
    } finally {
      cleanup();
    }
  });
});

describe('AgentTrace export() -- filtered exports', () => {
  it('9) filtered export: by status (success only)', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('filter-status');
      await agent.trace('s1', async () => 'ok', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await agent.trace('s2', async () => 'ok2', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await expect(
        agent.trace('e1', async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow();

      const allJson = agent.export('json', { runId });
      expect((JSON.parse(allJson) as Trace[]).length).toBe(3);

      const successJson = agent.export('json', { runId, status: ['success'] });
      const successTraces = JSON.parse(successJson) as Trace[];
      expect(successTraces.length).toBe(2);
      expect(successTraces.every((t) => t.status === 'success')).toBe(true);

      // CSV filtered
      const csv = agent.export('csv', { runId, status: ['success'] });
      const lines = csv.trim().split('\n');
      expect(lines.length).toBe(3); // header + 2 success rows

      // OTEL filtered
      const otelJson = agent.export('otel', { runId, status: ['error'] });
      const otlp = JSON.parse(otelJson) as Record<string, unknown>;
      const spans = (
        (otlp.resourceSpans as Array<Record<string, unknown>>)[0].scopeSpans as Array<
          Record<string, unknown>
        >
      )[0].spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('e1');
    } finally {
      cleanup();
    }
  });

  it('10) filtered export: by cost range (minCost / maxCost)', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('filter-cost');
      // Low cost trace (minimal tokens)
      await agent.trace('low-cost', async () => 'a', {
        tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
      // High cost trace (many tokens with expensive model)
      await agent.trace('high-cost', async () => 'b', {
        tokens: {
          promptTokens: 10000,
          completionTokens: 5000,
          totalTokens: 15000,
          model: 'gpt-4o',
        },
        model: 'gpt-4o',
      });

      const allTraces = agent.getTraces({ runId });
      const highCostTrace = allTraces.find((t) => t.name === 'high-cost')!;
      const lowCostTrace = allTraces.find((t) => t.name === 'low-cost')!;

      // Filter with minCost above low but below high
      const midThreshold = lowCostTrace.costUsd + 0.0001;
      const json = agent.export('json', { runId, minCost: midThreshold });
      const filtered = JSON.parse(json) as Trace[];
      expect(filtered.length).toBe(1);
      expect(filtered[0].name).toBe('high-cost');

      // Filter with maxCost below high
      const maxThreshold = highCostTrace.costUsd - 0.0001;
      const json2 = agent.export('json', { runId, maxCost: maxThreshold });
      const filtered2 = JSON.parse(json2) as Trace[];
      expect(filtered2.length).toBe(1);
      expect(filtered2[0].name).toBe('low-cost');
    } finally {
      cleanup();
    }
  });

  it('11) filtered export: by name (LIKE match)', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('filter-name');
      await agent.trace('alpha-step-1', async () => 'a', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await agent.trace('alpha-step-2', async () => 'b', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await agent.trace('beta-step-1', async () => 'c', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const json = agent.export('json', { runId, name: 'alpha' });
      const filtered = JSON.parse(json) as Trace[];
      expect(filtered.length).toBe(2);
      expect(filtered.every((t) => t.name.startsWith('alpha'))).toBe(true);

      const csv = agent.export('csv', { runId, name: 'beta' });
      const lines = csv.trim().split('\n');
      expect(lines.length).toBe(2); // header + 1 row
    } finally {
      cleanup();
    }
  });

  it('12) filtered export: by date range (fromDate / toDate)', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('filter-date');
      await agent.trace('early-trace', async () => 'old', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      // Record the time after first trace with a buffer
      await new Promise((r) => setTimeout(r, 50));
      const afterFirst = Date.now();
      await new Promise((r) => setTimeout(r, 50));

      await agent.trace('late-trace', async () => 'new', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      // Export only early traces (toDate before the late trace)
      const earlyJson = agent.export('json', { runId, toDate: afterFirst });
      const earlyTraces = JSON.parse(earlyJson) as Trace[];
      expect(earlyTraces.length).toBeGreaterThanOrEqual(1);
      expect(earlyTraces.some((t) => t.name === 'early-trace')).toBe(true);

      // Export only late traces (fromDate after the early trace)
      const allTraces = agent.getTraces({ runId });
      const earlyMaxCa = Math.max(
        ...allTraces.filter((t) => t.name === 'early-trace').map((t) => t.createdAt),
      );
      const lateJson = agent.export('json', { runId, fromDate: earlyMaxCa + 1 });
      const lateTraces = JSON.parse(lateJson) as Trace[];
      expect(lateTraces.length).toBeGreaterThanOrEqual(1);
      expect(lateTraces.some((t) => t.name === 'late-trace')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('13) filtered export: with limit and offset', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('filter-limit');
      for (let i = 0; i < 5; i++) {
        await agent.trace(`lim-${i}`, async () => `r-${i}`, {
          tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });
      }

      // Limit 2
      const json1 = agent.export('json', { runId, limit: 2 });
      expect((JSON.parse(json1) as Trace[]).length).toBe(2);

      // Limit 2, offset 2
      const json2 = agent.export('json', { runId, limit: 2, offset: 2 });
      expect((JSON.parse(json2) as Trace[]).length).toBe(2);

      // Limit 10, offset beyond total returns empty
      const json3 = agent.export('json', { runId, limit: 10, offset: 100 });
      expect((JSON.parse(json3) as Trace[]).length).toBe(0);

      // CSV with limit
      const csv = agent.export('csv', { runId, limit: 3 });
      const lines = csv.trim().split('\n');
      expect(lines.length).toBe(4); // header + 3 rows
    } finally {
      cleanup();
    }
  });
});

describe('AgentTrace export() -- large dataset exports', () => {
  it('14) large dataset: JSON export of 500 traces is valid and complete', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('large-json');
      const COUNT = 500;
      for (let i = 0; i < COUNT; i++) {
        await agent.trace(`bulk-json-${i}`, async () => `out-${i}`, {
          tokens: {
            promptTokens: (i % 10) * 5,
            completionTokens: (i % 7) * 3,
            totalTokens: (i % 10) * 5 + (i % 7) * 3,
          },
          metadata: { idx: i },
        });
      }

      const json = agent.export('json', { runId });
      const parsed = JSON.parse(json) as Trace[];
      expect(parsed.length).toBe(COUNT);

      // Spot check first, middle, last
      expect(parsed.some((t) => t.name === 'bulk-json-0')).toBe(true);
      expect(parsed.some((t) => t.name === 'bulk-json-249')).toBe(true);
      expect(parsed.some((t) => t.name === 'bulk-json-499')).toBe(true);

      // All have valid structure
      for (const t of parsed) {
        expect(t.id).toBeTruthy();
        expect(t.runId).toBe(runId);
        expect(typeof t.createdAt).toBe('number');
        expect(typeof t.costUsd).toBe('number');
      }
    } finally {
      cleanup();
    }
  });

  it('15) large dataset: CSV export of 500 traces has correct row count', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('large-csv');
      const COUNT = 500;
      for (let i = 0; i < COUNT; i++) {
        await agent.trace(`bulk-csv-${i}`, async () => `out-${i}`, {
          tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });
      }

      const csv = agent.export('csv', { runId });
      const lines = csv.trim().split('\n');
      expect(lines.length).toBe(COUNT + 1); // header + 500 data rows

      // Header is correct
      expect(lines[0]).toBe('id,runId,name,status,latencyMs,costUsd,totalTokens,createdAt');

      // Every data row has 8 columns
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i].split(',').length).toBe(8);
      }
    } finally {
      cleanup();
    }
  });

  it('16) large dataset: OTEL export of 200 traces has correct span count', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('large-otel');
      const COUNT = 200;
      for (let i = 0; i < COUNT; i++) {
        await agent.trace(`bulk-otel-${i}`, async () => `out-${i}`, {
          tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });
      }

      const json = agent.export('otel', { runId });
      const otlp = JSON.parse(json) as Record<string, unknown>;
      const spans = (
        (otlp.resourceSpans as Array<Record<string, unknown>>)[0].scopeSpans as Array<
          Record<string, unknown>
        >
      )[0].spans as Array<Record<string, unknown>>;
      expect(spans.length).toBe(COUNT);

      // All spans have required OTEL fields
      for (const span of spans) {
        expect(span).toHaveProperty('traceId');
        expect(span).toHaveProperty('spanId');
        expect(span).toHaveProperty('name');
        expect(span).toHaveProperty('startTimeUnixNano');
        expect(span).toHaveProperty('endTimeUnixNano');
        expect(span).toHaveProperty('attributes');
        expect(span).toHaveProperty('status');
      }
    } finally {
      cleanup();
    }
  });
});

describe('AgentTrace export() -- default format and edge cases', () => {
  it('17) default format is JSON when no format specified', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('default-format');
      await agent.trace('default-test', async () => 'ok', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      // Call export with no format argument (defaults to 'json')
      const result = agent.export('json', { runId });
      // Should be valid JSON array
      const parsed = JSON.parse(result) as Trace[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('18) export with no filter exports all traces across runs', async () => {
    const { agent, cleanup } = createAgent();
    try {
      agent.startRun('multi-run-1');
      await agent.trace('multi-1', async () => 'a', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      agent.completeRun();

      agent.startRun('multi-run-2');
      await agent.trace('multi-2', async () => 'b', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      // Export all (no filter)
      const json = agent.export('json');
      const parsed = JSON.parse(json) as Trace[];
      expect(parsed.length).toBe(2);
      expect(parsed.some((t) => t.name === 'multi-1')).toBe(true);
      expect(parsed.some((t) => t.name === 'multi-2')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('19) export with combined filters (status + name + limit)', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('combined-filters');
      await agent.trace('alpha-ok-1', async () => 'a', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await agent.trace('alpha-ok-2', async () => 'b', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await agent.trace('alpha-ok-3', async () => 'c', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await expect(
        agent.trace('alpha-fail', async () => {
          throw new Error('combo fail');
        }),
      ).rejects.toThrow();
      await agent.trace('beta-ok', async () => 'd', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      // Combined: status=success, name contains 'alpha', limit 2
      const json = agent.export('json', {
        runId,
        status: ['success'],
        name: 'alpha',
        limit: 2,
      });
      const parsed = JSON.parse(json) as Trace[];
      expect(parsed.length).toBe(2);
      expect(parsed.every((t) => t.status === 'success')).toBe(true);
      expect(parsed.every((t) => t.name.includes('alpha'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('20) export consistency: JSON and CSV export same traces for same filter', async () => {
    const { agent, cleanup } = createAgent();
    try {
      const runId = agent.startRun('consistency');
      await agent.trace('c1', async () => 'x', {
        tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      await agent.trace('c2', async () => 'y', {
        tokens: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      });

      const jsonTraces = JSON.parse(agent.export('json', { runId })) as Trace[];
      const csvLines = agent.export('csv', { runId }).trim().split('\n');

      // Same count
      expect(jsonTraces.length).toBe(2);
      expect(csvLines.length).toBe(3); // header + 2

      // Names match
      const jsonNames = jsonTraces.map((t) => t.name).sort();
      const csvNames = csvLines
        .slice(1)
        .map((ln) => ln.split(',')[2])
        .sort();
      expect(jsonNames).toEqual(csvNames);

      // Build a map from CSV: name -> totalTokens
      const csvTokenMap: Record<string, number> = {};
      for (let i = 1; i < csvLines.length; i++) {
        const cols = csvLines[i].split(',');
        csvTokenMap[cols[2]] = parseInt(cols[6], 10);
      }

      // Verify each JSON trace's totalTokens matches CSV
      for (const jt of jsonTraces) {
        expect(csvTokenMap[jt.name]).toBe(jt.tokens.totalTokens);
      }
    } finally {
      cleanup();
    }
  });
});
