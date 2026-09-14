/**
 * AgentTrace + Express.js Example
 *
 * Demonstrates:
 *   - Traced request handlers (every route auto-traced)
 *   - Express middleware that traces all incoming requests
 *   - Error tracking (sync throws, async rejections, next(err))
 *   - Cost-aware AI proxy route with token tracking
 *   - Run grouping per request lifecycle
 *
 * Run:
 *   cd examples/nodejs-express
 *   npm install
 *   npm run build
 *   npm start
 */

import express from 'express';
import { AgentTrace, init, alert } from '@agenttrace-io/sdk';
import type { Request, Response, NextFunction } from 'express';
import type { AgentUsageRecord } from '@agenttrace-io/sdk';

// ─── 1. Initialize AgentTrace ───────────────────────────────────────
const at = init({
  dbPath: './agenttrace-express.db',
  silent: false, // log trace events to stdout
  maxTraces: 50000, // keep plenty for a demo
  retentionDays: 30, // auto-cleanup after 30 days
});

// Register a runaway-cost alert (triggers if lifetime spend > $5)
at.registerAlert(
  alert({
    name: 'express-cost-guard',
    condition: (stats) => (stats.totalCostUsd || 0) > 5,
    webhook: undefined, // set to your Slack/Discord webhook URL
    cooldown: 300, // re-alert at most every 5 min
  }),
);

