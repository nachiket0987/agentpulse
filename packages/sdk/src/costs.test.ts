import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { AgentTrace, registerModelRate, type CostBreakdown, type TraceStats } from './index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-costs-'));
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

describe('cost tracking improvements (new tests)', () => {
  let dbPath: string;
  let agent: AgentTrace;

  beforeEach(() => {
    dbPath = makeTempDb();
    agent = new AgentTrace({ dbPath, silent: true });
  });

  afterEach(() => {
    if (agent) agent.close();
    if (dbPath) cleanupDb(dbPath);
  });

  it('supports custom model rate registration at runtime', async () => {
    registerModelRate('custom-rate-model', 0.01, 0.02); // $10/M prompt, $20/M comp

    agent.startRun('reg-run');
    await agent.trace('custom-priced', async () => 'ok', {
      tokens: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        model: 'custom-rate-model',
      },
      model: 'custom-rate-model',
    });

    const stats: TraceStats = agent.getStats();
    // (1000*0.01 + 500*0.02)/1000 = 0.02
    expect(stats.totalCostUsd).toBeCloseTo(0.02, 6);
    expect(stats.costByModel?.['custom-rate-model']).toBeCloseTo(0.02, 6);
  });

  it('includes costByModel in TraceStats', async () => {
    agent.startRun('model-break-run');
    await agent.trace('m1', async () => 'a', {
      tokens: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000, model: 'gpt-4o' },
      model: 'gpt-4o',
    });
    await agent.trace('m2', async () => 'b', {
      tokens: {
        promptTokens: 0,
        completionTokens: 1000,
        totalTokens: 1000,
        model: 'claude-sonnet-4',
      },
      model: 'claude-sonnet-4',
    });

    const stats = agent.getStats();
    expect(stats.costByModel).toBeDefined();
    expect(Object.keys(stats.costByModel || {}).length).toBeGreaterThanOrEqual(2);
    expect(stats.costByModel?.['gpt-4o']).toBeCloseTo(0.0025, 6); // 1000*0.0025 /1000
    expect(stats.costByModel?.['claude-sonnet-4']).toBeCloseTo(0.015, 6);
    expect(stats.totalCostUsd).toBeCloseTo(0.0175, 6);
  });

  it('getCostBreakdown returns byModel, byDay and total', async () => {
    agent.startRun('bd-run');
    await agent.trace('bd1', async () => 1, {
      tokens: { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000, model: 'gpt-4.1' },
      model: 'gpt-4.1',
    });

    const bd: CostBreakdown = agent.getCostBreakdown();
    expect(bd.totalCostUsd).toBeCloseTo(0.012, 6); // (2000*0.002 + 1000*0.008)/1000 = 0.012
    expect(bd.costByModel['gpt-4.1']).toBeCloseTo(0.012, 6);
    expect(typeof bd.costByDay).toBe('object');
    expect(Object.keys(bd.costByDay).length).toBeGreaterThan(0);
  });

  it('getCostBreakdown respects run-id filter', async () => {
    const runA = agent.startRun('run-a');
    await agent.trace('a1', async () => 'x', {
      tokens: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000, model: 'gpt-4.1-mini' },
      model: 'gpt-4.1-mini',
    });
    agent.completeRun();

    const runB = agent.startRun('run-b');
    await agent.trace('b1', async () => 'y', {
      tokens: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000, model: 'gpt-4.1-nano' },
      model: 'gpt-4.1-nano',
    });
    agent.completeRun();

    const all = agent.getCostBreakdown();
    const aOnly = agent.getCostBreakdown({ runId: runA });
    const bOnly = agent.getCostBreakdown({ runId: runB });

    expect(all.totalCostUsd).toBeCloseTo(0.0005, 6);
    expect(aOnly.totalCostUsd).toBeCloseTo(0.0004, 6);
    expect(bOnly.totalCostUsd).toBeCloseTo(0.0001, 6);
    expect(aOnly.costByModel['gpt-4.1-mini']).toBeCloseTo(0.0004, 6);
    expect(bOnly.costByModel['gpt-4.1-nano']).toBeCloseTo(0.0001, 6);
    expect(Object.keys(aOnly.costByModel)).not.toContain('gpt-4.1-nano');
  });

  it('calculates for newly added models (claude-opus-4, gemini-2.5 etc)', async () => {
    agent.startRun('new-models-run');
    await agent.trace('opus', async () => 'o', {
      tokens: {
        promptTokens: 1000,
        completionTokens: 0,
        totalTokens: 1000,
        model: 'claude-opus-4',
      },
      model: 'claude-opus-4',
    });
    await agent.trace('g25f', async () => 'g', {
      tokens: {
        promptTokens: 1000,
        completionTokens: 0,
        totalTokens: 1000,
        model: 'gemini-2.5-flash',
      },
      model: 'gemini-2.5-flash',
    });
    await agent.trace('ll4m', async () => 'l', {
      tokens: {
        promptTokens: 1000,
        completionTokens: 0,
        totalTokens: 1000,
        model: 'llama-4-maverick',
      },
      model: 'llama-4-maverick',
    });

    const bd = agent.getCostBreakdown();
    expect(bd.costByModel['claude-opus-4']).toBeCloseTo(0.005, 6);
    expect(bd.costByModel['gemini-2.5-flash']).toBeCloseTo(0.0003, 6);
    expect(bd.costByModel['llama-4-maverick']).toBeCloseTo(0.00015, 6);
  });
});
