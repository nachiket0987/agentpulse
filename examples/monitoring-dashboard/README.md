# AgentTrace Monitoring Dashboard

A standalone (no build step) monitoring dashboard that queries the AgentTrace
HTTP API. Open `index.html` in a browser or serve it with any static file
server.

## Quick Start

### Option A: Open directly in the browser

Assuming the AgentTrace dashboard server is running locally on port 4317
(the default):

    # In a separate terminal, start the dashboard server
    npx agenttrace dashboard --db ./agenttrace.db --port 4317

Then open `index.html` in your browser. The JS reads API endpoints from
the same origin by default.

### Option B: Serve with a static server

    # From the monitoring-dashboard/ directory
    npx serve . -p 8080

Then open http://localhost:8080 in the browser. Point `API_BASE` at the
AgentTrace server URL (see Configuration below).

## Configuration

Open a browser console and set:

    // If the AgentTrace API runs on a different host/port:
    localStorage.setItem('agenttrace_api_base', 'http://localhost:4317');

    // If the dashboard server requires an API key:
    localStorage.setItem('agenttrace_api_key', 'your-api-key');

    // To target a default DB path:
    localStorage.setItem('agenttrace_db_path', './agenttrace.db');

Reload the page after changing settings.

## API Endpoints Consumed

| Endpoint                | Purpose                                             |
| ----------------------- | --------------------------------------------------- | ----- |
| `GET /api/health`       | System health (disk, memory, db connectivity)       |
| `GET /api/stats`        | Aggregate trace stats (runs, tokens, cost, latency) |
| `GET /api/costs`        | Cost breakdown by model and by day                  |
| `GET /api/runs`         | Recent runs (supports `?status=` and `?limit=`)     |
| `GET /api/runs/:id`     | Single run detail                                   |
| `GET /api/traces`       | Traces (supports `?runId=` filter)                  |
| `GET /api/traces/:id`   | Single trace detail with tool calls                 |
| `GET /api/export`       | Export as JSON or CSV (`?format=json                | csv`) |
| `GET /api/usage/active` | Active agents list                                  |

## Features

- **System Health Panel** -- DB status, disk free, memory usage, uptime
- **Summary Stats** -- Total runs, traces, success rate, avg latency, cost, tokens
- **Cost Charts** -- CSS bar charts showing cost by model and cost over time
- **Top Tools & Errors** -- Most frequently called tools and most common errors
- **Active Agents** -- Live list of currently active agents
- **Runs Explorer** -- Filterable list of recent runs (by status)
- **Trace Drilldown** -- Click a run to see its traces, click a trace for full
  detail (tool calls, input/output, token usage, errors)
- **Export** -- Download all data as JSON or CSV
- **Auto-refresh** -- Polls every 5 seconds

## Files

| File         | Purpose                                                     |
| ------------ | ----------------------------------------------------------- |
| `index.html` | Dashboard markup, panels, charts containers                 |
| `style.css`  | Dark theme CSS (no frameworks, no build)                    |
| `app.js`     | Vanilla JS: API calls, rendering, auto-refresh event wiring |
| `README.md`  | This file                                                   |

## Integrating with Your App

To use this dashboard with your own AgentTrace deployment:

1.  Start the AgentTrace dashboard server:

    npx agenttrace dashboard --db /path/to/agenttrace.db --port 4317

2.  Copy these three files to any static hosting (or open locally)

3.  If serving from a different origin, set the API base URL:

    localStorage.setItem('agenttrace_api_base', 'http://your-host:4317');

4.  If you've configured API key authentication on the dashboard server,
    store the key:

        localStorage.setItem('agenttrace_api_key', 'your-key-here');
