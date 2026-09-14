/**
 * AgentTrace Dashboard
 * Local web UI + REST API for viewing agent traces
 */
import express, { Request, Response, Express, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { AgentTrace, DashboardConfig, ExportFormat, AgentUsageRecord } from '@agenttrace-io/sdk';

export const VERSION = '0.2.0';
export const PACKAGE_NAME = '@agenttrace-io/dashboard';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Public assets are sibling to dist/ in the published package
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---- API Key authentication ----

export interface ApiKeyRecord {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  createdAt: number;
}

/** In-memory key store. Key = SHA-256 hash, Value = record. */
export const apiKeyStore = new Map<string, ApiKeyRecord>();

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Generate a random API key string. */
function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a new API key. Returns { record, plaintextKey }.
 * The plaintext key is shown once; only the hash is stored.
 */
export function createApiKey(name: string): { record: ApiKeyRecord; plaintextKey: string } {
  const plaintextKey = generateApiKey();
  const hash = sha256(plaintextKey);
  const id = crypto.randomBytes(8).toString('hex');
  const prefix = plaintextKey.slice(0, 8);
  const record: ApiKeyRecord = {
    id,
    name,
    hash,
    prefix,
    createdAt: Date.now(),
  };
  apiKeyStore.set(hash, record);
  return { record, plaintextKey };
}

/** Validate a presented key. Returns the record if valid. */
function validateApiKey(key: string | undefined): ApiKeyRecord | null {
  if (!key) return null;
  const hash = sha256(key);
  return apiKeyStore.get(hash) || null;
}

/**
 * Authentication middleware.
 * Checks the X-API-Key header on API routes.
 * Allows /api/health without authentication.
 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Allow health check without auth
  if (req.path === '/api/health') {
    next();
    return;
  }

  // Only protect /api/* routes
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  // Allow localhost requests without API key (local development)
  // But if an API key IS provided, always validate it (even on localhost)
  const key = req.headers['x-api-key'] as string | undefined;
  if (!key) {
    const origin = req.headers.origin || '';
    const isLocalhost =
      !origin ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      origin.startsWith('https://localhost:') ||
      origin.startsWith('https://127.0.0.1:');
    if (isLocalhost) {
      next();
      return;
    }
  }

  const record = validateApiKey(key);
  if (!record) {
    res.status(401).json({ error: 'Invalid or missing API key', code: 'UNAUTHORIZED' });
    return;
  }

  next();
}

// ---- Health check helpers (internal) ----

function getDiskSpace(dbPath: string): { freeBytes: number; totalBytes: number } {
  let checkPath = process.cwd();
  if (dbPath && dbPath !== ':memory:') {
    try {
      const dir = path.dirname(dbPath);
      checkPath = dir || checkPath;
    } catch {
      /* ignore */
    }
  }
  try {
    const stats = fs.statfsSync(checkPath);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail ?? stats.bfree) * Number(stats.bsize);
    return { freeBytes: Math.max(0, freeBytes), totalBytes: Math.max(0, totalBytes) };
  } catch {
    return { freeBytes: 0, totalBytes: 0 };
  }
}

function getMemoryUsage(): { usedBytes: number; totalBytes: number } {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return { usedBytes, totalBytes };
}

function resourceStatus(usedBytes: number, totalBytes: number): 'ok' | 'warning' | 'critical' {
  if (!totalBytes || totalBytes <= 0) return 'ok';
  const usedPct = usedBytes / totalBytes;
  if (usedPct >= 0.9) return 'critical';
  if (usedPct >= 0.8) return 'warning';
  return 'ok';
}

export interface DashboardApp {
  app: Express;
  trace: AgentTrace;
  close: () => void;
}

/**
 * Create an Express app with the AgentTrace dashboard API + static frontend.
 * Does not start the listener (useful for testing).
 */
