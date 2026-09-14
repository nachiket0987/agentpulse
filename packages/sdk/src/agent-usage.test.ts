import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { TraceStorage } from './storage.js';
import type { AgentUsageRecord, UsageStats } from './types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-usage-'));
  return path.join(dir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const dir = path.dirname(dbPath);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

describe('agent_usage tracking system', () => {
  let dbPath: string;
  let storage: TraceStorage;

  beforeEach(() => {
    dbPath = makeTempDb();
    storage = new TraceStorage(dbPath);
  });

  afterEach(() => {
    if (storage) storage.close();
    if (dbPath) cleanupDb(dbPath);
  });

  it('creates agent_usage table on schema init', () => {
    // Access private db for schema verification (standard in storage tests)
    const db = (
      storage as unknown as { db: { prepare: (sql: string) => { get: () => { name?: string } } } }
    ).db;
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_usage'")
      .get();
    expect(row).toBeTruthy();
    expect(row?.name).toBe('agent_usage');
  });

  it('recordAgentUsage inserts correctly and getAgentUsage retrieves', () => {
    const rec: AgentUsageRecord = {
      id: randomUUID(),
      agentName: 'researcher-1',
      agentType: 'researcher',
      sessionId: 'sess-123',
      action: 'research',
      target: 'topic:climate',
      tokensUsed: 1200,
      costUsd: 0.024,
      durationMs: 4500,
      status: 'success',
      metadata: { model: 'gpt-4o' },
      createdAt: Date.now(),
    };

    storage.recordAgentUsage(rec);

    const all = storage.getAgentUsage();
    expect(all.length).toBe(1);
    expect(all[0].agentName).toBe('researcher-1');
    expect(all[0].action).toBe('research');
    expect(all[0].tokensUsed).toBe(1200);
    expect(all[0].costUsd).toBe(0.024);
    expect(all[0].durationMs).toBe(4500);
    expect(all[0].status).toBe('success');
    expect(all[0].metadata).toEqual({ model: 'gpt-4o' });
    expect(all[0].createdAt).toBe(rec.createdAt);
  });

  it('getAgentUsage supports all filter options', () => {
    const now = Date.now();
    const r1: AgentUsageRecord = {
      id: 'u1',
      agentName: 'agent-a',
      agentType: 'orchestrator',
      sessionId: 's1',
      action: 'delegate',
      target: 'task1',
      tokensUsed: 100,
      costUsd: 0.01,
      durationMs: 100,
      status: 'success',
      metadata: {},
      createdAt: now - 10000,
    };
    const r2: AgentUsageRecord = {
      id: 'u2',
      agentName: 'agent-b',
      agentType: 'worker',
      sessionId: 's1',
      action: 'implement',
      target: 'file.ts',
      tokensUsed: 200,
      costUsd: 0.02,
      durationMs: 200,
      status: 'success',
      metadata: {},
      createdAt: now - 5000,
    };
    const r3: AgentUsageRecord = {
      id: 'u3',
      agentName: 'agent-a',
      agentType: 'orchestrator',
      sessionId: 's2',
      action: 'review',
      target: 'pr-42',
      tokensUsed: 50,
      costUsd: 0.005,
      durationMs: 50,
      status: 'failure',
      metadata: { reason: 'timeout' },
      createdAt: now,
    };

    storage.recordAgentUsage(r1);
    storage.recordAgentUsage(r2);
    storage.recordAgentUsage(r3);

    // no filter
    expect(storage.getAgentUsage().length).toBe(3);

    // by agentName
    expect(storage.getAgentUsage({ agentName: 'agent-a' }).length).toBe(2);

    // by agentType
    const orch = storage.getAgentUsage({ agentType: 'orchestrator' });
    expect(orch.length).toBe(2);

    // by action
    expect(storage.getAgentUsage({ action: 'implement' }).length).toBe(1);

    // by status (single)
    expect(storage.getAgentUsage({ status: 'failure' }).length).toBe(1);

    // by status array
    expect(storage.getAgentUsage({ status: ['success', 'failure'] }).length).toBe(3);

    // date range
    const mid = storage.getAgentUsage({ fromDate: now - 6000, toDate: now - 4000 });
    expect(mid.length).toBe(1);
    expect(mid[0].id).toBe('u2');

    // limit / offset (ordered desc by created_at)
    const limited = storage.getAgentUsage({ limit: 1 });
    expect(limited.length).toBe(1);
    expect(limited[0].id).toBe('u3');

    const paged = storage.getAgentUsage({ limit: 1, offset: 1 });
    expect(paged.length).toBe(1);
    expect(paged[0].id).toBe('u2');
  });

  it('getUsageStats returns correct aggregations', () => {
    const now = Date.now();
    storage.recordAgentUsage({
      id: 's1',
      agentName: 'coder',
      agentType: 'coder',
      sessionId: 'ss',
      action: 'implement',
      target: 'a.ts',
      tokensUsed: 300,
      costUsd: 0.03,
      durationMs: 120,
      status: 'success',
      metadata: {},
      createdAt: now,
    });
    storage.recordAgentUsage({
      id: 's2',
      agentName: 'coder',
      agentType: 'coder',
      sessionId: 'ss',
      action: 'review',
      target: 'a.ts',
      tokensUsed: 100,
      costUsd: 0.01,
      durationMs: 60,
      status: 'success',
      metadata: {},
      createdAt: now,
    });
    storage.recordAgentUsage({
      id: 's3',
      agentName: 'researcher',
      agentType: 'researcher',
      sessionId: 'ss',
      action: 'research',
      target: 'x',
      tokensUsed: 500,
      costUsd: 0.05,
      durationMs: 300,
      status: 'success',
      metadata: {},
      createdAt: now,
    });

    const stats: UsageStats = storage.getUsageStats();
    expect(stats.totalAgents).toBe(2);
    expect(stats.totalActions).toBe(3);
    expect(stats.totalTokens).toBe(900);
    expect(stats.totalCostUsd).toBeCloseTo(0.09, 6);
    expect(stats.avgDurationMs).toBeCloseTo(160, 0); // (120+60+300)/3 = 160
    expect(stats.actionsByType['implement']).toBe(1);
    expect(stats.actionsByType['review']).toBe(1);
    expect(stats.actionsByType['research']).toBe(1);
    expect(stats.topAgents.length).toBe(2);
    expect(stats.topAgents[0].agentName).toBe('coder'); // 2 actions vs 1
    expect(stats.topAgents[0].actions).toBe(2);
    expect(stats.topAgents[0].tokens).toBe(400);
    expect(stats.topAgents[0].costUsd).toBeCloseTo(0.04, 6);

    // with agentName filter
    const coderStats = storage.getUsageStats('coder');
    expect(coderStats.totalAgents).toBe(1);
    expect(coderStats.totalActions).toBe(2);
    expect(coderStats.totalTokens).toBe(400);
    expect(coderStats.totalCostUsd).toBeCloseTo(0.04, 6);

    // with date filter (all same time, so from future -> 0)
    const futureStats = storage.getUsageStats(undefined, now + 1000);
    expect(futureStats.totalActions).toBe(0);
  });

  it('getActiveAgents returns correct data', () => {
    const t1 = Date.now() - 100000;
    const t2 = Date.now() - 50000;
    storage.recordAgentUsage({
      id: 'a1',
      agentName: 'orchestrator',
      agentType: 'orchestrator',
      sessionId: 's',
      action: 'delegate',
      target: 't',
      tokensUsed: 10,
      costUsd: 0.001,
      durationMs: 10,
      status: 'success',
      metadata: {},
      createdAt: t1,
    });
    storage.recordAgentUsage({
      id: 'a2',
      agentName: 'orchestrator',
      agentType: 'orchestrator',
      sessionId: 's',
      action: 'review',
      target: 't',
      tokensUsed: 5,
      costUsd: 0.0005,
      durationMs: 5,
      status: 'success',
      metadata: {},
      createdAt: t2,
    });
    storage.recordAgentUsage({
      id: 'a3',
      agentName: 'worker',
      agentType: 'worker',
      sessionId: 's',
      action: 'implement',
      target: 't',
      tokensUsed: 20,
      costUsd: 0.002,
      durationMs: 20,
      status: 'success',
      metadata: {},
      createdAt: t2 + 1000,
    });

    const active = storage.getActiveAgents();
    expect(active.length).toBe(2);
    // ordered by lastActive desc
    expect(active[0].agentName).toBe('worker');
    expect(active[0].totalActions).toBe(1);
    expect(typeof active[0].lastActive).toBe('string');
    expect(active[0].lastActive).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const orch = active.find((a) => a.agentName === 'orchestrator');
    expect(orch?.totalActions).toBe(2);
    expect(orch?.lastActive).toBe(new Date(t2).toISOString());
  });
});
