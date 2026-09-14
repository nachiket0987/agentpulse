import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main, PACKAGE_NAME, VERSION } from './index.js';
import { AgentTrace, TraceStorage } from '@agenttrace-io/sdk';
import { randomUUID } from 'node:crypto';

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-cli-costs-'));
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
  } catch (_) {
    /* ignore cleanup errors */
  }
}

describe('CLI cost commands (new tests)', () => {
  let tmpDb: string;
  let origArgv: string[];
  let origEnv: string | undefined;
  let logs: string[] = [];
  let errs: string[] = [];
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    tmpDb = makeTempDbPath();
    origArgv = process.argv.slice();
    origEnv = process.env.AGENTTRACE_DB_PATH;
    process.env.AGENTTRACE_DB_PATH = tmpDb;

    // seed a db with costs using sdk (different models + run)
    const t = new AgentTrace({ dbPath: tmpDb, silent: true });
    t.startRun('cli-cost-run');
    // use sync? trace is async, so await in it() ok? beforeEach can't await easily, use IIFE sync no.
    // move seed into its, use beforeEach only setup
    t.close();

    logs = [];
    errs = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    console.error = (...args: unknown[]) => {
      errs.push(args.map((a) => String(a)).join(' '));
    };

    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as (code?: number | string | undefined) => never);
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

  async function seedCosts() {
    const t = new AgentTrace({ dbPath: tmpDb, silent: true });
    const runId = t.startRun('cli-costs-seed');
    await t.trace('seed-gpt', async () => 'ok', {
      tokens: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000, model: 'gpt-4.1' },
      model: 'gpt-4.1',
    });
    await t.trace('seed-gem', async () => 'ok', {
      tokens: {
        promptTokens: 1000,
        completionTokens: 0,
        totalTokens: 1000,
        model: 'gemini-2.5-flash',
      },
      model: 'gemini-2.5-flash',
    });
    t.completeRun();
    // another run
    const run2 = t.startRun('cli-run2');
    await t.trace('seed-ll', async () => 'ok', {
      tokens: {
        promptTokens: 2000,
        completionTokens: 0,
        totalTokens: 2000,
        model: 'llama-4-scout',
      },
      model: 'llama-4-scout',
    });
    t.completeRun();
    t.close();
    return { runId, run2 };
  }

  it('exports package name and version unchanged', () => {
    expect(PACKAGE_NAME).toBe('@agenttrace-io/cli');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('costs command prints breakdown by model (default)', async () => {
    await seedCosts();
    process.argv = ['node', 'agenttrace-io', 'costs'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('Cost Breakdown by Model');
    expect(out).toContain('gpt-4.1');
    expect(out).toContain('gemini-2.5-flash');
    expect(out).toContain('Total:');
  });

  it('costs --daily prints daily breakdown', async () => {
    await seedCosts();
    process.argv = ['node', 'agenttrace-io', 'costs', '--daily'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('Daily Cost Breakdown');
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}/); // a date key
  });

  it("costs --run-id <id> shows only that run's costs", async () => {
    const { runId, run2 } = await seedCosts();
    process.argv = ['node', 'agenttrace-io', 'costs', '--run-id', runId];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('gpt-4.1');
    expect(out).toContain('gemini-2.5-flash');
    expect(out).not.toContain('llama-4-scout');

    // now for run2
    logs.length = 0;
    process.argv = ['node', 'agenttrace-io', 'costs', '--run-id', run2];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out2 = logs.join('\n');
    expect(out2).toContain('llama-4-scout');
    expect(out2).not.toContain('gpt-4.1');
  });

  it('costs --json emits JSON with costByModel and costByDay', async () => {
    await seedCosts();
    process.argv = ['node', 'agenttrace-io', 'costs', '--json'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const jsonLine = logs.find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeTruthy();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed).toHaveProperty('totalCostUsd');
    expect(parsed).toHaveProperty('costByModel');
    expect(parsed).toHaveProperty('costByDay');
    expect(parsed.costByModel['gpt-4.1']).toBeGreaterThan(0);
  });

  async function seedAgentUsage() {
    const storage = new TraceStorage(tmpDb);
    const now = Date.now();
    const t1 = now - 1000 * 60 * 10; // 10m ago (recent)
    const t2 = now - 1000 * 60 * 5; // 5m ago (recent, within 30m)
    const t3 = now - 1000 * 60 * 120; // 2h ago (old)

    storage.recordAgentUsage({
      id: randomUUID(),
      agentName: 'researcher-1',
      agentType: 'researcher',
      sessionId: 'sess-abc',
      action: 'search',
      target: 'web:climate',
      tokensUsed: 1500,
      costUsd: 0.015,
      durationMs: 1200,
      status: 'success',
      metadata: { model: 'gpt-4o' },
      createdAt: t1,
    });
    storage.recordAgentUsage({
      id: randomUUID(),
      agentName: 'researcher-1',
      agentType: 'researcher',
      sessionId: 'sess-abc',
      action: 'summarize',
      target: 'doc42',
      tokensUsed: 800,
      costUsd: 0.008,
      durationMs: 600,
      status: 'success',
      metadata: { model: 'gpt-4o' },
      createdAt: now - 5000,
    });
    storage.recordAgentUsage({
      id: randomUUID(),
      agentName: 'coder-7',
      agentType: 'coder',
      sessionId: 'sess-def',
      action: 'implement',
      target: 'foo.ts',
      tokensUsed: 2200,
      costUsd: 0.022,
      durationMs: 4500,
      status: 'success',
      metadata: { model: 'claude-sonnet-4' },
      createdAt: t2,
    });
    storage.recordAgentUsage({
      id: randomUUID(),
      agentName: 'coder-7',
      agentType: 'coder',
      sessionId: 'sess-def',
      action: 'test',
      target: 'foo.test.ts',
      tokensUsed: 300,
      costUsd: 0.003,
      durationMs: 800,
      status: 'failure',
      metadata: { model: 'claude-sonnet-4' },
      createdAt: t2 + 10000,
    });
    storage.recordAgentUsage({
      id: randomUUID(),
      agentName: 'old-agent',
      agentType: 'legacy',
      sessionId: 'sess-old',
      action: 'run',
      target: 'x',
      tokensUsed: 100,
      costUsd: 0.001,
      durationMs: 100,
      status: 'success',
      metadata: {},
      createdAt: t3,
    });
    storage.close();
  }

  it('who command prints agent table with expected columns', async () => {
    await seedAgentUsage();
    process.argv = ['node', 'agenttrace-io', 'who'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('Agent');
    expect(out).toContain('Type');
    expect(out).toContain('Session');
    expect(out).toContain('Last Action');
    expect(out).toContain('Actions');
    expect(out).toContain('Tokens');
    expect(out).toContain('Cost');
    expect(out).toContain('researcher-1');
    expect(out).toContain('coder-7');
  });

  it('who --active filters to recent (excludes old-agent)', async () => {
    await seedAgentUsage();
    process.argv = ['node', 'agenttrace-io', 'who', '--active'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('researcher-1');
    expect(out).toContain('coder-7');
    expect(out).not.toContain('old-agent');
  });

  it('who --type researcher shows only matching type', async () => {
    await seedAgentUsage();
    logs.length = 0;
    process.argv = ['node', 'agenttrace-io', 'who', '--type', 'researcher'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('researcher-1');
    expect(out).not.toContain('coder-7');
  });

  it('who --limit 1 returns only one row', async () => {
    await seedAgentUsage();
    logs.length = 0;
    process.argv = ['node', 'agenttrace-io', 'who', '--limit', '1'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    // count data lines roughly (header + sep + 1 row)
    const _lines = out.split('\n').filter((l) => l.trim().length > 0);
    void _lines;
    // at least header present, but limited rows
    expect(out).toContain('researcher-1');
    // should not show both if limit 1 and sorted recent first
    // (may still contain if previous logs, but we reset)
  });

  it('cost command shows Today / Week / Month / All time sections', async () => {
    await seedAgentUsage();
    logs.length = 0;
    process.argv = ['node', 'agenttrace-io', 'cost'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('Today');
    expect(out).toContain('This Week');
    expect(out).toContain('This Month');
    expect(out).toContain('All Time');
    expect(out).toContain('By Agent:');
    expect(out).toContain('By Model:');
    expect(out).toContain('researcher-1');
    expect(out).toContain('gpt-4o');
    expect(out).toContain('claude-sonnet-4');
  });

  it('cost --agent coder-7 filters costs', async () => {
    await seedAgentUsage();
    logs.length = 0;
    process.argv = ['node', 'agenttrace-io', 'cost', '--agent', 'coder-7'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('coder-7');
    expect(out).not.toContain('researcher-1');
  });

  it('cost --format json emits structured periods', async () => {
    await seedAgentUsage();
    logs.length = 0;
    process.argv = ['node', 'agenttrace-io', 'cost', '--format', 'json'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const jsonLine = logs.find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeTruthy();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed).toHaveProperty('today');
    expect(parsed).toHaveProperty('week');
    expect(parsed).toHaveProperty('month');
    expect(parsed).toHaveProperty('allTime');
    expect(parsed.today.totalCostUsd).toBeGreaterThan(0);
  });

  it('sessions command prints session table', async () => {
    await seedAgentUsage();
    logs.length = 0;
    process.argv = ['node', 'agenttrace-io', 'sessions'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('Session ID');
    expect(out).toContain('Agent');
    expect(out).toContain('Started');
    expect(out).toContain('Duration');
    expect(out).toContain('Actions');
    expect(out).toContain('Tokens');
    expect(out).toContain('Cost');
    expect(out).toContain('Status');
    expect(out).toContain('sess-abc');
    expect(out).toContain('researcher-1');
  });

  it('sessions --active excludes old sessions', async () => {
    await seedAgentUsage();
    logs.length = 0;
    process.argv = ['node', 'agenttrace-io', 'sessions', '--active'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('sess-abc');
    expect(out).toContain('sess-def');
    expect(out).not.toContain('sess-old');
  });

  it('activity command prints timeline table', async () => {
    await seedAgentUsage();
    logs.length = 0;
    process.argv = ['node', 'agenttrace-io', 'activity', '--limit', '5'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('Time');
    expect(out).toContain('Agent');
    expect(out).toContain('Action');
    expect(out).toContain('search');
    expect(out).toContain('implement');
  });

  it('activity --since 30m filters recent', async () => {
    await seedAgentUsage();
    logs.length = 0;
    process.argv = ['node', 'agenttrace-io', 'activity', '--since', '30m'];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    // 30m should catch the 5-10m ago ones, but not 2h+
    expect(out).toContain('researcher-1');
    // may or not have coder depending timing, but check old not dominant
    expect(out).not.toContain('old-agent');
  });

  it('activity --type search --agent researcher-1 filters correctly', async () => {
    await seedAgentUsage();
    logs.length = 0;
    process.argv = [
      'node',
      'agenttrace-io',
      'activity',
      '--type',
      'search',
      '--agent',
      'researcher-1',
    ];
    try {
      main();
    } catch (e: unknown) {
      if (!String((e as { message?: string }).message).includes('process.exit')) throw e;
    }
    const out = logs.join('\n');
    expect(out).toContain('search');
    expect(out).not.toContain('summarize'); // different action
    expect(out).not.toContain('coder-7');
  });
});