export function createDashboardApp(dbPath?: string): DashboardApp {
  const app = express();
  const effectiveDbPath = dbPath || './agenttrace.db';
  const trace = new AgentTrace({
    dbPath: effectiveDbPath,
    silent: true,
  });

  const startTime = Date.now();

  // Parse JSON bodies
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Only allow same-origin or localhost origins (never reflect arbitrary Origin)
    const allowed =
      !origin ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      origin.startsWith('https://localhost:') ||
      origin.startsWith('https://127.0.0.1:');
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin || 'http://localhost:3000');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Serve the static frontend without auth (assets, index.html)
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

  // ---------- API Key Management Routes (before auth middleware) ----------

  app.get('/api/v1/keys', (_req: Request, res: Response) => {
    const keys = Array.from(apiKeyStore.values()).map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      createdAt: r.createdAt,
    }));
    res.json({ keys });
  });

  app.post('/api/v1/keys', (req: Request, res: Response) => {
    const name = req.body?.name ? String(req.body.name) : 'default';
    const { record, plaintextKey } = createApiKey(name);
    res.status(201).json({
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      key: plaintextKey,
      createdAt: record.createdAt,
    });
  });

  app.delete('/api/v1/keys/:id', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    let found = false;
    for (const [hash, record] of apiKeyStore) {
      if (record.id === id) {
        apiKeyStore.delete(hash);
        found = true;
        break;
      }
    }
    if (!found) {
      res.status(404).json({ error: 'Key not found', code: 'NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // Authentication middleware — protects /api/* only, skips /api/health
  app.use(authMiddleware);

  // ---------- API Routes ----------

  app.get('/api/stats', (_req: Request, res: Response) => {
    try {
      const stats = trace.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/costs', (req: Request, res: Response) => {
    try {
      const runId = (req.query['run-id'] || req.query.runId || req.query['runId']) as
        | string
        | undefined;
      const breakdown = trace.getCostBreakdown({ runId: runId ? String(runId) : undefined });
      res.json(breakdown);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/runs', (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 200;
      const allRuns = trace.getRuns(Math.max(1, Math.min(1000, limit || 200)));

      const status = req.query.status as string | undefined;
      const runs = status
        ? (() => {
            const allowed = status.split(',').filter(Boolean);
            return allowed.length ? allRuns.filter((r) => allowed.includes(r.status)) : allRuns;
          })()
        : allRuns;

      res.json(runs);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/runs/:id', (req: Request, res: Response) => {
    try {
      const run = trace.getRun(String(req.params.id || ''));
      if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.json(run);
      return;
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }
  });

  app.get('/api/traces', (req: Request, res: Response) => {
    try {
      const filter: Record<string, unknown> = {};

      if (req.query.runId) {
        filter.runId = String(req.query.runId);
      }
      if (req.query.status) {
        filter.status = String(req.query.status).split(',').filter(Boolean);
      }
      if (req.query.name) {
        filter.name = String(req.query.name);
      }
      if (req.query.limit) {
        filter.limit = parseInt(String(req.query.limit), 10);
      }
      if (req.query.offset) {
        filter.offset = parseInt(String(req.query.offset), 10);
      }

      const traces = trace.getTraces(filter);
      res.json(traces);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/traces/:id', (req: Request, res: Response) => {
    try {
      const t = trace.getTrace(String(req.params.id || ''));
      if (!t) {
        res.status(404).json({ error: 'Trace not found' });
        return;
      }
      res.json(t);
      return;
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }
  });

  app.get('/api/traces/:id/tree', (req: Request, res: Response) => {
    try {
      const tree = trace.getTraceTree(String(req.params.id || ''));
      res.json(tree);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('not found') || msg.includes('Trace')) {
        res.status(404).json({ error: 'Trace not found' });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/export', (req: Request, res: Response) => {
    try {
      const format = (req.query.format === 'csv' ? 'csv' : 'json') as ExportFormat;

      // Use SDK export (traces). Could be extended to include runs.
      const data = trace.export(format);

      const mime = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';
      const filename = `agenttrace-export.${format}`;

      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- Agent Usage APIs (for /usage dashboard) ----------

  app.get('/api/usage', (req: Request, res: Response) => {
    try {
      const filter: Record<string, unknown> = {};
      if (req.query.agentName) filter.agentName = String(req.query.agentName);
      if (req.query.agentType) filter.agentType = String(req.query.agentType);
      if (req.query.action) filter.action = String(req.query.action);
      if (req.query.status) {
        const s = String(req.query.status);
        filter.status = s.includes(',') ? s.split(',').filter(Boolean) : s;
      }
      if (req.query.fromDate || req.query.from) {
        filter.fromDate = parseInt(String(req.query.fromDate || req.query.from), 10);
      }
      if (req.query.toDate || req.query.to) {
        filter.toDate = parseInt(String(req.query.toDate || req.query.to), 10);
      }
      if (req.query.limit) filter.limit = parseInt(String(req.query.limit), 10);
      if (req.query.offset) filter.offset = parseInt(String(req.query.offset), 10);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recs = trace.getAgentUsage(filter as any);
      res.json(recs);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/usage/stats', (req: Request, res: Response) => {
    try {
      const agentName = req.query.agentName ? String(req.query.agentName) : undefined;
      const fromDate = req.query.fromDate ? parseInt(String(req.query.fromDate), 10) : undefined;
      const toDate = req.query.toDate ? parseInt(String(req.query.toDate), 10) : undefined;
      const stats = trace.getUsageStats(agentName, fromDate, toDate);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/usage/active', (_req: Request, res: Response) => {
    try {
      const active = trace.getActiveAgents();
      res.json(active);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // SSE endpoint: pushes new usage events as they are recorded (via AgentTrace emitter)
  app.get('/api/usage/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if any
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // initial hello
    send('connected', { ts: Date.now() });

    const onUsage = (record: AgentUsageRecord) => {
      try {
        send('usage', record);
      } catch (_) {
        /* client gone */
      }
    };
    trace.onUsage(onUsage);

    // heartbeat to keep connection alive
    const hb = setInterval(() => {
      try {
        res.write(`: hb ${Date.now()}\n\n`);
      } catch (_) {
        clearInterval(hb);
      }
    }, 15000);

    const cleanup = () => {
      clearInterval(hb);
      trace.offUsage(onUsage);
      res.end();
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    // also timeout safety? but long lived
  });

  // Serve dedicated usage page at clean /usage URL
  app.get('/usage', (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, 'usage.html'));
  });

  // Detailed health check for Docker / orchestration (status, resource checks, DB ping)
  app.get('/api/health', (_req: Request, res: Response) => {
    const checkStart = Date.now();
    const checks: {
      database: { status: 'ok' | 'error'; responseTime: number };
      diskSpace: { status: 'ok' | 'warning' | 'critical'; freeBytes: number; totalBytes: number };
      memory: { status: 'ok' | 'warning' | 'critical'; usedBytes: number; totalBytes: number };
      activeAgents: number;
      totalTraces: number;
    } = {
      database: { status: 'error', responseTime: 0 },
      diskSpace: { status: 'ok', freeBytes: 0, totalBytes: 0 },
      memory: { status: 'ok', usedBytes: 0, totalBytes: 0 },
      activeAgents: 0,
      totalTraces: 0,
    };

    // DB connectivity test (simple query) + totalTraces + activeAgents
    try {
      const qStart = Date.now();
      // Use getStats for connectivity + totalTraces (exercises DB)
      const stats = trace.getStats();
      const dbRespTime = Date.now() - qStart;
      checks.database = { status: 'ok', responseTime: dbRespTime };
      checks.totalTraces = stats.totalTraces || 0;

      // activeAgents via COUNT(DISTINCT) on agent_usage (private storage access is internal)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = (trace as any).storage;
        const db = storage?.db;
        if (db && typeof db.prepare === 'function') {
          const ag = db.prepare('SELECT COUNT(DISTINCT agent_name) as c FROM agent_usage').get() as
            | { c?: number }
            | undefined;
          checks.activeAgents = ag?.c ?? 0;
        }
      } catch {
        checks.activeAgents = 0;
      }
    } catch {
      checks.database = { status: 'error', responseTime: Date.now() - checkStart };
      checks.totalTraces = 0;
      checks.activeAgents = 0;
    }

    // Disk space (relative to DB dir or cwd)
    try {
      const disk = getDiskSpace(effectiveDbPath);
      const dstatus = resourceStatus(disk.totalBytes - disk.freeBytes, disk.totalBytes);
      checks.diskSpace = {
        status: dstatus,
        freeBytes: disk.freeBytes,
        totalBytes: disk.totalBytes,
      };
    } catch {
      checks.diskSpace = { status: 'ok', freeBytes: 0, totalBytes: 0 };
    }

    // Memory (system, reflects container limits when cgrouped)
    try {
      const mem = getMemoryUsage();
      const mstatus = resourceStatus(mem.usedBytes, mem.totalBytes);
      checks.memory = { status: mstatus, usedBytes: mem.usedBytes, totalBytes: mem.totalBytes };
    } catch {
      checks.memory = { status: 'ok', usedBytes: 0, totalBytes: 0 };
    }

    // Derive overall status
    const critical =
      checks.database.status === 'error' ||
      checks.diskSpace.status === 'critical' ||
      checks.memory.status === 'critical';
    const warning = checks.diskSpace.status === 'warning' || checks.memory.status === 'warning';

    const overall: 'healthy' | 'degraded' | 'unhealthy' = critical
      ? 'unhealthy'
      : warning
        ? 'degraded'
        : 'healthy';

    const uptime = Date.now() - startTime;
    const timestamp = new Date().toISOString();

    const payload = {
      status: overall,
      version: VERSION,
      uptime,
      checks,
      timestamp,
    };

    const httpCode = overall === 'unhealthy' ? 503 : 200;
    res.status(httpCode).json(payload);
  });

  // Fallback: serve index.html for unknown GET paths (SPA-friendly client routing).
  // Placed after static + API routes. Only serves HTML for non-API, non-asset paths.
  app.use((req: Request, res: Response, _next?: unknown) => {
    if (req.method === 'GET' && !req.path.includes('.') && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    }
    // Let other cases 404 naturally
    if (!res.headersSent) {
      res.status(404).send('Not found');
    }
  });

  const close = () => {
    trace.close();
  };

  return { app, trace, close };
}

/**
 * Start the dashboard HTTP server and return the listening server instance.
 */
export function startDashboard(config: DashboardConfig = {}) {
  const { port = 4317, host = '127.0.0.1', dbPath } = config;

  const { app, close } = createDashboardApp(dbPath);

  const server = app.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`[agenttrace] Dashboard running at ${url}`);
    console.log(`[agenttrace] Open in browser: ${url}`);
    console.log(`[agenttrace] Press Ctrl+C to stop`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[agenttrace] Shutting down dashboard...');
    server.close(() => {
      close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

export default startDashboard;
