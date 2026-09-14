/**
 * Retention Tests -- cleanup, storage stats, policy, auto-cleanup scheduler
 *
 * Uses real SQLite temp files for cleanup/stats/policy tests (no mocks)
 * and a mocked-storage approach for the AgentTrace scheduler unit tests.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { AgentTrace } from './index.js';
import { TraceStorage } from './storage.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-retention-'));
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

/**
 * Insert a parent run idempotently. Traces carry a NOT NULL FK to runs(id)
 * with foreign_keys = ON, so a parent run must exist before inserting traces.
 * INSERT OR IGNORE keeps any run an explicit insertRun() call already created.
 */
function ensureRun(
  storage: TraceStorage,
  id: string,
  startedAt: number,
  status: string = 'success',
): void {
  const db = (
    storage as unknown as {
      db: {
        prepare: (sql: string) => { run: (...args: unknown[]) => void };
      };
    }
  ).db;
  db.prepare(
    'INSERT OR IGNORE INTO runs (id, name, status, metadata, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'run-auto', status, '{}', startedAt, startedAt, startedAt);
}

/** Insert a trace directly via the raw DB for timestamp-control tests */
function insertTrace(
  storage: TraceStorage,
  id: string,
  createdAt: number,
  runId: string = 'run-1',
  name: string = 'trace-1',
  status: string = 'success',
): void {
  // Satisfy the NOT NULL FK to runs(id) (foreign_keys = ON).
  ensureRun(storage, runId, createdAt, status);
  const db = (
    storage as unknown as {
      db: {
        prepare: (sql: string) => { run: (...args: unknown[]) => void };
      };
    }
  ).db;
  db.prepare(
    'INSERT INTO traces (id, run_id, name, status, latency_ms, cost_usd, total_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, runId, name, status, 100, 0.001, 50, createdAt, createdAt);
}

function insertRun(
  storage: TraceStorage,
  id: string,
  startedAt: number,
  name: string = 'run-1',
  status: string = 'success',
): void {
  const db = (
    storage as unknown as {
      db: {
        prepare: (sql: string) => { run: (...args: unknown[]) => void };
      };
    }
  ).db;
  // OR IGNORE: a parent run may already exist if insertTrace()/ensureRun()
  // created it first (e.g. getStorageStats count tests). Avoids a UNIQUE PK
  // violation without OR REPLACE, which would CASCADE-delete child traces.
  db.prepare(
    'INSERT OR IGNORE INTO runs (id, name, status, metadata, created_at, started_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, status, '{}', startedAt, startedAt, startedAt + 1000, startedAt);
}

function insertAgentUsage(
  storage: TraceStorage,
  id: string,
  createdAt: number,
  agentName: string = 'agent-1',
): void {
  const db = (
    storage as unknown as {
      db: {
        prepare: (sql: string) => { run: (...args: unknown[]) => void };
      };
    }
  ).db;
  db.prepare(
    'INSERT INTO agent_usage (id, agent_name, agent_type, session_id, action, target, tokens_used, cost_usd, duration_ms, status, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, agentName, 'worker', 's1', 'act', 'tgt', 100, 0.001, 500, 'success', '{}', createdAt);
}

function insertScore(storage: TraceStorage, traceId: string, value: number = 0.9): void {
  const db = (
    storage as unknown as {
      db: {
        prepare: (sql: string) => { run: (...args: unknown[]) => void };
      };
    }
  ).db;
  db.prepare(
    'INSERT INTO scores (id, trace_id, name, value, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(randomUUID(), traceId, 'test-scorer', value, Date.now());
}

function insertTraceLink(storage: TraceStorage, sourceId: string, targetId: string): void {
  const db = (
    storage as unknown as {
      db: {
        prepare: (sql: string) => { run: (...args: unknown[]) => void };
      };
    }
  ).db;
  db.prepare(
    'INSERT INTO trace_links (id, source_trace_id, target_trace_id, relation, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(randomUUID(), sourceId, targetId, 'child', Date.now());
}

// ============================================================================
// 1. TraceStorage.cleanupOldTraces
// ============================================================================
describe('TraceStorage.cleanupOldTraces', () => {
  let dbPath: string;
  let storage: TraceStorage;

  beforeEach(() => {
    dbPath = makeTempDb();
    storage = new TraceStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    cleanupDb(dbPath);
  });

  it('deletes only traces older than the given timestamp', () => {
    const NOW = 1_700_000_000_000;
    insertTrace(storage, 'old-1', NOW - 86400000, 'r1', 'old-trace'); // 1 day older
    insertTrace(storage, 'old-2', NOW - 3600000, 'r2', 'old-trace-2'); // 1 hour older
    insertTrace(storage, 'new-1', NOW - 1000, 'r3', 'new-trace'); // 1 sec older
    insertTrace(storage, 'new-2', NOW, 'r4', 'new-trace-2');

    const deleted = storage.cleanupOldTraces(NOW - 5000); // cut-off: 5s ago
    // old-1 (1 day old) and old-2 (1 hour old) are both older than 5s ago
    expect(deleted).toBe(2);

    const remaining = storage.getTraces();
    expect(remaining.length).toBe(2);
    const ids = remaining.map((t) => t.id);
    expect(ids).toContain('new-1');
    expect(ids).toContain('new-2');
  });

  it('returns 0 and deletes nothing when all traces are newer', () => {
    const NOW = 1_700_000_000_000;
    insertTrace(storage, 't1', NOW - 1000, 'r1');
    insertTrace(storage, 't2', NOW - 2000, 'r2');

    const deleted = storage.cleanupOldTraces(NOW - 5000);
    expect(deleted).toBe(0);
    expect(storage.getTraces().length).toBe(2);
  });

  it('returns 0 for invalid before value (zero)', () => {
    const NOW = 1_700_000_000_000;
    insertTrace(storage, 't1', NOW - 86400000, 'r1');

    expect(storage.cleanupOldTraces(0)).toBe(0);
    expect(storage.getTraces().length).toBe(1);
  });

  it('returns 0 for invalid before value (negative)', () => {
    const NOW = 1_700_000_000_000;
    insertTrace(storage, 't1', NOW - 86400000, 'r1');

    expect(storage.cleanupOldTraces(-100)).toBe(0);
    expect(storage.getTraces().length).toBe(1);
  });

  it('cleans dependent scores and trace_links when deleting old traces', () => {
    const NOW = 1_700_000_000_000;
    insertTrace(storage, 'old-1', NOW - 86400000, 'r1');
    insertTrace(storage, 'old-2', NOW - 86400000, 'r2');
    insertTrace(storage, 'new-1', NOW, 'r3');

    insertScore(storage, 'old-1', 0.8);
    insertScore(storage, 'old-2', 0.7);
    insertScore(storage, 'new-1', 0.95);
    insertTraceLink(storage, 'old-1', 'old-2');

    const deleted = storage.cleanupOldTraces(NOW - 5000);
    expect(deleted).toBe(2);

    // Only new-1 and its score should remain
    expect(storage.getTraces().length).toBe(1);
    expect(storage.getTraces()[0].id).toBe('new-1');

    // Verify scores for old traces are gone
    const db = (
      storage as unknown as {
        db: { prepare: (sql: string) => { get: () => { c: number } } };
      }
    ).db;
    const scoreCount = db.prepare('SELECT COUNT(*) as c FROM scores').get();
    expect(scoreCount!.c).toBe(1);

    // Verify trace_links for old traces are gone
    const linkCount = db.prepare('SELECT COUNT(*) as c FROM trace_links').get();
    expect(linkCount!.c).toBe(0);
  });
});

// ============================================================================
// 2. TraceStorage.cleanupOldRuns
// ============================================================================
describe('TraceStorage.cleanupOldRuns', () => {
  let dbPath: string;
  let storage: TraceStorage;

  beforeEach(() => {
    dbPath = makeTempDb();
    storage = new TraceStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    cleanupDb(dbPath);
  });

  it('deletes only runs older than the given timestamp', () => {
    const NOW = 1_700_000_000_000;
    insertRun(storage, 'run-old', NOW - 86400000);
    insertRun(storage, 'run-new', NOW - 1000);

    const deleted = storage.cleanupOldRuns(NOW - 5000);
    expect(deleted).toBe(1);

    const runs = storage.getRuns();
    expect(runs.length).toBe(1);
    expect(runs[0].id).toBe('run-new');
  });

  it('returns 0 for invalid before value', () => {
    const NOW = 1_700_000_000_000;
    insertRun(storage, 'run-1', NOW - 86400000);

    expect(storage.cleanupOldRuns(0)).toBe(0);
    expect(storage.cleanupOldRuns(-1)).toBe(0);
    expect(storage.getRuns().length).toBe(1);
  });

  it('cascades to delete traces belonging to deleted runs', () => {
    const NOW = 1_700_000_000_000;
    insertRun(storage, 'run-old', NOW - 86400000);
    insertRun(storage, 'run-new', NOW - 1000);
    insertTrace(storage, 't-old', NOW - 86400000, 'run-old');
    insertTrace(storage, 't-new', NOW - 1000, 'run-new');

    storage.cleanupOldRuns(NOW - 5000);

    expect(storage.getRuns().length).toBe(1);
    expect(storage.getTraces().length).toBe(1);
    expect(storage.getTraces()[0].id).toBe('t-new');
  });
});

// ============================================================================
// 3. TraceStorage.cleanupOldAgentUsage
// ============================================================================
describe('TraceStorage.cleanupOldAgentUsage', () => {
  let dbPath: string;
  let storage: TraceStorage;

  beforeEach(() => {
    dbPath = makeTempDb();
    storage = new TraceStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    cleanupDb(dbPath);
  });

  it('deletes only agent_usage records older than the given timestamp', () => {
    const NOW = 1_700_000_000_000;
    insertAgentUsage(storage, 'usage-old', NOW - 86400000, 'agent-a');
    insertAgentUsage(storage, 'usage-new', NOW - 1000, 'agent-b');

    const deleted = storage.cleanupOldAgentUsage(NOW - 5000);
    expect(deleted).toBe(1);

    const remaining = storage.getAgentUsage();
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe('usage-new');
  });

  it('returns 0 for invalid before value', () => {
    const NOW = 1_700_000_000_000;
    insertAgentUsage(storage, 'u1', NOW - 86400000);

    expect(storage.cleanupOldAgentUsage(0)).toBe(0);
    expect(storage.cleanupOldAgentUsage(-100)).toBe(0);
    expect(storage.getAgentUsage().length).toBe(1);
  });

  it('deletes all agent_usage when all are old', () => {
    const NOW = 1_700_000_000_000;
    insertAgentUsage(storage, 'u1', NOW - 86400000);
    insertAgentUsage(storage, 'u2', NOW - 172800000);

    const deleted = storage.cleanupOldAgentUsage(NOW);
    expect(deleted).toBe(2);
    expect(storage.getAgentUsage().length).toBe(0);
  });
});

// ============================================================================
// 4. TraceStorage.getStorageStats
// ============================================================================
describe('TraceStorage.getStorageStats', () => {
  let dbPath: string;
  let storage: TraceStorage;

  beforeEach(() => {
    dbPath = makeTempDb();
    storage = new TraceStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    cleanupDb(dbPath);
  });

  it('returns zero counts and null timestamps for an empty DB', () => {
    const stats = storage.getStorageStats();
    expect(stats.traceCount).toBe(0);
    expect(stats.runCount).toBe(0);
    expect(stats.oldestTrace).toBeNull();
    expect(stats.newestTrace).toBeNull();
  });

  it('reports correct trace and run counts', () => {
    const NOW = 1_700_000_000_000;
    insertTrace(storage, 't1', NOW - 5000, 'r1');
    insertTrace(storage, 't2', NOW, 'r1');
    insertTrace(storage, 't3', NOW - 2500, 'r2');
    insertRun(storage, 'r1', NOW - 5000);
    insertRun(storage, 'r2', NOW - 2500);

    const stats = storage.getStorageStats();
    expect(stats.traceCount).toBe(3);
    expect(stats.runCount).toBe(2);
  });

  it('reports oldest and newest trace timestamps', () => {
    const NOW = 1_700_000_000_000;
    insertTrace(storage, 't1', NOW - 10000, 'r1');
    insertTrace(storage, 't2', NOW, 'r2');
    insertTrace(storage, 't3', NOW - 5000, 'r3');

    const stats = storage.getStorageStats();
    expect(stats.oldestTrace).toBe(NOW - 10000);
    expect(stats.newestTrace).toBe(NOW);
  });

  it('reports a positive totalSizeBytes for a file-backed DB', () => {
    // Insert some data so the DB file is not empty
    insertTrace(storage, 't1', Date.now(), 'r1');

    const stats = storage.getStorageStats();
    expect(stats.totalSizeBytes).toBeGreaterThan(0);
  });
});

// ============================================================================
// 5. Retention policy (get/set)
// ============================================================================
describe('TraceStorage retention policy', () => {
  let dbPath: string;
  let storage: TraceStorage;

  beforeEach(() => {
    dbPath = makeTempDb();
    storage = new TraceStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    cleanupDb(dbPath);
  });

  it('returns default policy when none is set', () => {
    const policy = storage.getRetentionPolicy();
    expect(policy.retentionDays).toBe(30);
    expect(policy.cleanupIntervalHours).toBe(24);
  });

  it('persists and retrieves a custom policy', () => {
    storage.setRetentionPolicy(7, 6);
    const policy = storage.getRetentionPolicy();
    expect(policy.retentionDays).toBe(7);
    expect(policy.cleanupIntervalHours).toBe(6);
  });

  it('setRetentionPolicy without interval retains existing interval', () => {
    storage.setRetentionPolicy(14);
    const policy = storage.getRetentionPolicy();
    expect(policy.retentionDays).toBe(14);
    expect(policy.cleanupIntervalHours).toBe(24);
  });

  it('persists policy to settings table', () => {
    storage.setRetentionPolicy(90, 12);
    const db = (
      storage as unknown as {
        db: { prepare: (sql: string) => { get: (key: string) => { value?: string } | undefined } };
      }
    ).db;
    const row1 = db.prepare('SELECT value FROM settings WHERE key = ?').get('retentionDays');
    expect(row1?.value).toBe('90');
    const row2 = db.prepare('SELECT value FROM settings WHERE key = ?').get('cleanupIntervalHours');
    expect(row2?.value).toBe('12');
  });
});

// ============================================================================
// 6. AgentTrace delegation methods
// ============================================================================
describe('AgentTrace retention delegation', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTempDb();
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it('getRetentionPolicy returns config values', () => {
    const agent = new AgentTrace({
      dbPath,
      retentionDays: 14,
      cleanupIntervalHours: 6,
    });
    const policy = agent.getRetentionPolicy();
    expect(policy.retentionDays).toBe(14);
    expect(policy.cleanupIntervalHours).toBe(6);
    agent.close();
    // Note: ctor-provided values affect only this instance's config.
    // Persistence for other instances requires explicit setRetentionPolicy().
  });

  it('setRetentionPolicy persists and updates live config', () => {
    const agent = new AgentTrace({ dbPath, retentionDays: 30, cleanupIntervalHours: 24 });
    agent.setRetentionPolicy(7, 12);
    expect(agent.getRetentionPolicy().retentionDays).toBe(7);
    expect(agent.getRetentionPolicy().cleanupIntervalHours).toBe(12);
    agent.close();
  });

  it('setRetentionPolicy with retentionDays=0 disables scheduling', () => {
    const agent = new AgentTrace({ dbPath, retentionDays: 30 });
    agent.setRetentionPolicy(0);
    expect(agent.getRetentionPolicy().retentionDays).toBe(0);
    // The private _cleanupInterval should be cleared when retentionDays=0
    expect((agent as unknown as { _cleanupInterval?: unknown })._cleanupInterval).toBeUndefined();
    agent.close();
  });

  it('new AgentTrace picks up persisted policy from storage', () => {
    // First agent sets policy
    const agent1 = new AgentTrace({ dbPath });
    agent1.setRetentionPolicy(10, 5);
    agent1.close();

    // Second agent should load the persisted policy automatically
    const agent2 = new AgentTrace({ dbPath });
    const policy = agent2.getRetentionPolicy();
    expect(policy.retentionDays).toBe(10);
    expect(policy.cleanupIntervalHours).toBe(5);
    agent2.close();
  });
});

// ============================================================================
// 7. Auto-cleanup scheduler (setupRetentionCleanup)
// ============================================================================
describe('AgentTrace auto-cleanup scheduler', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTempDb();
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it('starts a cleanup interval when retentionDays > 0', () => {
    const agent = new AgentTrace({ dbPath, retentionDays: 30, cleanupIntervalHours: 1 });
    const interval = (agent as unknown as { _cleanupInterval?: unknown })._cleanupInterval;
    expect(interval).toBeDefined();
    expect(interval).not.toBeNull();
    agent.close();
  });

  it('does not start a cleanup interval when retentionDays = 0', () => {
    const agent = new AgentTrace({ dbPath, retentionDays: 0 });
    const interval = (agent as unknown as { _cleanupInterval?: unknown })._cleanupInterval;
    expect(interval).toBeUndefined();
    agent.close();
  });

  it('clears the interval on close()', () => {
    const agent = new AgentTrace({ dbPath, retentionDays: 30 });
    expect((agent as unknown as { _cleanupInterval?: unknown })._cleanupInterval).toBeDefined();
    agent.close();
    expect((agent as unknown as { _cleanupInterval?: unknown })._cleanupInterval).toBeUndefined();
  });

  it('reschedules the interval when setRetentionPolicy changes timing', () => {
    const agent = new AgentTrace({ dbPath, retentionDays: 30, cleanupIntervalHours: 24 });
    const oldInterval = (agent as unknown as { _cleanupInterval?: unknown })._cleanupInterval;
    expect(oldInterval).toBeDefined();

    agent.setRetentionPolicy(14, 6);
    const newInterval = (agent as unknown as { _cleanupInterval?: unknown })._cleanupInterval;
    expect(newInterval).toBeDefined();
    // The interval handle should have changed (old one cleared, new one created)
    expect(newInterval).not.toBe(oldInterval);
    agent.close();
  });

  it('reschedules the interval when setRetentionPolicy disables cleanup', () => {
    const agent = new AgentTrace({ dbPath, retentionDays: 30 });
    expect((agent as unknown as { _cleanupInterval?: unknown })._cleanupInterval).toBeDefined();

    agent.setRetentionPolicy(0);
    expect((agent as unknown as { _cleanupInterval?: unknown })._cleanupInterval).toBeUndefined();
    agent.close();
  });

  it('scheduled cleanup runs all three cleanup functions', () => {
    // Use a very short interval (0.01h = 36s, but we use fake timers approach)
    // Actually, the interval is in hours. Use 1 hour default.
    // We'll use vi.useFakeTimers to control scheduling.
    vi.useFakeTimers({ shouldAdvanceTime: false });

    let agent: AgentTrace | null = null;
    try {
      agent = new AgentTrace({ dbPath, retentionDays: 1, cleanupIntervalHours: 1 });
      const spyTraces = vi.spyOn(
        agent as unknown as { storage: { cleanupOldTraces: (b: number) => number } },
        'cleanupOldTraces' as never,
      );
      // Actually the storage is private. Let's spy on the storage's cleanup methods directly.
      // Clean up the bad spy.
      spyTraces.mockRestore(); // restore right away

      // Instead, spy on the storage methods
      const mockCleanupTraces = vi.fn().mockReturnValue(0);
      const mockCleanupRuns = vi.fn().mockReturnValue(0);
      const mockCleanupUsage = vi.fn().mockReturnValue(0);

      const internalStorage = (
        agent as unknown as {
          storage: {
            cleanupOldTraces: (b: number) => number;
            cleanupOldRuns: (b: number) => number;
            cleanupOldAgentUsage: (b: number) => number;
          };
        }
      ).storage;

      internalStorage.cleanupOldTraces = mockCleanupTraces;
      internalStorage.cleanupOldRuns = mockCleanupRuns;
      internalStorage.cleanupOldAgentUsage = mockCleanupUsage;

      // Advance time by 1 hour (the cleanup interval)
      vi.advanceTimersByTime(3600001);

      // The scheduler fires once intervalMs after construction.
      // Since we replaced methods AFTER construction, the first tick still fires the originals.
      // But after 2+ hours, subsequent ticks use our mocks.
      // Advance another interval so the mock is called.
      vi.advanceTimersByTime(3600001);

      // Restore originals
      agent.close();

      // Verify mocks were called at least once
      // Note: The first tick used originals, second+ tick uses mocks.
      // Actually, the setInterval callback captures `this.storage`, not the method directly.
      // Since we replaced the method on the object object, subsequent calls should use our mock.
      expect(mockCleanupTraces.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(mockCleanupRuns.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(mockCleanupUsage.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
      agent?.close();
    }
  });

  it('scheduler catches errors so host process does not crash', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    let agent: AgentTrace | null = null;
    try {
      agent = new AgentTrace({ dbPath, retentionDays: 1, cleanupIntervalHours: 1 });

      const internalStorage = (
        agent as unknown as {
          storage: { cleanupOldTraces: (b: number) => number };
        }
      ).storage;

      internalStorage.cleanupOldTraces = () => {
        throw new Error('boom');
      };

      // This should not throw despite cleanupOldTraces throwing
      expect(() => {
        vi.advanceTimersByTime(3600001);
        vi.advanceTimersByTime(3600001);
      }).not.toThrow();

      agent.close();
    } finally {
      vi.useRealTimers();
      agent?.close();
    }
  });
});
