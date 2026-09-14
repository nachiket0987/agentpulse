#!/usr/bin/env node

/**
 * agenttrace-instrument - CLI wrapper for zero-code auto-instrumentation
 *
 * Usage:
 *   agenttrace-instrument <runtime> [args...]
 *   agenttrace-instrument node my-agent.js
 *   agenttrace-instrument python my_agent.py
 *   agenttrace-instrument --scan
 *   agenttrace-instrument --help
 */

import { initAutoInstrument, shutdown } from './index.js';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(`
agenttrace-instrument - Zero-code auto-instrumentation for AI agents

Usage:
  agenttrace-instrument <runtime> [args...]
  agenttrace-instrument node my-agent.js
  agenttrace-instrument python my_agent.py
  agenttrace-instrument --scan     (scan for running agents)

Options:
  --db PATH          AgentTrace database path (default: ~/.agenttrace/agenttrace.db)
  --service NAME     Service name for traces (default: from package.json)
  --scan             Scan running processes for agents
  --json             Output scan results as JSON
  --verbose          Verbose output
  --console          Enable console output
  --help, -h         Show this help

Environment Variables:
  AGENTTRACE_DB_PATH        Database path
  AGENTTRACE_SERVICE_NAME   Service name
  AGENTTRACE_AUTO_INIT      Auto-init without wrapping (true/false)
  AGENTTRACE_DEBUG          Enable debug output (true/false)

Auto-detected frameworks:
  LangChain, LangGraph, CrewAI, AutoGen, LlamaIndex, DSPy,
  OpenAI SDK, Anthropic SDK, Semantic Kernel,
  any process with "agent", "llm", "gpt", "claude" in cmdline
`);
  process.exit(0);
}

// Parse options
let dbPath: string | undefined;
let serviceName: string | undefined;
let consoleOutput = false;
let doScan = false;
let jsonOutput = false;
let verbose = false;
const runtimeArgs: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--db' && rawArgs[i + 1]) {
    dbPath = rawArgs[++i];
    continue;
  }
  if (arg === '--service' && rawArgs[i + 1]) {
    serviceName = rawArgs[++i];
    continue;
  }
  if (arg === '--console') {
    consoleOutput = true;
    continue;
  }
  if (arg === '--scan') {
    doScan = true;
    continue;
  }
  if (arg === '--json') {
    jsonOutput = true;
    continue;
  }
  if (arg === '--verbose') {
    verbose = true;
    continue;
  }
  runtimeArgs.push(arg);
}

if (doScan) {
  scanAgents(jsonOutput, verbose);
  process.exit(0);
}

if (runtimeArgs.length === 0) {
  console.error('Usage: agenttrace-instrument <runtime> [args...]');
  console.error('Example: agenttrace-instrument node my-agent.js');
  process.exit(1);
}

// Initialize auto-instrumentation BEFORE running the target
initAutoInstrument({ dbPath, serviceName, console: consoleOutput });

const runtime = runtimeArgs[0];
const scriptArgs = runtimeArgs.slice(1);

if (scriptArgs.length === 0) {
  console.error(`Usage: agenttrace-instrument ${runtime} <script> [args...]`);
  shutdown();
  process.exit(1);
}

const script = scriptArgs[0];
const resolvedScript = path.resolve(process.cwd(), script);

if (!fs.existsSync(resolvedScript)) {
  console.error(`Script not found: ${script}`);
  shutdown();
  process.exit(1);
}

