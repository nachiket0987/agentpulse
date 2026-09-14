/**
 * AgentTrace Performance Benchmark Suite
 * Standalone script (not a test). Run via:
 *   node --experimental-strip-types packages/sdk/src/benchmark.ts
 * or after build:
 *   node packages/sdk/dist/benchmark.js
 *
 * Outputs structured JSON results to stdout.
 */

import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { AgentTrace, TraceStorage, type Trace } from './index.js';
import type { TraceFilter } from './types.js';

export interface BenchmarkResult {
  timestamp: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  benchmarks: {
    insertion: InsertionResult;
    queries: QueriesResult;
    exports: ExportsResult;
    memory: MemoryResult;
    concurrent: ConcurrentResult;
  };
}

export interface InsertionResult {
  count: number;
  timeMs: number;
  tracesPerSecond: number;
}

export interface QueryPerf {
  name: string;
  filter: TraceFilter;
  count: number;
  timeMs: number;
}

export interface QueriesResult {
  datasetSize: number;
  queries: QueryPerf[];
}

export interface ExportPerf {
  size: number;
  json: { timeMs: number; outputLength: number };
  csv: { timeMs: number; outputLength: number };
}

export interface ExportsResult {
  results: ExportPerf[];
}

export interface MemoryResult {
  datasetSize: number;
  before: { rssMB: number; heapUsedMB: number };
  afterInsert: { rssMB: number; heapUsedMB: number };
  deltaInsert: { rssMB: number; heapUsedMB: number };
  afterFullLoad: { rssMB: number; heapUsedMB: number };
  approxMBPerTrace: number;
}

export interface ConcurrentResult {
  count: number;
  timeMs: number;
  tracesPerSecond: number;
}

function makeTraceData(
  i: number,
  runId: string,
  baseTime: number,
): Omit<Trace, 'createdAt' | 'updatedAt'> {
  const models = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'gemini-2.0-flash'] as const;
  const model = models[i % models.length];
  const isError = i % 20 === 0;
  const status: Trace['status'] = isError ? 'error' : 'success';
  const promptTokens = 80 + (i % 180);
  const completionTokens = 30 + (i % 90);
  const latencyMs = 15 + (i % 480);
  const costUsd = (promptTokens * 0.0015 + completionTokens * 0.002) / 1000;

  const hasTools = i % 5 === 0;
  const toolCalls = hasTools
    ? [
        {
          id: `tool-${i}`,
          name: i % 3 === 0 ? 'web_search' : 'calculator',
          input: { query: `q${i}` },
          output: { result: `r${i}` },
          latencyMs: 4 + (i % 12),
          success: true,
          timestamp: baseTime + i,
        },
      ]
    : [];

  return {
    id: `bench-${baseTime}-${i}`,
    runId,
    name: `op-${i % 28}`,
    status,
    input: i % 2 === 0 ? { prompt: `input for ${i}` } : null,
    output: isError ? null : i % 3 === 0 ? { value: i * 2 } : `output-${i}`,
    tokens: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model,
      provider: 'openai',
    },
    toolCalls,
    latencyMs,
    costUsd,
    error: isError ? 'simulated error for benchmark' : undefined,
    metadata: { iter: i, batch: Math.floor(i / 100), tag: `tag-${i % 12}` },
    parentId: undefined,
  };
}

async function benchInsertion(count = 5000): Promise<InsertionResult> {
  const agent = new AgentTrace({ dbPath: ':memory:', silent: true, autoCleanup: false });
  agent.startRun('bench-insertion');
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    await agent.trace(`ins-${i}`, async () => ({ ok: i }), {
      input: { i },
      tokens: {
        promptTokens: 50,
        completionTokens: 20,
        totalTokens: 70,
        model: 'gpt-4o-mini',
      },
      metadata: { bench: true, i: i % 200 },
    });
  }
  const dur = performance.now() - t0;
  const rate = count / (dur / 1000);
  agent.close();
  return {
    count,
    timeMs: Math.round(dur * 100) / 100,
    tracesPerSecond: Math.round(rate),
  };
}

