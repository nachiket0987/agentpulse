/**
 * SelfTracker tests
 * Verifies thin self-tracking wrapper for AI agent usage
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SelfTracker } from './self-track.js';
import { TraceStorage } from './storage.js';
import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function makeTempDb(): string {
  return `./test-self-${randomUUID()}.db`;
}

function makeTempLog(): string {
  const dir = path.join(os.tmpdir(), `agenttrace-self-test-${randomUUID()}`);
  return path.join(dir, 'agenttrace-usage.jsonl');
}

function cleanupDb(db: string): void {
  try {
    if (existsSync(db)) unlinkSync(db);
  } catch (_) {
    /* ignore */
  }
  try {
    if (existsSync(db + '-wal')) unlinkSync(db + '-wal');
  } catch (_) {
    /* ignore */
  }
  try {
    if (existsSync(db + '-shm')) unlinkSync(db + '-shm');
  } catch (_) {
    /* ignore */
  }
}

function cleanupLog(log: string): void {
  try {
    const dir = path.dirname(log);
    if (existsSync(log)) unlinkSync(log);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('SelfTracker', () => {
  let dbPath: string;
  let logPath: string;
  let origEnvDb: string | undefined;
  let origEnvLog: string | undefined;

  beforeEach(() => {
    dbPath = makeTempDb();
    logPath = makeTempLog();
    origEnvDb = process.env.AGENTTRACE_DB_PATH;
    origEnvLog = process.env.AGENTTRACE_USAGE_LOG;
    process.env.AGENTTRACE_DB_PATH = dbPath;
    process.env.AGENTTRACE_USAGE_LOG = logPath;
  });

  afterEach(() => {
    // close any lingering?
    if (origEnvDb === undefined) delete process.env.AGENTTRACE_DB_PATH;
    else process.env.AGENTTRACE_DB_PATH = origEnvDb;
    if (origEnvLog === undefined) delete process.env.AGENTTRACE_USAGE_LOG;
    else process.env.AGENTTRACE_USAGE_LOG = origEnvLog;
    cleanupDb(dbPath);
    cleanupLog(logPath);
  });

  it('exports and constructs with required config', () => {
    const st = new SelfTracker({ agentName: 'test-agent', agentType: 'local-agent' });
    expect(st).toBeInstanceOf(SelfTracker);
    st.close();
  });

  it('startSession returns a uuid and creates a self-tracked run', () => {
    const st = new SelfTracker({ agentName: 'test-agent', agentType: 'local-agent', dbPath });
    const sid = st.startSession();
    expect(typeof sid).toBe('string');
    expect(UUID_RE.test(sid)).toBe(true);

    const storage = new TraceStorage(dbPath);
    const run = storage.getRun(sid);
    expect(run).not.toBeNull();
    expect(run!.name).toBe('test-agent-self-session');
    expect(run!.metadata.selfTracked).toBe(true);
    expect(run!.metadata.agentName).toBe('test-agent');
    expect(run!.status).toBe('running');
    storage.close();
    st.close();
  });

  it('track* methods create traces under current session and log to jsonl', () => {
    const st = new SelfTracker({ agentName: 'test-agent', agentType: 'local-agent', dbPath });
    const sid = st.startSession();

    st.trackAction('code-edit', 'src/foo.ts', { diff: 12 });
    st.trackDelegation('coder', 'implement feature X');
    st.trackResearch('how to use sqlite wal', 7);
    st.trackImplementation(['src/a.ts', 'src/b.ts'], 142);
    st.trackReview('42', 'approved');

    const storage = new TraceStorage(dbPath);
    const traces = storage.getTraces({ runId: sid });
    expect(traces.length).toBe(5);

    const names = traces.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'self:action:code-edit',
        'self:delegation',
        'self:implementation',
        'self:research',
        'self:review',
      ].sort(),
    );

    // metadata tagging
    const actionTrace = traces.find((t) => t.name.includes('code-edit'))!;
    expect(actionTrace.metadata.selfTracked).toBe(true);
    expect(actionTrace.metadata.action).toBe('code-edit');
    expect(actionTrace.metadata.target).toBe('src/foo.ts');

    const delTrace = traces.find((t) => t.name === 'self:delegation')!;
    expect(delTrace.metadata.actionType).toBe('delegation');
    expect(delTrace.metadata.targetAgent).toBe('coder');

    // jsonl written (5 actions + 1 session_start)
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(6);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.some((e) => e.type === 'session_start' && e.sessionId === sid)).toBe(true);
    expect(parsed.some((e) => e.type === 'action' && e.action === 'code-edit')).toBe(true);
    expect(parsed.some((e) => e.type === 'delegation')).toBe(true);
    expect(parsed.some((e) => e.type === 'research' && e.results === 7)).toBe(true);
    expect(parsed.some((e) => e.type === 'implementation' && e.linesOfCode === 142)).toBe(true);
    expect(parsed.some((e) => e.type === 'review' && e.prNumber === '42')).toBe(true);

    storage.close();
    st.close();
  });

  it('getSessionStats reflects actions, duration, tokens/cost (0 for pure self actions)', () => {
    const st = new SelfTracker({ agentName: 'test-agent', agentType: 'local-agent', dbPath });
    const sid = st.startSession();
    st.trackAction('x', 'y');
    st.trackResearch('q', 3);

    const stats = st.getSessionStats();
    expect(stats.sessionId).toBe(sid);
    expect(stats.actions).toBe(2);
    expect(stats.duration).toBeGreaterThanOrEqual(0);
    expect(stats.tokens).toBe(0);
    expect(stats.cost).toBe(0);

    st.endSession();
    const storage = new TraceStorage(dbPath);
    const run = storage.getRun(sid)!;
    expect(run.status).toBe('success');
    storage.close();
    st.close();
  });

  it('auto-starts session on first track if none active', () => {
    const st = new SelfTracker({ agentName: 'test-agent', agentType: 'local-agent', dbPath });
    st.trackAction('auto', 'start');
    const stats = st.getSessionStats();
    expect(stats.sessionId).toMatch(UUID_RE);
    expect(stats.actions).toBe(1);
    st.close();
  });

  it('endSession is safe when no session', () => {
    const st = new SelfTracker({ agentName: 'test-agent', agentType: 'local-agent', dbPath });
    expect(() => st.endSession()).not.toThrow();
    st.close();
  });

  it('getSessionStats returns zeros when no active session', () => {
    const st = new SelfTracker({ agentName: 'test-agent', agentType: 'local-agent', dbPath });
    const stats = st.getSessionStats();
    expect(stats.sessionId).toBe('');
    expect(stats.actions).toBe(0);
    st.close();
  });

  it('multiple sessions are isolated', () => {
    const st = new SelfTracker({ agentName: 'test-agent', agentType: 'local-agent', dbPath });
    const s1 = st.startSession();
    st.trackAction('a1', 't1');
    st.endSession();

    const s2 = st.startSession();
    st.trackAction('a2', 't2');
    st.trackDelegation('d', 'task');

    expect(s2).not.toBe(s1);
    const stats2 = st.getSessionStats();
    expect(stats2.sessionId).toBe(s2);
    expect(stats2.actions).toBe(2);

    const storage = new TraceStorage(dbPath);
    const traces1 = storage.getTraces({ runId: s1 });
    const traces2 = storage.getTraces({ runId: s2 });
    expect(traces1.length).toBe(1);
    expect(traces2.length).toBe(2);
    storage.close();
    st.close();
  });
});
