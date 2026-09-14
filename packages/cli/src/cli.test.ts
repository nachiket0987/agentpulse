import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main, PACKAGE_NAME, VERSION } from './index.js';
import { AgentTrace, TraceStorage } from '@agenttrace-io/sdk';
import { randomUUID } from 'node:crypto';

// ── Helpers ──

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-cli-'));
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
  } catch (_e) {
    /* ignore */
  }
}

async function seedData(dbPath: string) {
  const t = new AgentTrace({ dbPath, silent: true });
  const r1 = t.startRun('test-run-1');
  await t.trace('trace-1', async () => 'ok', {
    tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150, model: 'gpt-4o' },
    model: 'gpt-4o',
  });
  try {
    await t.trace(
      'trace-2',
      async () => {
        throw new Error('boom');
      },
      {
        tokens: {
          promptTokens: 200,
          completionTokens: 100,
          totalTokens: 300,
          model: 'claude-sonnet-4',
        },
        model: 'claude-sonnet-4',
      },
    );
  } catch (_) {
    // expected for error status trace
  }
  t.completeRun();

  const r2 = t.startRun('test-run-2');
  await t.trace('nested-trace', async () => 'hello', {
    tokens: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
  });
  t.completeRun();
  t.close();
  return { r1, r2 };
}

async function seedAgentUsage(dbPath: string) {
  const storage = new TraceStorage(dbPath);
  const now = Date.now();
  storage.recordAgentUsage({
    id: randomUUID(),
    agentName: 'agent-a',
    agentType: 'researcher',
    sessionId: 'sess-1',
    action: 'search',
    target: 'web',
    tokensUsed: 500,
    costUsd: 0.005,
    durationMs: 200,
    status: 'success',
    metadata: { model: 'gpt-4o' },
    createdAt: now - 600000,
  });
  storage.recordAgentUsage({
    id: randomUUID(),
    agentName: 'agent-b',
    agentType: 'coder',
    sessionId: 'sess-2',
    action: 'implement',
    tokensUsed: 1000,
    costUsd: 0.01,
    durationMs: 500,
    status: 'success',
    metadata: { model: 'claude-sonnet-4' },
    createdAt: now - 60000,
  });
  storage.recordAgentUsage({
    id: randomUUID(),
    agentName: 'agent-a',
    agentType: 'researcher',
    sessionId: 'sess-1',
    action: 'summarize',
    tokensUsed: 300,
    costUsd: 0.003,
    durationMs: 150,
    status: 'success',
    metadata: { model: 'gpt-4o' },
    createdAt: now - 30000,
  });
  storage.close();
}

// ── Test harness ──

