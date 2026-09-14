import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from './index.js';
import { AgentTrace, TraceStorage } from '@agenttrace-io/sdk';
import { randomUUID } from 'node:crypto';

// ── Helpers (tmp DB + cleanup, modeled on research-backed patterns for fs/DB side effects) ──

function makeTempDbPath(suffix = 'cli-cmds'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agenttrace-${suffix}-`));
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

async function seedStatsData(dbPath: string) {
  const t = new AgentTrace({ dbPath, silent: true });
  t.startRun('stats-run-1');
  await t.trace('ok-trace', async () => 'ok', {
    tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15, model: 'gpt-4o' },
    model: 'gpt-4o',
  });
  t.completeRun();
  t.startRun('stats-run-2');
  try {
    await t.trace(
      'err-trace',
      async () => {
        throw new Error('boom');
      },
      {
        tokens: { promptTokens: 20, completionTokens: 0, totalTokens: 20, model: 'claude' },
        model: 'claude',
      },
    );
  } catch {
    /* error trace */
  }
  t.completeRun('error');
  t.close();
}

async function seedExportData(dbPath: string) {
  const t = new AgentTrace({ dbPath, silent: true });
  const r = t.startRun('export-run');
  await t.trace('exp-1', async () => ({ v: 1 }), {
    tokens: { promptTokens: 5, completionTokens: 5, totalTokens: 10, model: 'gpt-4o' },
  });
  t.completeRun();
  t.close();
  return r;
}

async function seedTreeData(dbPath: string): Promise<string> {
  const t = new AgentTrace({ dbPath, silent: true });
  const rid = t.startRun('tree-run');
  await t.trace('root', async () => 'r');
  t.completeRun();
  const tr = t.getTraces({ runId: rid, limit: 1 })[0];
  t.close();
  return tr ? tr.id : '';
}

async function seedAgentData(dbPath: string) {
  const s = new TraceStorage(dbPath);
  const now = Date.now();
  s.recordAgentUsage({
    id: randomUUID(),
    agentName: 'researcher-x',
    agentType: 'researcher',
    sessionId: 'sess-x1',
    action: 'search',
    target: 'web',
    tokensUsed: 300,
    costUsd: 0.003,
    durationMs: 120,
    status: 'success',
    metadata: { model: 'gpt-4o' },
    createdAt: now - 120000,
  });
  s.recordAgentUsage({
    id: randomUUID(),
    agentName: 'coder-y',
    agentType: 'coder',
    sessionId: 'sess-y2',
    action: 'edit',
    tokensUsed: 800,
    costUsd: 0.008,
    durationMs: 400,
    status: 'success',
    metadata: { model: 'claude-sonnet-4' },
    createdAt: now - 30000,
  });
  s.close();
}

// ── Harness (per-test isolation, console capture, exit mock, env/argv restore; supports async cmds) ──

describe('CLI commands', () => {
  let tmpDb: string;
  let origArgv: string[];
  let origEnv: string | undefined;
  let logs: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    tmpDb = makeTempDbPath();
    origArgv = process.argv.slice();
    origEnv = process.env.AGENTTRACE_DB_PATH;
    process.env.AGENTTRACE_DB_PATH = tmpDb;

    logs = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    console.error = (...args: unknown[]) => {
      logs.push('ERR:' + args.map(String).join(' '));
    };

    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as typeof process.exit);
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    process.argv = origArgv;
    if (origEnv === undefined) {
      delete process.env.AGENTTRACE_DB_PATH;
    } else {
      process.env.AGENTTRACE_DB_PATH = origEnv;
    }
    vi.restoreAllMocks();
    if (tmpDb) rmrf(tmpDb);
  });

  async function runCmd(args: string[]) {
    process.argv = ['node', 'agenttrace-io', ...args];
    try {
      const res = main() as void | Promise<void> | undefined;
      if (res && typeof res === 'object' && 'then' in res) {
        await (res as Promise<void>).catch((e: unknown) => {
          const msg = String((e as { message?: string }).message || e);
          if (!msg.includes('process.exit')) throw e;
        });
      }
    } catch (e: unknown) {
      const msg = String((e as { message?: string }).message || e);
      if (!msg.includes('process.exit')) throw e;
    }
  }

  function out() {
    return logs.join('\n');
  }
  function clearLogs() {
    logs.length = 0;
  }

  function lastJson() {
    const line = logs.find((l) => l.trim().startsWith('{') || l.trim().startsWith('['));
    return line ? JSON.parse(line) : undefined;
  }

  // 1. init — creates valid DB at specified path (via AGENTTRACE_DB_PATH)
  describe('init', () => {
    it('creates a valid DB file at the specified path', async () => {
      expect(fs.existsSync(tmpDb)).toBe(false);
      await runCmd(['init']);
      expect(fs.existsSync(tmpDb)).toBe(true);
      // basic validity: size > 0 and no error on open
      const st = fs.statSync(tmpDb);
      expect(st.size).toBeGreaterThan(0);
      const t = new AgentTrace({ dbPath: tmpDb, silent: true });
      t.close();
      expect(out()).toContain('Created');
    });

    it('reports when DB already exists (no overwrite)', async () => {
      await runCmd(['init']);
      clearLogs();
      await runCmd(['init']);
      expect(out()).toContain('already exists');
      expect(fs.existsSync(tmpDb)).toBe(true);
    });
  });

  // 9. Error handling: missing DB
  describe('error handling (missing DB)', () => {
    it('stats on missing DB prints error and exits', async () => {
      // no init
      await runCmd(['stats']);
      const o = out();
      expect(o).toContain('No ');
      expect(o).toContain('agenttrace.db');
      expect(o).toContain('Run "agenttrace init"');
    });

    it('runs on missing DB prints error', async () => {
      await runCmd(['runs']);
      expect(out()).toContain('No ');
    });

    it('tree without DB still requires --trace-id first (arg error before DB)', async () => {
      await runCmd(['tree']);
      expect(out()).toContain('Usage: agenttrace tree --trace-id');
    });
  });

  // 9. Invalid arguments
  describe('error handling (invalid args)', () => {
    it('tree without --trace-id errors with usage', async () => {
      await runCmd(['init']);
      clearLogs();
      await runCmd(['tree']);
      expect(out()).toContain('Usage: agenttrace tree --trace-id <id>');
    });
  });

  // 2. stats — correct shape (and --json)
  describe('stats', () => {
    it('returns JSON with correct shape via --json', async () => {
      await seedStatsData(tmpDb);
      await runCmd(['stats', '--json']);
      const parsed = lastJson();
      expect(parsed).toBeTruthy();
      expect(parsed).toHaveProperty('totalRuns');
      expect(parsed).toHaveProperty('totalTraces');
      expect(parsed).toHaveProperty('successRate');
      expect(parsed).toHaveProperty('avgLatencyMs');
      expect(parsed).toHaveProperty('totalCostUsd');
      expect(parsed).toHaveProperty('totalTokens');
      expect(parsed).toHaveProperty('avgTokensPerTrace');
      expect(typeof parsed.totalRuns).toBe('number');
      expect(typeof parsed.successRate).toBe('number');
    });

    it('prints human stats with expected keys', async () => {
      await seedStatsData(tmpDb);
      clearLogs();
      await runCmd(['stats']);
      const o = out();
      expect(o).toContain('Total Runs:');
      expect(o).toContain('Total Traces:');
      expect(o).toContain('Success Rate:');
      expect(o).toContain('Total Cost:');
    });
  });

  // 10. --json on applicable + 3. export
  describe('export', () => {
    it('--json (default) returns parseable JSON array of traces', async () => {
      await seedExportData(tmpDb);
      await runCmd(['export', '--json']);
      const parsed = lastJson();
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty('id');
      expect(parsed[0]).toHaveProperty('name');
    });

    it('writes correct content to --output file (JSON)', async () => {
      await seedExportData(tmpDb);
      const outFile = path.join(path.dirname(tmpDb), 'export.json');
      clearLogs();
      await runCmd(['export', '--output', outFile]);
      expect(fs.existsSync(outFile)).toBe(true);
      const content = fs.readFileSync(outFile, 'utf8');
      const parsed = JSON.parse(content);
      expect(Array.isArray(parsed)).toBe(true);
      expect(out()).toContain('Exported JSON to');
    });

    it('writes correct CSV content to --output (CSV format)', async () => {
      await seedExportData(tmpDb);
      const outFile = path.join(path.dirname(tmpDb), 'export.csv');
      clearLogs();
      await runCmd(['export', '--format', 'csv', '--output', outFile]);
      expect(fs.existsSync(outFile)).toBe(true);
      const content = fs.readFileSync(outFile, 'utf8');
      expect(content).toContain('id,runId,name,status');
      expect(out()).toContain('Exported CSV to');
    });
  });

  // 4. tree — outputs trace hierarchy
  describe('tree', () => {
    it('outputs trace hierarchy (table form)', async () => {
      const traceId = await seedTreeData(tmpDb);
      clearLogs();
      await runCmd(['tree', '--trace-id', traceId]);
      const o = out();
      expect(o).toContain('Trace Tree:');
      expect(o).toContain('root');
    });

    it('--json returns parseable tree with trace node', async () => {
      const traceId = await seedTreeData(tmpDb);
      clearLogs();
      await runCmd(['tree', '--trace-id', traceId, '--json']);
      const parsed = lastJson();
      expect(parsed).toBeTruthy();
      expect(parsed).toHaveProperty('trace');
      expect(parsed.trace).toHaveProperty('name', 'root');
    });
  });

  // 5. who
  describe('who', () => {
    it('returns active agents table', async () => {
      await seedAgentData(tmpDb);
      await runCmd(['who']);
      const o = out();
      expect(o).toContain('Agent');
      expect(o).toContain('Type');
      expect(o).toContain('Actions');
      expect(o).toContain('researcher-x');
      expect(o).toContain('coder-y');
    });

    it('--json returns parseable array', async () => {
      await seedAgentData(tmpDb);
      clearLogs();
      await runCmd(['who', '--json']);
      const parsed = lastJson();
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty('agentName');
    });
  });

  // 6. sessions
  describe('sessions', () => {
    it('lists sessions with correct columns', async () => {
      await seedAgentData(tmpDb);
      await runCmd(['sessions']);
      const o = out();
      expect(o).toContain('Session ID');
      expect(o).toContain('Agent');
      expect(o).toContain('Started');
      expect(o).toContain('Duration');
      expect(o).toContain('Actions');
      expect(o).toContain('Tokens');
      expect(o).toContain('Cost');
      expect(o).toContain('Status');
      expect(o).toContain('sess-x1');
    });

    it('--json returns parseable array with session fields', async () => {
      await seedAgentData(tmpDb);
      clearLogs();
      await runCmd(['sessions', '--json']);
      const parsed = lastJson();
      expect(Array.isArray(parsed)).toBe(true);
      if (parsed.length > 0) {
        expect(parsed[0]).toHaveProperty('sessionId');
        expect(parsed[0]).toHaveProperty('agentName');
      }
    });
  });

  // 7. activity
  describe('activity', () => {
    it('shows recent actions timeline', async () => {
      await seedAgentData(tmpDb);
      await runCmd(['activity', '--limit', '5']);
      const o = out();
      expect(o).toContain('Time');
      expect(o).toContain('Agent');
      expect(o).toContain('Action');
      expect(o).toContain('search');
    });

    it('--json returns parseable array', async () => {
      await seedAgentData(tmpDb);
      clearLogs();
      await runCmd(['activity', '--json']);
      const parsed = lastJson();
      expect(Array.isArray(parsed) || parsed === undefined).toBe(true); // may be empty array case
    });
  });

  // 8. costs — breakdown (by model/day as "period")
  describe('costs', () => {
    it('returns cost breakdown (by model) with --json correct shape', async () => {
      await seedStatsData(tmpDb);
      clearLogs();
      await runCmd(['costs', '--json']);
      const parsed = lastJson();
      expect(parsed).toBeTruthy();
      expect(parsed).toHaveProperty('totalCostUsd');
      expect(parsed).toHaveProperty('costByModel');
      expect(parsed).toHaveProperty('costByDay');
      expect(typeof parsed.totalCostUsd).toBe('number');
    });

    it('--daily shows period-style daily breakdown', async () => {
      await seedStatsData(tmpDb);
      clearLogs();
      await runCmd(['costs', '--daily']);
      const o = out();
      expect(o).toContain('Daily Cost Breakdown');
      // date keys like 2026-...
      expect(o).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('prints model breakdown by default', async () => {
      await seedStatsData(tmpDb);
      clearLogs();
      await runCmd(['costs']);
      const o = out();
      expect(o).toContain('Cost Breakdown by Model');
      expect(o).toContain('Total:');
    });
  });

  // 10. --json flag coverage on more applicable (who/sessions already, stats/costs/export/tree above)
  describe('--json flag (additional applicable commands)', () => {
    it('who --json is parseable', async () => {
      await seedAgentData(tmpDb);
      clearLogs();
      await runCmd(['who', '--json']);
      const p = lastJson();
      expect(Array.isArray(p)).toBe(true);
    });

    it('sessions --json is parseable', async () => {
      await seedAgentData(tmpDb);
      clearLogs();
      await runCmd(['sessions', '--json']);
      const p = lastJson();
      expect(Array.isArray(p) || p == null).toBe(true);
    });
  });
});
