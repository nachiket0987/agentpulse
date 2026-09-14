/**
 * AgentTrace Self-Tracker
 * Thin wrapper for AI agents to automatically track their own operations
 * via AgentTrace storage + JSONL log for external consumption.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { TraceStorage } from './storage.js';
import type { Run, Trace } from './types.js';

export interface SelfTrackerConfig {
  agentName: string;
  agentType: string;
  dbPath?: string;
}

export class SelfTracker {
  private agentName: string;
  private agentType: string;
  private storage: TraceStorage;
  private dbPath: string;
  private logPath: string;
  private currentSessionId: string | null = null;
  private sessionStartTime: number = 0;

  constructor(config: SelfTrackerConfig) {
    this.agentName = config.agentName;
    this.agentType = config.agentType;
    this.dbPath = config.dbPath || process.env.AGENTTRACE_DB_PATH || './agenttrace.db';
    this.storage = new TraceStorage(this.dbPath);
    // Allow override via env for deployment flexibility
    const envLog = process.env.AGENTTRACE_USAGE_LOG;
    this.logPath = envLog || path.join(os.homedir(), '.config', 'agenttrace', 'usage.jsonl');
  }

  private ensureLogDir(): void {
    const dir = path.dirname(this.logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private appendLog(entry: Record<string, unknown>): void {
    this.ensureLogDir();
    appendFileSync(
      this.logPath,
      JSON.stringify({ ...entry, timestamp: entry.timestamp || Date.now() }) + '\n',
      'utf8',
    );
  }

  private ensureSession(): string {
    if (!this.currentSessionId) {
      this.startSession();
    }
    return this.currentSessionId!;
  }

  startSession(): string {
    const sessionId = randomUUID();
    const startedAt = Date.now();
    this.storage.createRun({
      id: sessionId,
      name: `${this.agentName}-self-session`,
      startedAt,
      metadata: {
        agentName: this.agentName,
        agentType: this.agentType,
        selfTracked: true,
        kind: 'self-session',
      },
    });
    this.currentSessionId = sessionId;
    this.sessionStartTime = startedAt;
    this.appendLog({
      timestamp: startedAt,
      agentName: this.agentName,
      agentType: this.agentType,
      sessionId,
      type: 'session_start',
    });
    return sessionId;
  }

  trackAction(action: string, target: string, metadata: Record<string, unknown> = {}): void {
    const sessionId = this.ensureSession();
    const now = Date.now();
    const trace: Omit<Trace, 'createdAt' | 'updatedAt'> = {
      id: randomUUID(),
      runId: sessionId,
      name: `self:action:${action}`,
      status: 'success',
      input: { target },
      output: null,
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      toolCalls: [],
      latencyMs: 0,
      costUsd: 0,
      error: undefined,
      metadata: {
        selfTracked: true,
        agentName: this.agentName,
        agentType: this.agentType,
        actionType: 'action',
        action,
        target,
        ...metadata,
      },
      parentId: undefined,
    };
    this.storage.createTrace(trace);
    this.appendLog({
      timestamp: now,
      agentName: this.agentName,
      agentType: this.agentType,
      sessionId,
      type: 'action',
      action,
      target,
      metadata,
    });
  }

  trackDelegation(targetAgent: string, task: string): void {
    const sessionId = this.ensureSession();
    const now = Date.now();
    const trace: Omit<Trace, 'createdAt' | 'updatedAt'> = {
      id: randomUUID(),
      runId: sessionId,
      name: 'self:delegation',
      status: 'success',
      input: { task },
      output: null,
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      toolCalls: [],
      latencyMs: 0,
      costUsd: 0,
      error: undefined,
      metadata: {
        selfTracked: true,
        agentName: this.agentName,
        agentType: this.agentType,
        actionType: 'delegation',
        targetAgent,
        task,
      },
      parentId: undefined,
    };
    this.storage.createTrace(trace);
    this.appendLog({
      timestamp: now,
      agentName: this.agentName,
      agentType: this.agentType,
      sessionId,
      type: 'delegation',
      target: targetAgent,
      task,
    });
  }

  trackResearch(query: string, results: number): void {
    const sessionId = this.ensureSession();
    const now = Date.now();
    const trace: Omit<Trace, 'createdAt' | 'updatedAt'> = {
      id: randomUUID(),
      runId: sessionId,
      name: 'self:research',
      status: 'success',
      input: { query },
      output: { results },
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      toolCalls: [],
      latencyMs: 0,
      costUsd: 0,
      error: undefined,
      metadata: {
        selfTracked: true,
        agentName: this.agentName,
        agentType: this.agentType,
        actionType: 'research',
        query,
        results,
      },
      parentId: undefined,
    };
    this.storage.createTrace(trace);
    this.appendLog({
      timestamp: now,
      agentName: this.agentName,
      agentType: this.agentType,
      sessionId,
      type: 'research',
      query,
      results,
    });
  }

  trackImplementation(files: string[], linesOfCode: number): void {
    const sessionId = this.ensureSession();
    const now = Date.now();
    const trace: Omit<Trace, 'createdAt' | 'updatedAt'> = {
      id: randomUUID(),
      runId: sessionId,
      name: 'self:implementation',
      status: 'success',
      input: { files },
      output: { linesOfCode },
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      toolCalls: [],
      latencyMs: 0,
      costUsd: 0,
      error: undefined,
      metadata: {
        selfTracked: true,
        agentName: this.agentName,
        agentType: this.agentType,
        actionType: 'implementation',
        files,
        linesOfCode,
      },
      parentId: undefined,
    };
    this.storage.createTrace(trace);
    this.appendLog({
      timestamp: now,
      agentName: this.agentName,
      agentType: this.agentType,
      sessionId,
      type: 'implementation',
      files,
      linesOfCode,
    });
  }

  trackReview(prNumber: string, status: string): void {
    const sessionId = this.ensureSession();
    const now = Date.now();
    const trace: Omit<Trace, 'createdAt' | 'updatedAt'> = {
      id: randomUUID(),
      runId: sessionId,
      name: 'self:review',
      status: 'success',
      input: { prNumber },
      output: { status },
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      toolCalls: [],
      latencyMs: 0,
      costUsd: 0,
      error: undefined,
      metadata: {
        selfTracked: true,
        agentName: this.agentName,
        agentType: this.agentType,
        actionType: 'review',
        prNumber,
        status,
      },
      parentId: undefined,
    };
    this.storage.createTrace(trace);
    this.appendLog({
      timestamp: now,
      agentName: this.agentName,
      agentType: this.agentType,
      sessionId,
      type: 'review',
      prNumber,
      status,
    });
  }

  endSession(): void {
    if (this.currentSessionId) {
      const now = Date.now();
      this.storage.completeRun(this.currentSessionId, 'success');
      this.appendLog({
        timestamp: now,
        agentName: this.agentName,
        agentType: this.agentType,
        sessionId: this.currentSessionId,
        type: 'session_end',
      });
      this.currentSessionId = null;
      this.sessionStartTime = 0;
    }
  }

  getSessionStats(): {
    sessionId: string;
    actions: number;
    duration: number;
    tokens: number;
    cost: number;
  } {
    if (!this.currentSessionId) {
      return { sessionId: '', actions: 0, duration: 0, tokens: 0, cost: 0 };
    }
    const run: Run | null = this.storage.getRun(this.currentSessionId);
    const traces: Trace[] = this.storage.getTraces({ runId: this.currentSessionId });
    const duration = Date.now() - (this.sessionStartTime || (run?.startedAt ?? Date.now()));
    return {
      sessionId: this.currentSessionId,
      actions: traces.length,
      duration: Math.max(0, Math.floor(duration / 1000)), // seconds
      tokens: run?.totalTokens?.totalTokens ?? 0,
      cost: run?.totalCostUsd ?? 0,
    };
  }

  /**
   * Close underlying storage (for cleanup in tests / long running)
   */
  close(): void {
    this.storage.close();
  }
}
