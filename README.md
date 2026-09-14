# AgentPulse ⚡

<p align="center">
  <img src="docs/assets/logo.svg" width="100" height="100" alt="AgentPulse logo" />
</p>

<h3 align="center">Open-Source AI Agent Observability & Telemetry Platform</h3>
<p align="center"><b>Local-First. Zero Cloud Dependency. Privacy-Preserving SQLite Storage.</b></p>

<p align="center">
  <a href="https://github.com/nachiket0987/agentpulse"><img src="https://img.shields.io/badge/Author-Nachiket%20Gadilohar-indigo?style=for-the-badge&logo=github" alt="Author" /></a>
  <a href="https://linkedin.com/in/nachiket-gadilohar-profile/"><img src="https://img.shields.io/badge/LinkedIn-Nachiket%20Gadilohar-blue?style=for-the-badge&logo=linkedin" alt="LinkedIn" /></a>
  <a href="https://github.com/nachiket0987/agentpulse/actions"><img src="https://img.shields.io/github/actions/workflow/status/nachiket0987/agentpulse/ci.yml?branch=main&label=CI&style=for-the-badge" alt="CI Status" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white" />
  <img src="https://img.shields.io/badge/Express.js-000000?style=flat-square&logo=express&logoColor=white" />
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/OpenTelemetry-000000?style=flat-square&logo=opentelemetry&logoColor=white" />
</p>

---

## 🚀 Overview

**AgentPulse** delivers end-to-end telemetry and operational visibility into autonomous AI agents, multi-agent frameworks, and LLM execution pipelines. 

Every prompt token, completion output, tool invocation, model cost, and subagent tree execution is stored **locally on your host system** inside an embedded SQLite database (`agentpulse.db` in WAL mode). No cloud servers. No subscriptions. No data leakage.

```bash
# Trace any CLI agent in one line (zero code modification required)
agentpulse wrap claude "Write a hello world function"

# Launch local interactive web dashboard
agentpulse dashboard
# → Serving live at http://127.0.0.1:4317
```

---

## ✨ Key Features

- ⚡ **Zero-Config CLI Wrapper (`agentpulse wrap`)**: Instantly intercept and record any terminal command or CLI binary without code changes.
- 💰 **Real-Time Token & Cost Analytics**: Auto-calculates prompt and completion costs using built-in model pricing metrics (GPT-4o, Claude 3.5 Sonnet, Llama, etc.).
- 🌲 **Multi-Agent Tree Hierarchy**: Trace nested parent-child agent workflows, recursive tool executions, and step latencies.
- 🛡️ **Budget Guardrails & Alerts**: Define per-agent daily token and monetary thresholds with instant local webhook notifications on breach.
- 📊 **Local Dark Web Dashboard**: Embedded Express server serving real-time filterable UI, run logs, and trace tree drill-downs.
- 🔌 **Native SDKs & Middleware**: Drop-in support for Node.js/TypeScript, Python, CrewAI, and LangGraph.
- 📡 **OpenTelemetry (OTLP) Export**: Export trace events in standard OTLP JSON format for enterprise monitoring integrations.

---

## 🏗️ Architecture & Data Flow

```mermaid
graph TB
    subgraph Agents["AI Agent Runtimes"]
        A1["CLI Commands<br/>('agentpulse wrap')"]
        A2["TypeScript SDK<br/>(@agentpulse-io/sdk)"]
        A3["Python SDK<br/>(agentpulse-io)"]
        A4["LangGraph & CrewAI<br/>Middleware"]
    end

    subgraph CoreEngine["AgentPulse Engine & Storage"]
        DB[("Embedded SQLite<br/>agentpulse.db (WAL Mode)")]
        COST["Model Pricing & Cost Engine"]
        ALERT["Budget Guardrail & Webhooks"]
    end

    subgraph Interfaces["Presentation Layer"]
        CLI["Terminal CLI<br/>(agentpulse)"]
        DASH["Express Web UI<br/>(http://127.0.0.1:4317)"]
        OTEL["OTLP Exporter"]
    end

    A1 --> A2
    A4 --> A3
    A2 --> COST --> DB
    A3 --> COST --> DB

    DB --> CLI
    DB --> DASH
    A2 --> ALERT
    A2 --> OTEL
```

---

## 📦 Setup & Installation

### 1. Global CLI Installation
```bash
npm install -g @agentpulse-io/cli

# Verify installation
agentpulse --version
```

### 2. TypeScript / Node.js SDK
```bash
npm install @agentpulse-io/sdk
```

```typescript
import { AgentPulse } from '@agentpulse-io/sdk';

const agent = new AgentPulse({ dbPath: './agentpulse.db' });
const runId = agent.startRun('research-agent');

const result = await agent.trace('search_step', async () => {
  return await performWebSearch("AgentPulse architecture");
}, {
  model: 'gpt-4o',
  tokens: { promptTokens: 120, completionTokens: 45 }
});

agent.completeRun();
agent.close();
```

### 3. Python SDK
```bash
pip install agentpulse-io
```

```python
from agentpulse import AgentPulse

agent = AgentPulse(db_path='./agentpulse.db')

with agent.trace('analysis_step') as t:
    output = run_llm_chain("Summarize research paper")
    t.set_output(output)
```

---

## 🐳 Docker Deployment

Run AgentPulse standalone using Docker:

```bash
# Pull and launch standalone container
docker run -d -p 4317:4317 -v agentpulse-data:/app/data ghcr.io/nachiket0987/agentpulse:latest

# Or launch via docker-compose
docker-compose up -d
```

---

## 📚 Project Documentation

For comprehensive design and engineering documents, see the [`docs/`](file:///c:/Users/nachi/Downloads/agenttrace-main/agenttrace-main/docs) directory:

- 📄 [Product Requirement Document (PRD)](file:///c:/Users/nachi/Downloads/agenttrace-main/agenttrace-main/docs/PRD.md)
- 📄 [Software Requirements Specification (SRS)](file:///c:/Users/nachi/Downloads/agenttrace-main/agenttrace-main/docs/SRS.md)
- 📄 [System Architecture Document](file:///c:/Users/nachi/Downloads/agenttrace-main/agenttrace-main/docs/ARCHITECTURE.md)
- 📄 [UI/UX Specification Document](file:///c:/Users/nachi/Downloads/agenttrace-main/agenttrace-main/docs/UI_UX_DESIGN.md)
- 📄 [Development Plan & Roadmap](file:///c:/Users/nachi/Downloads/agenttrace-main/agenttrace-main/docs/DEVELOPMENT_PLAN.md)

---

## 👤 Author & Contact

**Nachiket Gadilohar** — AI Engineer  
- ✉️ Email: [nachiketlohar0306@gmail.com](mailto:nachiketlohar0306@gmail.com)  
- 🐙 GitHub: [@nachiket0987](https://github.com/nachiket0987)  
- 💼 LinkedIn: [Nachiket Gadilohar Profile](https://linkedin.com/in/nachiket-gadilohar-profile/)  
