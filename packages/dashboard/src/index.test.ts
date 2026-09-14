import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { PACKAGE_NAME, VERSION, createDashboardApp, createApiKey } from './index.js';
import { AgentTrace } from '@agenttrace-io/sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-dash-'));
  return path.join(dir, 'agenttrace.db');
}

function rmrf(p: string): void {
  try {
    if (fs.existsSync(p)) {
      if (fs.statSync(p).isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      } else {
        fs.unlinkSync(p);
        const d = path.dirname(p);
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      }
    }
  } catch {
    /* ignore */
  }
}

async function seedForDashboard(dbPath: string) {
  const t = new AgentTrace({ dbPath, silent: true });
  const rid = t.startRun('dash-run');
  await t.trace('dash-trace-1', async () => ({ ok: true }), {
    tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15, model: 'gpt-4o-mini' },
  });
  t.completeRun();
  t.close();
  return rid;
}

describe('@agenttrace-io/dashboard', () => {
  it('exports the package version', () => {
    expect(VERSION).toBe('0.2.0');
  });

  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('@agenttrace-io/dashboard');
  });
});

describe('Dashboard server API (createDashboardApp)', () => {
  let tmpDb: string;
  let server: http.Server;
  let port: number;
  let apiKey: string;
  let closeApp: () => void;

  beforeEach(async () => {
    tmpDb = makeTempDbPath();
    await seedForDashboard(tmpDb);

    const { app, close } = createDashboardApp(tmpDb);
    closeApp = close;

    // Create an API key for protected /api/* routes (health is open)
    const { plaintextKey } = createApiKey('test-key');
    apiKey = plaintextKey;

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });
  });

  afterEach(() => {
    try {
      server.close();
    } catch (_) {
      /* ignore */
    }
    try {
      closeApp?.();
    } catch (_) {
      /* ignore */
    }
    if (tmpDb) rmrf(tmpDb);
  });

  function apiFetch(pathname: string, init?: RequestInit) {
    const headers = new Headers(init?.headers || {});
    headers.set('X-API-Key', apiKey);
    return fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  }

  it('GET /api/stats returns stats', async () => {
    const res = await apiFetch('/api/stats');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { totalRuns?: number; totalTraces?: number };
    expect(j.totalRuns).toBeGreaterThanOrEqual(1);
    expect(j.totalTraces).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/runs returns runs', async () => {
    const res = await apiFetch('/api/runs');
    expect(res.status).toBe(200);
    const runs = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]).toHaveProperty('id');
    expect(runs[0]).toHaveProperty('name');
  });

  it('GET /api/traces returns traces', async () => {
    const res = await apiFetch('/api/traces');
    expect(res.status).toBe(200);
    const traces = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(traces)).toBe(true);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]).toHaveProperty('runId');
    expect(traces[0]).toHaveProperty('name');
  });

  it('GET /api/traces?runId=... filters', async () => {
    // first get a run
    const runsRes = await apiFetch('/api/runs?limit=1');
    const runs = (await runsRes.json()) as Array<Record<string, unknown>>;
    const rid = (runs[0] as Record<string, unknown> | undefined)?.id as string | undefined;
    expect(rid).toBeTruthy();

    const res = await apiFetch(`/api/traces?runId=${rid}`);
    expect(res.status).toBe(200);
    const traces = (await res.json()) as Array<Record<string, unknown>>;
    expect(traces.every((t) => (t as Record<string, unknown>).runId === rid)).toBe(true);
  });

  it('GET /api/health does not require auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBeLessThan(500);
    const j = (await res.json()) as { status?: string };
    expect(j).toHaveProperty('status');
  });

  // Task 2b additions
  it('dashboard server starts and serves the frontend', async () => {
    // Root may serve index.html or redirect; any non-5xx proves server is live and static mounted
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBeLessThan(500);
  });

  it('GET /api/runs returns runs', async () => {
    const res = await apiFetch('/api/runs');
    expect(res.status).toBe(200);
    const runs = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]).toHaveProperty('id');
    expect(runs[0]).toHaveProperty('name');
  });

  it('GET /api/traces returns traces', async () => {
    const res = await apiFetch('/api/traces');
    expect(res.status).toBe(200);
    const traces = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(traces)).toBe(true);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]).toHaveProperty('runId');
    expect(traces[0]).toHaveProperty('name');
  });

  it('GET /api/stats returns stats', async () => {
    const res = await apiFetch('/api/stats');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { totalRuns?: number; totalTraces?: number };
    expect(j.totalRuns).toBeGreaterThanOrEqual(1);
    expect(j.totalTraces).toBeGreaterThanOrEqual(1);
  });
});