function populateDataset(size: number): { agent: AgentTrace; runId: string } {
  const agent = new AgentTrace({ dbPath: ':memory:', silent: true, autoCleanup: false });
  const runId = agent.startRun('bench-populate');
  const storage = (agent as unknown as { storage: TraceStorage }).storage;
  const baseTime = Date.now() - size * 10; // spread timestamps a bit
  for (let i = 0; i < size; i++) {
    storage.createTrace(makeTraceData(i, runId, baseTime));
  }
  return { agent, runId };
}

async function benchQueries(agent: AgentTrace): Promise<QueriesResult> {
  const queries: QueryPerf[] = [];

  // no filter (all)
  let t0 = performance.now();
  let res = agent.getTraces();
  let t = performance.now() - t0;
  queries.push({
    name: 'noFilter',
    filter: {},
    count: res.length,
    timeMs: Math.round(t * 100) / 100,
  });

  // by status success
  t0 = performance.now();
  res = agent.getTraces({ status: ['success'] });
  t = performance.now() - t0;
  queries.push({
    name: 'byStatusSuccess',
    filter: { status: ['success'] },
    count: res.length,
    timeMs: Math.round(t * 100) / 100,
  });

  // by status error
  t0 = performance.now();
  res = agent.getTraces({ status: ['error'] });
  t = performance.now() - t0;
  queries.push({
    name: 'byStatusError',
    filter: { status: ['error'] },
    count: res.length,
    timeMs: Math.round(t * 100) / 100,
  });

  // name like
  t0 = performance.now();
  res = agent.getTraces({ name: 'op-1' }); // LIKE %op-1%
  t = performance.now() - t0;
  queries.push({
    name: 'byNameLike',
    filter: { name: 'op-1' },
    count: res.length,
    timeMs: Math.round(t * 100) / 100,
  });

  // cost range (mid)
  t0 = performance.now();
  res = agent.getTraces({ minCost: 0.0002, maxCost: 0.0005 });
  t = performance.now() - t0;
  queries.push({
    name: 'byCostRange',
    filter: { minCost: 0.0002, maxCost: 0.0005 },
    count: res.length,
    timeMs: Math.round(t * 100) / 100,
  });

  // latency range
  t0 = performance.now();
  res = agent.getTraces({ minLatency: 100, maxLatency: 300 });
  t = performance.now() - t0;
  queries.push({
    name: 'byLatencyRange',
    filter: { minLatency: 100, maxLatency: 300 },
    count: res.length,
    timeMs: Math.round(t * 100) / 100,
  });

  // limit + offset (pagination)
  t0 = performance.now();
  res = agent.getTraces({ limit: 100, offset: 5000 });
  t = performance.now() - t0;
  queries.push({
    name: 'limitOffset',
    filter: { limit: 100, offset: 5000 },
    count: res.length,
    timeMs: Math.round(t * 100) / 100,
  });

  // by runId
  const runs = agent.getRuns(1);
  const runId = runs[0]?.id;
  if (runId) {
    t0 = performance.now();
    res = agent.getTraces({ runId });
    t = performance.now() - t0;
    queries.push({
      name: 'byRunId',
      filter: { runId },
      count: res.length,
      timeMs: Math.round(t * 100) / 100,
    });
  }

  return {
    datasetSize: agent.getStats().totalTraces,
    queries,
  };
}

async function benchExports(): Promise<ExportsResult> {
  const sizes = [1000, 10000, 100000];
  const results: ExportPerf[] = [];

  for (const size of sizes) {
    const { agent } = populateDataset(size);
    // JSON
    let t0 = performance.now();
    const jsonStr = agent.export('json');
    const jsonTime = performance.now() - t0;
    // CSV
    t0 = performance.now();
    const csvStr = agent.export('csv');
    const csvTime = performance.now() - t0;

    results.push({
      size,
      json: { timeMs: Math.round(jsonTime * 100) / 100, outputLength: jsonStr.length },
      csv: { timeMs: Math.round(csvTime * 100) / 100, outputLength: csvStr.length },
    });
    agent.close();
  }

  return { results };
}

