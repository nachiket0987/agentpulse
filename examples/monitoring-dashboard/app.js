/**
 * AgentTrace Monitoring Dashboard
 *
 * Standalone vanilla-JS dashboard that queries the AgentTrace HTTP API.
 *
 * Endpoints consumed:
 *   GET /api/health          -- system health (disk, memory, db)
 *   GET /api/stats           -- aggregate trace stats
 *   GET /api/costs           -- cost breakdown by model / day
 *   GET /api/runs            -- recent runs (supports ?status= filter)
 *   GET /api/runs/:id        -- single run detail
 *   GET /api/traces          -- traces (supports ?runId= filter)
 *   GET /api/traces/:id      -- single trace detail
 *   GET /api/export          -- export (json|csv)
 *   GET /api/usage/active    -- active agents list
 */

(function () {
  'use strict';

  // ---- Configuration ----
  var API_BASE = '';
  try {
    API_BASE = localStorage.getItem('agenttrace_api_base') || '';
  } catch (_) {}
  var REFRESH_MS = 5000;
  var RUNS_LIMIT = 200;
  var DEFAULT_DB_PATH = '';

  // ---- State ----
  var state = {
    stats: null,
    health: null,
    costs: null,
    runs: [],
    traces: [],
    activeAgents: [],
    selectedRunId: null,
    selectedTraceId: null,
    statusFilter: 'all',
    autoRefreshId: null,
    apiKey: '',
    autoRefreshEnabled: true,
  };

  // ---- DOM Helpers ----
  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- Formatting ----
  function formatLatency(ms) {
    if (ms == null) return '0ms';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function formatCost(cost) {
    if (cost == null) return '$0.0000';
    return '$' + Number(cost).toFixed(4);
  }

  function formatPercent(rate) {
    if (rate == null) return '0%';
    return (Number(rate) * 100).toFixed(1) + '%';
  }

  function formatNumber(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString();
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    var b = Number(bytes);
    while (b >= 1024 && i < units.length - 1) {
      b /= 1024;
      i++;
    }
    return b.toFixed(1) + ' ' + units[i];
  }

  function statusClass(status) {
    if (!status) return '';
    var s = String(status).toLowerCase();
    if (s === 'success') return 'success';
    if (s === 'failure' || s === 'error') return 'failure';
    if (s === 'running') return 'running';
    if (s === 'timeout') return 'timeout';
    return '';
  }

  // ---- API Fetch ----
  function apiFetch(path) {
    var url = API_BASE + path;
    var opts = { headers: {} };
    if (state.apiKey) opts.headers['X-API-Key'] = state.apiKey;
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        var msg = ' ' + res.status;
        return res
          .json()
          .then(function (j) {
            throw new Error((j && j.error ? j.error : 'Request failed') + msg);
          })
          .catch(function (e) {
            if (e instanceof SyntaxError) throw new Error('Request failed ' + res.status);
            throw e;
          });
      }
      return res.json();
    });
  }

  // ---- Data Loading ----
  function loadHealth() {
    return apiFetch('/api/health')
      .then(function (data) {
        state.health = data;
      })
      .catch(function () {
        state.health = null;
      });
  }
  function loadStats() {
    return apiFetch('/api/stats?db=' + state.dbPath).then(function (data) {
      state.stats = data;
    });
  }
  function loadCosts() {
    return apiFetch('/api/costs?db=' + state.dbPath).then(function (data) {
      state.costs = data;
    });
  }
  function loadRuns() {
    var url = '/api/runs?limit=' + RUNS_LIMIT;
    if (state.statusFilter && state.statusFilter !== 'all')
      url += '&status=' + encodeURIComponent(state.statusFilter);
    return apiFetch(url).then(function (data) {
      state.runs = Array.isArray(data) ? data : [];
    });
  }
  function loadTracesForRun(runId) {
    return apiFetch('/api/traces?runId=' + encodeURIComponent(runId) + '&limit=200').then(
      function (data) {
        state.traces = Array.isArray(data) ? data : [];
      },
    );
  }
  function loadTraceDetail(traceId) {
    return apiFetch('/api/traces/' + encodeURIComponent(traceId)).catch(function () {
      return (
        state.traces.find(function (t) {
          return t.id === traceId;
        }) || null
      );
    });
  }
  function loadActiveAgents() {
    return apiFetch('/api/usage/active')
      .then(function (data) {
        state.activeAgents = Array.isArray(data) ? data : [];
      })
      .catch(function () {
        /* endpoint may not exist on older versions */ state.activeAgents = [];
      });
  }
  // Refresh
  function refreshAll() {
    return Promise.all([loadStats(), loadCosts(), loadRuns(), loadActiveAgents(), loadHealth()])
      .then(function () {
        if (state.selectedRunId) {
          loadTracesForRun(state.selectedRunId).catch(function () {});
        }
      })
      .catch(function (err) {
        console.warn('[monitor] refresh error', err);
      });
  }

  // ---- Rendering ----

  /* -- Health Panel -- */
  function renderHealth() {
    var container = $('health-details');
    var badge = $('health-status');
    if (!container) return;
    container.innerHTML = '';
    if (!state.health) {
      badge.className = 'health-badge';
      badge.textContent = 'Unavailable';
      container.appendChild(el('div', 'empty', 'Health endpoint not reachable'));
      return;
    }
    var h = state.health;
    badge.className = 'health-badge ' + (h.status || 'healthy');
    badge.textContent = h.status || 'unknown';

    var items = [];
    if (h.checks) {
      var db = h.checks.database;
      if (db)
        items.push({
          label: 'Database status: ' + db.status + ' (' + (db.responseTime || 0) + 'ms)',
        });
      var disk = h.checks.diskSpace;
      if (disk)
        items.push({
          label:
            'Disk: ' +
            formatBytes(disk.freeBytes) +
            ' free / ' +
            formatBytes(disk.totalBytes) +
            ' total (' +
            disk.status +
            ')',
        });
      var mem = h.checks.memory;
      if (mem)
        items.push({
          label:
            'Memory: ' +
            formatBytes(mem.usedBytes) +
            ' / ' +
            formatBytes(mem.totalBytes) +
            ' (' +
            mem.status +
            ')',
        });
      if (h.checks.activeAgents != null)
        items.push({ label: 'Active agents: ' + h.checks.activeAgents });
      if (h.checks.totalTraces != null)
        items.push({ label: 'Total traces: ' + formatNumber(h.checks.totalTraces) });
    }
    if (h.uptime != null) items.push({ label: 'Uptime: ' + formatLatency(h.uptime) });
    if (h.version) items.push({ label: 'Version: ' + h.version });
    if (h.timestamp) items.push({ label: 'Checked: ' + new Date(h.timestamp).toLocaleString() });

    items.forEach(function (it) {
      var row = el('div', 'detail-row');
      row.appendChild(el('span', 'value', it.label));
      container.appendChild(row);
    });
  }

  /* -- Stats Cards -- */
  function renderStats() {
    var s = state.stats;
    if (!s) return;
    var map = {
      'total-runs': formatNumber(s.totalRuns || 0),
      'total-traces': formatNumber(s.totalTraces || 0),
      'success-rate': formatPercent(s.successRate || 0),
      'avg-latency': formatLatency(s.avgLatencyMs || 0),
      'total-cost': formatCost(s.totalCostUsd || 0),
      'total-tokens': formatNumber(s.totalTokens || 0),
    };
    Object.keys(map).forEach(function (id) {
      var el = $(id);
      if (el) el.textContent = map[id];
    });
  }

  /* -- Cost Charts (CSS bar charts) -- */
  function renderCostCharts() {
    var costs = state.costs;
    if (!costs) return;

    // Cost by model
    var modelContainer = $('chart-cost-by-model');
    if (modelContainer) {
      modelContainer.innerHTML = '';
      var modelData = costs.costByModel || {};
      var modelKeys = Object.keys(modelData);
      if (!modelKeys.length) {
        modelContainer.appendChild(el('div', 'empty', 'No cost data yet'));
      } else {
        var maxModelCost = Math.max.apply(
          null,
          modelKeys.map(function (k) {
            return modelData[k];
          }),
        );
        modelKeys.sort(function (a, b) {
          return modelData[b] - modelData[a];
        });
        modelKeys.forEach(function (model) {
          var cost = modelData[model];
          var pct = maxModelCost > 0 ? (cost / maxModelCost) * 100 : 0;
          var row = el('div', 'bar-row');
          row.appendChild(el('span', 'bar-label', model));
          var barWrap = el('div', 'bar-track');
          var bar = el('div', 'bar-fill');
          bar.style.width = pct.toFixed(1) + '%';
          barWrap.appendChild(bar);
          row.appendChild(barWrap);
          row.appendChild(el('span', 'bar-value', formatCost(cost)));
          modelContainer.appendChild(row);
        });
      }
    }

    // Cost by day
    var dayContainer = $('chart-cost-by-day');
    if (dayContainer) {
      dayContainer.innerHTML = '';
      var dayData = costs.costByDay || {};
      var dayKeys = Object.keys(dayData);
      if (!dayKeys.length) {
        dayContainer.appendChild(el('div', 'empty', 'No daily cost data yet'));
      } else {
        var maxDayCost = Math.max.apply(
          null,
          dayKeys.map(function (k) {
            return dayData[k];
          }),
        );
        dayKeys.sort();
        dayKeys.forEach(function (day) {
          var cost = dayData[day];
          var pct = maxDayCost > 0 ? (cost / maxDayCost) * 100 : 0;
          var row = el('div', 'bar-row');
          row.appendChild(el('span', 'bar-label', day));
          var barWrap = el('div', 'bar-track');
          var bar = el('div', 'bar-fill');
          bar.style.width = pct.toFixed(1) + '%';
          barWrap.appendChild(bar);
          row.appendChild(barWrap);
          row.appendChild(el('span', 'bar-value', formatCost(cost)));
          dayContainer.appendChild(row);
        });
      }
    }
  }

  /* -- Top Tools -- */
  function renderTopTools() {
    var container = $('top-tools-list');
    if (!container) return;
    container.innerHTML = '';
    var tools = state.stats && state.stats.topTools ? state.stats.topTools : [];
    if (!tools.length) {
      container.appendChild(el('div', 'empty', 'No tool calls yet'));
      return;
    }
    var maxCount = Math.max.apply(
      null,
      tools.map(function (t) {
        return t.count;
      }),
    );
    tools.forEach(function (t) {
      var pct = maxCount > 0 ? (t.count / maxCount) * 100 : 0;
      var row = el('div', 'bar-row');
      row.appendChild(el('span', 'bar-label', t.name));
      var barWrap = el('div', 'bar-track');
      var bar = el('div', 'bar-fill tools');
      bar.style.width = pct.toFixed(1) + '%';
      barWrap.appendChild(bar);
      row.appendChild(barWrap);
      row.appendChild(el('span', 'bar-value', t.count + 'x | ' + formatLatency(t.avgLatencyMs)));
      container.appendChild(row);
    });
  }

  /* -- Top Errors -- */
  function renderTopErrors() {
    var container = $('top-errors-list');
    if (!container) return;
    container.innerHTML = '';
    var errors = state.stats && state.stats.topErrors ? state.stats.topErrors : [];
    if (!errors.length) {
      container.appendChild(el('div', 'empty', 'No errors yet'));
      return;
    }
    var maxCount = Math.max.apply(
      null,
      errors.map(function (e) {
        return e.count;
      }),
    );
    errors.forEach(function (e) {
      var pct = maxCount > 0 ? (e.count / maxCount) * 100 : 0;
      var row = el('div', 'bar-row');
      row.appendChild(
        el('span', 'bar-label', e.error.length > 40 ? e.error.slice(0, 40) + '...' : e.error),
      );
      var barWrap = el('div', 'bar-track');
      var bar = el('div', 'bar-fill errors');
      bar.style.width = pct.toFixed(1) + '%';
      barWrap.appendChild(bar);
      row.appendChild(barWrap);
      row.appendChild(el('span', 'bar-value', e.count + 'x'));
      container.appendChild(row);
    });
  }

  /* -- Active Agents -- */
  function renderActiveAgents() {
    var container = $('active-agents-list');
    var countEl = $('active-agents-count');
    var dotEl = $('agents-live-dot');
    if (!container) return;
    container.innerHTML = '';
    if (countEl)
      countEl.textContent =
        state.activeAgents.length + ' agent' + (state.activeAgents.length !== 1 ? 's' : '');
    if (dotEl) {
      dotEl.className = 'live-dot' + (state.activeAgents.length ? '' : ' off');
    }
    if (!state.activeAgents.length) {
      container.appendChild(el('div', 'empty', 'No active agents'));
      return;
    }
    state.activeAgents.forEach(function (agent) {
      var item = el('div', 'run-item');
      var header = el('div', 'run-header');
      header.appendChild(el('span', 'badge success', 'active'));
      header.appendChild(el('span', 'run-title', agent.agentName || agent.id || 'unknown'));
      item.appendChild(header);
      var meta = el('div', 'run-meta');
      if (agent.agentType) meta.appendChild(el('span', 'meta-item', agent.agentType));
      if (agent.lastAction) meta.appendChild(el('span', 'meta-item', 'last: ' + agent.lastAction));
      if (agent.actions != null)
        meta.appendChild(el('span', 'meta-item', agent.actions + ' actions'));
      if (agent.tokens != null)
        meta.appendChild(el('span', 'meta-item', formatNumber(agent.tokens) + ' tokens'));
      if (agent.costUsd != null)
        meta.appendChild(el('span', 'meta-item', formatCost(agent.costUsd)));
      item.appendChild(meta);
      container.appendChild(item);
    });
  }

  /* -- Runs -- */
  function renderRuns() {
    var container = $('runs-list');
    if (!container) return;
    container.innerHTML = '';
    var filtered = state.runs;
    if (state.statusFilter && state.statusFilter !== 'all') {
      filtered = state.runs.filter(function (r) {
        return r.status === state.statusFilter;
      });
    }
    var countEl = $('runs-count');
    if (countEl)
      countEl.textContent = filtered.length + ' run' + (filtered.length !== 1 ? 's' : '');
    if (!filtered.length) {
      container.appendChild(
        el(
          'div',
          'empty',
          state.runs.length ? 'No runs match filter' : 'No runs yet. Start tracing!',
        ),
      );
      return;
    }
    filtered.forEach(function (run) {
      var item = el('div', 'run-item');
      item.dataset.runId = run.id;
      if (state.selectedRunId === run.id) item.classList.add('selected');
      var header = el('div', 'run-header');
      header.appendChild(el('span', 'badge ' + statusClass(run.status), run.status));
      header.appendChild(el('span', 'run-title', run.name || run.id));
      item.appendChild(header);
      var meta = el('div', 'run-meta');
      var started = new Date(run.startedAt || Date.now());
      var timeStr = started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      meta.appendChild(el('span', 'meta-item', (run.traceCount || 0) + ' traces'));
      meta.appendChild(el('span', 'meta-item', formatLatency(run.totalLatencyMs || 0)));
      meta.appendChild(el('span', 'meta-item', formatCost(run.totalCostUsd || 0)));
      meta.appendChild(el('span', 'meta-item', timeStr));
      if (run.errorCount > 0)
        meta.appendChild(el('span', 'meta-item errors-text', run.errorCount + ' errors'));
      item.appendChild(meta);
      item.addEventListener('click', function () {
        selectRun(run.id, item);
      });
      container.appendChild(item);
    });
  }

  /* -- Traces -- */
  function renderTraces() {
    var container = $('traces-list');
    var sec = $('traces-section');
    var countEl = $('traces-count');
    if (!container) return;
    container.innerHTML = '';
    if (countEl)
      countEl.textContent = state.traces.length + ' trace' + (state.traces.length !== 1 ? 's' : '');
    if (!state.traces.length) {
      container.appendChild(el('div', 'empty', 'No traces for this run'));
      return;
    }
    state.traces.forEach(function (trace) {
      var item = el('div', 'trace-item');
      item.dataset.traceId = trace.id;
      if (state.selectedTraceId === trace.id) item.classList.add('selected');
      var header = el('div', 'trace-header');
      header.appendChild(el('span', 'badge ' + statusClass(trace.status), trace.status));
      header.appendChild(el('span', 'trace-name', trace.name || 'trace'));
      item.appendChild(header);
      var meta = el('div', 'trace-meta');
      meta.textContent =
        formatLatency(trace.latencyMs || 0) +
        ' | ' +
        formatCost(trace.costUsd || 0) +
        ' | ' +
        (trace.tokens && trace.tokens.totalTokens ? trace.tokens.totalTokens + ' tokens' : '');
      item.appendChild(meta);
      if (trace.toolCalls && trace.toolCalls.length) {
        var tools = el(
          'div',
          'trace-tools',
          trace.toolCalls.length + ' tool call' + (trace.toolCalls.length > 1 ? 's' : ''),
        );
        item.appendChild(tools);
      }
      item.addEventListener('click', function () {
        selectTrace(trace.id, item, trace);
      });
      container.appendChild(item);
    });
    if (sec) sec.style.display = '';
  }

  /* -- Trace Details -- */
  function renderTraceDetails(trace) {
    var container = $('trace-details');
    if (!container) return;
    container.innerHTML = '';
    var head = el('div', 'trace-header');
    head.appendChild(el('span', 'badge ' + statusClass(trace.status), trace.status));
    head.appendChild(el('span', 'trace-name', trace.name || trace.id));
    container.appendChild(head);
    var metrics = el('div');
    var rows = [
      ['Latency', formatLatency(trace.latencyMs)],
      ['Cost', formatCost(trace.costUsd)],
      [
        'Tokens',
        (trace.tokens ? trace.tokens.totalTokens : 0) +
          ' (p:' +
          (trace.tokens ? trace.tokens.promptTokens : 0) +
          ' c:' +
          (trace.tokens ? trace.tokens.completionTokens : 0) +
          ')',
      ],
      ['Model', (trace.tokens && trace.tokens.model) || '-'],
      ['Created', trace.createdAt ? new Date(trace.createdAt).toLocaleString() : '-'],
    ];
    rows.forEach(function (r) {
      var row = el('div', 'detail-row');
      row.appendChild(el('span', 'key', r[0]));
      row.appendChild(el('span', 'value', String(r[1])));
      metrics.appendChild(row);
    });
    container.appendChild(metrics);
    if (trace.toolCalls && trace.toolCalls.length > 0) {
      container.appendChild(el('h4', '', 'Tool Calls'));
      trace.toolCalls.forEach(function (tc) {
        var tcEl = el('div', 'tool-call');
        var th = el('div', 'tool-header');
        th.appendChild(el('span', '', tc.name));
        th.appendChild(
          el('span', 'badge ' + (tc.success ? 'success' : 'failure'), tc.success ? 'ok' : 'fail'),
        );
        if (tc.latencyMs != null) th.appendChild(el('span', '', formatLatency(tc.latencyMs)));
        tcEl.appendChild(th);
        if (tc.input != null) {
          tcEl.appendChild(el('div', '', 'input:'));
          tcEl.appendChild(el('pre', 'json-block', JSON.stringify(tc.input, null, 2)));
        }
        if (tc.output != null) {
          tcEl.appendChild(el('div', '', 'output:'));
          tcEl.appendChild(el('pre', 'json-block', JSON.stringify(tc.output, null, 2)));
        }
        if (tc.error) {
          var err = el('div', 'value', 'Error: ' + tc.error);
          tcEl.appendChild(err);
        }
        container.appendChild(tcEl);
      });
    }
    if (trace.error) {
      var errBox = el('div', 'detail-row');
      errBox.appendChild(el('span', 'key', 'Error'));
      var ev = el('span', 'value', trace.error);
      errBox.appendChild(ev);
      container.appendChild(errBox);
    }
    container.appendChild(el('h4', '', 'Input'));
    container.appendChild(el('pre', 'json-block', JSON.stringify(trace.input, null, 2)));
    container.appendChild(el('h4', '', 'Output'));
    container.appendChild(el('pre', 'json-block', JSON.stringify(trace.output, null, 2)));
    if (trace.tokens) {
      container.appendChild(el('h4', '', 'Token Usage'));
      container.appendChild(el('pre', 'json-block', JSON.stringify(trace.tokens, null, 2)));
    }
  }

  // ---- Selection Handlers ----
  function selectRun(runId, clickedEl) {
    state.selectedRunId = runId;
    state.selectedTraceId = null;
    document.querySelectorAll('.run-item').forEach(function (el) {
      el.classList.toggle('selected', el.dataset.runId === runId);
    });
    var tracesSec = $('traces-section');
    var tracesList = $('traces-list');
    var nameEl = $('selected-run-name');
    if (tracesSec) tracesSec.style.display = '';
    if (tracesList) tracesList.innerHTML = '<div class="empty">Loading traces...</div>';
    var run = state.runs.find(function (r) {
      return r.id === runId;
    });
    if (nameEl) nameEl.textContent = run && run.name ? run.name : runId;
    var detailsSec = $('details-section');
    if (detailsSec) detailsSec.style.display = 'none';
    loadTracesForRun(runId)
      .then(renderTraces)
      .catch(function () {
        if (tracesList) tracesList.innerHTML = '<div class="empty">Failed to load traces</div>';
      });
  }

  function selectTrace(traceId, clickedEl, traceData) {
    state.selectedTraceId = traceId;
    document.querySelectorAll('.trace-item').forEach(function (el) {
      el.classList.toggle('selected', el.dataset.traceId === traceId);
    });
    var detailsSec = $('details-section');
    if (detailsSec) detailsSec.style.display = '';
    if (traceData) {
      renderTraceDetails(traceData);
    } else {
      loadTraceDetail(traceId)
        .then(function (t) {
          if (t) renderTraceDetails(t);
        })
        .catch(function () {
          var det = $('trace-details');
          if (det) det.innerHTML = '<div class="empty">Failed to load trace details</div>';
        });
    }
  }

  // ---- Full Render ----
  function renderAll() {
    renderHealth();
    renderStats();
    renderCostCharts();
    renderTopTools();
    renderTopErrors();
    renderActiveAgents();
    renderRuns();
    renderTraces();
  }

  // ---- Event Wiring ----
  function setupFilters() {
    var group = $('filters');
    if (!group) return;
    group.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.filter-btn');
      if (!btn) return;
      var status = btn.getAttribute('data-status') || 'all';
      group.querySelectorAll('.filter-btn').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      state.statusFilter = status;
      loadRuns()
        .then(renderRuns)
        .catch(function () {});
    });
  }

  function setupExports() {
    var jsonBtn = $('export-json-btn');
    var csvBtn = $('export-csv-btn');
    function doExport(format) {
      var url = API_BASE + '/api/export?format=' + format;
      var opts = { headers: {} };
      if (state.apiKey) opts.headers['X-API-Key'] = state.apiKey;
      fetch(url, opts)
        .then(function (res) {
          if (!res.ok) throw new Error('Export failed');
          return res.blob();
        })
        .then(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'agenttrace-export.' + format;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () {
            URL.revokeObjectURL(a.href);
          }, 1000);
        })
        .catch(function (e) {
          alert('Export failed: ' + e.message);
        });
    }
    if (jsonBtn)
      jsonBtn.addEventListener('click', function () {
        doExport('json');
      });
    if (csvBtn)
      csvBtn.addEventListener('click', function () {
        doExport('csv');
      });
  }

  function setupRefresh() {
    var btn = $('refresh-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        refreshAll().then(renderAll);
      });
    }
    // Auto-refresh
    if (state.autoRefreshId) clearInterval(state.autoRefreshId);
    state.autoRefreshId = setInterval(function () {
      refreshAll().then(renderAll);
    }, REFRESH_MS);
  }

  function setupCloseDetails() {
    var btn = $('close-details-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        var sec = $('details-section');
        if (sec) sec.style.display = 'none';
        state.selectedTraceId = null;
        document.querySelectorAll('.trace-item').forEach(function (el) {
          el.classList.remove('selected');
        });
      });
    }
  }

  // ---- Init ----
  function init() {
    // Read API key from localStorage
    try {
      state.apiKey = localStorage.getItem('agenttrace_api_key') || '';
    } catch (_) {}
    try {
      state.dbPath = localStorage.getItem('agenttrace_db_path') || '';
    } catch (_) {}

    setupFilters();
    setupExports();
    setupCloseDetails();
    setupRefresh();

    refreshAll()
      .then(renderAll)
      .catch(function () {
        renderAll();
      });
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
