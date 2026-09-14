# Software Requirements Specification (SRS) — AgentPulse

**Project Name:** AgentPulse  
**Author:** Nachiket Gadilohar  
**Document Status:** Final  

---

## 1. System Overview & Scope
This document specifies the functional, non-functional, security, data, and interface requirements for **AgentPulse**, an open-source, local-first AI agent observability platform.

---

## 2. User Roles & Access Control

Since AgentPulse is a local-first system designed for developer workstations, user roles are scoped locally:

| Role | Environment | Permissions |
| :--- | :--- | :--- |
| **Local Developer (Admin)** | Local Workstation | Full read/write access to local SQLite DB, CLI configuration, budget management, and web dashboard. |
| **Read-Only Viewer** | Local Network / Dashboard | Access local dashboard UI over HTTP (configurable read-only port mode). |
| **Agent Process (SDK)** | Embedded Runtime | Ingest trace events, update run records, emit metrics. |

---

## 3. Functional Requirements

### 3.1 CLI Interceptor & Subprocess Tracing
- **FR-CLI-001**: The system MUST provide a CLI binary `agentpulse` executable from any terminal shell.
- **FR-CLI-002**: `agentpulse wrap <command>` MUST spawn `<command>` as a managed child process, capturing `stdout`, `stderr`, exit code, and timing metrics.
- **FR-CLI-003**: The CLI wrapper MUST parse standard LLM token metadata from process output or environment variables and commit records to `agentpulse.db`.

### 3.2 Trace & Run Data Ingestion
- **FR-ING-001**: The system MUST support creating structured **Runs** identified by a unique UUIDv4.
- **FR-ING-002**: Each Run MAY contain multiple hierarchical **Traces** (spans) linked via `parent_trace_id`.
- **FR-ING-003**: Traces MUST support capturing:
  - Input prompt / payload
  - Output completion / result
  - Model identifier (e.g., `gpt-4o`, `claude-3-5-sonnet`)
  - Prompt tokens, completion tokens, and total tokens
  - Calculated monetary cost (USD) based on built-in model pricing matrices
  - Execution start time, end time, and latency (ms)
  - Tool invocation arguments, tool name, and return outputs.

### 3.3 Storage & Persistence
- **FR-STO-001**: Data MUST be persisted in an embedded SQLite database (`agentpulse.db`).
- **FR-STO-002**: Database connections MUST enable Write-Ahead Logging (`PRAGMA journal_mode=WAL`) and foreign key validation (`PRAGMA foreign_keys=ON`).
- **FR-STO-003**: The system MUST support automatic schema migrations upon CLI execution.

### 3.4 Local Web Dashboard & REST API
- **FR-DSH-001**: The system MUST launch an Express web server hosting a local dashboard UI at `http://127.0.0.1:4317`.
- **FR-DSH-002**: The server MUST expose REST API endpoints (`/api/runs`, `/api/traces`, `/api/stats`, `/api/costs`, `/api/budgets`).
- **FR-DSH-003**: The UI MUST provide interactive search, filtering by status (`success`, `error`, `running`), and tree visualization of nested spans.

### 3.5 Budget & Webhook Engine
- **FR-BDG-001**: Users MUST be able to define token and cost limits per agent via `agentpulse budget set <agent_id>`.
- **FR-BDG-002**: When a budget threshold (80%, 100%) is breached, the system MUST log a warning and trigger registered HTTP webhooks with an HMAC SHA-256 signature header.

---

## 4. Data Requirements & Schema Validation

### Data Validation Rules:
- `id` MUST be a valid UUIDv4 string.
- `prompt_tokens` and `completion_tokens` MUST be non-negative integers.
- `cost` MUST be computed as a floating-point number rounded to 6 decimal places.

---

## 5. Non-Functional Requirements

### 5.1 Performance
- **NFR-PERF-001**: Trace ingestion overhead MUST NOT exceed `2ms` per step.
- **NFR-PERF-002**: Dashboard REST API response time MUST be `< 50ms` for default queries (top 50 runs).

### 5.2 Security & Privacy
- **NFR-SEC-001**: No trace data, prompt strings, or API metrics shall be transmitted to external servers unless explicitly configured via webhooks or OTLP export by the user.
- **NFR-SEC-002**: Webhooks MUST authenticate payloads using HMAC SHA-256 signatures.

### 5.3 Reliability & Availability
- **NFR-REL-001**: Database lock timeouts MUST be set to `5000ms` to prevent SQLite busy errors during parallel process executions.

---

## 6. Acceptance Criteria
1. `agentpulse wrap` successfully runs CLI binaries and logs run records to `agentpulse.db`.
2. Dashboard opens on port 4317 and displays real-time execution statistics without external internet connection.
3. Subagent hierarchies are correctly visualized as nested tree nodes in the web interface.