async function benchMemory(): Promise<MemoryResult> {
  const size = 10000;
  const agent = new AgentTrace({ dbPath: ':memory:', silent: true, autoCleanup: false });
  const before = process.memoryUsage();

  const runId = agent.startRun('bench-memory');
  const storage = (agent as unknown as { storage: TraceStorage }).storage;
  const baseTime = Date.now();
  for (let i = 0; i < size; i++) {
    storage.createTrace(makeTraceData(i, runId, baseTime));
  }
  const afterInsert = process.memoryUsage();

  // full load into JS objects (exercises rowToTrace + tool subqueries)
  const _loaded = agent.getTraces({ limit: size + 10 });
  const afterLoad = process.memoryUsage();

  const deltaRss = (afterInsert.rss - before.rss) / 1024 / 1024;
  const deltaHeap = (afterInsert.heapUsed - before.heapUsed) / 1024 / 1024;
  const approx = (afterLoad.heapUsed - before.heapUsed) / 1024 / 1024 / size;

  agent.close();

  return {
    datasetSize: size,
    before: {
      rssMB: Math.round((before.rss / 1024 / 1024) * 100) / 100,
      heapUsedMB: Math.round((before.heapUsed / 1024 / 1024) * 100) / 100,
    },
    afterInsert: {
      rssMB: Math.round((afterInsert.rss / 1024 / 1024) * 100) / 100,
      heapUsedMB: Math.round((afterInsert.heapUsed / 1024 / 1024) * 100) / 100,
    },
    deltaInsert: {
      rssMB: Math.round(deltaRss * 100) / 100,
      heapUsedMB: Math.round(deltaHeap * 100) / 100,
    },
    afterFullLoad: {
      rssMB: Math.round((afterLoad.rss / 1024 / 1024) * 100) / 100,
      heapUsedMB: Math.round((afterLoad.heapUsed / 1024 / 1024) * 100) / 100,
    },
    approxMBPerTrace: Math.round(approx * 10000) / 10000,
  };
}

async function benchConcurrent(count = 2000): Promise<ConcurrentResult> {
  const agent = new AgentTrace({ dbPath: ':memory:', silent: true, autoCleanup: false });
  agent.startRun('bench-concurrent');
  const t0 = performance.now();
  const promises: Promise<unknown>[] = [];
  for (let i = 0; i < count; i++) {
    promises.push(
      agent.trace(`conc-${i}`, async () => ({ i }), {
        tokens: {
          promptTokens: 12,
          completionTokens: 6,
          totalTokens: 18,
          model: 'gpt-4o-mini',
        },
      }),
    );
  }
  await Promise.all(promises);
  const dur = performance.now() - t0;
  const rate = count / (dur / 1000);
  agent.close();
  return {
    count,
    timeMs: Math.round(dur * 100) / 100,
    tracesPerSecond: Math.round(rate),
  };
}

export async function runBenchmarks(): Promise<BenchmarkResult> {
  const result: BenchmarkResult = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    benchmarks: {
      insertion: await benchInsertion(5000),
      queries: { datasetSize: 0, queries: [] },
      exports: { results: [] },
      memory: {} as MemoryResult,
      concurrent: { count: 0, timeMs: 0, tracesPerSecond: 0 },
    },
  };

  // Queries dataset (10k)
  const qSetup = populateDataset(10000);
  result.benchmarks.queries = await benchQueries(qSetup.agent);
  qSetup.agent.close();

  // Exports (1k/10k/100k)
  result.benchmarks.exports = await benchExports();

  // Memory (10k)
  result.benchmarks.memory = await benchMemory();

  // Concurrent
  result.benchmarks.concurrent = await benchConcurrent(2000);

  return result;
}

// Standalone execution detection (cross platform)
function isMain(): boolean {
  try {
    if (!process.argv[1]) return false;
    const thisFile = fileURLToPath(import.meta.url);
    const invoked = process.argv[1];
    // normalize slashes
    return invoked === thisFile || invoked.replace(/\\/g, '/') === thisFile.replace(/\\/g, '/');
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  try {
    const results = await runBenchmarks();
    const json = JSON.stringify(results, null, 2);
    console.log(json);
  } catch (err: unknown) {
    console.error('Benchmark failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (isMain()) {
  main();
}
