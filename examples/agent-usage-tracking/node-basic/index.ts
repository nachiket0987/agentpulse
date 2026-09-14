/**
 * AgentTrace Node Basic Example
 * Shows an AI agent using @agenttrace-io/sdk to trace its own workflow,
 * track costs across models, record high-level actions, set alerts,
 * and self-query usage stats.
 *
 * Run:
 *   cd examples/agent-usage-tracking/node-basic
 *   npm install
 *   npm start
 *
 * Or from repo root (uses workspace link):
 *   npx tsx examples/agent-usage-tracking/node-basic/index.ts
 */

import { init, trace, alert, type AgentUsageRecord } from '@agenttrace-io/sdk';

async function main() {
  // 1. Initialize (respects AGENTTRACE_DB_PATH if set)
  const at = init({ dbPath: './agenttrace.db', silent: false });

  console.log('=== AgentTrace Node Basic Example ===');
  console.log('DB:', (at as any).config?.dbPath || './agenttrace.db');

  // Optional: group everything under a named run
  const runId = at.startRun('agent-self-demo', {
    agentName: 'demo-agent',
    purpose: 'install-guide',
  });

  // 2. Trace a simple nested workflow (simulated research + synthesize)
  try {
    const facts = await trace(
      'research',
      async () => {
        // Pretend we called an LLM or tool
        await new Promise((r) => setTimeout(r, 30));
        return ['fact1: X is growing', 'fact2: Y enables Z'];
      },
      {
        input: { query: 'latest in agent observability' },
        model: 'gpt-4o-mini',
        tokens: { promptTokens: 180, completionTokens: 95, totalTokens: 275 },
      },
    );

    const answer = await trace(
      'synthesize',
      async () => {
        await new Promise((r) => setTimeout(r, 25));
        return 'Summary: Observability is critical for cost control and debugging.';
      },
      {
        input: { factsCount: facts.length },
        model: 'claude-sonnet-4',
        tokens: { promptTokens: 320, completionTokens: 110, totalTokens: 430 },
      },
    );

    console.log('Workflow result:', answer);

    // 3. Record high-level agent actions (beyond raw LLM traces)
    const usageRecords: Omit<AgentUsageRecord, 'id' | 'createdAt'>[] = [
      {
        agentName: 'demo-agent',
        agentType: 'researcher',
        sessionId: runId,
        action: 'web_research',
        target: 'agent observability',
        tokensUsed: 275,
        costUsd: 0.0007,
        durationMs: 45,
        status: 'success',
        metadata: { sources: 2 },
      },
      {
        agentName: 'demo-agent',
        agentType: 'researcher',
        sessionId: runId,
        action: 'synthesize',
        target: 'final-answer',
        tokensUsed: 430,
        costUsd: 0.0061,
        durationMs: 30,
        status: 'success',
        metadata: { model: 'claude-sonnet-4' },
      },
    ];

    for (const rec of usageRecords) {
      at.recordAgentUsage(rec);
    }

    // 4. Set up an alert for runaway costs (fires on next trace if condition met)
    at.registerAlert(
      alert({
        name: 'demo-runaway-cost',
        condition: (stats) => (stats.totalCostUsd || 0) > 10,
        webhook: undefined, // in real use: 'https://hooks.example.com/agent-costs'
        cooldown: 300,
      }),
    );

    // Force an alert check (normally auto after trace)
    await at.checkAlerts();

    // 5. Self-query usage stats (agent introspecting itself)
    const traceStats = at.getStats();
    console.log('\n--- Trace Stats ---');
    console.log('Total traces:', traceStats.totalTraces);
    console.log('Total cost USD:', traceStats.totalCostUsd?.toFixed(6));
    console.log('Success rate:', traceStats.successRate);

    const usageStats = at.getUsageStats();
    console.log('\n--- Agent Usage Stats (self-reported actions) ---');
    console.log('Total actions logged:', usageStats.totalActions);
    console.log('Total agents seen:', usageStats.totalAgents);
    console.log('Actions by type:', usageStats.actionsByType);
    console.log('Top agents:', usageStats.topAgents);

    const myActions = at.getAgentUsage({ agentName: 'demo-agent' });
    console.log('\n--- My actions (filtered) ---');
    console.log('Count:', myActions.length);
    if (myActions.length > 0) {
      console.log('First action:', myActions[0].action, 'cost:', myActions[0].costUsd);
    }

    const costBreakdown = at.getCostBreakdown(runId);
    console.log('\n--- Cost Breakdown for this run ---');
    console.log('Total:', costBreakdown.totalCostUsd.toFixed(6));
    console.log('By model:', costBreakdown.costByModel);

    at.completeRun('success');
  } catch (err) {
    console.error('Workflow error:', err);
    at.completeRun('error');
  } finally {
    // Cleanup
    at.close();
    console.log('\n=== Done. DB written to agenttrace.db ===');
    console.log('Inspect with: npx agenttrace stats --db ./agenttrace.db');
    console.log('Dashboard: npx agenttrace dashboard --db ./agenttrace.db');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