const child = spawn(runtime, scriptArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    AGENTTRACE_AUTO_INIT: 'true',
    AGENTTRACE_DB_PATH: dbPath || process.env.AGENTTRACE_DB_PATH || '',
    AGENTTRACE_SERVICE_NAME: serviceName || process.env.AGENTTRACE_SERVICE_NAME || '',
    AGENTTRACE_DEBUG: consoleOutput ? 'true' : 'false',
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${path.join(import.meta.dirname || '', 'index.js')}`,
    ]
      .filter(Boolean)
      .join(' '),
  },
  shell: process.platform === 'win32',
});

child.on('close', (code) => {
  shutdown();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

// ── Process Scanner ────────────────────────────────────────────────

interface AgentFramework {
  framework: string;
  patterns: string[];
}

const AGENT_FRAMEWORKS: Record<string, AgentFramework> = {
  langchain: {
    framework: 'LangChain',
    patterns: ['langchain', '@langchain', 'langgraph', 'ChatOpenAI', 'ChatAnthropic'],
  },
  crewai: { framework: 'CrewAI', patterns: ['crewai', 'Crew('] },
  autogen: {
    framework: 'AutoGen',
    patterns: ['autogen', 'ConversableAgent', 'AssistantAgent'],
  },
  openai: { framework: 'OpenAI', patterns: ['openai'] },
  anthropic: { framework: 'Anthropic', patterns: ['anthropic'] },
  llamaindex: { framework: 'LlamaIndex', patterns: ['llamaindex', 'llama-index'] },
  dspy: { framework: 'DSPy', patterns: ['dspy', 'DSPy'] },
  semantic: {
    framework: 'Semantic Kernel',
    patterns: ['semantic-kernel', 'SemanticKernel'],
  },
  hermes: { framework: 'Hermes', patterns: ['hermes', 'hermes-agent'] },
  aider: { framework: 'Aider', patterns: ['aider'] },
  cursor: { framework: 'Cursor', patterns: ['cursor-agent'] },
  codex: { framework: 'Codex', patterns: ['codex', 'openai-codex'] },
  claude: { framework: 'Claude Code', patterns: ['claude-code', 'claude_code'] },
};

interface DetectedAgent {
  pid: string;
  name: string;
  cmdline: string;
  runtime: string;
  platform: string;
  framework: string | null;
  agentType: string | null;
}

function scanAgents(json: boolean, verbose: boolean): void {
  const agents: DetectedAgent[] = [];

  // Scan WSL/Linux processes
  try {
    const ps = execSync('ps aux', { encoding: 'utf8', timeout: 5000 });
    for (const line of ps.split('\n')) {
      if (!line.trim()) continue;
      const lower = line.toLowerCase();
      const isNode = lower.includes('node ') || lower.includes('node.exe');
      const isPython = lower.includes('python') || lower.includes('python.exe');
      if (!isNode && !isPython) continue;

      let framework: string | null = null;
      let agentType: string | null = null;
      for (const [key, sig] of Object.entries(AGENT_FRAMEWORKS)) {
        if (sig.patterns.some((p) => lower.includes(p.toLowerCase()))) {
          framework = sig.framework;
          agentType = key;
          break;
        }
      }
      if (
        !framework &&
        (lower.includes('agent') ||
          lower.includes('llm') ||
          lower.includes('gpt') ||
          lower.includes('claude'))
      ) {
        agentType = 'unknown-agent';
      }
      if (agentType) {
        const parts = line.trim().split(/\s+/);
        agents.push({
          pid: parts[1] || '0',
          name: extractName(line, isNode ? 'node' : 'python'),
          cmdline: line.trim(),
          runtime: isNode ? 'node' : 'python',
          platform: 'wsl',
          framework,
          agentType,
        });
      }
    }
  } catch {
    /* ignore */
  }

  // Scan Windows processes from WSL. Pin cwd to a Windows-native path so
  // cmd.exe doesn't emit the "UNC paths are not supported" warning when the
  // process is launched from a `\\wsl.localhost\...` working directory.
  try {
    const tasklist = execSync('cmd.exe /c tasklist /fo csv /nh 2>nul', {
      encoding: 'utf8',
      timeout: 5000,
      cwd: fs.existsSync('/mnt/c') ? '/mnt/c' : undefined,
    });
    for (const line of tasklist.split('\n')) {
      if (!line.trim()) continue;
      const lower = line.toLowerCase();
      const isNode = lower.includes('node.exe');
      const isPython = lower.includes('python.exe');
      if (!isNode && !isPython) continue;

      let framework: string | null = null;
      let agentType: string | null = null;
      for (const [key, sig] of Object.entries(AGENT_FRAMEWORKS)) {
        if (sig.patterns.some((p) => lower.includes(p.toLowerCase()))) {
          framework = sig.framework;
          agentType = key;
          break;
        }
      }
      if (lower.includes('agent') || lower.includes('chatbot') || lower.includes('ai-')) {
        agentType = 'unknown-agent';
      }
      if (agentType) {
        const cols = line.split(',');
        const name = (cols[0] || '').replace(/"/g, '');
        const pid = (cols[1] || '').replace(/"/g, '');
        agents.push({
          pid,
          name,
          cmdline: line.trim(),
          runtime: isNode ? 'node' : 'python',
          platform: 'windows',
          framework,
          agentType,
        });
      }
    }
  } catch {
    /* ignore */
  }

  if (json) {
    console.log(JSON.stringify({ agents }, null, 2));
  } else {
    if (agents.length === 0) {
      console.log('[AgentTrace] No agent processes detected.');
      console.log(
        '[AgentTrace] Recognized: LangChain, CrewAI, AutoGen, OpenAI, Anthropic, LlamaIndex, DSPy, Hermes, Aider, Cursor',
      );
    } else {
      console.log(`[AgentTrace] Detected ${agents.length} agent process(es):\n`);
      for (const a of agents) {
        console.log(
          `  ${a.platform.toUpperCase().padEnd(7)} ${a.pid.padStart(7)} ${a.runtime.padEnd(7)} ${(a.framework || 'unknown').padEnd(15)} ${a.name}`,
        );
        if (verbose) console.log(`    ${a.cmdline.substring(0, 120)}`);
      }
    }
  }
}

function extractName(cmdline: string, _runtime: string): string {
  const match = cmdline.match(/(?:node|node\.exe|python|python3|python\.exe)\s+(.+?)(?:\s|$)/);
  if (match) {
    const script = match[1];
    return path.basename(script, path.extname(script)) || script;
  }
  return cmdline.split(/\s+/)[0] || 'unknown';
}
