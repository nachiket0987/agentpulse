#!/usr/bin/env node

/**
 * AgentTrace CLI
 * Command-line interface for querying traces, runs, stats and exports
 */

import {
  AgentTrace,
  type Run,
  type Trace,
  type TraceStats,
  type CostBreakdown,
  type TraceTreeNode,
  type AgentUsageRecord,
  type AgentWho,
  type AgentSession,
  type AgentUsageFilter,
  type WebhookConfig,
  AlertCondition,
  ExportFormat,
  TraceStorage,
} from '@agenttrace-io/sdk';
import { startDashboard } from '@agenttrace-io/dashboard';
import {
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  realpathSync,
  openSync,
  writeSync,
  unlinkSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Agent framework signatures for auto-detection
const AGENT_SIGNATURES: Record<string, { framework: string; patterns: string[] }> = {
  langchain: {
    framework: 'LangChain',
    patterns: ['langchain', '@langchain', 'langchainjs', 'ChatOpenAI', 'ChatAnthropic'],
  },
  crewai: { framework: 'CrewAI', patterns: ['crewai', 'CrewAI', 'Crew('] },
  autogen: {
    framework: 'AutoGen',
    patterns: ['autogen', 'AutoGen', 'ConversableAgent', 'AssistantAgent'],
  },
  openai: { framework: 'OpenAI SDK', patterns: ['openai', 'OpenAI', 'from_openai', 'AzureOpenAI'] },
  anthropic: { framework: 'Anthropic SDK', patterns: ['anthropic', 'Anthropic'] },
  llamaindex: { framework: 'LlamaIndex', patterns: ['llamaindex', 'llama-index', 'LlamaIndex'] },
  dspy: { framework: 'DSPy', patterns: ['dspy', 'DSPy'] },
  agno: { framework: 'Agno', patterns: ['agno', 'Agent('] },
  semanticKernel: { framework: 'Semantic Kernel', patterns: ['semantic-kernel', 'SemanticKernel'] },
  hermes: { framework: 'Hermes', patterns: ['hermes', 'hermes-agent', 'hermes_cli'] },
  openInterpreter: { framework: 'Open Interpreter', patterns: ['open-interpreter', 'interpreter'] },
  aider: { framework: 'Aider', patterns: ['aider'] },
  cursor: { framework: 'Cursor', patterns: ['cursor-agent'] },
  windsurf: { framework: 'Windsurf', patterns: ['windsurf'] },
  codex: { framework: 'Codex', patterns: ['codex', 'openai-codex'] },
  claude: { framework: 'Claude Code', patterns: ['claude-code', 'claude_code'] },
};

// Known AI agent process names (image names from tasklist / process list)
const AGENT_PROCESS_NAMES = new Set([
  'hermes',
  'hermes.exe',
  'hermes-agent',
  'hermes-agent.exe',
  'aider',
  'aider.exe',
  'cursor-agent',
  'cursor-agent.exe',
  'open-interpreter',
  'interpreter',
  'claude-code',
  'claude',
  'codex',
  'openai-codex',
  'windsurf',
  'agent.exe',
  'ai-agent.exe',
  'langchain',
  'crewai',
  'autogen',
]);

function detectAgents(
  processList: string,
  platform: string,
): Array<{
  pid: string;
  name: string;
  cmdline: string;
  runtime: string;
  platform: string;
  framework: string;
}> {
  const agents: Array<{
    pid: string;
    name: string;
    cmdline: string;
    runtime: string;
    platform: string;
    framework: string;
  }> = [];
  if (!processList) return agents;
  const lines = processList.split('\n').filter((l) => l.trim());
  for (const line of lines) {
    const lower = line.toLowerCase();
    let runtime = 'unknown';
    if (lower.includes('node ') || lower.includes('node.exe')) runtime = 'node';
    else if (lower.includes('python') || lower.includes('python3') || lower.includes('python.exe'))
      runtime = 'python';
    else if (lower.includes('java ') || lower.includes('java.exe')) runtime = 'java';
    else if (lower.includes('dotnet ') || lower.includes('dotnet.exe')) runtime = 'dotnet';
    if (runtime === 'unknown') continue;

    // Extract command/script name for matching (avoid false positives from paths)
    let cmdName = '';
    if (runtime === 'node') {
      const m = line.match(/node(?:\.exe)?\s+(.+?)(?:\s|$)/);
      if (m?.[1]) cmdName = (m[1].split(/[/\\]/).pop() || '').toLowerCase();
    } else if (runtime === 'python') {
      // Handle -m module pattern first
      const mM = line.match(/python(?:3)?(?:\.exe)?\s+-m\s+(\S+)/);
      if (mM?.[1]) cmdName = mM[1].toLowerCase();
      else {
        const m = line.match(/python(?:3)?(?:\.exe)?\s+(.+?)(?:\s|$)/);
        if (m?.[1]) cmdName = (m[1].split(/[/\\]/).pop() || '').toLowerCase();
      }
    }
    const matchTarget = cmdName || lower; // fallback to full line if no cmd extracted

    let detectedFramework = '';
    for (const [, sig] of Object.entries(AGENT_SIGNATURES)) {
      if (sig.patterns.some((p) => matchTarget.includes(p.toLowerCase()))) {
        detectedFramework = sig.framework;
        break;
      }
    }
    if (!detectedFramework) {
      const first = line.split(/[,\s]/)[0];
      const procName = first ? first.replace(/"/g, '').toLowerCase() : '';
      const isAgentLike =
        lower.includes('agent') ||
        lower.includes('llm') ||
        lower.includes('gpt') ||
        lower.includes('claude') ||
        lower.includes('chat') ||
        lower.includes('ai-agent') ||
        lower.includes('openai') ||
        lower.includes('anthropic') ||
        AGENT_PROCESS_NAMES.has(procName);
      if (isAgentLike) detectedFramework = 'Unknown Agent';
    }
    if (!detectedFramework) continue;
    const parts = line
      .trim()
      .split(/[,\s]+/)
      .filter(Boolean);
    const pid =
      process.platform === 'win32' ? (parts[1] || '0').replace(/"/g, '') : parts[1] || '0';
    let name = 'unknown';
    if (runtime === 'node') {
      const m = line.match(/node(?:\.exe)?\s+(.+?)(?:\s|$)/);
      if (m?.[1]) name = m[1].split(/[/\\]/).pop() || m[1];
    } else if (runtime === 'python') {
      // Handle -m module pattern first
      const mM = line.match(/python(?:3)?(?:\.exe)?\s+-m\s+(\S+)/);
      if (mM?.[1]) name = mM[1].replace(/\.[^.]+$/, '');
      else {
        const m = line.match(/python(?:3)?(?:\.exe)?\s+(.+?)(?:\s|$)/);
        if (m?.[1]) name = m[1].split(/[/\\]/).pop() || m[1];
      }
    }
    agents.push({
      pid,
      name,
      cmdline: line.trim().substring(0, 200),
      runtime,
      platform,
      framework: detectedFramework,
    });
  }
  return agents;
}

// When invoking Windows executables (cmd.exe, tasklist) from inside WSL, the
// child inherits a `\\wsl.localhost\...` UNC working directory that Windows
// cannot use, so it prints a noisy "UNC paths are not supported" warning to
// stderr before defaulting to the Windows directory. Pin the cwd to a
// Windows-native path so the warning never appears. `/mnt/c` maps to `C:\`
// under the default WSL drvfs mount; fall back to omitting cwd if it's absent.
const WIN_EXEC_CWD = existsSync('/mnt/c') ? '/mnt/c' : undefined;

// Version is read from package.json at runtime (no hardcoded version)
function readVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Try multiple paths: dist/../package.json (normal), dist/../../package.json (workspace root)
    const candidates = [
      join(__dirname, '..', 'package.json'),
      join(__dirname, '..', '..', 'package.json'),
    ];
    for (const pkgPath of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.version) return pkg.version;
      } catch {
        /* try next */
      }
    }
    return '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Backfill: scan existing processes and import them as historical runs
async function backfillFromExistingProcesses(storage: TraceStorage): Promise<number> {
  const { execSync } = await import('node:child_process');
  let imported = 0;
  let localList = '';
  try {
    if (process.platform === 'win32') {
      localList = execSync('tasklist /fo csv /nh', { encoding: 'utf8', timeout: 5000 });
    } else {
      localList = execSync('ps aux', { encoding: 'utf8', timeout: 5000 });
    }
  } catch {
    /* ignore */
  }
  const agents = detectAgents(localList, process.platform);
  const isWSL =
    process.platform === 'linux' &&
    existsSync('/proc/version') &&
    readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');
  if (isWSL) {
    try {
      const winList = execSync('cmd.exe /c tasklist /fo csv /nh', {
        encoding: 'utf8',
        timeout: 10000,
        cwd: WIN_EXEC_CWD,
      });
      agents.push(...detectAgents(winList, 'windows'));
    } catch {
      /* ignore */
    }
  }
  for (const agent of agents) {
    const runId = `backfill-${agent.pid}-${agent.name}`;
    try {
      const existing = storage.getRun(runId);
      if (!existing) {
        storage.createRun({
          id: runId,
          name: agent.name,
          startedAt: Date.now(),
          metadata: {
            pid: agent.pid,
            runtime: agent.runtime,
            platform: agent.platform,
            framework: agent.framework || 'unknown',
            cmdline: agent.cmdline?.substring(0, 200),
            autoDetected: true,
            backfilled: true,
          },
        });
        // Also create a usage record so `activity` shows detected agents
        storage.recordAgentUsage({
          id: `usage-${runId}`,
          agentName: agent.name,
          agentType: agent.framework || 'unknown',
          sessionId: runId,
          action: 'process_detected',
          target: agent.cmdline?.substring(0, 100) || undefined,
          tokensUsed: 0,
          costUsd: 0,
          durationMs: 0,
          status: 'success',
          metadata: {
            pid: agent.pid,
            runtime: agent.runtime,
            platform: agent.platform,
            framework: agent.framework || 'unknown',
            autoDetected: true,
            backfilled: true,
          },
          createdAt: Date.now(),
        });
        imported++;
      }
    } catch {
      /* ignore duplicates */
    }
  }
  return imported;
}

export const VERSION = readVersion();

/** Published npm package name. */
export const PACKAGE_NAME = '@agenttrace-io/cli';

function getDefaultDbPath(): string {
  // Use platform-appropriate data directory
  const home = homedir();
  // Check for explicit env override first
  if (process.env.AGENTTRACE_DB_PATH) {
    return process.env.AGENTTRACE_DB_PATH;
  }
  // Windows: %APPDATA%/agenttrace/agenttrace.db
  if (process.platform === 'win32' && process.env.APPDATA) {
    const dir = join(process.env.APPDATA, 'agenttrace');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'agenttrace.db');
  }
  // macOS ~/Library/Application Support/agenttrace/agenttrace.db
  if (process.platform === 'darwin') {
    const dir = join(home, 'Library', 'Application Support', 'agenttrace');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'agenttrace.db');
  }
  // Linux/other: ~/.local/share/agenttrace/agenttrace.db (XDG)
  const xdgData = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  const dir = join(xdgData, 'agenttrace');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'agenttrace.db');
}

function getDbPath(): string {
  return getDefaultDbPath();
}

// ANSI colors for status
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const NO_COLOR =
  process.env.NO_COLOR === '1' ||
  process.env.NO_COLOR === 'true' ||
  process.argv.includes('--no-color');

function color(s: string, c: string): string {
  if (NO_COLOR) return s;
  return c + s + RESET;
}

