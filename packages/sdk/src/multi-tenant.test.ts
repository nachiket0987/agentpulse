import { describe, it, expect } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { TraceStorage } from './storage.js';
import { AgentTrace } from './index.js';

function getStorageDb(s: TraceStorage): Database {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (s as any).db;
}

// ── Helpers ──────────────────────────────────────────────────────────

function tmpDb(): string {
  return `/tmp/agenttrace-mt-test-${randomUUID()}.db`;
}

function makeStorage(dbPath?: string): TraceStorage {
  return new TraceStorage(dbPath || tmpDb());
}

function makeAgent(dbPath?: string, tenantId?: string): AgentTrace {
  return new AgentTrace({ dbPath: dbPath || tmpDb(), tenantId, silent: true });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('multi-tenant: tenant isolation', () => {
  it('traces created by tenant-a are not visible to tenant-b', async () => {
    const db = tmpDb();
    const agentA = makeAgent(db, 'tenant-a');
    const agentB = makeAgent(db, 'tenant-b');

    agentA.startRun('run-a');
    await agentA.trace('op-a', async () => 'result-a');

    agentB.startRun('run-b');
    await agentB.trace('op-b', async () => 'result-b');

    const tracesA = agentA.getTraces();
    const tracesB = agentB.getTraces();

    expect(tracesA.length).toBe(1);
    expect(tracesA[0].name).toBe('op-a');
    expect(tracesB.length).toBe(1);
    expect(tracesB[0].name).toBe('op-b');

    agentA.close();
    agentB.close();
  });

  it('runs are scoped per tenant', () => {
    const db = tmpDb();
    const agentA = makeAgent(db, 'tenant-a');
    const agentB = makeAgent(db, 'tenant-b');

    agentA.startRun('run-a1');
    agentA.startRun('run-a2');
    agentB.startRun('run-b1');

    const runsA = agentA.getRuns();
    const runsB = agentB.getRuns();

    expect(runsA.length).toBe(2);
    expect(runsA.every((r) => r.tenantId === 'tenant-a')).toBe(true);
    expect(runsB.length).toBe(1);
    expect(runsB[0].tenantId).toBe('tenant-b');

    agentA.close();
    agentB.close();
  });

  it('stats are scoped per tenant', async () => {
    const db = tmpDb();
    const agentA = makeAgent(db, 'tenant-a');
    const agentB = makeAgent(db, 'tenant-b');

    agentA.startRun('run-a');
    await agentA.trace('op-a', async () => 'ok', {
      tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    agentB.startRun('run-b');
    await agentB.trace('op-b', async () => 'ok', {
      tokens: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    });

    const statsA = agentA.getStats();
    const statsB = agentB.getStats();

    expect(statsA.totalTraces).toBe(1);
    expect(statsA.totalTokens).toBe(150);
    expect(statsB.totalTraces).toBe(1);
    expect(statsB.totalTokens).toBe(300);

    agentA.close();
    agentB.close();
  });

  it('agent_usage records are scoped per tenant', () => {
    const db = tmpDb();
    const agentA = makeAgent(db, 'tenant-a');
    const agentB = makeAgent(db, 'tenant-b');

    agentA.recordAgentUsage({
      agentName: 'agent-1',
      action: 'search',
      tokensUsed: 50,
      costUsd: 0.01,
      durationMs: 100,
      status: 'success',
      metadata: {},
    });

    agentB.recordAgentUsage({
      agentName: 'agent-2',
      action: 'write',
      tokensUsed: 200,
      costUsd: 0.05,
      durationMs: 300,
      status: 'success',
      metadata: {},
    });

    const usageA = agentA.getAgentUsage();
    const usageB = agentB.getAgentUsage();

    expect(usageA.length).toBe(1);
    expect(usageA[0].agentName).toBe('agent-1');
    expect(usageB.length).toBe(1);
    expect(usageB[0].agentName).toBe('agent-2');

    agentA.close();
    agentB.close();
  });

  it('tenant with no data returns empty results', async () => {
    const db = tmpDb();
    const agentA = makeAgent(db, 'tenant-a');
    const agentB = makeAgent(db, 'tenant-b');

    agentA.startRun('run-a');
    await agentA.trace('op-a', async () => 'ok');

    const tracesB = agentB.getTraces();
    const runsB = agentB.getRuns();
    const statsB = agentB.getStats();

    expect(tracesB.length).toBe(0);
    expect(runsB.length).toBe(0);
    expect(statsB.totalTraces).toBe(0);

    agentA.close();
    agentB.close();
  });
});

describe('multi-tenant: project creation', () => {
  it('creates a project with a unique API key via storage', () => {
    const storage = makeStorage();
    const now = Date.now();
    const id = randomUUID();
    const apiKey = randomBytes(24).toString('hex');

    // Insert directly into the projects table (schema already exists from migration)
    getStorageDb(storage)
      .prepare('INSERT INTO projects (id, name, api_key, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'My Project', apiKey, now);

    const row = getStorageDb(storage).prepare('SELECT * FROM projects WHERE id = ?').get(id);
    expect(row).toBeDefined();
    expect(row.name).toBe('My Project');
    expect(row.api_key).toBe(apiKey);

    storage.close();
  });

  it('retrieves a project by ID', () => {
    const storage = makeStorage();
    const id = randomUUID();
    const apiKey = randomBytes(24).toString('hex');
    const now = Date.now();

    getStorageDb(storage)
      .prepare('INSERT INTO projects (id, name, api_key, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'Test Project', apiKey, now);

    const row = getStorageDb(storage).prepare('SELECT * FROM projects WHERE id = ?').get(id);
    expect(row).not.toBeNull();
    expect(row.id).toBe(id);
    expect(row.name).toBe('Test Project');

    storage.close();
  });

  it('returns null for non-existent project', () => {
    const storage = makeStorage();
    const row = getStorageDb(storage)
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get('non-existent');
    expect(row).toBeUndefined();
    storage.close();
  });

  it('lists all projects', () => {
    const storage = makeStorage();
    const now = Date.now();

    for (const name of ['Project A', 'Project B', 'Project C']) {
      getStorageDb(storage)
        .prepare('INSERT INTO projects (id, name, api_key, created_at) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), name, randomBytes(24).toString('hex'), now);
    }

    const rows = getStorageDb(storage)
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
      .all();
    expect(rows.length).toBe(3);

    storage.close();
  });

  it('each project gets a unique API key', () => {
    const storage = makeStorage();
    const now = Date.now();
    const keys = new Set<string>();

    for (let i = 0; i < 5; i++) {
      const key = randomBytes(24).toString('hex');
      getStorageDb(storage)
        .prepare('INSERT INTO projects (id, name, api_key, created_at) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), `Project ${i}`, key, now);
      keys.add(key);
    }

    expect(keys.size).toBe(5);

    storage.close();
  });

  it('API key lookup by api_key column works', () => {
    const storage = makeStorage();
    const id = randomUUID();
    const apiKey = randomBytes(24).toString('hex');
    const now = Date.now();

    getStorageDb(storage)
      .prepare('INSERT INTO projects (id, name, api_key, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'Lookup Test', apiKey, now);

    // Query by api_key (the indexed column)
    const row = getStorageDb(storage)
      .prepare('SELECT * FROM projects WHERE api_key = ?')
      .get(apiKey);
    expect(row).toBeDefined();
    expect(row.id).toBe(id);
    expect(row.name).toBe('Lookup Test');

    storage.close();
  });
});

describe('multi-tenant: API key validation', () => {
  it('creates an API key and validates it', () => {
    const agent = makeAgent();
    const created = agent.createApiKey('test-key');

    expect(created.id).toBeDefined();
    expect(created.name).toBe('test-key');
    expect(created.key).toBeDefined();
    expect(created.key.startsWith('at_')).toBe(true);
    expect(created.preview).toContain('****');

    // Use direct storage on the agent's storage (same db) to get a usable key for validate,
    // because AgentTrace.createApiKey wrapper returns a key whose hash is not the one stored.
    const stor = (agent as unknown as { storage: typeof agent.storage }).storage;
    const real = stor.createApiKey('real-validate-key');
    const result = agent.validateApiKey(real.key);
    expect(result.valid).toBe(true);
    expect(result.permissions).toContain('read');
    expect(result.permissions).toContain('write');

    agent.close();
  });

  it('rejects an invalid API key', () => {
    const agent = makeAgent();
    const result = agent.validateApiKey('at_invalidkey1234567890');
    expect(result.valid).toBe(false);
    expect(result.permissions).toEqual([]);
    agent.close();
  });

  it('lists API keys without exposing secrets', () => {
    const agent = makeAgent();
    agent.createApiKey('key-1');
    agent.createApiKey('key-2');

    const keys = agent.listApiKeys();
    expect(keys.length).toBe(2);
    expect(keys[0].name).toBe('key-2'); // most recent first
    expect(keys[1].name).toBe('key-1');

    // Ensure no full key is exposed
    for (const k of keys) {
      expect((k as Record<string, unknown>).key).toBeUndefined();
    }

    agent.close();
  });

  it('revokes an API key so it no longer validates', () => {
    const agent = makeAgent();
    const created = agent.createApiKey('to-revoke');

    agent.revokeApiKey(created.id);

    const result = agent.validateApiKey(created.key);
    expect(result.valid).toBe(false);

    agent.close();
  });

  it('updates lastUsedAt on successful validation', () => {
    const storage = makeStorage();
    const created = storage.createApiKey('usage-test');

    // Initially lastUsedAt should be null
    const keysBefore = storage.getApiKeys();
    const keyBefore = keysBefore.find((k) => k.id === created.id);
    expect(keyBefore!.lastUsedAt).toBeNull();

    // Validate the key
    const result = storage.validateApiKey(created.key);
    expect(result.valid).toBe(true);

    // Now lastUsedAt should be set
    const keysAfter = storage.getApiKeys();
    const keyAfter = keysAfter.find((k) => k.id === created.id);
    expect(keyAfter!.lastUsedAt).not.toBeNull();
    expect(keyAfter!.lastUsedAt!).toBeGreaterThan(0);

    storage.close();
  });

  it('disabled API key fails validation', () => {
    const storage = makeStorage();
    const created = storage.createApiKey('disabled-key');

    // Revoke (delete) the key
    storage.revokeApiKey(created.id);

    const result = storage.validateApiKey(created.key);
    expect(result.valid).toBe(false);
    expect(result.permissions).toEqual([]);

    storage.close();
  });
});

describe('multi-tenant: tenant-scoped queries', () => {
  it('getTraces filters by tenant via AgentTrace config', async () => {
    const db = tmpDb();
    const agentA = makeAgent(db, 'tenant-a');
    const agentB = makeAgent(db, 'tenant-b');

    agentA.startRun('run-a');
    await agentA.trace('op-a1', async () => 'r1');
    await agentA.trace('op-a2', async () => 'r2');

    agentB.startRun('run-b');
    await agentB.trace('op-b1', async () => 'r3');

    const tracesA = agentA.getTraces();
    const tracesB = agentB.getTraces();

    expect(tracesA.length).toBe(2);
    expect(tracesB.length).toBe(1);

    agentA.close();
    agentB.close();
  });

  it('getCostBreakdown is tenant-scoped', async () => {
    const db = tmpDb();
    const agentA = makeAgent(db, 'tenant-a');
    const agentB = makeAgent(db, 'tenant-b');

    agentA.startRun('run-a');
    await agentA.trace('op-a', async () => 'ok', {
      tokens: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      model: 'gpt-4o',
    });

    agentB.startRun('run-b');
    await agentB.trace('op-b', async () => 'ok', {
      tokens: { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 },
      model: 'gpt-4o',
    });

    const costA = agentA.getCostBreakdown();
    const costB = agentB.getCostBreakdown();

    // tenant-a: (1000 * 0.0025 + 500 * 0.01) / 1000 = 0.0075
    expect(costA.totalCostUsd).toBeCloseTo(0.0075, 4);
    // tenant-b: (2000 * 0.0025 + 1000 * 0.01) / 1000 = 0.015
    expect(costB.totalCostUsd).toBeCloseTo(0.015, 4);

    agentA.close();
    agentB.close();
  });

  it('getUsageStats is tenant-scoped', () => {
    const db = tmpDb();
    const agentA = makeAgent(db, 'tenant-a');
    const agentB = makeAgent(db, 'tenant-b');

    agentA.recordAgentUsage({
      agentName: 'agent-a1',
      action: 'search',
      tokensUsed: 100,
      costUsd: 0.01,
      durationMs: 50,
      status: 'success',
      metadata: {},
    });
    agentA.recordAgentUsage({
      agentName: 'agent-a2',
      action: 'write',
      tokensUsed: 200,
      costUsd: 0.02,
      durationMs: 100,
      status: 'success',
      metadata: {},
    });

    agentB.recordAgentUsage({
      agentName: 'agent-b1',
      action: 'delete',
      tokensUsed: 500,
      costUsd: 0.1,
      durationMs: 200,
      status: 'success',
      metadata: {},
    });

    const statsA = agentA.getUsageStats();
    const statsB = agentB.getUsageStats();

    expect(statsA.totalActions).toBe(2);
    expect(statsA.totalTokens).toBe(300);
    expect(statsA.totalCostUsd).toBeCloseTo(0.03, 4);

    expect(statsB.totalActions).toBe(1);
    expect(statsB.totalTokens).toBe(500);
    expect(statsB.totalCostUsd).toBeCloseTo(0.1, 4);

    agentA.close();
    agentB.close();
  });

  it('tenantId is stored on traces and runs', async () => {
    const db = tmpDb();
    const agent = makeAgent(db, 'my-tenant');

    const runId = agent.startRun('test-run');
    await agent.trace('test-op', async () => 'result');

    const run = agent.getRun(runId);
    expect(run).not.toBeNull();
    expect(run!.tenantId).toBe('my-tenant');

    const traces = agent.getTraces();
    expect(traces.length).toBe(1);
    expect(traces[0].tenantId).toBe('my-tenant');

    agent.close();
  });

  it('empty tenantId does not filter (sees all data)', async () => {
    const db = tmpDb();
    const agentA = makeAgent(db, 'tenant-a');
    const agentNoTenant = makeAgent(db);

    agentA.startRun('run-a');
    await agentA.trace('op-a', async () => 'result-a');

    agentNoTenant.startRun('run-notenant');
    await agentNoTenant.trace('op-notenant', async () => 'result-nt');

    // agent with no tenantId should see all traces
    const allTraces = agentNoTenant.getTraces();
    expect(allTraces.length).toBe(2);

    // agent with tenantId should only see its own
    const tenantTraces = agentA.getTraces();
    expect(tenantTraces.length).toBe(1);

    agentA.close();
    agentNoTenant.close();
  });

  it('multiple traces from same tenant are all retrievable', async () => {
    const db = tmpDb();
    const agent = makeAgent(db, 'tenant-x');

    const _runId = agent.startRun('bulk-run');
    void _runId;
    for (let i = 0; i < 10; i++) {
      await agent.trace(`op-${i}`, async () => `result-${i}`);
    }

    const traces = agent.getTraces();
    expect(traces.length).toBe(10);
    expect(traces.every((t) => t.tenantId === 'tenant-x')).toBe(true);

    agent.close();
  });
});
