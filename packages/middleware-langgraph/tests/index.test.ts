import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { AgentTraceMiddleware, VERSION, PACKAGE_NAME } from '../src/index.js';
import { AgentTrace } from '@agenttrace-io/sdk';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';

function tempDbPath(): string {
  return join(tmpdir(), `agenttrace-mw-test-${randomUUID()}.db`);
}

function cleanupDb(path: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // ignore
    }
  }
}

describe('AgentTraceMiddleware', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it('exports correct version and package name', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(PACKAGE_NAME).toBe('@agenttrace-io/middleware-langgraph');
  });

  it('implements NodeMiddleware interface', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    expect(typeof mw.beforeNode).toBe('function');
    expect(typeof mw.afterNode).toBe('function');
    expect(typeof mw.onError).toBe('function');
    mw.close();
  });

  it('records a trace on afterNode with success status', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const nodeName = 'summarize';
    const state = { messages: ['hello'] };
    mw.beforeNode(nodeName, state);
    const result = { messages: ['hello', 'summary'] };
    mw.afterNode(nodeName, state, result);

    const traces = inspector.getTraces();
    expect(traces.length).toBeGreaterThanOrEqual(1);
    const trace = traces.find((t) => t.name === nodeName);
    expect(trace).toBeDefined();
    expect(trace!.status).toBe('success');
    expect(trace!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(trace!.metadata).toEqual({ framework: 'langgraph' });

    mw.close();
    inspector.close();
  });

  it('records input and output on success traces', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const input = { query: 'search terms' };
    const output = { results: ['a', 'b'] };
    mw.beforeNode('search', input);
    mw.afterNode('search', input, output);

    const trace = inspector.getTraces().find((t) => t.name === 'search');
    expect(trace).toBeDefined();
    expect(trace!.input).toEqual(input);
    expect(trace!.output).toEqual(output);

    mw.close();
    inspector.close();
  });

  it('records a trace on onError with error status', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const nodeName = 'failing-node';
    const state = { data: 42 };
    mw.beforeNode(nodeName, state);
    mw.onError(nodeName, state, new Error('timeout exceeded'));

    const traces = inspector.getTraces();
    const trace = traces.find((t) => t.name === nodeName);
    expect(trace).toBeDefined();
    expect(trace!.status).toBe('error');
    expect(trace!.error).toBe('timeout exceeded');
    expect(trace!.output).toBeNull();

    mw.close();
    inspector.close();
  });

  it('handles non-Error objects in onError', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    mw.beforeNode('crash', {});
    // Cast to satisfy TypeScript; runtime sees a non-Error
    mw.onError('crash', {}, 'string error' as unknown as Error);

    const trace = inspector.getTraces().find((t) => t.name === 'crash');
    expect(trace).toBeDefined();
    expect(trace!.status).toBe('error');
    expect(trace!.error).toBe('string error');

    mw.close();
    inspector.close();
  });

  it('extracts tokens from usage_metadata (modern LangChain)', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const result = {
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      },
      response_metadata: { model_name: 'gpt-4o' },
    };
    mw.beforeNode('llm-call', {});
    mw.afterNode('llm-call', {}, result);

    const trace = inspector.getTraces().find((t) => t.name === 'llm-call');
    expect(trace).toBeDefined();
    expect(trace!.tokens.promptTokens).toBe(100);
    expect(trace!.tokens.completionTokens).toBe(50);
    expect(trace!.tokens.totalTokens).toBe(150);

    mw.close();
    inspector.close();
  });

  it('extracts tokens from response_metadata.tokenUsage (older LangChain)', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const result = {
      response_metadata: {
        tokenUsage: {
          promptTokens: 200,
          completionTokens: 80,
          totalTokens: 280,
        },
        model_name: 'gpt-4o-mini',
      },
    };
    mw.beforeNode('old-llm', {});
    mw.afterNode('old-llm', {}, result);

    const trace = inspector.getTraces().find((t) => t.name === 'old-llm');
    expect(trace).toBeDefined();
    expect(trace!.tokens.promptTokens).toBe(200);
    expect(trace!.tokens.completionTokens).toBe(80);
    expect(trace!.tokens.totalTokens).toBe(280);

    mw.close();
    inspector.close();
  });

  it('extracts tokens from direct token fields on result', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const result = {
      totalTokens: 500,
      promptTokens: 300,
      completionTokens: 200,
      model: 'claude-sonnet-4',
    };
    mw.beforeNode('direct', {});
    mw.afterNode('direct', {}, result);

    const trace = inspector.getTraces().find((t) => t.name === 'direct');
    expect(trace).toBeDefined();
    expect(trace!.tokens.totalTokens).toBe(500);
    expect(trace!.tokens.promptTokens).toBe(300);
    expect(trace!.tokens.completionTokens).toBe(200);

    mw.close();
    inspector.close();
  });

  it('extracts tokens from deep nested usage objects', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const result = {
      nested: {
        deep: {
          token_usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      },
    };
    mw.beforeNode('deep-scan', {});
    mw.afterNode('deep-scan', {}, result);

    const trace = inspector.getTraces().find((t) => t.name === 'deep-scan');
    expect(trace).toBeDefined();
    expect(trace!.tokens.totalTokens).toBe(15);

    mw.close();
    inspector.close();
  });

  it('returns zero tokens when no usage info present', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    mw.beforeNode('plain', {});
    mw.afterNode('plain', {}, { text: 'no tokens here' });

    const trace = inspector.getTraces().find((t) => t.name === 'plain');
    expect(trace).toBeDefined();
    expect(trace!.tokens.totalTokens).toBe(0);
    expect(trace!.tokens.promptTokens).toBe(0);
    expect(trace!.tokens.completionTokens).toBe(0);

    mw.close();
    inspector.close();
  });

  it('computes cost for known models', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    // gpt-4o: prompt=0.0025, completion=0.01 per 1K tokens
    const result = {
      usage_metadata: {
        input_tokens: 1000,
        output_tokens: 1000,
        total_tokens: 2000,
      },
      response_metadata: { model_name: 'gpt-4o' },
    };
    mw.beforeNode('cost-check', {});
    mw.afterNode('cost-check', {}, result);

    const trace = inspector.getTraces().find((t) => t.name === 'cost-check');
    expect(trace).toBeDefined();
    // 1000 * 0.0025 / 1000 + 1000 * 0.01 / 1000 = 0.0025 + 0.01 = 0.0125
    expect(trace!.costUsd).toBeCloseTo(0.0125, 6);

    mw.close();
    inspector.close();
  });

  it('uses fallback rate for unknown models', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const result = {
      usage_metadata: {
        input_tokens: 1000,
        output_tokens: 1000,
        total_tokens: 2000,
      },
      response_metadata: { model_name: 'custom-llm-7b' },
    };
    mw.beforeNode('unknown-model', {});
    mw.afterNode('unknown-model', {}, result);

    const trace = inspector.getTraces().find((t) => t.name === 'unknown-model');
    expect(trace).toBeDefined();
    // fallback: 1000 * 0.001 / 1000 + 1000 * 0.002 / 1000 = 0.001 + 0.002 = 0.003
    expect(trace!.costUsd).toBeCloseTo(0.003, 6);

    mw.close();
    inspector.close();
  });

  it('auto-creates a run when no currentRunId exists', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    // No startRun called on the middleware's agent
    mw.beforeNode('auto-run', {});
    mw.afterNode('auto-run', {}, 'done');

    const trace = inspector.getTraces().find((t) => t.name === 'auto-run');
    expect(trace).toBeDefined();
    expect(trace!.runId).toBeTruthy();
    // Should also have created a run row
    const runs = inspector.getRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);

    mw.close();
    inspector.close();
  });

  it('propagates run context from startRun', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const runId = mw.getAgentTrace().startRun('my-langgraph-run');
    mw.beforeNode('context-node', {});
    mw.afterNode('context-node', {}, 'result');

    const trace = inspector.getTraces().find((t) => t.name === 'context-node');
    expect(trace).toBeDefined();
    expect(trace!.runId).toBe(runId);

    mw.close();
    inspector.close();
  });

  it('handles stacked invocations of the same node name', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    mw.getAgentTrace().startRun('stacked');

    // Two sequential calls to the same node name
    mw.beforeNode('process', { step: 1 });
    mw.beforeNode('process', { step: 2 });
    mw.afterNode('process', { step: 2 }, 'result-2');
    mw.afterNode('process', { step: 1 }, 'result-1');

    const traces = inspector.getTraces().filter((t) => t.name === 'process');
    expect(traces.length).toBe(2);
    // Both should be success
    expect(traces.every((t) => t.status === 'success')).toBe(true);

    mw.close();
    inspector.close();
  });

  it('handles beforeNode without prior afterNode (orphan before)', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    // Call afterNode without beforeNode — should still record a trace
    mw.afterNode('orphan', {}, 'some-result');

    const trace = inspector.getTraces().find((t) => t.name === 'orphan');
    expect(trace).toBeDefined();
    expect(trace!.status).toBe('success');

    mw.close();
    inspector.close();
  });

  it('handles onError without prior beforeNode (orphan error)', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    mw.onError('orphan-err', {}, new Error('unexpected'));

    const trace = inspector.getTraces().find((t) => t.name === 'orphan-err');
    expect(trace).toBeDefined();
    expect(trace!.status).toBe('error');

    mw.close();
    inspector.close();
  });

  it('beforeNode returns the state unchanged', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const state = { data: [1, 2, 3] };
    const returned = mw.beforeNode('pass-through', state);
    expect(returned).toBe(state);
    mw.close();
  });

  it('afterNode returns the result unchanged', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const result = { answer: 42 };
    mw.beforeNode('pass-result', {});
    const returned = mw.afterNode('pass-result', {}, result);
    expect(returned).toBe(result);
    mw.close();
  });

  it('getAgentTrace returns usable AgentTrace instance', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const agent = mw.getAgentTrace();
    expect(agent).toBeInstanceOf(AgentTrace);

    const runId = agent.startRun('test-via-getter');
    expect(typeof runId).toBe('string');
    expect(runId.length).toBeGreaterThan(0);

    mw.close();
  });

  it('close does not throw', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    expect(() => mw.close()).not.toThrow();
  });

  it('records multiple nodes in a single run', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const runId = mw.getAgentTrace().startRun('multi-node');

    mw.beforeNode('node-a', { input: 1 });
    mw.afterNode('node-a', { input: 1 }, { output: 2 });

    mw.beforeNode('node-b', { input: 2 });
    mw.afterNode('node-b', { input: 2 }, { output: 3 });

    const traces = inspector.getTraces();
    const aTrace = traces.find((t) => t.name === 'node-a');
    const bTrace = traces.find((t) => t.name === 'node-b');
    expect(aTrace).toBeDefined();
    expect(bTrace).toBeDefined();
    expect(aTrace!.runId).toBe(runId);
    expect(bTrace!.runId).toBe(runId);

    mw.close();
    inspector.close();
  });

  it('extracts tokens from array of messages with usage_metadata', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    // LangChain often returns an array of messages
    const result = [
      { type: 'human', content: 'hi' },
      {
        type: 'ai',
        content: 'hello',
        usage_metadata: {
          input_tokens: 5,
          output_tokens: 3,
          total_tokens: 8,
        },
        response_metadata: { model_name: 'gpt-4o-mini' },
      },
    ];
    mw.beforeNode('array-result', {});
    mw.afterNode('array-result', {}, result);

    const trace = inspector.getTraces().find((t) => t.name === 'array-result');
    expect(trace).toBeDefined();
    expect(trace!.tokens.totalTokens).toBe(8);
    expect(trace!.tokens.promptTokens).toBe(5);
    expect(trace!.tokens.completionTokens).toBe(3);

    mw.close();
    inspector.close();
  });

  it('respects silent mode (no console.error on trace failure)', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    // This just verifies construction with silent: true works
    mw.beforeNode('silent-test', {});
    mw.afterNode('silent-test', {}, 'ok');
    mw.close();
    // No assertion on console.error — just ensuring no throw
  });

  it('extracts tokens from kwargs.usage_metadata (python interop shape)', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const result = {
      kwargs: {
        usage_metadata: {
          input_tokens: 50,
          output_tokens: 25,
          total_tokens: 75,
        },
      },
    };
    mw.beforeNode('kwargs-shape', {});
    mw.afterNode('kwargs-shape', {}, result);

    const trace = inspector.getTraces().find((t) => t.name === 'kwargs-shape');
    expect(trace).toBeDefined();
    expect(trace!.tokens.totalTokens).toBe(75);

    mw.close();
    inspector.close();
  });

  it('extracts tokens from additional_kwargs.usage_metadata', () => {
    const mw = new AgentTraceMiddleware({ dbPath, silent: true });
    const inspector = new AgentTrace({ dbPath, silent: true });

    const result = {
      additional_kwargs: {
        usage_metadata: {
          input_tokens: 30,
          output_tokens: 15,
          total_tokens: 45,
        },
      },
    };
    mw.beforeNode('addl-kwargs', {});
    mw.afterNode('addl-kwargs', {}, result);

    const trace = inspector.getTraces().find((t) => t.name === 'addl-kwargs');
    expect(trace).toBeDefined();
    expect(trace!.tokens.totalTokens).toBe(45);

    mw.close();
    inspector.close();
  });
});