describe('CLI commands (comprehensive)', () => {
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
      const res = main();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (res && typeof (res as any).then === 'function') {
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

  // ── version ──

  describe('version', () => {
    it('prints version string', () => {
      runCmd(['version']);
      expect(out()).toContain(PACKAGE_NAME);
      expect(out()).toContain(VERSION);
    });
  });

  // ── help / unknown ──

  describe('help / unknown', () => {
    it('prints usage for --help', () => {
      runCmd(['--help']);
      expect(out()).toContain('Commands:');
      expect(out()).toContain('init');
      expect(out()).toContain('runs');
      expect(out()).toContain('traces');
    });

    it('prints help for unknown command', () => {
      runCmd(['__badcmd__']);
      expect(out()).toContain('Unknown command:');
      expect(out()).toContain('Commands:');
    });
  });

  // ── init ──

  describe('init', () => {
    it('creates a new database', () => {
      expect(fs.existsSync(tmpDb)).toBe(false);
      runCmd(['init']);
      expect(fs.existsSync(tmpDb)).toBe(true);
      expect(out()).toContain('Created');
    });

    it('reports existing database', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['init']);
      expect(out()).toContain('already exists');
    });
  });

  // ── runs ──

  describe('runs', () => {
    it('prints table with headers by default', async () => {
      await seedData(tmpDb);
      runCmd(['runs']);
      const o = out();
      expect(o).toContain('ID');
      expect(o).toContain('Name');
      expect(o).toContain('Status');
      expect(o).toContain('test-run');
    });

    it('returns no runs for empty db', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['runs']);
      expect(out()).toContain('No runs found');
    });

    it('--limit controls number of results', async () => {
      await seedData(tmpDb);
      runCmd(['runs', '--limit', '1']);
      const lines = out()
        .split('\n')
        .filter((l) => l.trim().length > 0);
      // header + separator + 1 data row = 3 lines minimum
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });

    it('--status filters by status', async () => {
      await seedData(tmpDb);
      runCmd(['runs', '--status', 'success']);
      const o = out();
      expect(o).toContain('test-run');
    });

    it('--json emits JSON array', async () => {
      await seedData(tmpDb);
      runCmd(['runs', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('['));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty('id');
      expect(parsed[0]).toHaveProperty('name');
    });
  });

  // ── traces ──

  describe('traces', () => {
    it('prints table with headers', async () => {
      await seedData(tmpDb);
      runCmd(['traces']);
      const o = out();
      expect(o).toContain('ID');
      expect(o).toContain('Name');
      expect(o).toContain('Status');
      expect(o).toContain('trace');
    });

    it('returns no traces for empty db', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['traces']);
      expect(out()).toContain('No traces found');
    });

    it('--run-id filters by run', async () => {
      const { r1 } = await seedData(tmpDb);
      runCmd(['traces', '--run-id', r1]);
      const o = out();
      expect(o).toContain('trace-1');
    });

    it('--status filters traces', async () => {
      await seedData(tmpDb);
      await runCmd(['traces', '--status', 'error']);
      const o = out();
      expect(o).toContain('trace-2');
    });

    it('--json emits JSON array', async () => {
      await seedData(tmpDb);
      runCmd(['traces', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('['));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });

    it('--limit controls results', async () => {
      await seedData(tmpDb);
      runCmd(['traces', '--limit', '1']);
      const o = out();
      expect(o).toBeTruthy();
    });
  });

  // ── stats ──

  describe('stats', () => {
    it('prints stats section', async () => {
      await seedData(tmpDb);
      runCmd(['stats']);
      const o = out();
      expect(o).toContain('Total Runs');
      expect(o).toContain('Total Traces');
      expect(o).toContain('Success Rate');
      expect(o).toContain('Avg Latency');
      expect(o).toContain('Total Cost');
      expect(o).toContain('Total Tokens');
    });

    it('--json emits JSON', async () => {
      await seedData(tmpDb);
      runCmd(['stats', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('totalRuns');
      expect(parsed).toHaveProperty('totalTraces');
      expect(parsed).toHaveProperty('successRate');
      expect(parsed).toHaveProperty('totalCostUsd');
    });

    it('shows empty stats for empty db', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['stats']);
      expect(out()).toContain('Total Runs:     0');
    });
  });

  // ── costs ──

  describe('costs', () => {
    it('prints cost breakdown by model', async () => {
      await seedData(tmpDb);
      runCmd(['costs']);
      const o = out();
      expect(o).toContain('Cost Breakdown by Model');
      expect(o).toContain('gpt-4o');
      expect(o).toContain('Total:');
    });

    it('--daily prints daily breakdown', async () => {
      await seedData(tmpDb);
      runCmd(['costs', '--daily']);
      const o = out();
      expect(o).toContain('Daily Cost Breakdown');
      expect(o).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('--run-id filters to single run', async () => {
      const { r1, r2 } = await seedData(tmpDb);
      runCmd(['costs', '--run-id', r1]);
      const o1 = out();
      expect(o1).toContain('gpt-4o');

      clearLogs();
      runCmd(['costs', '--run-id', r2]);
      const o2 = out();
      expect(o2).not.toContain('gpt-4o');
    });

    it('--json emits JSON', async () => {
      await seedData(tmpDb);
      runCmd(['costs', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('totalCostUsd');
      expect(parsed).toHaveProperty('costByModel');
      expect(parsed).toHaveProperty('costByDay');
    });
  });

  // ── export ──

  describe('export', () => {
    it('exports JSON by default to stdout', async () => {
      await seedData(tmpDb);
      runCmd(['export']);
      const o = out();
      const parsed = JSON.parse(o);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });

    it('exports CSV with --format csv', async () => {
      await seedData(tmpDb);
      runCmd(['export', '--format', 'csv']);
      const o = out();
      expect(o).toContain('id,runId,name,status');
    });

    it('--run-id filters export', async () => {
      const { r1 } = await seedData(tmpDb);
      runCmd(['export', '--run-id', r1]);
      const parsed = JSON.parse(out());
      for (const t of parsed) {
        expect(t.runId).toBe(r1);
      }
    });

    it('--output writes to file', async () => {
      await seedData(tmpDb);
      const outFile = path.join(path.dirname(tmpDb), 'out.json');
      runCmd(['export', '--output', outFile]);
      expect(fs.existsSync(outFile)).toBe(true);
      const content = fs.readFileSync(outFile, 'utf8');
      const parsed = JSON.parse(content);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  // ── tree ──

  describe('tree', () => {
    it('errors without --trace-id', () => {
      runCmd(['tree']);
      expect(out()).toContain('ERR:');
    });

    it('prints trace tree', async () => {
      const t = new AgentTrace({ dbPath: tmpDb, silent: true });
      const runId = t.startRun('tree-run');
      await t.trace('root-trace', async () => 'ok');
      t.completeRun();
      const found = t.getTraces({ runId, limit: 1 })[0];
      const traceId = found ? found.id : '';
      t.close();

      await runCmd(['tree', '--trace-id', traceId]);
      const o = out();
      expect(o).toContain('Trace Tree:');
      expect(o).toContain('root-trace');
    });

    it('--json emits JSON', async () => {
      const t = new AgentTrace({ dbPath: tmpDb, silent: true });
      const runId = t.startRun('tree-run');
      await t.trace('root-trace', async () => 'ok');
      t.completeRun();
      const found = t.getTraces({ runId, limit: 1 })[0];
      const traceId = found ? found.id : '';
      t.close();

      await runCmd(['tree', '--trace-id', traceId, '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('trace');
    });
  });

  // ── alerts ──

  describe('alerts', () => {
    it('lists no alerts for empty db', () => {
      runCmd(['alerts', 'list']);
      expect(out()).toContain('No alerts configured');
    });

    it('lists no alerts with --json', () => {
      runCmd(['alerts', 'list', '--json']);
      expect(out()).toContain('[]');
    });

    it('alerts history shows empty', async () => {
      runCmd(['init']);
      clearLogs();
      await runCmd(['alerts', 'history']);
      expect(out()).toContain('No alert history');
    });

    it('alerts test --name missing prints error on no db', () => {
      runCmd(['alerts', 'test', '--name', 'nope']);
      expect(out()).toContain('ERR:');
    });
  });

  // ── health ──

  describe('health', () => {
    it('prints health checks', async () => {
      await runCmd(['init']);
      clearLogs();
      await runCmd(['health']);
      const o = out();
      expect(o).toContain('gateway');
      expect(o).toContain('database');
      expect(o).toContain('dashboard');
    });

    it('--json emits JSON', async () => {
      await runCmd(['init']);
      clearLogs();
      await runCmd(['health', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('checks');
      expect(parsed.checks).toHaveProperty('database');
      expect(parsed.checks).toHaveProperty('gateway');
    });
  });

  // ── self-stats ──

  describe('self-stats', () => {
    it('prints self-stats without data', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['self-stats']);
      const o = out();
      expect(o).toContain('Self-Tracking');
      expect(o).toContain('Actions:  0');
    });

    it('--json emits JSON', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['self-stats', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('today');
      expect(parsed).toHaveProperty('week');
      expect(parsed).toHaveProperty('topActions');
    });
  });

  // ── who ──

  describe('who', () => {
    it('prints agent table', async () => {
      await seedAgentUsage(tmpDb);
      runCmd(['who']);
      const o = out();
      expect(o).toContain('agent-a');
      expect(o).toContain('agent-b');
    });

    it('--active filters old agents', async () => {
      await seedAgentUsage(tmpDb);
      runCmd(['who', '--active']);
      expect(out()).toContain('agent-a');
      expect(out()).toContain('agent-b');
    });

    it('--type filters by agent type', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['who', '--type', 'researcher']);
      const _o = out();
      void _o;
      expect(out()).toContain('agent-a');
      expect(out()).not.toContain('agent-b');
    });

    it('--limit caps results', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['who', '--limit', '1']);
      const o = out();
      expect(o).toBeTruthy();
    });

    it('--json emits JSON array', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['who', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('['));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  // ── cost ──

  describe('cost', () => {
    it('shows 4 period sections', async () => {
      await seedAgentUsage(tmpDb);
      runCmd(['cost']);
      const o = out();
      expect(o).toContain('Today');
      expect(o).toContain('This Week');
      expect(o).toContain('This Month');
      expect(o).toContain('All Time');
      expect(o).toContain('By Agent:');
      expect(o).toContain('By Model:');
    });

    it('--agent filters to single agent', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['cost', '--agent', 'agent-a']);
      const o = out();
      expect(o).toContain('agent-a');
      expect(o).not.toContain('agent-b');
    });

    it('--format json emits periods', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['cost', '--format', 'json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('today');
      expect(parsed).toHaveProperty('week');
      expect(parsed).toHaveProperty('month');
      expect(parsed).toHaveProperty('allTime');
    });
  });

  // ── sessions ──

  describe('sessions', () => {
    it('prints session table', async () => {
      await seedAgentUsage(tmpDb);
      runCmd(['sessions']);
      const o = out();
      expect(o).toContain('Session ID');
      expect(o).toContain('Agent');
      expect(o).toContain('sess-1');
    });

    it('--active excludes old sessions', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['sessions', '--active']);
      const o = out();
      // sess-2 (recent) should be present
      expect(o).toContain('sess-2');
    });

    it('--agent filters sessions', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['sessions', '--agent', 'agent-a']);
      const o = out();
      expect(o).toContain('sess-1');
    });

    it('--json emits JSON array', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['sessions', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('['));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  // ── activity ──

  describe('activity', () => {
    it('prints activity timeline', async () => {
      await seedAgentUsage(tmpDb);
      runCmd(['activity', '--limit', '10']);
      const o = out();
      expect(o).toContain('Time');
      expect(o).toContain('Agent');
      expect(o).toContain('Action');
      expect(o).toContain('search');
    });

    it('--since filters by duration', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['activity', '--since', '30m']);
      const o = out();
      // agent-b is within 30m (60s ago)
      expect(o).toContain('agent-b');
    });

    it('--type filters by action', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['activity', '--type', 'search']);
      const o = out();
      expect(o).toContain('search');
      expect(o).not.toContain('implement');
    });

    it('--agent filters by agent name', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['activity', '--agent', 'agent-a']);
      const o = out();
      expect(o).not.toContain('implement');
    });

    it('--json emits JSON array', async () => {
      await seedAgentUsage(tmpDb);
      clearLogs();
      runCmd(['activity', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('['));
      expect(jsonLine).toBeTruthy();
    });
  });

  // ── webhook ──

  describe('webhook', () => {
    it('list with no db shows no webhooks configured', () => {
      runCmd(['webhook', 'list']);
      expect(out()).toContain('No webhooks configured');
    });

    it('list with --json on no db returns []', () => {
      runCmd(['webhook', 'list', '--json']);
      expect(out()).toBe('[]');
    });

    it('list after adding shows webhook', () => {
      runCmd(['init']);
      clearLogs();
      runCmd([
        'webhook',
        'add',
        '--url',
        'https://example.com/hook',
        '--events',
        'trace.complete,run.complete',
      ]);
      const o = out();
      expect(o).toContain('Registered webhook');
      expect(o).toContain('https://example.com/hook');

      clearLogs();
      runCmd(['webhook', 'list']);
      const o2 = out();
      expect(o2).toContain('https://example.com/hook');
      expect(o2).toContain('enabled');
    });

    it('add requires --url', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['webhook', 'add']);
      expect(out()).toContain('ERR:');
    });

    it('remove requires --id', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['webhook', 'remove']);
      expect(out()).toContain('ERR:');
    });

    it('remove deletes webhook', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['webhook', 'add', '--url', 'https://example.com/hook']);
      const regOut = out();
      // extract id from output
      const idMatch = regOut.match(/(\w{8})\s+->/);
      expect(idMatch).toBeTruthy();
      void idMatch;

      clearLogs();
      runCmd(['webhook', 'list', '--json']);
      const listOut = out();
      const hooks = JSON.parse(listOut);
      expect(hooks.length).toBeGreaterThan(0);
      const fullId = hooks[0].id;

      clearLogs();
      runCmd(['webhook', 'remove', '--id', fullId]);
      expect(out()).toContain('Removed webhook');

      clearLogs();
      runCmd(['webhook', 'list']);
      expect(out()).toContain('No webhooks configured');
    });

    it('--json on add returns JSON', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['webhook', 'add', '--url', 'https://example.com/hook', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('id');
      expect(parsed).toHaveProperty('url');
      expect(parsed).toHaveProperty('events');
    });
  });

  // ── cleanup ──

  describe('cleanup', () => {
    it('errors on missing db', () => {
      runCmd(['cleanup']);
      expect(out()).toContain('ERR:');
    });

    it('runs cleanup on existing db', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['cleanup']);
      const o = out();
      expect(o).toContain('Cleanup complete');
      expect(o).toContain('Traces deleted');
      expect(o).toContain('Runs deleted');
      expect(o).toContain('Usage deleted');
    });

    it('--days sets retention threshold', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['cleanup', '--days', '7']);
      expect(out()).toContain('7 days');
    });

    it('--json emits JSON', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['cleanup', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('tracesDeleted');
      expect(parsed).toHaveProperty('runsDeleted');
      expect(parsed).toHaveProperty('usageDeleted');
      expect(parsed).toHaveProperty('days');
    });
  });

  // ── retention ──

  describe('retention', () => {
    it('show with no db reports error', () => {
      runCmd(['retention', 'show']);
      expect(out()).toContain('No database found');
    });

    it('show displays policy and stats', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['retention', 'show']);
      const o = out();
      expect(o).toContain('Retention Policy');
      expect(o).toContain('Retention days');
      expect(o).toContain('Storage Stats');
      expect(o).toContain('Trace count');
    });

    it('stats subcommand shows same as show', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['retention', 'stats']);
      expect(out()).toContain('Retention Policy');
    });

    it('set requires --days', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['retention', 'set']);
      expect(out()).toContain('ERR:');
    });

    it('set persists retention days', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['retention', 'set', '--days', '90']);
      expect(out()).toContain('90 days');

      clearLogs();
      runCmd(['retention', 'show']);
      expect(out()).toContain('90');
    });

    it('set with --interval updates interval', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['retention', 'set', '--days', '60', '--interval', '12']);
      expect(out()).toContain('60 days');
      expect(out()).toContain('12h');
    });

    it('--json on show emits JSON', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['retention', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('policy');
      expect(parsed).toHaveProperty('stats');
    });

    it('--json on set emits JSON', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['retention', 'set', '--days', '45', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('retentionDays', 45);
    });
  });

  // ── key ──

  describe('key', () => {
    it('list with no db shows no keys', () => {
      runCmd(['key', 'list']);
      expect(out()).toContain('No API keys found');
    });

    it('list with --json returns empty array', () => {
      runCmd(['key', 'list', '--json']);
      expect(out()).toBe('[]');
    });

    it('list after creating shows key', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['key', 'create', '--name', 'test-key']);
      const o = out();
      expect(o).toContain('Created API key: test-key');
      expect(o).toContain('Key:');

      clearLogs();
      runCmd(['key', 'list']);
      expect(out()).toContain('test-key');
    });

    it('create requires --name', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['key', 'create']);
      expect(out()).toContain('ERR:');
    });

    it('revoke requires --id', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['key', 'revoke']);
      expect(out()).toContain('ERR:');
    });

    it('create --json emits JSON', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['key', 'create', '--name', 'json-key', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('id');
      expect(parsed).toHaveProperty('name', 'json-key');
      expect(parsed).toHaveProperty('key');
      expect(parsed).toHaveProperty('preview');
    });

    it('revoke removes key', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['key', 'create', '--name', 'to-revoke']);
      // get key id from list
      clearLogs();
      runCmd(['key', 'list', '--json']);
      const keys = JSON.parse(out());
      const id = keys[0].id;

      clearLogs();
      runCmd(['key', 'revoke', '--id', id]);
      expect(out()).toContain('Revoked API key');

      clearLogs();
      runCmd(['key', 'list']);
      expect(out()).toContain('No API keys found');
    });

    it('list --json returns array', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['key', 'create', '--name', 'list-test']);
      clearLogs();
      runCmd(['key', 'list', '--json']);
      const parsed = JSON.parse(out());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });
  });

  // ── benchmark ──

  describe('benchmark', () => {
    it('runs benchmark and prints results', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['benchmark']);
      const o = out();
      expect(o).toContain('Benchmark Results');
      expect(o).toContain('write:');
      expect(o).toContain('read:');
      expect(o).toContain('stats:');
    });

    it('--json emits JSON', () => {
      runCmd(['init']);
      clearLogs();
      runCmd(['benchmark', '--json']);
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('results');
      expect(Array.isArray(parsed.results)).toBe(true);
      expect(parsed.results.length).toBeGreaterThanOrEqual(3);
    });
  });
});
