import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import { createDashboardApp, createApiKey, apiKeyStore } from './index.ts';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

let _memTotal = 16 * 1024 * 1024 * 1024;
let _memFree = 8 * 1024 * 1024 * 1024;
vi.mock('node:os', () => ({
  totalmem: vi.fn(() => _memTotal),
  freemem: vi.fn(() => _memFree),
  default: {
    totalmem: vi.fn(() => _memTotal),
    freemem: vi.fn(() => _memFree),
  },
}));

let _diskBfree = 500;
vi.mock('node:fs', () => ({
  statfsSync: vi.fn(() => ({ bsize: 4096, blocks: 10000, bfree: _diskBfree, bavail: _diskBfree })),
  default: {
    statfsSync: vi.fn(() => ({
      bsize: 4096,
      blocks: 10000,
      bfree: _diskBfree,
      bavail: _diskBfree,
    })),
  },
}));

function getServerPort(server: http.Server): number {
  const addr = server.address();
  if (addr && typeof addr === 'object' && 'port' in addr) {
    return ((addr as AddressInfo).port as number) || 0;
  }
  return 0;
}

describe('dashboard cost API endpoints (new tests)', () => {
  let servers: http.Server[] = [];
  let closes: Array<() => void> = [];

  beforeEach(() => {
    _memTotal = 16 * 1024 * 1024 * 1024;
    _memFree = 8 * 1024 * 1024 * 1024;
    _diskBfree = 500000;
  });

  afterEach(() => {
    servers.forEach((s) => {
      try {
        s.close();
      } catch (_) {
        /* ignore close errors in cleanup */
      }
    });
    closes.forEach((c) => {
      try {
        c();
      } catch (_) {
        /* ignore close errors in cleanup */
      }
    });
    servers = [];
    closes = [];
    apiKeyStore.clear();
    vi.restoreAllMocks();
  });

  async function startTemp(app: Express): Promise<{ port: number; base: string }> {
    const server = app.listen(0);
    servers.push(server);
    const port = getServerPort(server);
    // wait for listen
    await new Promise((r) => setTimeout(r, 5));
    return { port, base: `http://127.0.0.1:${port}` };
  }

  it('GET /api/costs returns total, costByModel, costByDay', async () => {
    const { app, trace, close } = createDashboardApp(':memory:');
    closes.push(close);
    const { plaintextKey } = createApiKey('test');

    trace.startRun('cost-run-x');
    await trace.trace('costed-1', async () => 'res1', {
      tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, model: 'gpt-4o' },
      model: 'gpt-4o',
    });
    await trace.trace('costed-2', async () => 'res2', {
      tokens: {
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
        model: 'gemini-2.5-pro',
      },
      model: 'gemini-2.5-pro',
    });

    const { base } = await startTemp(app);
    const res = await fetch(`${base}/api/costs`, {
      headers: { 'X-API-Key': plaintextKey },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.totalCostUsd).toBe('number');
    expect(data.totalCostUsd).toBeGreaterThan(0);
    expect(data.costByModel).toBeTruthy();
    expect(data.costByModel['gpt-4o']).toBeCloseTo(0.0075, 6);
    expect(data.costByModel['gemini-2.5-pro']).toBeCloseTo(0.00125, 6);
    expect(data.costByDay).toBeTruthy();
    expect(typeof data.costByDay).toBe('object');
  });

  it('GET /api/costs?run-id=... returns costs for specific run only', async () => {
    const { app, trace, close } = createDashboardApp(':memory:');
    closes.push(close);
    const { plaintextKey } = createApiKey('test');

    const run1 = trace.startRun('run-one');
    await trace.trace('r1-op', async () => 'x', {
      tokens: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000, model: 'gpt-4.1' },
      model: 'gpt-4.1',
    });
    trace.completeRun();

    const run2 = trace.startRun('run-two');
    await trace.trace('r2-op', async () => 'y', {
      tokens: {
        promptTokens: 1000,
        completionTokens: 0,
        totalTokens: 1000,
        model: 'claude-haiku-4.5',
      },
      model: 'claude-haiku-4.5',
    });
    trace.completeRun();

    const { base } = await startTemp(app);

    const allRes = await fetch(`${base}/api/costs`, {
      headers: { 'X-API-Key': plaintextKey },
    });
    const all = await allRes.json();
    expect(all.totalCostUsd).toBeCloseTo(0.003, 6); // 0.002 + 0.001

    const r1Res = await fetch(`${base}/api/costs?run-id=${run1}`, {
      headers: { 'X-API-Key': plaintextKey },
    });
    const r1 = await r1Res.json();
    expect(r1.totalCostUsd).toBeCloseTo(0.002, 6);
    expect(r1.costByModel['gpt-4.1']).toBeCloseTo(0.002, 6);
    expect(r1.costByModel['claude-haiku-4.5']).toBeUndefined();

    const r2Res = await fetch(`${base}/api/costs?run-id=${run2}`, {
      headers: { 'X-API-Key': plaintextKey },
    });
    const r2 = await r2Res.json();
    expect(r2.totalCostUsd).toBeCloseTo(0.001, 6);
    expect(r2.costByModel['claude-haiku-4.5']).toBeCloseTo(0.001, 6);
  });

  it('supports both run-id and runId query params', async () => {
    const { app, trace, close } = createDashboardApp(':memory:');
    closes.push(close);
    const { plaintextKey } = createApiKey('test');

    const rid = trace.startRun('qparam');
    await trace.trace('qp', async () => 1, {
      tokens: { promptTokens: 500, completionTokens: 0, totalTokens: 500, model: 'llama-4-scout' },
      model: 'llama-4-scout',
    });
    trace.completeRun();

    const { base } = await startTemp(app);

    const res1 = await fetch(`${base}/api/costs?run-id=${rid}`, {
      headers: { 'X-API-Key': plaintextKey },
    });
    const d1 = await res1.json();
    expect(d1.totalCostUsd).toBeCloseTo(0.00004, 6); // 500*0.00008 /1000 = 0.00004

    const res2 = await fetch(`${base}/api/costs?runId=${rid}`, {
      headers: { 'X-API-Key': plaintextKey },
    });
    const d2 = await res2.json();
    expect(d2.totalCostUsd).toBeCloseTo(0.00004, 6);
  });

  it('GET /api/health returns the full structured payload with checks', async () => {
    const { app, trace, close } = createDashboardApp(':memory:');
    closes.push(close);

    // seed a trace so totalTraces > 0, and some agent usage for activeAgents
    const _runId = trace.startRun('health-run');
    void _runId;
    await trace.trace('health-op', async () => 'ok', {
      tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    trace.recordAgentUsage({
      agentName: 'test-agent',
      action: 'test',
      status: 'success',
      tokensUsed: 15,
      costUsd: 0,
      durationMs: 10,
    });
    trace.completeRun();

    const { base } = await startTemp(app);
    const t0 = Date.now();
    const res = await fetch(`${base}/api/health`);
    const dur = Date.now() - t0;
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.status).toBe('healthy');
    expect(typeof data.version).toBe('string');
    expect(data.version.length).toBeGreaterThan(0);
    expect(typeof data.uptime).toBe('number');
    expect(data.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof data.timestamp).toBe('string');
    expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(data.checks).toBeTruthy();
    expect(data.checks.database.status).toBe('ok');
    expect(typeof data.checks.database.responseTime).toBe('number');
    expect(data.checks.database.responseTime).toBeGreaterThanOrEqual(0);
    expect(data.checks.database.responseTime).toBeLessThan(100);

    expect(data.checks.diskSpace).toBeTruthy();
    expect(['ok', 'warning', 'critical']).toContain(data.checks.diskSpace.status);
    expect(typeof data.checks.diskSpace.freeBytes).toBe('number');
    expect(typeof data.checks.diskSpace.totalBytes).toBe('number');

    expect(data.checks.memory).toBeTruthy();
    expect(['ok', 'warning', 'critical']).toContain(data.checks.memory.status);
    expect(typeof data.checks.memory.usedBytes).toBe('number');
    expect(typeof data.checks.memory.totalBytes).toBe('number');

    expect(typeof data.checks.activeAgents).toBe('number');
    expect(data.checks.activeAgents).toBeGreaterThanOrEqual(0);
    expect(typeof data.checks.totalTraces).toBe('number');
    expect(data.checks.totalTraces).toBeGreaterThanOrEqual(1);

    // endpoint fast
    expect(dur).toBeLessThan(100);
  });

  it('GET /api/health returns 200/healthy on fresh in-memory DB (simple query succeeds)', async () => {
    const { app, close } = createDashboardApp(':memory:');
    closes.push(close);

    const { base } = await startTemp(app);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('healthy');
    expect(data.checks.database.status).toBe('ok');
    expect(data.checks.totalTraces).toBe(0);
    // simple SELECT exercised; tables created by AgentTrace init
  });

  it('returns 503 + unhealthy when database connectivity fails', async () => {
    const { app, trace, close } = createDashboardApp(':memory:');
    // close the underlying DB to force error path in health check
    trace.close();
    closes.push(close);

    const { base } = await startTemp(app);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.status).toBe('unhealthy');
    expect(data.checks.database.status).toBe('error');
    expect(typeof data.checks.database.responseTime).toBe('number');
  });

  it('returns degraded (still 200) on resource warning (80-90%)', async () => {
    const total = 10000;
    const used = 8600; // 86%
    _memTotal = total;
    _memFree = total - used;

    const { app, close } = createDashboardApp(':memory:');
    closes.push(close);

    const { base } = await startTemp(app);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('degraded');
    expect(data.checks.memory.status).toBe('warning');
    expect(data.checks.memory.usedBytes).toBe(used);
  });

  it('returns unhealthy + 503 on critical memory (>=90%)', async () => {
    const total = 10000;
    const used = 9500; // 95% critical
    _memTotal = total;
    _memFree = total - used;

    const { app, close } = createDashboardApp(':memory:');
    closes.push(close);

    const { base } = await startTemp(app);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.status).toBe('unhealthy');
    expect(data.checks.memory.status).toBe('critical');
  });

  it('detects disk critical and reports unhealthy (via fs.statfsSync)', async () => {
    // simulate low disk (95% used) BEFORE creating app (so getDiskSpace sees it)
    _diskBfree = 500;

    const { app, close } = createDashboardApp(':memory:');
    closes.push(close);

    const { base } = await startTemp(app);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.status).toBe('unhealthy');
    expect(data.checks.diskSpace.status).toBe('critical');
    expect(data.checks.diskSpace.totalBytes).toBeGreaterThan(0);
  });
});
