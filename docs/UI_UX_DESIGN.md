# UI/UX Specification Document — AgentPulse

**Project Name:** AgentPulse  
**Author:** Nachiket Gadilohar  
**Version:** 1.0.0  

---

## 1. Design Philosophy & Principles

AgentPulse follows a **developer-centric, dark-first UI philosophy**:
1. **High Information Density**: Present execution metrics, trace trees, and token consumption cleanly without visual clutter.
2. **Instant Visual Feedback**: Color-coded status badges, real-time live polling every 5 seconds, and instant search filtering.
3. **Zero Configuration**: Out-of-the-box responsive web interface running locally without setup.

---

## 2. Color Palette & Design System

### 2.1 Color Tokens
- **Background**: Slate 900 (`#0f172a`)
- **Card / Surface**: Slate 800 (`#1e293b`)
- **Border / Divider**: Slate 700 (`#334155`)
- **Primary Accent**: Indigo 500 (`#6366f1`)
- **Success Badge**: Emerald 500 (`#22c55e`)
- **Error Badge**: Red 500 (`#ef4444`)
- **Warning / Alert**: Amber 500 (`#f59e0b`)

---

## 3. Screen Structure & Navigation

### 3.1 Layout Architecture
- **Header**: AgentPulse branding, Live polling status indicator (5s), Export button (JSON/CSV).
- **Stats Overview Bar**: Total Runs, Success Rate %, Average Latency (ms), Total Calculated Cost ($).
- **Controls & Search Bar**: Search input for run name/ID, Status dropdown filter.
- **Run Log Table**: Column headers for Name, Status, Duration, Tokens, Cost, Timestamp, View Details button.
- **Trace Tree Inspector Drawer**: Expandable side/bottom panel displaying parent-child agent spans, raw prompt strings, completion outputs, and tool call parameters.

---

## 4. Component Library & Interaction Design

### 4.1 Stats Cards
- Four-up top summary cards displaying high-level telemetry metrics.

### 4.2 Run Table & Status Badges
- **Success**: Emerald pill badge with `●` icon.
- **Error**: Red pill badge with `✕` icon.
- **Running**: Pulsing Indigo badge with spinner animation.

### 4.3 Interactive Trace Tree View
- Hierarchical tree representation of parent-child subagents.
- Clicking any node opens a drawer/modal displaying full input/output parameters.

---

## 5. UI States & Responsive Behavior

| State | Visual Treatment |
| :--- | :--- |
| **Loading State** | Skeleton shimmer placeholders over table rows while fetching `/api/runs`. |
| **Empty State** | Centered graphic with code snippet: `agentpulse wrap <command>` to record first run. |
| **Error State** | Warning toast banner at top with retry button if SQLite DB connection fails. |
| **Responsive View** | On mobile/tablet screens (< 768px), sidebar collapses into top navigation dropdown. |