function colorizeStatus(status: string): string {
  const s = status.toLowerCase();
  const plain = status;
  if (s === 'success') return color(plain, GREEN);
  if (s === 'error' || s === 'failure') return color(plain, RED);
  if (s === 'running' || s === 'timeout') return color(plain, YELLOW);
  return plain;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

function pad(str: string, width: number): string {
  const vis = visibleLength(str);
  return str + ' '.repeat(Math.max(0, width - vis));
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '0';
  return Math.round(Number(n)).toLocaleString();
}

function fmtCost(c: number | null | undefined): string {
  if (c == null) return '$0.0000';
  return '$' + Number(c).toFixed(4);
}

function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return '0ms';
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function _asciiSpark(values: number[], width = 10): string {
  if (!values || values.length === 0) return '';
  const max = Math.max(...values, 1);
  const blocks = ' ▁▂▃▄▅▆▇█';
  let out = '';
  for (let i = 0; i < Math.min(width, values.length); i++) {
    const v = values[values.length - Math.min(width, values.length) + i] || 0;
    const idx = Math.min(
      blocks.length - 1,
      Math.max(0, Math.floor((v / max) * (blocks.length - 1))),
    );
    out += blocks[idx];
  }
  return out;
}

function printTable(headers: string[], rows: string[][]): void {
  if (rows.length === 0) return;

  const widths: number[] = headers.map((h, i) => {
    const rowMax = Math.max(0, ...rows.map((r) => visibleLength(r[i] ?? '')));
    return Math.max(h.length, rowMax);
  });

  // header
  console.log(headers.map((h, i) => pad(h, widths[i] ?? 0)).join('  '));
  // separator
  console.log(widths.map((w) => '-'.repeat(w ?? 0)).join('  '));
  // rows
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i] ?? 0)).join('  '));
  }
}

function printRunsTable(runs: Run[]): void {
  const headers = ['ID', 'Name', 'Status', 'Traces', 'Tokens', 'Cost', '▂', 'Started'];
  // build cost spark history per run from recent context (simple per-row mini bar)
  const maxCost = Math.max(0.0001, ...runs.map((r) => r.totalCostUsd || 0));
  const rows = runs.map((r) => {
    const cost = r.totalCostUsd || 0;
    const barLen = Math.max(1, Math.min(8, Math.round((cost / maxCost) * 8)));
    const bar = '█'.repeat(barLen) + ' '.repeat(8 - barLen);
    return [
      (r.id || '').substring(0, 8),
      r.name || '',
      colorizeStatus(r.status || ''),
      fmtNum(r.traceCount ?? 0),
      fmtNum(r.totalTokens?.totalTokens ?? 0),
      fmtCost(cost),
      bar,
      r.startedAt ? new Date(r.startedAt).toISOString().slice(0, 19).replace('T', ' ') : '',
    ];
  });
  printTable(headers, rows);
}

function printTracesTable(traces: Trace[]): void {
  const headers = ['ID', 'Name', 'Status', 'Latency', 'Tokens', 'Cost', 'Created'];
  const rows = traces.map((t) => [
    (t.id || '').substring(0, 8),
    t.name || '',
    colorizeStatus(t.status || ''),
    fmtLatency(t.latencyMs ?? 0),
    fmtNum(t.tokens?.totalTokens ?? 0),
    fmtCost(t.costUsd ?? 0),
    t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 19).replace('T', ' ') : '',
  ]);
  printTable(headers, rows);
}

function printStats(stats: TraceStats): void {
  console.log('AgentTrace Statistics');
  console.log('=====================');
  console.log(`Total Runs:     ${fmtNum(stats.totalRuns ?? 0)}`);
  console.log(`Total Traces:   ${fmtNum(stats.totalTraces ?? 0)}`);
  const rate = ((stats.successRate ?? 0) * 100).toFixed(1);
  console.log(`Success Rate:   ${rate}%`);
  console.log(`Avg Latency:    ${fmtLatency(stats.avgLatencyMs ?? 0)}`);
  console.log(`Total Cost:     ${fmtCost(stats.totalCostUsd ?? 0)}`);
  console.log(`Total Tokens:   ${fmtNum(stats.totalTokens ?? 0)}`);
  console.log(`Avg Tokens:     ${fmtNum(stats.avgTokensPerTrace ?? 0)}`);

  // Simple trend hint (computed if we can infer from SDK; otherwise neutral)
  const trendNote =
    stats.totalCostUsd && stats.totalCostUsd > 0 ? '  (↑ track daily with `costs --daily`)' : '';
  console.log(`Cost trend:${trendNote}`);

  if (stats.topTools && stats.topTools.length > 0) {
    console.log('\nTop Tools:');
    for (const t of stats.topTools.slice(0, 5)) {
      console.log(`  ${t.name}: ${fmtNum(t.count)} (avg ${t.avgLatencyMs}ms)`);
    }
  }
  if (stats.topErrors && stats.topErrors.length > 0) {
    console.log('\nTop Errors:');
    for (const e of stats.topErrors.slice(0, 5)) {
      console.log(`  ${e.error}: ${fmtNum(e.count)}`);
    }
  }
}

function printCosts(breakdown: CostBreakdown, daily: boolean): void {
  const title = daily ? 'Daily Cost Breakdown' : 'Cost Breakdown by Model';
  console.log(title);
  console.log('='.repeat(title.length));
  const data = daily ? breakdown.costByDay : breakdown.costByModel;
  const entries = Object.entries(data);
  if (entries.length === 0) {
    console.log('No costs recorded.');
  } else {
    // sort by cost desc for models, chrono for days
    const sorted = daily
      ? entries.sort(([a], [b]) => a.localeCompare(b))
      : entries.sort(([, c1], [, c2]) => (c2 as number) - (c1 as number));
    for (const [key, cost] of sorted) {
      console.log(`  ${key}: $${(cost as number).toFixed(4)}`);
    }
  }
  console.log(`\nTotal: $${breakdown.totalCostUsd.toFixed(4)}`);
}

function printTraceTree(node: TraceTreeNode | null | undefined, prefix = '', isLast = true): void {
  if (!node || !node.trace) return;
  const t = node.trace;
  const branch = prefix + (isLast ? '└── ' : '├── ');
  const status = colorizeStatus(t.status || '');
  const shortId = (t.id || '').substring(0, 8);
  console.log(
    `${branch}${shortId} ${t.name || ''} ${status} ${t.latencyMs ?? 0}ms $${((t.costUsd ?? 0) as number).toFixed(4)}`,
  );
  const childPrefix = prefix + (isLast ? '    ' : '│   ');
  const children = (node.children || []) as TraceTreeNode[];
  children.forEach((child, idx) => {
    const lastChild = idx === children.length - 1;
    printTraceTree(child, childPrefix, lastChild);
  });
}

function printUsage(): void {
  console.log(`Usage: agenttrace <command> [options]  (alias: agenttrace-io)

Commands:
  status               Show daemon, dashboard, and database status at a glance
  init                 Create empty agenttrace.db in current dir
  wrap                 Trace any CLI command (zero-config)
  dashboard            Start the local dashboard server
  runs                 List recent runs (most recent first)
  traces               List traces (most recent first)
  stats                Show summary statistics
  costs                Show cost breakdown by model (or --daily)
  export               Export traces to JSON or CSV
  benchmark            Run performance benchmark suite (prints JSON results)
  tree                 Show parent/child/related trace tree (multi-agent)
  alerts               Manage alerts: list | test --name N | history
  health               Check health of gateway, dashboard, and database
  daemon               Start/stop background daemon (dashboard + auto-detect)
  service              Install/uninstall system service (systemd/launchd)
  self-stats           Show self-tracked usage stats
  budget               Manage per-agent token budgets: set | list | status | check
  who                  Show active agents (usage tracking)
  cost                 Show agent cost breakdown (periods + by agent/model)
  sessions             List agent sessions with aggregates
  activity             Show recent agent activity timeline
  webhook              Manage webhooks: add <url> <events...> | list | remove <id> | test <id>
  cleanup              Manually run data retention cleanup (deletes expired traces, runs, usage)
  retention            Manage data retention policy: show | set <days> [--interval H]
  version              Show CLI version
  update               Update to latest version (npm install -g)

Options (by command):
  runs, traces:
    --limit N            Number of results (default: runs=20, traces=50)
    --status FILTER      Comma-separated statuses (success,error,failure,running,timeout)
  traces, export, costs:
    --run-id ID          Filter by run ID
  export:
    --format json|csv|otel    Output format (default: json)
    --output FILE        Write to file instead of stdout
  costs:
    --daily              Breakdown costs by day instead of by model
  tree:
    --trace-id ID        Trace ID to display tree for (required)
  alerts:
    list                 List configured alerts
    test --name NAME     Test delivery for alert (forces condition + ignores cooldown)
    history              Show alert trigger history
  who:
    --active             Only agents active in last 30min
    --type TYPE          Filter by agent type
    --limit N            Max agents to show (default 50)
  cost:
    --from DATE          Start date (YYYY-MM-DD or ISO)
    --to DATE            End date (YYYY-MM-DD or ISO)
    --agent NAME         Filter to specific agent
    --format json|table  Output format (default: table)
  sessions:
    --agent NAME         Filter by agent name
    --active             Only sessions with recent activity (30min)
    --limit N            Max sessions (default 20)
  activity:
    --agent NAME         Filter by agent
    --type ACTION        Filter by action type
    --limit N            Max entries (default 30)
    --since DURATION     e.g. 1h, 30m, 2d (from now backwards)
  webhook:
    add --url <url> --events <e1,e2,...>
                         Register a webhook for the given event types
    list                 List all configured webhooks
    remove --id <id>     Remove a webhook by ID (prefix match)
    test --id <id>       Send a test payload to a webhook by ID
    Events: trace.complete, trace.error, run.complete, run.error, cost.threshold, agent.inactive
  cleanup:
    --days N             Override retention days (default: use policy setting)
    --dry-run            Show what would be deleted without deleting
  retention:
    show                 Show current retention policy and storage stats
    set <days>           Set retention policy (days); optional --interval H

Global:
  --json               Emit machine-readable JSON (for runs, traces, stats, costs, export, self-stats)
  --help               Show this help

Examples:
  agenttrace status
  agenttrace status --json
  agenttrace init
  agenttrace wrap claude "Write a hello world function"
  agenttrace runs --limit 5 --status success,running
  agenttrace traces --run-id 123e4567 --json
  agenttrace export --format csv --output out.csv --run-id abc
  agenttrace dashboard
  agenttrace costs
  agenttrace costs --daily --json
  agenttrace costs --run-id abc123
  agenttrace alerts list
  agenttrace alerts test --name high-error-rate
  agenttrace alerts history
  agenttrace tree --trace-id abc123def
  agenttrace self-stats
  agenttrace self-stats --json
  agenttrace who --active --limit 10
  agenttrace cost --format table
  agenttrace cost --agent researcher-1 --from 2026-01-01
  agenttrace sessions --active
  agenttrace activity --since 2h --limit 20
  agenttrace cleanup
  agenttrace cleanup --days 7 --dry-run
  agenttrace retention show
  agenttrace retention set 60
  agenttrace retention set 90 --interval 12
  agenttrace webhook add https://example.com/hook trace.complete run.complete
  agenttrace webhook list
  agenttrace webhook test abc12345
  agenttrace webhook remove abc12345
  npx agenttrace version
  # agenttrace-io also works as an alias
`);
}

function isSelfTracked(t: Trace | Run): boolean {
  const meta = (t as Trace).metadata || (t as Run).metadata || {};
  return meta.selfTracked === true || (t as Trace).name?.startsWith?.('self:') === true;
}

function getDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getWeekStart(ts: number): number {
  const d = new Date(ts);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // monday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function printSelfStats(storage: TraceStorage, useJson: boolean): void {
  // Fetch recent data (no hard limit to include historical self usage)
  const runs = storage.getRuns(5000);
  const traces = storage.getTraces({ limit: 20000 });

  const selfRuns = runs.filter((r) => isSelfTracked(r));
  const selfTraces = traces.filter((t) => isSelfTracked(t));

  const now = Date.now();
  const todayStart = getDayStart(now);
  const weekStart = getWeekStart(now);

  const todayTraces = selfTraces.filter((t) => (t.createdAt || 0) >= todayStart);
  const weekTraces = selfTraces.filter((t) => (t.createdAt || 0) >= weekStart);

  // Today's summary
  const todayActions = todayTraces.length;
  const todayTokens = todayTraces.reduce((s, t) => s + (t.tokens?.totalTokens || 0), 0);
  const todayCost = todayTraces.reduce((s, t) => s + (t.costUsd || 0), 0);
  const todaySessions = new Set(todayTraces.map((t) => t.runId)).size;

  // Week summary
  const weekActions = weekTraces.length;
  const weekTokens = weekTraces.reduce((s, t) => s + (t.tokens?.totalTokens || 0), 0);
  const weekCost = weekTraces.reduce((s, t) => s + (t.costUsd || 0), 0);
  const weekSessions = new Set(weekTraces.map((t) => t.runId)).size;

  // Top actions by type (use actionType from meta or derive from name)
  const actionCounts: Record<string, number> = {};
  for (const t of selfTraces) {
    const meta = t.metadata || {};
    const at =
      (meta.actionType as string) ||
      (t.name || '').replace(/^self:/, '').split(':')[0] ||
      'unknown';
    actionCounts[at] = (actionCounts[at] || 0) + 1;
  }
  const topActions = Object.entries(actionCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([type, count]) => ({ type, count }));

  // Cost breakdown (self only) - by day for recent
  const costByDay: Record<string, number> = {};
  for (const t of selfTraces) {
    if (!t.createdAt) continue;
    const day = new Date(t.createdAt).toISOString().slice(0, 10);
    costByDay[day] = (costByDay[day] || 0) + (t.costUsd || 0);
  }
  const totalSelfCost = Object.values(costByDay).reduce((s, v) => s + v, 0);

  // Active sessions
  const activeSessions = selfRuns.filter((r) => r.status === 'running').length;
  const activeSessionIds = selfRuns
    .filter((r) => r.status === 'running')
    .map((r) => (r.id || '').substring(0, 8));

  const summary = {
    today: {
      actions: todayActions,
      tokens: todayTokens,
      costUsd: Number(todayCost.toFixed(6)),
      sessions: todaySessions,
    },
    week: {
      actions: weekActions,
      tokens: weekTokens,
      costUsd: Number(weekCost.toFixed(6)),
      sessions: weekSessions,
    },
    topActions,
    costBreakdown: {
      totalCostUsd: Number(totalSelfCost.toFixed(6)),
      costByDay,
    },
    activeSessions,
    activeSessionIds,
    totalSelfTraces: selfTraces.length,
    totalSelfRuns: selfRuns.length,
  };

  if (useJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('AgentTrace Self-Tracking Stats');
  console.log('==============================================');
  console.log('');
  console.log("Today's Activity:");
  console.log(`  Actions:  ${summary.today.actions}`);
  console.log(`  Tokens:   ${summary.today.tokens}`);
  console.log(`  Cost:     $${summary.today.costUsd}`);
  console.log(`  Sessions: ${summary.today.sessions}`);
  console.log('');
  console.log('This Week:');
  console.log(`  Actions:  ${summary.week.actions}`);
  console.log(`  Tokens:   ${summary.week.tokens}`);
  console.log(`  Cost:     $${summary.week.costUsd}`);
  console.log(`  Sessions: ${summary.week.sessions}`);
  console.log('');
  if (topActions.length > 0) {
    console.log('Top Actions by Type:');
    const maxA = Math.max(...topActions.map((a) => a.count), 1);
    for (const a of topActions.slice(0, 8)) {
      const bar = '█'.repeat(Math.max(1, Math.round((a.count / maxA) * 12)));
      console.log(`  ${a.type.padEnd(14)} ${String(a.count).padStart(4)} ${bar}`);
    }
    console.log('');
  }
  console.log('Cost Breakdown (self-tracked):');
  console.log(`  Total: $${summary.costBreakdown.totalCostUsd}`);
  const sortedDays = Object.keys(costByDay).sort();
  if (sortedDays.length > 0) {
    for (const d of sortedDays.slice(-7)) {
      const c = costByDay[d] ?? 0;
      console.log(`  ${d}: $${c.toFixed(6)}`);
    }
  }
  console.log('');
  console.log(
    `Active Sessions: ${activeSessions}${activeSessionIds.length ? ' (' + activeSessionIds.join(', ') + ')' : ''}`,
  );
  if (summary.totalSelfTraces === 0) {
    console.log('\n(No self-tracked data yet. Use SelfTracker in your agent to record actions.)');
  }
}

// ---- Agent usage CLI helpers (who, cost, sessions, activity) ----

function parseSinceDuration(s: string | boolean | undefined): number | undefined {
  if (!s || typeof s !== 'string') return undefined;
  const m = s.trim().match(/^(\d+)([smhd])$/i);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2]!.toLowerCase();
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
  return Date.now() - n * mult;
}