// ─── 2. Express middleware: trace every request ─────────────────────
function agentTraceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const runId = at.startRun(`${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    userAgent: req.get('user-agent') || 'unknown',
  });

  // Attach runId so handlers can enrich the run
  (req as any).traceRunId = runId;

  // When the response finishes, complete the run
  res.on('finish', () => {
    const latency = Date.now() - (res as any).startTime;
    at.recordAgentUsage({
      agentName: 'express-server',
      agentType: 'http-handler',
      sessionId: runId,
      action: `${req.method} ${req.path}`,
      target: req.path,
      tokensUsed: 0,
      costUsd: 0,
      durationMs: latency,
      status: res.statusCode < 400 ? 'success' : 'failure',
      metadata: { statusCode: res.statusCode },
    });
    at.completeRun(res.statusCode < 500 ? 'success' : 'error');
  });

  // Mark start time for latency calc
  (res as any).startTime = Date.now();
  next();
}

// ─── 3. Error tracking middleware ───────────────────────────────────
function errorTracingMiddleware(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Record the error as a failed trace
  at.recordAgentUsage({
    agentName: 'express-server',
    agentType: 'error-handler',
    sessionId: (req as any).traceRunId || 'unknown',
    action: 'unhandled-error',
    target: req.path,
    tokensUsed: 0,
    costUsd: 0,
    durationMs: 0,
    status: 'failure',
    metadata: {
      errorMessage: err.message,
      errorStack: err.stack?.slice(0, 500), // truncate stack
      method: req.method,
    },
  });

  console.error(`[AgentTrace] Unhandled error on ${req.method} ${req.path}:`, err.message);

  res.status(500).json({
    error: 'Internal server error',
    traceRunId: (req as any).traceRunId || undefined,
  });
}

// ─── 4. Create the Express app ──────────────────────────────────────
const app = express();
app.use(express.json());

// Apply tracing middleware globally
app.use(agentTraceMiddleware);

// ─── 5. Traced routes ──────────────────────────────────────────────

// Health check (lightweight, no AI)
app.get('/health', (_req: Request, res: Response) => {
  const health = at.getHealth();
  res.json({ status: 'ok', trace: health });
});

// Get trace stats
app.get('/stats', async (_req: Request, res: Response) => {
  const stats = at.getStats();
  const costBreakdown = at.getCostBreakdown();
  res.json({ stats, costBreakdown });
});

// Get usage stats for the express-server agent
app.get('/usage', (_req: Request, res: Response) => {
  const usageStats = at.getUsageStats('express-server');
  const actions = at.getAgentUsage({ agentName: 'express-server' });
  res.json({ usageStats, recentActions: actions.slice(-20) });
});

// Traced AI completion endpoint — simulates calling an LLM
app.post('/api/chat', async (req: Request, res: Response, next: NextFunction) => {
  const { message, model = 'gpt-4o-mini' } = req.body as { message?: string; model?: string };

  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    const result = await at.trace(
      'llm-chat-completion',
      async () => {
        // Simulate an LLM call (replace with real OpenAI/Anthropic call)
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
        return {
          reply: `Echo: ${message}`,
          model,
          simulated: true,
        };
      },
      {
        input: { message, model },
        model,
        provider: 'openai',
        tokens: {
          promptTokens: message.length + 20,
          completionTokens: 40 + Math.floor(Math.random() * 60),
          totalTokens: message.length + 60 + Math.floor(Math.random() * 60),
          model,
        },
        metadata: { endpoint: '/api/chat', runId: (req as any).traceRunId },
      },
    );

    res.json(result);
  } catch (err) {
    next(err); // error middleware will track it
  }
});

// Traced tool-use endpoint — simulates an agent calling tools
app.post('/api/agent/run', async (req: Request, res: Response, next: NextFunction) => {
  const { task, tools = ['web_search', 'code_interpreter'] } = req.body as {
    task?: string;
    tools?: string[];
  };

  if (!task) {
    res.status(400).json({ error: 'task is required' });
    return;
  }

  try {
    // Trace the full agent run as one unit
    const result = await at.trace(
      'agent-run',
      async () => {
        // Step 1: Plan
        const plan = await at.trace(
          'agent-plan',
          async () => {
            await new Promise((r) => setTimeout(r, 30));
            return { steps: tools.map((t, i) => `Step ${i + 1}: use ${t}`) };
          },
          {
            input: { task, tools },
            model: 'claude-sonnet-4',
            tokens: {
              promptTokens: 200,
              completionTokens: 80,
              totalTokens: 280,
              model: 'claude-sonnet-4',
            },
          },
        );

        // Step 2: Execute tools
        const toolResults = [];
        for (const tool of tools) {
          const toolResult = await at.trace(
            `tool-${tool}`,
            async () => {
              await new Promise((r) => setTimeout(r, 20 + Math.random() * 50));
              return { tool, output: `Result from ${tool} for: ${task}`, success: true };
            },
            {
              input: { tool, task },
              metadata: { toolName: tool },
            },
          );
          toolResults.push(toolResult);
          at.recordToolCall({
            name: tool,
            input: { task },
            output: toolResult,
            latencyMs: 50,
            success: true,
          });
        }

        // Step 3: Synthesize
        const answer = await at.trace(
          'agent-synthesize',
          async () => {
            await new Promise((r) => setTimeout(r, 40));
            return `Completed task "${task}" using ${tools.length} tools. Plan: ${plan.steps.join('; ')}`;
          },
          {
            input: { toolResults: toolResults.length },
            model: 'claude-sonnet-4',
            tokens: {
              promptTokens: 150,
              completionTokens: 60,
              totalTokens: 210,
              model: 'claude-sonnet-4',
            },
          },
        );

        return { task, plan, toolResults, answer };
      },
      {
        input: { task, tools },
        model: 'claude-sonnet-4',
        metadata: { endpoint: '/api/agent/run' },
      },
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Traced batch evaluation endpoint
app.post('/api/evaluate', async (req: Request, res: Response, next: NextFunction) => {
  const { traceIds } = req.body as { traceIds?: string[] };

  try {
    const scorerResults = await at.evaluate({
      traceIds,
      scorers: [
        {
          name: 'latency-score',
          fn: (t) => Math.max(0, 100 - (t.latencyMs || 0) / 10),
        },
        {
          name: 'cost-efficiency',
          fn: (t) => {
            const cost = t.costUsd || 0;
            return cost === 0 ? 100 : Math.max(0, 100 - cost * 10000);
          },
        },
      ],
    });

    res.json({ evaluations: scorerResults });
  } catch (err) {
    next(err);
  }
});

// Export traces endpoint
app.get('/api/export/:format', (req: Request, res: Response) => {
  const format = req.params.format as 'json' | 'csv' | 'otel';
  if (!['json', 'csv', 'otel'].includes(format)) {
    res.status(400).json({ error: 'format must be json, csv, or otel' });
    return;
  }
  const data = at.export(format);
  const contentType = format === 'csv' ? 'text/csv' : 'application/json';
  res.type(contentType).send(data);
});

// ─── 6. Error middleware (must be last) ─────────────────────────────
app.use(errorTracingMiddleware);

// ─── 7. Start server ────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);

const server = app.listen(PORT, () => {
  console.log(`[AgentTrace Express] Listening on http://localhost:${PORT}`);
  console.log(
    `[AgentTrace Express] DB: ${(at as any).config?.dbPath || './agenttrace-express.db'}`,
  );
  console.log();
  console.log('Routes:');
  console.log(`  GET  /health            - Health + AgentTrace status`);
  console.log(`  GET  /stats             - Trace stats + cost breakdown`);
  console.log(`  GET  /usage             - Agent usage stats`);
  console.log(`  POST /api/chat          - Traced LLM completion`);
  console.log(`  POST /api/agent/run     - Traced multi-tool agent run`);
  console.log(`  POST /api/evaluate      - Score traces`);
  console.log(`  GET  /api/export/:fmt   - Export (json|csv|otel)`);
});

// Graceful shutdown
function shutdown() {
  console.log('\n[AgentTrace Express] Shutting down...');

  // Print final stats
  const stats = at.getStats();
  console.log(
    `[AgentTrace] Final stats: ${stats.totalTraces} traces, $${(stats.totalCostUsd || 0).toFixed(6)} total cost, ${stats.successRate} success rate`,
  );

  at.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