function parseDateInput(d: string | boolean | undefined): number | undefined {
  if (!d || typeof d !== 'string') return undefined;
  const t = Date.parse(d);
  if (Number.isFinite(t)) return t;
  return undefined;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s}s`;
}

function formatDateShort(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

function getModelFromRec(r: AgentUsageRecord): string {
  const meta = r.metadata || {};
  const m = (meta as Record<string, unknown>).model;
  return typeof m === 'string' ? m : 'unknown';
}

function computeAgentCostBreakdown(recs: AgentUsageRecord[]): {
  totalCostUsd: number;
  costByAgent: Record<string, number>;
  costByModel: Record<string, number>;
} {
  let total = 0;
  const byAgent: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  for (const r of recs) {
    const c = r.costUsd || 0;
    total += c;
    byAgent[r.agentName] = (byAgent[r.agentName] || 0) + c;
    const mod = getModelFromRec(r);
    byModel[mod] = (byModel[mod] || 0) + c;
  }
  return { totalCostUsd: total, costByAgent: byAgent, costByModel: byModel };
}

function getPeriodStarts(): { today: number; week: number; month: number; all: number } {
  const now = Date.now();
  const dToday = new Date(now);
  dToday.setHours(0, 0, 0, 0);
  const today = dToday.getTime();

  // week start (monday) reuse logic similar to self-stats
  const dWeek = new Date(now);
  const day = dWeek.getDay();
  const diff = dWeek.getDate() - day + (day === 0 ? -6 : 1);
  dWeek.setDate(diff);
  dWeek.setHours(0, 0, 0, 0);
  const week = dWeek.getTime();

  const dMonth = new Date(now);
  dMonth.setDate(1);
  dMonth.setHours(0, 0, 0, 0);
  const month = dMonth.getTime();

  return { today, week, month, all: 0 };
}

function printAgentCostSection(
  title: string,
  bd: ReturnType<typeof computeAgentCostBreakdown>,
): void {
  console.log(title);
  console.log('='.repeat(title.length));
  console.log(`Total: $${bd.totalCostUsd.toFixed(4)}`);
  // by agent
  const agents = Object.entries(bd.costByAgent).sort(([, a], [, b]) => b - a);
  if (agents.length > 0) {
    console.log('By Agent:');
    for (const [name, c] of agents.slice(0, 10)) {
      console.log(`  ${name}: $${c.toFixed(4)}`);
    }
  }
  // by model
  const models = Object.entries(bd.costByModel).sort(([, a], [, b]) => b - a);
  if (models.length > 0) {
    console.log('By Model:');
    for (const [m, c] of models.slice(0, 10)) {
      console.log(`  ${m}: $${c.toFixed(4)}`);
    }
  }
  console.log('');
}

function printWhoTable(who: AgentWho[]): void {
  const headers = ['Agent', 'Type', 'Session', 'Last Action', 'Actions', 'Tokens', 'Cost'];
  const rows = who.map((w) => [
    w.agentName,
    w.agentType || '',
    w.sessionId ? w.sessionId.substring(0, 8) : '',
    w.lastAction,
    fmtNum(w.actions),
    fmtNum(w.tokens),
    fmtCost(w.costUsd || 0),
  ]);
  printTable(headers, rows);
}

function printSessionsTable(sessions: AgentSession[]): void {
  const headers = [
    'Session ID',
    'Agent',
    'Started',
    'Duration',
    'Actions',
    'Tokens',
    'Cost',
    'Status',
  ];
  const rows = sessions.map((s) => [
    s.sessionId.substring(0, 12),
    s.agentName,
    formatDateShort(s.startedAt),
    formatDuration(s.durationMs),
    fmtNum(s.actions),
    fmtNum(s.tokens),
    fmtCost(s.costUsd || 0),
    colorizeStatus(s.status),
  ]);
  printTable(headers, rows);
}

function printActivityTimeline(recs: AgentUsageRecord[]): void {
  if (recs.length === 0) {
    console.log('No activity found.');
    return;
  }
  const headers = ['Time', 'Agent', 'Action', 'Tokens', 'Cost', 'Status'];
  const rows = recs.map((r) => [
    formatDateShort(r.createdAt),
    r.agentName,
    r.action + (r.target ? `:${r.target}` : ''),
    fmtNum(r.tokensUsed || 0),
    fmtCost(r.costUsd || 0),
    colorizeStatus(r.status),
  ]);
  printTable(headers, rows);
}

function printWebhooksTable(webhooks: WebhookConfig[]): void {
  if (webhooks.length === 0) {
    console.log('No webhooks configured.');
    return;
  }
  const headers = ['ID', 'URL', 'Events', 'Enabled', 'Last Triggered', 'Failures'];
  const rows = webhooks.map((w) => [
    w.id.substring(0, 8),
    w.url,
    (w.events || []).join(','),
    w.enabled ? 'enabled' : 'disabled',
    w.lastTriggeredAt
      ? new Date(w.lastTriggeredAt).toISOString().slice(0, 19).replace('T', ' ')
      : 'never',
    String(w.failureCount || 0),
  ]);
  printTable(headers, rows);
}

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  // Command is the first non-flag argument
  const command = args.find((a) => typeof a === 'string' && !a.startsWith('-')) || 'help';
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
    // flag
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      const key = arg.slice(2, eqIdx);
      const val = arg.slice(eqIdx + 1);
      flags[key] = val;
    } else {
      const key = arg.slice(2);
      const next = args[i + 1];
      const val: string | boolean =
        i + 1 < args.length && typeof next === 'string' && !next.startsWith('-')
          ? (i++, next)
          : true;
      flags[key] = val;
    }
  }
  return { command, flags };
}

function getAgentTrace(requireDb = true): AgentTrace {
  const dbp = getDbPath();
  if (requireDb && !existsSync(dbp)) {
    console.error(`No ${dbp} found in current directory.`);
    console.error('Run "agenttrace init" to create one.');
    process.exit(1);
  }
  return new AgentTrace({ dbPath: dbp, silent: true });
}

async function runMain(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  if (flags.help || command === 'help') {
    printUsage();
    return;
  }

  const useJson = !!flags.json;

  // detect subcommand for alerts (e.g. alerts list, alerts test)
  const alertsSub: string | undefined = (() => {
    if (command !== 'alerts') return undefined;
    const argvArgs = process.argv.slice(2);
    const idx = argvArgs.indexOf('alerts');
    if (idx === -1) return undefined;
    for (let k = idx + 1; k < argvArgs.length; k++) {
      const c = argvArgs[k];
      if (typeof c === 'string' && !c.startsWith('-')) {
        return c;
      }
    }
    return undefined;
  })();

  // detect subcommand for webhooks (e.g. webhook add, webhook list, webhook remove, webhook test)
  const webhookSub: string | undefined = (() => {
    if (command !== 'webhook') return undefined;
    const argvArgs = process.argv.slice(2);
    const idx = argvArgs.indexOf('webhook');
    if (idx === -1) return undefined;
    for (let k = idx + 1; k < argvArgs.length; k++) {
      const c = argvArgs[k];
      if (typeof c === 'string' && !c.startsWith('-')) {
        return c;
      }
    }
    return undefined;
  })();

  // capture positional args for webhook commands (used in webhook subcommand handling below)
  const _webhookPositionals: string[] = (() => {
    if (command !== 'webhook') return [];
    const argvArgs = process.argv.slice(2);
    const idx = argvArgs.indexOf('webhook');
    if (idx === -1) return [];
    const result: string[] = [];
    for (let k = idx + 1; k < argvArgs.length; k++) {
      const c = argvArgs[k];
      if (typeof c === 'string' && !c.startsWith('-')) {
        result.push(c);
      }
    }
    // First positional is the subcommand; rest are args
    return result.slice(1);
  })();
  void _webhookPositionals;

  // detect subcommand for retention (e.g. retention show, retention set <days>)
  const _retentionSub: string | undefined = (() => {
    if (command !== 'retention') return undefined;
    const argvArgs = process.argv.slice(2);
    const idx = argvArgs.indexOf('retention');
    if (idx === -1) return undefined;
    for (let k = idx + 1; k < argvArgs.length; k++) {
      const c = argvArgs[k];
      if (typeof c === 'string' && !c.startsWith('-')) {
        return c;
      }
    }
    return undefined;
  })();
  void _retentionSub;

  switch (command) {
    case 'init': {
      const dbp = getDbPath();
      if (existsSync(dbp)) {
        console.log(`${dbp} already exists.`);
      } else {
        const trace = new AgentTrace({ dbPath: dbp, silent: true });
        trace.close();
        console.log(`Created ${dbp}`);
      }
      // Backfill: scan existing processes and import as historical runs
      try {
        const storage = new TraceStorage(dbp);
        const imported = await backfillFromExistingProcesses(storage);
        if (imported > 0) {
          console.log(`Backfilled ${imported} existing agent process(es) from this machine.`);
        }
        storage.close();
      } catch {
        /* non-fatal */
      }
      break;
    }

    case 'wrap': {
      const argvArgs = process.argv.slice(2);
      const cmd = argvArgs[1];
      if (!cmd) {
        console.error('Usage: agenttrace wrap <command> [args...]');
        process.exit(1);
      }
      const cmdArgs = argvArgs.slice(2);
      const agenttrace = new AgentTrace({ dbPath: getDbPath(), silent: true });
      const runId = agenttrace.startRun(`wrap:${cmd}`);
      void runId;
      const inputStr = `${cmd} ${cmdArgs.join(' ')}`.trim();
      let stdout = '';
      let stderr = '';
      let exitCode: number;
      try {
        const { spawn } = await import('node:child_process');
        const result = await new Promise<string>((resolve, reject) => {
          const child = spawn(cmd, cmdArgs, { stdio: 'pipe', shell: true });
          child.stdout.on('data', (d: Buffer) => {
            stdout += d.toString();
            process.stdout.write(d); // stream to user's terminal in real time
          });
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString();
            process.stderr.write(d); // stream to user's terminal in real time
          });
          child.on('close', (code: number | null) => {
            exitCode = code ?? 0;
            if (exitCode !== 0) {
              const e = new Error(
                stderr.slice(0, 500) || `exited with code ${exitCode}`,
              ) as Error & {
                exitCode?: number;
              };
              e.exitCode = exitCode;
              reject(e);
            } else {
              resolve(stdout.slice(0, 2000));
            }
          });
          child.on('error', (err: unknown) => {
            exitCode = 1;
            reject(err);
          });
        });
        await agenttrace.trace(`wrap:${cmd}`, async () => result, { input: inputStr });
        agenttrace.completeRun('success');
      } catch (e: unknown) {
        agenttrace.completeRun('error');
        const err = e as Error & { exitCode?: number };
        exitCode = err?.exitCode ?? 1;
        if (stderr) process.stderr.write(stderr.slice(0, 500));
        agenttrace.close();
        process.exit(exitCode);
      }
      agenttrace.close();
      process.exit(0);
      break;
    }

    case 'dashboard': {
      const rawPort = flags.port ? parseInt(String(flags.port), 10) : NaN;
      const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : undefined;
      const host = typeof flags.host === 'string' ? String(flags.host) : undefined;
      try {
        const server = startDashboard({ dbPath: getDbPath(), port, host });
        return new Promise<void>((resolve) => {
          server.on('close', () => resolve());
          process.on('SIGINT', () => {
            server.close();
            resolve();
          });
          process.on('SIGTERM', () => {
            server.close();
            resolve();
          });
        });
      } catch (e) {
        console.error('Failed to start dashboard:', e);
        process.exit(1);
      }
    }

    // eslint-disable-next-line no-fallthrough
    case 'watch': {
      // Background watcher: auto-discovers and traces all running agents
      const scanInterval = flags.interval ? parseInt(String(flags.interval), 10) * 1000 : 10000;
      const isWSL =
        process.platform === 'linux' &&
        existsSync('/proc/version') &&
        readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');

      console.log(`[AgentTrace] Starting agent watcher (scan every ${scanInterval / 1000}s)...`);
      if (isWSL)
        console.log('[AgentTrace] WSL detected — will scan both WSL and Windows processes');

      const dbPath = getDbPath();
      const storage = new TraceStorage(dbPath);
      let scanCount = 0;

      const doScan = async (): Promise<void> => {
        scanCount++;
        try {
          const { execSync } = await import('node:child_process');
          let localList = '';
          try {
            if (process.platform === 'win32') {
              localList = execSync('tasklist /fo csv /nh', { encoding: 'utf8', timeout: 5000 });
            } else {
              localList = execSync('ps aux', { encoding: 'utf8', timeout: 5000 });
            }
          } catch {
            /* ignore */
          }

          const agents = detectAgents(localList, process.platform);

          if (isWSL) {
            try {
              const winList = execSync('cmd.exe /c tasklist /fo csv /nh', {
                encoding: 'utf8',
                timeout: 10000,
                cwd: WIN_EXEC_CWD,
              });
              agents.push(...detectAgents(winList, 'windows'));
            } catch {
              /* ignore */
            }
          }

          if (agents.length > 0) {
            // Record discovered agents as runs + usage records
            for (const agent of agents) {
              const runId = `watch-${agent.pid}-${agent.name}`;
              try {
                // Check if we already have this run
                const existing = storage.getRun(runId);
                if (!existing) {
                  storage.createRun({
                    id: runId,
                    name: agent.name,
                    startedAt: Date.now(),
                    metadata: {
                      pid: agent.pid,
                      runtime: agent.runtime,
                      platform: agent.platform,
                      framework: agent.framework || 'unknown',
                      cmdline: agent.cmdline?.substring(0, 200),
                      autoDetected: true,
                      watcherScan: scanCount,
                    },
                  });
                  // Also create a usage record so `activity` shows detected agents
                  storage.recordAgentUsage({
                    id: `usage-${runId}`,
                    agentName: agent.name,
                    agentType: agent.framework || 'unknown',
                    sessionId: runId,
                    action: 'process_detected',
                    target: agent.cmdline?.substring(0, 100) || undefined,
                    tokensUsed: 0,
                    costUsd: 0,
                    durationMs: 0,
                    status: 'success',
                    metadata: {
                      pid: agent.pid,
                      runtime: agent.runtime,
                      platform: agent.platform,
                      framework: agent.framework || 'unknown',
                      autoDetected: true,
                      watcherScan: scanCount,
                    },
                    createdAt: Date.now(),
                  });
                }
              } catch {
                /* ignore duplicates */
              }
            }
            if (flags.verbose) {
              console.log(`[Watch] Scan #${scanCount}: ${agents.length} agent(s) detected`);
              for (const a of agents) {
                console.log(
                  `  ${a.platform} | ${a.pid} | ${a.runtime} | ${a.framework || '?'} | ${a.name}`,
                );
              }
            }
          }
        } catch (e) {
          if (flags.verbose) {
            console.error(`[Watch] Scan error:`, e);
          }
        }
      };

      // Run immediately, then on interval
      await doScan();
      const intervalId = setInterval(doScan, scanInterval);

      // Keep process alive
      process.on('SIGINT', () => {
        console.log('\n[AgentTrace] Watcher stopped.');
        clearInterval(intervalId);
        storage.close();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        clearInterval(intervalId);
        storage.close();
        process.exit(0);
      });

      // Block forever
      return new Promise(() => {});
    }

    case 'runs': {
      const trace = getAgentTrace();
      const rawLimit = flags.limit ? parseInt(String(flags.limit), 10) : NaN;
      const lim = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
      const allRuns = trace.getRuns(Math.max(1, Math.min(1000, lim)));

      const statusRaw = flags.status ? String(flags.status) : '';
      const runs = statusRaw
        ? (() => {
            const allowed = statusRaw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            return allowed.length ? allRuns.filter((r) => allowed.includes(r.status)) : allRuns;
          })()
        : allRuns;

      trace.close();

      if (useJson) {
        console.log(JSON.stringify(runs, null, 2));
      } else if (runs.length === 0) {
        console.log('No runs found.');
      } else {
        printRunsTable(runs);
      }
      break;
    }

    case 'traces': {
      const trace = getAgentTrace();
      const rawLimit = flags.limit ? parseInt(String(flags.limit), 10) : NaN;
      const lim = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;
      const runId = (flags['run-id'] || flags.runId || flags['runId']) as string | undefined;

      const filter: Record<string, unknown> = {
        limit: Math.max(1, Math.min(1000, lim)),
      };
      if (runId) {
        filter.runId = String(runId);
      }
      const statusRaw = flags.status ? String(flags.status) : '';
      if (statusRaw) {
        const statuses = statusRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (statuses.length) {
          filter.status = statuses;
        }
      }

      const traces = trace.getTraces(filter);
      trace.close();

      if (useJson) {
        console.log(JSON.stringify(traces, null, 2));
      } else if (traces.length === 0) {
        console.log('No traces found.');
      } else {
        printTracesTable(traces);
      }
      break;
    }

    case 'stats': {
      const trace = getAgentTrace();
      const stats = trace.getStats();
      trace.close();

      if (useJson) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        printStats(stats);
      }
      break;
    }

    case 'costs': {
      const trace = getAgentTrace();
      const runId = (flags['run-id'] || flags.runId || flags['runId']) as string | undefined;
      const daily = !!flags.daily;
      const breakdown = trace.getCostBreakdown({ runId: runId ? String(runId) : undefined });
      trace.close();

      if (useJson) {
        console.log(JSON.stringify(breakdown, null, 2));
      } else {
        printCosts(breakdown, daily);
      }
      break;
    }

    case 'export': {
      const trace = getAgentTrace();
      const format: ExportFormat = flags.format === 'csv' ? 'csv' : 'json';
      const runId = (flags['run-id'] || flags.runId || flags['runId']) as string | undefined;

      const filter: Record<string, unknown> = {};
      if (runId) {
        filter.runId = String(runId);
      }

      const data = trace.export(format, filter);
      trace.close();

      const outFile = flags.output ? String(flags.output) : '';
      if (outFile) {
        writeFileSync(outFile, data, 'utf8');
        console.log(`Exported ${format.toUpperCase()} to ${outFile}`);
      } else {
        console.log(data);
      }
      break;
    }

    case 'tree': {
      const traceId = (flags['trace-id'] || flags.traceId || flags['traceId']) as
        | string
        | undefined;
      if (!traceId) {
        console.error('Usage: agenttrace tree --trace-id <id>');
        process.exit(1);
      }
      const tr = getAgentTrace();
      const tree: TraceTreeNode = (() => {
        try {
          return tr.getTraceTree(String(traceId));
        } catch (e: unknown) {
          console.error('Error:', e instanceof Error ? e.message : String(e));
          tr.close();
          process.exit(1);
        }
      })();
      tr.close();

      if (useJson) {
        console.log(JSON.stringify(tree, null, 2));
      } else if (!tree || !tree.trace) {
        console.log('Trace not found.');
      } else {
        console.log('Trace Tree:');
        printTraceTree(tree);
      }
      break;
    }

    case 'alerts': {
      const sub = alertsSub || 'list';
      const dbp = getDbPath();
      const dbExists = existsSync(dbp);
      if (!dbExists && (sub === 'test' || sub === 'history')) {
        console.error(`No ${dbp} found in current directory.`);
        console.error('Run "agenttrace init" to create one.');
        process.exit(1);
      }
      if (sub === 'list' || sub === '') {
        if (!dbExists) {
          if (useJson) {
            console.log('[]');
          } else {
            console.log('No alerts configured.');
          }
          break;
        }
        const agent = new AgentTrace({ dbPath: dbp, silent: true });
        const alerts = agent.getAlerts();
        agent.close();
        if (useJson) {
          console.log(JSON.stringify(alerts, null, 2));
        } else if (alerts.length === 0) {
          console.log('No alerts configured.');
        } else {
          console.log('Configured alerts:');
          for (const a of alerts) {
            const parts: string[] = [`cooldown=${a.cooldown}s`];
            if (a.webhook) parts.push('webhook');
            if (a.email) parts.push('email');
            const last = a.lastTriggered
              ? new Date(a.lastTriggered).toISOString().slice(0, 19)
              : 'never';
            console.log(`  ${a.name} (${parts.join(', ')}) lastTriggered=${last}`);
          }
        }
        break;
      }
      const agent = new AgentTrace({ dbPath: dbp, silent: true });
      if (sub === 'history') {
        const history = agent.getAlertHistory();
        agent.close();
        if (useJson) {
          console.log(JSON.stringify(history, null, 2));
        } else if (history.length === 0) {
          console.log('No alert history.');
        } else {
          console.log('Alert history (newest first):');
          for (const h of history.slice(0, 100)) {
            const t = new Date(h.triggeredAt).toISOString().slice(0, 19).replace('T', ' ');
            const del = h.delivered ? 'delivered' : `failed${h.error ? ' (' + h.error + ')' : ''}`;
            console.log(`  ${t}  ${h.alertName}  ${del}`);
          }
        }
        break;
      }
      if (sub === 'test') {
        const name = flags.name || flags['name'] ? String(flags.name || flags['name']) : '';
        if (!name) {
          console.error('Usage: agenttrace alerts test --name <name>');
          agent.close();
          process.exit(1);
        }
        const alerts = agent.getAlerts();
        const def = alerts.find((a: AlertCondition) => a.name === name);
        if (!def) {
          console.error(`Alert '${name}' not found. Register it via the SDK first.`);
          agent.close();
          process.exit(1);
        }
        // Force a test by registering a temp always-true version (bypasses cooldown + uses stored config)
        const testAlert: AlertCondition = {
          name: def.name,
          condition: () => true,
          webhook: def.webhook,
          email: def.email,
          cooldown: 0,
          lastTriggered: 0,
        };
        agent.registerAlert(testAlert);
        const fired = await agent.checkAlerts();
        agent.close();
        if (fired.length > 0) {
          const f = fired[0]!;
          const outcome = f.delivered ? 'delivered' : `failed${f.error ? ': ' + f.error : ''}`;
          console.log(`Test-fired alert '${name}'. ${outcome}`);
        } else {
          console.log(`Alert '${name}' test did not fire.`);
        }
        break;
      }
      console.error(`Unknown alerts subcommand: ${sub}`);
      printUsage();
      agent.close();
      process.exit(1);
      break;
    }

    case 'health': {
      const dbp = getDbPath();
      const useJsonLocal = useJson;
      const GREEN = '\x1b[32m';
      const RED = '\x1b[31m';
      const YELLOW = '\x1b[33m';
      const RESET = '\x1b[0m';

      const checks: Record<string, unknown> = {};

      // Database check (always; creates empty db if absent like init)
      let dbOk = false;
      let dbTraceCount = 0;
      let dbSize = 0;
      let dbIntegrity: { tablesExist: boolean; noOrphans: boolean; details?: string } | undefined;
      try {
        const tr = new AgentTrace({ dbPath: dbp, silent: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const h: any = tr.getHealth();
        tr.close();
        dbOk = h.status === 'ok';
        dbTraceCount = h.traceCount;
        dbSize = h.dbSize;
        dbIntegrity = h.integrity;
        checks.database = {
          ok: dbOk,
          dbPath: dbp,
          traceCount: dbTraceCount,
          dbSize,
          integrity: dbIntegrity,
        };
      } catch (e: unknown) {
        checks.database = { ok: false, dbPath: dbp, error: String(e) };
      }

      // Dashboard check (local default)
      let dashOk = false;
      const dashPort = 4317;
      const dashUrl = `http://127.0.0.1:${dashPort}/api/health`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const resp = await fetch(dashUrl, { signal: controller.signal, method: 'GET' });
        clearTimeout(timeout);
        if (resp.ok) {
          const data = (await resp.json()) as { status?: string };
          dashOk = data && data.status === 'ok';
        }
      } catch (_) {
        // not reachable
      }
      checks.dashboard = { ok: dashOk, url: dashUrl };

      // Gateway: treat as core data access (db/sdk layer)
      const gatewayOk = dbOk;
      checks.gateway = { ok: gatewayOk };

      const overallOk = gatewayOk && dbOk;

      if (useJsonLocal) {
        console.log(
          JSON.stringify(
            {
              status: overallOk ? 'ok' : 'degraded',
              checks,
            },
            null,
            2,
          ),
        );
      } else {
        console.log('AgentTrace Health');
        console.log('=================');
        const gStr = gatewayOk ? `${GREEN}ok${RESET}` : `${RED}fail${RESET}`;
        console.log(`gateway:   ${gStr}`);
        const dStr = dashOk ? `${GREEN}ok${RESET}` : `${YELLOW}not running${RESET}`;
        console.log(`dashboard: ${dStr} (${dashUrl})`);
        const dbStr = dbOk ? `${GREEN}ok${RESET}` : `${RED}fail${RESET}`;
        const extra = dbOk ? ` (traces=${dbTraceCount}, size=${dbSize}B)` : '';
        console.log(`database:  ${dbStr} (${dbp})${extra}`);
        if (dbOk && dbIntegrity && (!dbIntegrity.tablesExist || !dbIntegrity.noOrphans)) {
          console.log(
            `  ${YELLOW}integrity: tablesExist=${dbIntegrity.tablesExist}, noOrphans=${dbIntegrity.noOrphans}${dbIntegrity.details ? ' ' + dbIntegrity.details : ''}${RESET}`,
          );
        }
      }

      if (!overallOk) {
        process.exit(1);
      }
      break;
    }

    case 'version': {
      console.log(`${PACKAGE_NAME} ${VERSION}`);
      break;
    }

    case 'update': {
      const { execSync } = await import('node:child_process');
      console.log(`Current version: ${VERSION}`);
      console.log('Checking for updates...');
      try {
        const latest = execSync(`npm view ${PACKAGE_NAME} version`, { encoding: 'utf-8' }).trim();
        if (latest && /^\d+\.\d+\.\d+$/.test(latest)) {
          const [lMaj = 0, lMin = 0, lPat = 0] = latest.split('.').map(Number);
          const [vMaj = 0, vMin = 0, vPat = 0] = VERSION.split('.').map(Number);
          const isNewer =
            lMaj > vMaj ||
            (lMaj === vMaj && lMin > vMin) ||
            (lMaj === vMaj && lMin === vMin && lPat > vPat);
          if (!isNewer) {
            console.log(`Already up to date (v${VERSION}).`);
          } else {
            console.log(`Updating from v${VERSION} to v${latest}...`);
            execSync(`npm install -g ${PACKAGE_NAME}@${latest}`, { stdio: 'inherit' });
            console.log(`Updated to v${latest}.`);
          }
        } else {
          console.log(`Already up to date (v${VERSION}).`);
        }
      } catch (e: unknown) {
        console.error('Update failed:', e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
      break;
    }

    case 'self-stats': {
      const dbp = getDbPath();
      // self-stats creates db on demand (no error if missing; will just show zeros)
      const storage = new TraceStorage(dbp);
      try {
        printSelfStats(storage, useJson);
      } finally {
        storage.close();
      }
      break;
    }

    case 'who': {
      const dbp = getDbPath();
      const storage = new TraceStorage(dbp);
      try {
        const activeOnly = !!flags.active;
        const typeF = flags.type ? String(flags.type) : undefined;
        const rawLim = flags.limit ? parseInt(String(flags.limit), 10) : NaN;
        const lim = Number.isFinite(rawLim) && rawLim > 0 ? rawLim : 50;
        const who = storage.getAgentWho({ activeOnly, agentType: typeF, limit: lim });
        if (useJson) {
          console.log(JSON.stringify(who, null, 2));
        } else if (who.length === 0) {
          console.log('No agents found.');
        } else {
          printWhoTable(who);
        }
      } finally {
        storage.close();
      }
      break;
    }

    case 'cost': {
      const dbp = getDbPath();
      const storage = new TraceStorage(dbp);
      try {
        const agentF = flags.agent ? String(flags.agent) : undefined;
        const from = parseDateInput(flags.from);
        const to = parseDateInput(flags.to);
        const fmt = (flags.format ? String(flags.format) : 'table').toLowerCase();
        const isJson = fmt === 'json' || useJson;

        const allRecs = storage.getAgentUsage({
          agentName: agentF,
          limit: 50000,
        });

        if (from || to) {
          const filtered = allRecs.filter((r) => {
            if (from && r.createdAt < from) return false;
            if (to && r.createdAt > to) return false;
            return true;
          });
          const bd = computeAgentCostBreakdown(filtered);
          if (isJson) {
            console.log(
              JSON.stringify(
                {
                  range: {
                    from: from ? new Date(from).toISOString() : null,
                    to: to ? new Date(to).toISOString() : null,
                  },
                  agent: agentF || null,
                  ...bd,
                },
                null,
                2,
              ),
            );
          } else {
            const title = `Agent Cost Breakdown (custom range)${agentF ? ` for ${agentF}` : ''}`;
            printAgentCostSection(title, bd);
          }
        } else {
          // show 4 periods + breakdowns
          const periods = getPeriodStarts();
          const todayRecs = allRecs.filter((r) => r.createdAt >= periods.today);
          const weekRecs = allRecs.filter((r) => r.createdAt >= periods.week);
          const monthRecs = allRecs.filter((r) => r.createdAt >= periods.month);
          const allBd = computeAgentCostBreakdown(allRecs);
          const todayBd = computeAgentCostBreakdown(todayRecs);
          const weekBd = computeAgentCostBreakdown(weekRecs);
          const monthBd = computeAgentCostBreakdown(monthRecs);

          if (isJson) {
            console.log(
              JSON.stringify(
                {
                  agent: agentF || null,
                  today: todayBd,
                  week: weekBd,
                  month: monthBd,
                  allTime: allBd,
                },
                null,
                2,
              ),
            );
          } else {
            console.log('Agent Cost Breakdown');
            console.log('====================');
            if (agentF) console.log(`Filter: agent=${agentF}`);
            console.log('');
            printAgentCostSection('Today', todayBd);
            printAgentCostSection('This Week', weekBd);
            printAgentCostSection('This Month', monthBd);
            printAgentCostSection('All Time', allBd);
          }
        }
      } finally {
        storage.close();
      }
      break;
    }

    case 'sessions': {
      const dbp = getDbPath();
      const storage = new TraceStorage(dbp);
      try {
        const agentF = flags.agent ? String(flags.agent) : undefined;
        const activeOnly = !!flags.active;
        const rawLim = flags.limit ? parseInt(String(flags.limit), 10) : NaN;
        const lim = Number.isFinite(rawLim) && rawLim > 0 ? rawLim : 20;
        const sessions = storage.getAgentSessions({ agentName: agentF, activeOnly, limit: lim });
        if (useJson) {
          console.log(JSON.stringify(sessions, null, 2));
        } else if (sessions.length === 0) {
          console.log('No sessions found.');
        } else {
          printSessionsTable(sessions);
        }
      } finally {
        storage.close();
      }
      break;
    }

    case 'activity': {
      const dbp = getDbPath();
      const storage = new TraceStorage(dbp);
      try {
        const agentF = flags.agent ? String(flags.agent) : undefined;
        const actionF = flags.type ? String(flags.type) : undefined; // --type means action
        const rawLim = flags.limit ? parseInt(String(flags.limit), 10) : NaN;
        const lim = Number.isFinite(rawLim) && rawLim > 0 ? rawLim : 30;
        const sinceFrom = parseSinceDuration(flags.since);
        const f: Record<string, unknown> = { limit: lim };
        if (agentF) f.agentName = agentF;
        if (actionF) f.action = actionF;
        if (sinceFrom) f.fromDate = sinceFrom;
        const recs = storage.getAgentUsage(f as AgentUsageFilter);
        if (useJson) {
          console.log(JSON.stringify(recs, null, 2));
        } else if (recs.length === 0) {
          console.log('No activity found.');
        } else {
          printActivityTimeline(recs);
        }
      } finally {
        storage.close();
      }
      break;
    }

    case 'webhook': {
      const sub = webhookSub || 'list';
      const dbp = getDbPath();
      const dbExists = existsSync(dbp);
      if (sub === 'list' || sub === '') {
        if (!dbExists) {
          if (useJson) {
            console.log('[]');
          } else {
            console.log('No webhooks configured.');
          }
          break;
        }
        const agent = new AgentTrace({ dbPath: dbp, silent: true });
        try {
          const webhooks = agent.getWebhooks();
          if (useJson) {
            console.log(JSON.stringify(webhooks, null, 2));
          } else if (webhooks.length === 0) {
            console.log('No webhooks configured.');
          } else {
            printWebhooksTable(webhooks);
          }
        } finally {
          agent.close();
        }
        break;
      }
      // For add/remove/test, require existing db
      if (!dbExists) {
        console.error(`No ${dbp} found in current directory.`);
        console.error('Run "agenttrace init" to create one.');
        process.exit(1);
      }
      const agent = new AgentTrace({ dbPath: dbp, silent: true });
      try {
        if (sub === 'add') {
          const url = flags.url ? String(flags.url) : '';
          const eventsRaw = flags.events ? String(flags.events) : '';
          if (!url) {
            console.error(
              'Usage: agenttrace webhook add --url <url> [--events <event1,event2,...>]',
            );
            console.error(
              'Events: trace.complete, trace.error, run.complete, run.error, cost.threshold, agent.inactive',
            );
            process.exit(1);
          }
          const defaultEvents: import('@agenttrace-io/sdk').WebhookEvent[] = [
            'trace.complete',
            'trace.error',
            'run.complete',
            'run.error',
            'cost.threshold',
            'agent.inactive',
          ];
          const events = eventsRaw
            ? eventsRaw
                .split(',')
                .map((e) => e.trim())
                .filter(Boolean)
            : defaultEvents;
          const id = agent.addWebhook(url, events as import('@agenttrace-io/sdk').WebhookEvent[]);
          if (useJson) {
            console.log(JSON.stringify({ id, url, events }, null, 2));
          } else {
            console.log(
              `Registered webhook: ${id.substring(0, 8)} -> ${url} (${events.join(',')})`,
            );
          }
          break;
        }
        if (sub === 'remove') {
          const id = flags.id ? String(flags.id) : '';
          if (!id) {
            console.error('Usage: agenttrace webhook remove --id <id>');
            process.exit(1);
          }
          const webhooks = agent.getWebhooks();
          const match = webhooks.find((w) => w.id.startsWith(id) || w.id === id);
          if (!match) {
            console.error(`Webhook '${id}' not found.`);
            process.exit(1);
          }
          agent.removeWebhook(match.id);
          if (useJson) {
            console.log(JSON.stringify({ id: match.id, removed: true }, null, 2));
          } else {
            console.log(`Removed webhook ${match.id.substring(0, 8)}.`);
          }
          break;
        }
        if (sub === 'test') {
          const id = flags.id ? String(flags.id) : '';
          if (!id) {
            console.error('Usage: agenttrace webhook test --id <id>');
            process.exit(1);
          }
          const webhooks = agent.getWebhooks();
          const match = webhooks.find((w) => w.id.startsWith(id) || w.id === id);
          if (!match) {
            console.error(`Webhook '${id}' not found.`);
            process.exit(1);
          }
          const result = await agent.testWebhook(match.id);
          if (useJson) {
            console.log(JSON.stringify(result, null, 2));
          } else if (result.ok) {
            console.log(`Webhook ${match.id.substring(0, 8)} delivered (HTTP ${result.status}).`);
          } else {
            console.log(
              `Webhook ${match.id.substring(0, 8)} failed: ${result.error || `HTTP ${result.status}`}`,
            );
          }
          break;
        }
        console.error(`Unknown webhook subcommand: ${sub}`);
        printUsage();
        process.exit(1);
      } finally {
        agent.close();
      }
      break;
    }

    case 'cleanup': {
      const dbp = getDbPath();
      if (!existsSync(dbp)) {
        console.error(`No ${dbp} found in current directory.`);
        console.error('Run "agenttrace init" to create one.');
        process.exit(1);
      }
      const storage = new TraceStorage(dbp);
      const rawDays = flags.days ? parseInt(String(flags.days), 10) : NaN;
      const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 30;
      const cutoff = Date.now() - days * 86400000;
      const tracesDeleted = storage.cleanupOldTraces(cutoff);
      const runsDeleted = storage.cleanupOldRuns(cutoff);
      const usageDeleted = storage.cleanupOldAgentUsage(cutoff);
      storage.close();
      if (useJson) {
        console.log(JSON.stringify({ tracesDeleted, runsDeleted, usageDeleted, days }, null, 2));
      } else {
        console.log(`Cleanup complete (older than ${days} days):`);
        console.log(`  Traces deleted:  ${tracesDeleted}`);
        console.log(`  Runs deleted:    ${runsDeleted}`);
        console.log(`  Usage deleted:   ${usageDeleted}`);
      }
      break;
    }

    case 'retention': {
      const dbp = getDbPath();
      const dbExists = existsSync(dbp);
      const argvArgs2 = process.argv.slice(2);
      const idx2 = argvArgs2.indexOf('retention');
      let sub = 'show';
      if (idx2 !== -1) {
        for (let k = idx2 + 1; k < argvArgs2.length; k++) {
          const c = argvArgs2[k];
          if (typeof c === 'string' && !c.startsWith('-')) {
            sub = c;
            break;
          }
        }
      }

      if (sub === 'show' || sub === 'stats') {
        if (!dbExists) {
          if (useJson) {
            console.log(JSON.stringify({ error: 'no database' }, null, 2));
          } else {
            console.log('No database found. Run "agenttrace init" first.');
          }
          break;
        }
        const storage = new TraceStorage(dbp);
        const policy = storage.getRetentionPolicy();
        const stats = storage.getStorageStats();
        storage.close();
        if (useJson) {
          console.log(JSON.stringify({ policy, stats }, null, 2));
        } else {
          console.log('Retention Policy:');
          console.log(`  Retention days:        ${policy.retentionDays}`);
          console.log(`  Cleanup interval (hrs): ${policy.cleanupIntervalHours}`);
          console.log('');
          console.log('Storage Stats:');
          console.log(`  DB size:      ${stats.totalSizeBytes} bytes`);
          console.log(`  Trace count:  ${stats.traceCount}`);
          console.log(`  Run count:    ${stats.runCount}`);
          if (stats.oldestTrace) {
            console.log(
              `  Oldest trace: ${new Date(stats.oldestTrace).toISOString().slice(0, 19)}`,
            );
          }
          if (stats.newestTrace) {
            console.log(
              `  Newest trace: ${new Date(stats.newestTrace).toISOString().slice(0, 19)}`,
            );
          }
        }
        break;
      }

      if (!dbExists) {
        console.error(`No ${dbp} found in current directory.`);
        console.error('Run "agenttrace init" to create one.');
        process.exit(1);
      }
      const storage = new TraceStorage(dbp);

      if (sub === 'set') {
        const rawDays = flags.days ? parseInt(String(flags.days), 10) : NaN;
        if (!Number.isFinite(rawDays) || rawDays < 0) {
          console.error('Usage: agenttrace retention set --days <N> [--interval <H>]');
          storage.close();
          process.exit(1);
        }
        const interval = flags.interval ? parseInt(String(flags.interval), 10) : undefined;
        storage.setRetentionPolicy(
          rawDays,
          Number.isFinite(interval) && interval! > 0 ? interval : undefined,
        );
        storage.close();
        if (useJson) {
          console.log(
            JSON.stringify(
              { retentionDays: rawDays, cleanupIntervalHours: interval || 24 },
              null,
              2,
            ),
          );
        } else {
          console.log(`Retention policy set: ${rawDays} days, cleanup every ${interval || 24}h`);
        }
        break;
      }

      console.error(`Unknown retention subcommand: ${sub}`);
      printUsage();
      storage.close();
      process.exit(1);
      break;
    }

    case 'key': {
      const dbp = getDbPath();
      const dbExists = existsSync(dbp);
      const argvArgs3 = process.argv.slice(2);
      const idx3 = argvArgs3.indexOf('key');
      let sub = 'list';
      if (idx3 !== -1) {
        for (let k = idx3 + 1; k < argvArgs3.length; k++) {
          const c = argvArgs3[k];
          if (typeof c === 'string' && !c.startsWith('-')) {
            sub = c;
            break;
          }
        }
      }

      if (sub === 'list') {
        if (!dbExists) {
          if (useJson) {
            console.log('[]');
          } else {
            console.log('No API keys found.');
          }
          break;
        }
        const storage = new TraceStorage(dbp);
        const keys = storage.getApiKeys();
        storage.close();
        if (useJson) {
          console.log(JSON.stringify(keys, null, 2));
        } else if (keys.length === 0) {
          console.log('No API keys found.');
        } else {
          console.log('API Keys:');
          for (const k of keys) {
            const status = k.enabled ? 'enabled' : 'disabled';
            const last = k.lastUsedAt ? new Date(k.lastUsedAt).toISOString().slice(0, 19) : 'never';
            console.log(`  ${k.id.substring(0, 8)}  ${k.name}  [${status}]  last_used=${last}`);
          }
        }
        break;
      }

      if (!dbExists) {
        console.error(`No ${dbp} found in current directory.`);
        console.error('Run "agenttrace init" to create one.');
        process.exit(1);
      }
      const storage = new TraceStorage(dbp);

      if (sub === 'create') {
        const name = flags.name ? String(flags.name) : '';
        if (!name) {
          console.error('Usage: agenttrace key create --name <name>');
          storage.close();
          process.exit(1);
        }
        const created = storage.createApiKey(name);
        storage.close();
        if (useJson) {
          console.log(
            JSON.stringify(
              {
                id: created.id,
                name: created.name,
                key: created.key,
                preview: created.preview,
                createdAt: created.createdAt,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(`Created API key: ${created.name}`);
          console.log(`  ID:      ${created.id.substring(0, 8)}`);
          console.log(`  Key:     ${created.key}`);
          console.log(`  Preview: ${created.preview}`);
          console.log('  (Store this key — it will not be shown again)');
        }
        break;
      }

      if (sub === 'revoke' || sub === 'delete' || sub === 'remove') {
        const id = flags.id ? String(flags.id) : '';
        if (!id) {
          console.error('Usage: agenttrace key revoke --id <id>');
          storage.close();
          process.exit(1);
        }
        storage.revokeApiKey(id);
        storage.close();
        if (useJson) {
          console.log(JSON.stringify({ revoked: true, id }, null, 2));
        } else {
          console.log(`Revoked API key ${id.substring(0, 8)}`);
        }
        break;
      }

      console.error(`Unknown key subcommand: ${sub}`);
      printUsage();
      storage.close();
      process.exit(1);
      break;
    }

    case 'benchmark': {
      const trace = getAgentTrace();
      const results: Array<{ name: string; ops: number; durationMs: number; opsPerSec: number }> =
        [];

      // Write benchmark
      {
        const start = Date.now();
        const ops = 100;
        for (let i = 0; i < ops; i++) {
          trace.startRun(`bench-${i}`);
          trace.completeRun();
        }
        const durationMs = Date.now() - start;
        results.push({
          name: 'write',
          ops,
          durationMs,
          opsPerSec: Math.round((ops / durationMs) * 1000),
        });
      }

      // Read benchmark
      {
        const start = Date.now();
        const runs = trace.getRuns(1000);
        const durationMs = Date.now() - start;
        results.push({
          name: 'read',
          ops: runs.length,
          durationMs,
          opsPerSec: Math.round((runs.length / Math.max(1, durationMs)) * 1000),
        });
      }

      // Stats benchmark
      {
        const start = Date.now();
        const iterations = 10;
        for (let i = 0; i < iterations; i++) {
          trace.getStats();
        }
        const durationMs = Date.now() - start;
        results.push({
          name: 'stats',
          ops: iterations,
          durationMs,
          opsPerSec: Math.round((iterations / durationMs) * 1000),
        });
      }

      trace.close();

      if (useJson) {
        console.log(JSON.stringify({ results }, null, 2));
      } else {
        console.log('Benchmark Results:');
        for (const r of results) {
          console.log(`  ${r.name}: ${r.ops} ops in ${r.durationMs}ms (${r.opsPerSec} ops/sec)`);
        }
      }
      break;
    }

    case 'budget':
    case 'budget-check': {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const budgetArgv = process.argv.slice(2);
      const budgetIdx = budgetArgv.indexOf(command);
      let budgetSub = command === 'budget-check' ? 'check' : 'list';
      let budgetAgent: string | undefined;
      if (budgetIdx !== -1) {
        for (let k = budgetIdx + 1; k < budgetArgv.length; k++) {
          const c = budgetArgv[k];
          if (typeof c === 'string' && !c.startsWith('-')) {
            if (budgetSub === 'list' || budgetSub === 'check') {
              budgetSub = c;
            } else if (!budgetAgent) {
              budgetAgent = c;
            }
          }
        }
      }
      const sub = (flags.sub as string) || budgetSub;
      const agent = (flags.agent ? String(flags.agent) : undefined) || budgetAgent || undefined;
      const dbp = getDbPath();
      const storage = new TraceStorage(dbp);
      try {
        const _db = (storage as any).db;
        if (sub === 'list' || sub === '') {
          const rows =
            (storage as any).db.prepare('SELECT * FROM budgets ORDER BY agent_name').all() || [];
          if (useJson) {
            console.log(
              JSON.stringify(
                rows.map((r: any) => ({
                  agent: r.agent_name,
                  maxTokensPerDay: r.max_tokens_per_day,
                  maxCostPerDay: r.max_cost_per_day,
                })),
                null,
                2,
              ),
            );
          } else if (!rows || rows.length === 0) {
            console.log('No budgets configured.');
          } else {
            console.log('Budgets:');
            for (const r of rows as any[]) {
              console.log(
                `  ${r.agent_name}: tokens=${r.max_tokens_per_day || 0}/day cost=$${(r.max_cost_per_day || 0).toFixed(2)}/day`,
              );
            }
          }
          break;
        }
        if (sub === 'set') {
          const name = agent || '';
          if (!name) {
            console.error('Usage: agenttrace budget set <agent-name> --tokens <N> --cost <M>');
            process.exit(1);
          }
          const maxTokens = flags.tokens ? parseInt(String(flags.tokens), 10) || 0 : 0;
          const maxCost = flags.cost ? parseFloat(String(flags.cost)) || 0 : 0;
          const now = Date.now();
          (storage as any).db
            .prepare(
              `
            INSERT OR REPLACE INTO budgets (agent_name, max_tokens_per_day, max_cost_per_day, created_at)
            VALUES (?, ?, ?, ?)
          `,
            )
            .run(name, maxTokens, maxCost, now);
          if (useJson) {
            console.log(
              JSON.stringify(
                { agent: name, maxTokensPerDay: maxTokens, maxCostPerDay: maxCost },
                null,
                2,
              ),
            );
          } else {
            console.log(
              `Budget set for ${name}: ${maxTokens} tokens/day, $${maxCost.toFixed(2)} cost/day`,
            );
          }
          break;
        }
        // status or check
        const name = agent || '';
        if (!name) {
          console.error(
            'Usage: agenttrace budget status <agent-name>  or  budget check <agent-name>',
          );
          process.exit(1);
        }
        const brow = (storage as any).db
          .prepare('SELECT * FROM budgets WHERE agent_name = ?')
          .get(name) as any;
        const maxT = brow ? Number(brow.max_tokens_per_day || 0) : 0;
        const maxC = brow ? Number(brow.max_cost_per_day || 0) : 0;
        const dayStart = getDayStart(Date.now());
        const urow = (storage as any).db
          .prepare(
            'SELECT COALESCE(SUM(tokens_used),0) as t, COALESCE(SUM(cost_usd),0) as c FROM agent_usage WHERE agent_name = ? AND created_at >= ?',
          )
          .get(name, dayStart) as any;
        const usedT = urow ? Number(urow.t || 0) : 0;
        const usedC = urow ? Number(urow.c || 0) : 0;
        // projected daily
        const elapsed = Date.now() - dayStart;
        const dayMs = 86400000;
        const frac = elapsed > 0 ? Math.min(1, elapsed / dayMs) : 1;
        const projT = frac > 0 ? Math.round(usedT / frac) : usedT;
        const projC = frac > 0 ? usedC / frac : usedC;
        const overT = maxT > 0 && usedT > maxT;
        const overC = maxC > 0 && usedC > maxC;
        const isOver = overT || overC;
        if (sub === 'check' || command === 'budget-check') {
          storage.close();
          if (isOver) {
            if (!useJson) console.error(`Over budget for ${name}`);
            process.exit(1);
          } else {
            process.exit(0);
          }
        }
        if (useJson) {
          console.log(
            JSON.stringify(
              {
                agent: name,
                maxTokensPerDay: maxT,
                maxCostPerDay: maxC,
                usedTokens: usedT,
                usedCostUsd: usedC,
                projectedTokens: projT,
                projectedCostUsd: Number(projC.toFixed(4)),
                overBudget: isOver,
                overTokens: overT,
                overCost: overC,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(`Budget status for ${name}:`);
          console.log(`  Tokens today: ${usedT} / ${maxT || '∞'}  (projected ~${projT})`);
          console.log(
            `  Cost today:   $${usedC.toFixed(4)} / $${maxC.toFixed(2) || '∞'}  (projected ~$${projC.toFixed(4)})`,
          );
          if (isOver) {
            console.log('  *** OVER BUDGET ***');
          }
        }
      } finally {
        storage.close();
      }
      break;
    }

    case 'daemon': {
      let sub = (() => {
        const argvArgs = process.argv.slice(2);
        const idx = argvArgs.indexOf('daemon');
        if (idx === -1) return undefined;
        for (let k = idx + 1; k < argvArgs.length; k++) {
          const c = argvArgs[k];
          if (typeof c === 'string' && !c.startsWith('-')) return c;
        }
        return undefined;
      })();

      const agenttraceDir = (() => {
        const home = homedir();
        const xdgData = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
        const dir = join(xdgData, 'agenttrace');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return dir;
      })();
      const pidFile = join(agenttraceDir, 'daemon.pid');
      const logFile = join(agenttraceDir, 'daemon.log');

      if (sub === 'stop') {
        if (!existsSync(pidFile)) {
          console.log('Daemon is not running.');
          break;
        }
        const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`Daemon stopped (PID ${pid}).`);
        } catch {
          console.log(`Daemon not running (stale PID file removed).`);
        }
        try {
          unlinkSync(pidFile);
        } catch {
          /* ignore */
        }
        break;
      }

      if (sub === 'restart') {
        // Stop if running
        if (existsSync(pidFile)) {
          const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
          try {
            process.kill(pid, 'SIGTERM');
            console.log(`Daemon stopped (PID ${pid}).`);
          } catch {
            /* already dead */
          }
          try {
            unlinkSync(pidFile);
          } catch {
            /* ignore */
          }
          // Wait for process to fully exit
          await new Promise((r) => setTimeout(r, 1000));
        }
        // Fall through to start logic below
        sub = undefined as any; // triggers the start path
      }

      if (sub === 'status') {
        if (!existsSync(pidFile)) {
          console.log('Daemon: stopped');
          break;
        }
        const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        try {
          process.kill(pid, 0);
          console.log(`Daemon: running (PID ${pid})`);
          console.log(`  PID file: ${pidFile}`);
          console.log(`  Log file: ${logFile}`);
        } catch {
          console.log('Daemon: stopped (stale PID file)');
        }
        break;
      }

      // Check if already running (applies to both start and __run)
      if (existsSync(pidFile)) {
        const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        try {
          process.kill(pid, 0);
          console.log(`Daemon already running (PID ${pid}). Use 'agenttrace daemon stop' first.`);
          process.exit(1);
        } catch {
          /* stale PID file, continue */
          try {
            unlinkSync(pidFile);
          } catch {
            /* ignore */
          }
        }
      }

      const dbPath = getDbPath();
      const port = parseInt((flags['port'] as string) || '4317', 10);
      const host = (flags['host'] as string) || '127.0.0.1';

      // 'start' (or default): spawn a DETACHED child running '__run', then return.
      // '__run' is the internal worker that actually blocks and serves.
      if (sub !== '__run') {
        const { spawn } = await import('node:child_process');
        const selfPath = process.argv[1] || 'agenttrace';
        const childArgs = [selfPath, 'daemon', '__run'];
        if (flags['port']) childArgs.push('--port', String(port));
        if (flags['host']) childArgs.push('--host', host);
        if (flags['scan'] === false) childArgs.push('--no-scan');
        if (flags['scan-interval'])
          childArgs.push('--scan-interval', String(flags['scan-interval']));

        const out = openSync(logFile, 'a');
        const child = spawn(process.execPath, childArgs, {
          detached: true,
          stdio: ['ignore', out, out],
          env: process.env,
        });
        child.unref();

        // Wait briefly and confirm the child wrote its PID file / is alive.
        await new Promise((r) => setTimeout(r, 600));
        console.log(`[AgentTrace] Daemon started (PID ${child.pid}).`);
        console.log(`[AgentTrace] Dashboard: http://${host}:${port}`);
        console.log(`[AgentTrace] Log: ${logFile}`);
        console.log(`[AgentTrace] Stop with: agenttrace daemon stop`);
        process.exit(0);
      }

      // ---- __run worker (blocking) ----
      // Write PID file
      writeFileSync(pidFile, String(process.pid), 'utf-8');

      // Open log file
      const logFd = openSync(logFile, 'a');

      // Redirect stdout/stderr to log file
      process.stdout.write = ((chunk: any) => {
        writeSync(logFd, typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      }) as any;
      process.stderr.write = ((chunk: any) => {
        writeSync(logFd, typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      }) as any;

      console.log(`[AgentTrace] Daemon starting (PID ${process.pid})`);
      console.log(`[AgentTrace] DB: ${dbPath}`);
      console.log(`[AgentTrace] Dashboard: http://${host}:${port}`);
      console.log(`[AgentTrace] Log: ${logFile}`);

      // Start dashboard
      const { startDashboard } = await import('@agenttrace-io/dashboard');
      const server = startDashboard({ port, host, dbPath });

      // Start background agent scanning
      const scanIntervalMs = parseInt((flags['scan-interval'] as string) || '30000', 10);
      const doScan = flags['scan'] !== false; // default true

      let scanTimer: ReturnType<typeof setInterval> | null = null;
      if (doScan) {
        const runScan = async () => {
          try {
            const { execSync } = await import('node:child_process');
            const localList = execSync('ps aux', { encoding: 'utf8', timeout: 5000 });
            const trace = new AgentTrace({ dbPath, silent: true });
            const agents = detectAgents(localList, 'linux');
            for (const agent of agents) {
              trace.recordAgentUsage({
                agentName: agent.name,
                agentType: agent.framework || 'unknown',
                action: 'detected',
                target: agent.cmdline.substring(0, 200),
                status: 'success',
                tokensUsed: 0,
                costUsd: 0,
                durationMs: 0,
                metadata: { pid: agent.pid, runtime: agent.runtime, platform: agent.platform },
              });
            }
            trace.close();
          } catch {
            /* non-fatal */
          }
        };

        // Initial scan
        runScan();
        scanTimer = setInterval(runScan, scanIntervalMs);
      }

      // Graceful shutdown
      const cleanup = () => {
        console.log('[AgentTrace] Daemon shutting down...');
        if (scanTimer) clearInterval(scanTimer);
        server.close();
        try {
          unlinkSync(pidFile);
        } catch {
          /* ignore */
        }
        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
      process.on('exit', () => {
        if (scanTimer) clearInterval(scanTimer);
      });

      // Keep alive
      // (server.listen already keeps the event loop alive)
      break;
    }

    case 'service': {
      const sub = (() => {
        const argvArgs = process.argv.slice(2);
        const idx = argvArgs.indexOf('service');
        if (idx === -1) return undefined;
        for (let k = idx + 1; k < argvArgs.length; k++) {
          const c = argvArgs[k];
          if (typeof c === 'string' && !c.startsWith('-')) return c;
        }
        return undefined;
      })();

      if (sub === 'install') {
        const binPath = process.argv[1] || 'agenttrace';
        if (process.platform === 'win32') {
          console.log('On Windows, use Task Scheduler:');
          console.log('  1. Open Task Scheduler');
          console.log('  2. Create Basic Task → "AgentTrace Daemon"');
          console.log('  3. Trigger: At startup');
          console.log('  4. Action: Start a program');
          console.log(`     Program: ${binPath}`);
          console.log('     Arguments: daemon __run');
          break;
        }

        const systemdDir = join(homedir(), '.config', 'systemd', 'user');
        const systemdFile = join(systemdDir, 'agenttrace.service');

        if (process.platform === 'darwin') {
          // macOS launchd
          const plistDir = join(homedir(), 'Library', 'LaunchAgents');
          const plistFile = join(plistDir, 'com.agenttrace.daemon.plist');
          if (!existsSync(plistDir)) mkdirSync(plistDir, { recursive: true });
          const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agenttrace.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binPath}</string>
    <string>daemon</string>
    <string>__run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), '.local', 'share', 'agenttrace', 'daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), '.local', 'share', 'agenttrace', 'daemon.log')}</string>
</dict>
</plist>`;
          writeFileSync(plistFile, plist, 'utf-8');
          console.log(`Installed launchd plist: ${plistFile}`);
          console.log(
            'Start now:  launchctl load ~/Library/LaunchAgents/com.agenttrace.daemon.plist',
          );
          console.log(
            'Stop:       launchctl unload ~/Library/LaunchAgents/com.agenttrace.daemon.plist',
          );
          console.log('Status:     launchctl list | grep agenttrace');
        } else {
          // Linux systemd
          if (!existsSync(systemdDir)) mkdirSync(systemdDir, { recursive: true });
          const unit = `[Unit]
Description=AgentTrace Daemon - Local AI agent observability
After=network.target

[Service]
Type=simple
ExecStart=${binPath} daemon __run
Restart=on-failure
RestartSec=5
StandardOutput=append:${join(homedir(), '.local', 'share', 'agenttrace', 'daemon.log')}
StandardError=append:${join(homedir(), '.local', 'share', 'agenttrace', 'daemon.log')}

[Install]
WantedBy=default.target
`;
          writeFileSync(systemdFile, unit, 'utf-8');
          console.log(`Installed systemd user service: ${systemdFile}`);
          console.log('');
          console.log('Start now:  systemctl --user start agenttrace');
          console.log('Enable:     systemctl --user enable agenttrace');
          console.log('Status:     systemctl --user status agenttrace');
          console.log('Logs:       journalctl --user -u agenttrace -f');
        }
        break;
      }

      if (sub === 'uninstall') {
        if (process.platform === 'darwin') {
          const plistFile = join(
            homedir(),
            'Library',
            'LaunchAgents',
            'com.agenttrace.daemon.plist',
          );
          if (existsSync(plistFile)) {
            unlinkSync(plistFile);
            console.log(`Removed: ${plistFile}`);
            console.log(
              'Unload:  launchctl unload ~/Library/LaunchAgents/com.agenttrace.daemon.plist',
            );
          } else {
            console.log('No launchd plist found.');
          }
        } else if (process.platform !== 'win32') {
          const systemdFile = join(homedir(), '.config', 'systemd', 'user', 'agenttrace.service');
          if (existsSync(systemdFile)) {
            unlinkSync(systemdFile);
            console.log(`Removed: ${systemdFile}`);
            console.log('Disable: systemctl --user disable agenttrace');
            console.log('Reload:  systemctl --user daemon-reload');
          } else {
            console.log('No systemd service found.');
          }
        } else {
          console.log('On Windows, remove the Task Scheduler entry manually.');
        }
        break;
      }

      console.log('Usage: agenttrace service <install|uninstall>');
      break;
    }

    case 'status': {
      // Single-glance overview: daemon, dashboard, agents, recent activity
      const dbp = getDbPath();
      const useJsonLocal = useJson;
      const GREEN = '\x1b[32m';
      const YELLOW = '\x1b[33m';
      const RED = '\x1b[31m';
      const RESET = '\x1b[0m';

      const statusData: Record<string, unknown> = { version: VERSION };

      // Daemon status
      const agenttraceDir = (() => {
        const home = homedir();
        const xdgData = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
        return join(xdgData, 'agenttrace');
      })();
      const pidFile = join(agenttraceDir, 'daemon.pid');
      let daemonRunning = false;
      let daemonPid: number | null = null;
      if (existsSync(pidFile)) {
        try {
          daemonPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
          if (daemonPid) process.kill(daemonPid, 0);
          daemonRunning = true;
        } catch {
          daemonRunning = false;
        }
      }
      statusData.daemon = { running: daemonRunning, pid: daemonPid };

      // Dashboard check
      let dashRunning = false;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const resp = await fetch('http://127.0.0.1:4317/api/health', {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (resp.ok) {
          const data = (await resp.json()) as Record<string, unknown>;
          dashRunning = data?.status === 'healthy';
          const checks = data?.checks as Record<string, unknown> | undefined;
          const dbCheck = checks?.database as Record<string, unknown> | undefined;
          statusData.dashboard = {
            running: dashRunning,
            uptime: data?.uptime,
            activeAgents: checks?.activeAgents,
            totalTraces: dbCheck?.traceCount,
          };
        }
      } catch {
        /* not reachable */
      }
      if (!dashRunning) statusData.dashboard = { running: false };

      // Database stats
      let dbOk = false;
      let dbTraces = 0;
      let dbSize = 0;
      try {
        const tr = new AgentTrace({ dbPath: dbp, silent: true });
        const h = tr.getHealth();
        dbOk = h.status === 'ok';
        dbTraces = h.traceCount;
        dbSize = h.dbSize;
        tr.close();
      } catch {
        /* empty db or missing */
      }
      statusData.database = { ok: dbOk, path: dbp, traces: dbTraces, size: dbSize };

      if (useJsonLocal) {
        console.log(JSON.stringify(statusData, null, 2));
      } else {
        const daemonStr = daemonRunning
          ? `${GREEN}running${RESET} (PID ${daemonPid})`
          : `${YELLOW}stopped${RESET}`;
        const dashStr = dashRunning
          ? `${GREEN}running${RESET} (http://127.0.0.1:4317)`
          : `${YELLOW}not running${RESET}`;
        const dbStr = dbOk ? `${GREEN}ok${RESET}` : `${RED}unavailable${RESET}`;

        console.log(`AgentTrace Status`);
        console.log(`================`);
        console.log(`Version:    ${VERSION}`);
        console.log(`Daemon:     ${daemonStr}`);
        console.log(`Dashboard:  ${dashStr}`);
        console.log(`Database:   ${dbStr} (${dbp})`);
        if (dbOk) {
          console.log(`  Traces: ${dbTraces}  Size: ${dbSize}B`);
        }
        if (dashRunning && statusData.dashboard) {
          const d = statusData.dashboard as Record<string, unknown>;
          if (d.activeAgents) console.log(`  Active agents: ${d.activeAgents}`);
        }
        if (!daemonRunning) {
          console.log(`\nStart daemon: ${GREEN}agenttrace daemon start${RESET}`);
        } else if (!dashRunning) {
          console.log(`\nDashboard not responding despite daemon running. Check logs.`);
        }
      }
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}

async function checkForUpdates(): Promise<void> {
  try {
    const { execSync } = await import('node:child_process');
    const latest = execSync(`npm view ${PACKAGE_NAME} version --prefer-online`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (latest && /^\d+\.\d+\.\d+$/.test(latest)) {
      // Only notify if npm version is strictly newer
      const [lMaj = 0, lMin = 0, lPat = 0] = latest.split('.').map(Number);
      const [vMaj = 0, vMin = 0, vPat = 0] = VERSION.split('.').map(Number);
      const isNewer =
        lMaj > vMaj ||
        (lMaj === vMaj && lMin > vMin) ||
        (lMaj === vMaj && lMin === vMin && lPat > vPat);
      if (isNewer) {
        console.log(
          `\n  \x1b[33m▲ AgentTrace update available: v${VERSION} → v${latest}\x1b[0m\n  \x1b[2m  Run: agenttrace update\x1b[0m\n`,
        );
      }
    }
  } catch {
    /* silent */
  }
}

function main(): void | Promise<void> {
  // Non-blocking version check (runs in background, prints notice if outdated)
  checkForUpdates().catch(() => {
    /* silent */
  });
  try {
    const result = runMain();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<void>).catch((err: unknown) => {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
    }
  } catch (err: unknown) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Run CLI main() only when this file is executed directly (bin or `node dist/index.js`).
// Prevents side effects (e.g. printing help) when the module is imported (tests, `require`/`import`).
const isMain = (() => {
  try {
    const invoked = process.argv[1];
    if (!invoked) return false;
    // Resolve symlinks (npm bin symlinks point to dist/index.js)
    let resolved: string;
    try {
      resolved = realpathSync(invoked);
    } catch {
      resolved = invoked;
    }
    // Check resolved path and raw path for all known entry points
    const targets = [resolved, invoked];
    for (const t of targets) {
      if (
        t.endsWith('dist/index.js') ||
        t.includes('@agenttrace-io/cli') ||
        t.includes('agenttrace-io/cli') ||
        t.endsWith('/agenttrace-io') || // also matches agenttrace-io
        t.endsWith('/agenttrace')
      ) {
        return true;
      }
    }
    // Fallback: check if this module is the entry point via import.meta.url
    const thisFile = fileURLToPath(import.meta.url);
    if (resolved === thisFile || invoked === thisFile) return true;
    return false;
  } catch (_) {
    return false;
  }
})();

if (isMain) {
  const result = main();
  if (result && typeof (result as any).then === 'function') {
    (result as Promise<void>).catch((err: unknown) => {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  }
}

export { main };
