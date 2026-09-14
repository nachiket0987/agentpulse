/**
 * AgentTrace Dashboard — Complete Vanilla JS Rewrite
 * No frameworks. Pure HTML/CSS/JS. Follows exact design system.
 */
(function () {
  'use strict';

  // State
  var state = {
    stats: null,
    runs: [],
    traces: [],
    selectedRunId: null,
    selectedTraceId: null,
    statusFilter: 'all',
    dateRange: 'all',
    searchTerm: '',
    autoRefreshId: null,
    lastRefresh: 0,
  };

  // Utils
  function $(id) {
    return document.getElementById(id);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fmtLatency(ms) {
    if (ms == null) return '0ms';
    if (ms < 1000) return Math.round(ms) + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }
  function fmtCost(c) {
    if (c == null) return '$0.0000';
    return '$' + Number(c).toFixed(4);
  }
  function fmtPct(r) {
    if (r == null) return '0%';
    return (Number(r) * 100).toFixed(1) + '%';
  }
  function fmtNum(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString();
  }
  function statusCls(s) {
    if (!s) return '';
    var v = String(s).toLowerCase();
    if (v === 'success') return 'success';
    if (v === 'failure' || v === 'error') return 'failure';
    if (v === 'running') return 'running';
    if (v === 'timeout') return 'timeout';
    return '';
  }
  function relTime(ts) {
    if (!ts) return '';
    var d = Date.now() - new Date(ts).getTime();
    if (d < 0) d = 0;
    var s = Math.floor(d / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function withinRange(run, range) {
    if (range === 'all') return true;
    var t = new Date(run.startedAt || run.createdAt || 0).getTime();
    var now = Date.now();
    if (range === '1h') return now - t <= 3600000;
    if (range === 'today') {
      var start = new Date();
      start.setHours(0, 0, 0, 0);
      return t >= start.getTime();
    }
    if (range === 'week') {
      var w = new Date();
      w.setDate(w.getDate() - 7);
      w.setHours(0, 0, 0, 0);
      return t >= w.getTime();
    }
    return true;
  }

  // Fetch
  async function fetchJSON(url) {
    var res = await fetch(url);
    if (!res.ok) {
      var msg = 'Request failed: ' + res.status;
      try {
        var j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }

  // Data
  async function loadVersion() {
    try {
      const h = await fetchJSON('/api/health');
      const badge = document.getElementById('version-badge');
      if (badge && h.version) badge.textContent = 'v' + h.version;
    } catch (_) {
      /* silent */
    }
  }
  async function loadStats() {
    state.stats = await fetchJSON('/api/stats');
    renderStats();
    renderBurnAndTop();
    return state.stats;
  }
  async function loadRuns() {
    var runs = await fetchJSON('/api/runs?limit=400');
    state.runs = Array.isArray(runs) ? runs : [];
    renderRuns();
    return state.runs;
  }
  async function loadTraces(runId) {
    if (!runId) return [];
    var url = '/api/traces?runId=' + encodeURIComponent(runId) + '&limit=300';
    var t = await fetchJSON(url);
    state.traces = Array.isArray(t) ? t : [];
    renderTraces();
    return state.traces;
  }
  async function loadTraceDetail(id) {
    try {
      return await fetchJSON('/api/traces/' + encodeURIComponent(id));
    } catch (_) {
      return (
        state.traces.find(function (x) {
          return x.id === id;
        }) || null
      );
    }
  }

  async function refreshAll(keepSel) {
    try {
      await loadVersion();
      await loadStats();
      await loadRuns();
      if (keepSel && state.selectedRunId) {
        await loadTraces(state.selectedRunId);
        if (state.selectedTraceId) {
          var still = state.traces.find(function (t) {
            return t.id === state.selectedTraceId;
          });
          if (still) renderTraceDetails(still);
        }
      }
      state.lastRefresh = Date.now();
    } catch (e) {
      console.warn('[AgentTrace] refresh error', e);
    }
  }

  // Rendering — Stats with sparklines (mini SVG)
  function sparklineSVG(values, w, h, color) {
    if (!values || !values.length) values = [0, 0];
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    if (max === min) max = min + 1;
    var pts = values
      .map(function (v, i) {
        var x = (i / (values.length - 1)) * w;
        var y = h - ((v - min) / (max - min)) * h;
        return x.toFixed(1) + ',' + y.toFixed(1);
      })
      .join(' ');
    var svg =
      '<svg width="' +
      w +
      '" height="' +
      h +
      '" viewBox="0 0 ' +
      w +
      ' ' +
      h +
      '" preserveAspectRatio="none">' +
      '<polyline points="' +
      pts +
      '" fill="none" stroke="' +
      (color || '#3b82f6') +
      '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    return svg;
  }

  function renderStats() {
    var s = state.stats || {};
    var html = '';
    var total = s.totalRuns || 0;
    var rate = s.successRate || 0;
    var lat = s.avgLatencyMs || 0;
    var cost = s.totalCostUsd || 0;

    // Build tiny history arrays from top-level if present, else synthesize from runs
    var tokenHist = (s.tokenHistory || []).slice(-12);
    var costHist = (s.costHistory || []).slice(-12);
    if ((!tokenHist.length || !costHist.length) && state.runs.length) {
      // synthesize from recent runs (cost and tokens)
      var recent = state.runs.slice(0, 12).reverse();
      tokenHist = recent.map(function (r) {
        return (r.totalTokens && r.totalTokens.totalTokens) || 0;
      });
      costHist = recent.map(function (r) {
        return r.totalCostUsd || 0;
      });
    }
    if (!tokenHist.length) tokenHist = [0, 1, 0, 2, 1, 3];
    if (!costHist.length) costHist = [0, 0.001, 0.002, 0.0015, 0.003, 0.0025];

    html +=
      '<div class="stat-card">' +
      '<div class="stat-value" id="total-runs">' +
      fmtNum(total) +
      '</div>' +
      '<div class="stat-label">Total Runs</div>' +
      '<div class="stat-spark">' +
      sparklineSVG(tokenHist, 110, 26, '#3b82f6') +
      '</div>' +
      '</div>';

    html +=
      '<div class="stat-card">' +
      '<div class="stat-value" id="success-rate">' +
      fmtPct(rate) +
      '</div>' +
      '<div class="stat-label">Success Rate</div>' +
      '<div class="stat-spark">' +
      sparklineSVG(
        state.runs.length
          ? state.runs
              .slice(0, 12)
              .reverse()
              .map(function (r) {
                return r.status === 'success' ? 1 : 0;
              })
          : [1, 1, 0, 1, 1, 1],
        110,
        26,
        '#22c55e',
      ) +
      '</div>' +
      '</div>';

    html +=
      '<div class="stat-card">' +
      '<div class="stat-value" id="avg-latency">' +
      fmtLatency(lat) +
      '</div>' +
      '<div class="stat-label">Avg Latency</div>' +
      '<div class="stat-spark">' +
      sparklineSVG(
        state.runs.length
          ? state.runs
              .slice(0, 12)
              .reverse()
              .map(function (r) {
                return r.totalLatencyMs || 0;
              })
          : [80, 120, 90, 140, 110, 95],
        110,
        26,
        '#eab308',
      ) +
      '</div>' +
      '</div>';

    html +=
      '<div class="stat-card">' +
      '<div class="stat-value" id="total-cost">' +
      fmtCost(cost) +
      '</div>' +
      '<div class="stat-label">Total Cost (USD)</div>' +
      '<div class="stat-spark">' +
      sparklineSVG(costHist, 110, 26, '#3b82f6') +
      '</div>' +
      '</div>';

    var grid = $('stats');
    if (grid) grid.innerHTML = html;
  }

  // Burn rate + Top agents (computed client side)
  function computeBurnAndTop() {
    var runs = state.runs || [];
    if (!runs.length) return { tpm: 0, cph: 0, top: [] };

    var now = Date.now();
    var hourAgo = now - 3600000;
    var recent = runs.filter(function (r) {
      var t = new Date(r.startedAt || r.createdAt || 0).getTime();
      return t >= hourAgo;
    });

    var totalTokens = 0;
    var totalCost = 0;
    recent.forEach(function (r) {
      totalTokens += (r.totalTokens && r.totalTokens.totalTokens) || 0;
      totalCost += r.totalCostUsd || 0;
    });

    var mins = Math.max(1, (now - hourAgo) / 60000);
    var tpm = Math.round(totalTokens / mins);
    var cph = (totalCost / (mins / 60)) * 1; // cost per hour based on last hour window

    // Top agents by cost (from runs.name heuristic or metadata)
    var byAgent = {};
    runs.forEach(function (r) {
      var name = (r.name || '').split('.')[0] || 'unknown';
      byAgent[name] = (byAgent[name] || 0) + (r.totalCostUsd || 0);
    });
    var top = Object.entries(byAgent)
      .sort(function (a, b) {
        return b[1] - a[1];
      })
      .slice(0, 5)
      .map(function (e) {
        return { name: e[0], cost: e[1] };
      });

    return { tpm: tpm, cph: cph, top: top };
  }

  function renderBurnAndTop() {
    var b = computeBurnAndTop();
    var bt = $('burn-tokens');
    var bc = $('burn-cost');
    if (bt) bt.textContent = fmtNum(b.tpm) + ' t/min';
    if (bc) bc.textContent = fmtCost(b.cph) + '/hr (last hour)';

    var list = $('top-agents-list');
    if (!list) return;
    list.innerHTML = '';
    if (!b.top.length) {
      list.innerHTML = '<div class="empty small">No agent cost data yet</div>';
      return;
    }
    b.top.forEach(function (a) {
      var row = el('div', 'row');
      row.innerHTML =
        '<span class="name">' + a.name + '</span><span class="cost">' + fmtCost(a.cost) + '</span>';
      list.appendChild(row);
    });
  }

  // Runs list with relative time + mini cost bars
  function renderRuns() {
    var c = $('runs-list');
    if (!c) return;
    c.innerHTML = '';

    var filtered = state.runs.filter(function (r) {
      var okStatus = state.statusFilter === 'all' || r.status === state.statusFilter;
      var okRange = withinRange(r, state.dateRange);
      var okSearch =
        !state.searchTerm ||
        (r.name || '').toLowerCase().indexOf(state.searchTerm.toLowerCase()) !== -1;
      return okStatus && okRange && okSearch;
    });

    var countEl = $('runs-count');
    if (countEl)
      countEl.textContent = filtered.length + ' run' + (filtered.length === 1 ? '' : 's');
    var totalEl = $('runs-total');
    if (totalEl) totalEl.textContent = fmtNum(state.runs.length);

    if (!filtered.length) {
      var msg = state.runs.length
        ? 'No runs match your filters'
        : 'No runs yet. Wrap your first agent!';
      var empty = el('div', 'empty');
      empty.innerHTML =
        '<div class="icon">◌</div>' +
        '<div>' +
        msg +
        '</div>' +
        (state.runs.length
          ? ''
          : '<small>Run <code>npx agenttrace dashboard</code> after instrumenting.</small>');
      c.appendChild(empty);
      return;
    }

    var maxCost = 0;
    filtered.forEach(function (r) {
      if ((r.totalCostUsd || 0) > maxCost) maxCost = r.totalCostUsd || 0;
    });
    if (maxCost <= 0) maxCost = 0.0001;

    filtered.forEach(function (run) {
      var item = el('div', 'run-item');
      item.setAttribute('role', 'listitem');
      item.setAttribute('tabindex', '0');
      item.dataset.runId = run.id;

      if (state.selectedRunId === run.id) item.classList.add('selected');

      var header = el('div', 'run-header');
      var badge = el('span', 'badge ' + statusCls(run.status), run.status || 'unknown');
      var title = el('span', 'run-title', run.name || run.id);
      header.appendChild(badge);
      header.appendChild(title);

      var meta = el('div', 'run-meta');
      meta.appendChild(el('span', 'meta-item', (run.traceCount || 0) + ' traces'));
      meta.appendChild(el('span', 'meta-item', fmtLatency(run.totalLatencyMs || 0)));
      var costStr = fmtCost(run.totalCostUsd || 0);
      var costSpan = el('span', 'meta-item', costStr);
      // mini cost bar
      var pct = Math.max(2, Math.min(100, Math.round(((run.totalCostUsd || 0) / maxCost) * 100)));
      var bar = el('span', 'cost-bar');
      bar.style.width = pct + 'px';
      costSpan.appendChild(bar);
      meta.appendChild(costSpan);

      var rt = relTime(run.startedAt || run.createdAt);
      if (rt) meta.appendChild(el('span', 'meta-item', rt));

      if (run.errorCount > 0) meta.appendChild(el('span', 'meta-item', run.errorCount + ' errors'));

      item.appendChild(header);
      item.appendChild(meta);

      // events
      function selectThis() {
        selectRun(run.id, item);
      }
      item.addEventListener('click', selectThis);
      item.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          selectThis();
        }
      });

      c.appendChild(item);
    });
  }

  function selectRun(runId, elClicked) {
    state.selectedRunId = runId;
    state.selectedTraceId = null;

    document.querySelectorAll('.run-item').forEach(function (it) {
      it.classList.toggle('selected', it.dataset.runId === runId);
    });

    var sec = $('traces-section');
    var list = $('traces-list');
    var nameEl = $('selected-run-name');
    if (sec) sec.style.display = '';
    if (list)
      list.innerHTML = '<div class="skeleton skeleton-line" style="margin:12px 16px"></div>'.repeat(
        3,
      );

    var run = state.runs.find(function (r) {
      return r.id === runId;
    });
    if (nameEl) nameEl.textContent = run && run.name ? run.name : runId;

    var det = $('details-section');
    if (det) det.style.display = 'none';

    loadTraces(runId).catch(function () {
      if (list) list.innerHTML = '<div class="empty">Failed to load traces</div>';
    });
  }

  function renderTraces() {
    var c = $('traces-list');
    var sec = $('traces-section');
    var cnt = $('traces-count');
    if (!c) return;
    c.innerHTML = '';

    if (cnt)
      cnt.textContent = state.traces.length + ' trace' + (state.traces.length === 1 ? '' : 's');

    if (!state.traces.length) {
      c.appendChild(el('div', 'empty', 'No traces for this run'));
      if (sec) sec.style.display = '';
      return;
    }

    state.traces.forEach(function (tr) {
      var item = el('div', 'trace-item');
      item.setAttribute('role', 'listitem');
      item.setAttribute('tabindex', '0');
      item.dataset.traceId = tr.id;
      if (state.selectedTraceId === tr.id) item.classList.add('selected');

      var hdr = el('div', 'trace-header');
      hdr.appendChild(el('span', 'badge ' + statusCls(tr.status), tr.status || 'unknown'));
      hdr.appendChild(el('span', 'trace-name', tr.name || 'trace'));
      item.appendChild(hdr);

      var m = el('div', 'trace-meta');
      var tok = tr.tokens && tr.tokens.totalTokens ? tr.tokens.totalTokens + ' tokens' : '';
      m.textContent =
        fmtLatency(tr.latencyMs || 0) + ' • ' + fmtCost(tr.costUsd || 0) + (tok ? ' • ' + tok : '');
      item.appendChild(m);

      if (tr.toolCalls && tr.toolCalls.length) {
        var tsum = el(
          'div',
          '',
          tr.toolCalls.length + ' tool call' + (tr.toolCalls.length > 1 ? 's' : ''),
        );
        tsum.style.fontSize = '11px';
        tsum.style.color = 'var(--text-muted)';
        item.appendChild(tsum);
      }

      function pick() {
        selectTrace(tr.id, item, tr);
      }
      item.addEventListener('click', pick);
      item.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          pick();
        }
      });
      c.appendChild(item);
    });
    if (sec) sec.style.display = '';
  }

  function selectTrace(traceId, clicked, data) {
    state.selectedTraceId = traceId;
    document.querySelectorAll('.trace-item').forEach(function (it) {
      it.classList.toggle('selected', it.dataset.traceId === traceId);
    });
    var dsec = $('details-section');
    if (dsec) dsec.style.display = '';
    if (data) {
      renderTraceDetails(data);
    } else {
      loadTraceDetail(traceId)
        .then(function (t) {
          if (t) renderTraceDetails(t);
        })
        .catch(function () {
          var box = $('trace-details');
          if (box) box.innerHTML = '<div class="empty">Failed to load details</div>';
        });
    }
  }

  // Collapsible JSON + sections
  function makeCollapsibleSection(title, bodyEl) {
    var sec = el('div', 'detail-section');
    var hdr = el('div', 'detail-section-header');
    hdr.innerHTML = '<h4>' + title + '</h4><span class="chevron" aria-hidden="true">▾</span>';
    var body = el('div', 'detail-section-body');
    body.appendChild(bodyEl);
    sec.appendChild(hdr);
    sec.appendChild(body);

    hdr.addEventListener('click', function () {
      sec.classList.toggle('collapsed');
    });
    // default expanded
    return sec;
  }

  function prettyJSON(obj) {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (_) {
      return String(obj);
    }
  }

  function renderTraceDetails(trace) {
    var c = $('trace-details');
    if (!c) return;
    c.innerHTML = '';

    // header
    var head = el('div', 'trace-header');
    head.appendChild(el('span', 'badge ' + statusCls(trace.status), trace.status || 'unknown'));
    head.appendChild(el('span', 'trace-name', trace.name || trace.id));
    c.appendChild(head);

    // metrics (always visible)
    var metrics = el('div');
    var rows = [
      ['Latency', fmtLatency(trace.latencyMs)],
      ['Cost', fmtCost(trace.costUsd)],
      [
        'Tokens',
        (trace.tokens && trace.tokens.totalTokens) +
          ' (p:' +
          (trace.tokens && trace.tokens.promptTokens) +
          ' c:' +
          (trace.tokens && trace.tokens.completionTokens) +
          ')',
      ],
      ['Model', (trace.tokens && trace.tokens.model) || '—'],
      ['Created', trace.createdAt ? new Date(trace.createdAt).toLocaleString() : '—'],
    ];
    rows.forEach(function (r) {
      var row = el('div', 'detail-row');
      row.appendChild(el('span', 'key', r[0]));
      row.appendChild(el('span', 'value', String(r[1])));
      metrics.appendChild(row);
    });
    c.appendChild(metrics);

    // Tool calls (collapsible)
    if (trace.toolCalls && trace.toolCalls.length) {
      var toolsWrap = el('div');
      trace.toolCalls.forEach(function (tc) {
        var tcEl = el('div', 'tool-call');
        var th = el('div', 'tool-header');
        th.appendChild(el('span', '', tc.name || 'tool'));
        th.appendChild(
          el('span', 'badge ' + (tc.success ? 'success' : 'failure'), tc.success ? 'ok' : 'fail'),
        );
        if (tc.latencyMs != null) th.appendChild(el('span', '', fmtLatency(tc.latencyMs)));
        tcEl.appendChild(th);

        if (tc.input != null) {
          var preI = el('pre', 'json-block', prettyJSON(tc.input));
          tcEl.appendChild(el('div', '', 'input:'));
          tcEl.appendChild(preI);
        }
        if (tc.output != null) {
          var preO = el('pre', 'json-block', prettyJSON(tc.output));
          tcEl.appendChild(el('div', '', 'output:'));
          tcEl.appendChild(preO);
        }
        if (tc.error) {
          var er = el('div', 'value', 'Error: ' + tc.error);
          er.style.color = 'var(--error)';
          tcEl.appendChild(er);
        }
        toolsWrap.appendChild(tcEl);
      });
      c.appendChild(
        makeCollapsibleSection('Tool Calls (' + trace.toolCalls.length + ')', toolsWrap),
      );
    }

    // Error
    if (trace.error) {
      var erBox = el('div', 'detail-row');
      erBox.appendChild(el('span', 'key', 'Error'));
      var ev = el('span', 'value', trace.error);
      ev.style.color = 'var(--error)';
      erBox.appendChild(ev);
      c.appendChild(erBox);
    }

    // Input (collapsible)
    var inPre = el('pre', 'json-block', prettyJSON(trace.input));
    c.appendChild(makeCollapsibleSection('Input', inPre));

    // Output (collapsible)
    var outPre = el('pre', 'json-block', prettyJSON(trace.output));
    c.appendChild(makeCollapsibleSection('Output', outPre));

    // Tokens raw (collapsible)
    if (trace.tokens) {
      var tokPre = el('pre', 'json-block', prettyJSON(trace.tokens));
      c.appendChild(makeCollapsibleSection('Token Usage', tokPre));
    }
  }

  // Filters, search, date range
  function setupFilters() {
    var group = $('status-filters');
    if (group) {
      group.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.filter-btn');
        if (!btn) return;
        group.querySelectorAll('.filter-btn').forEach(function (b) {
          var act = b === btn;
          b.classList.toggle('active', act);
          b.setAttribute('aria-pressed', act ? 'true' : 'false');
        });
        state.statusFilter = btn.getAttribute('data-status') || 'all';
        renderRuns();
      });
    }

    var dr = $('date-range');
    if (dr) {
      dr.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.date-btn');
        if (!btn) return;
        dr.querySelectorAll('.date-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        state.dateRange = btn.getAttribute('data-range') || 'all';
        renderRuns();
      });
    }

    var search = $('search-input');
    if (search) {
      var t;
      search.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          state.searchTerm = search.value || '';
          renderRuns();
        }, 120);
      });
    }
  }

  // Export
  async function doExport(fmt) {
    try {
      var url = '/api/export?format=' + fmt;
      var res = await fetch(url);
      if (!res.ok) throw new Error('Export failed');
      var blob = await res.blob();
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'agenttrace-export.' + fmt;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
      }, 800);
      showToast('Exported ' + fmt.toUpperCase(), 'success');
    } catch (e) {
      showToast('Export failed: ' + e.message, 'error');
    }
  }
  function setupExports() {
    var j = $('export-json-btn');
    var c = $('export-csv-btn');
    if (j)
      j.addEventListener('click', function () {
        doExport('json');
      });
    if (c)
      c.addEventListener('click', function () {
        doExport('csv');
      });
  }

  // Refresh button + keyboard
  function setupRefresh() {
    var btn = $('refresh-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        btn.classList.add('spinning');
        refreshAll(true).finally(function () {
          setTimeout(function () {
            btn.classList.remove('spinning');
          }, 400);
        });
      });
    }

    // Keyboard shortcuts: j/k navigate runs, enter expand, esc close, r refresh
    document.addEventListener('keydown', function (ev) {
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;

      var runs = Array.prototype.slice.call(document.querySelectorAll('.run-item'));
      var idx = runs.findIndex(function (el) {
        return el.classList.contains('selected');
      });

      if (ev.key.toLowerCase() === 'r') {
        ev.preventDefault();
        var rb = $('refresh-btn');
        if (rb) rb.click();
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        var dsec = $('details-section');
        if (dsec && dsec.style.display !== 'none') {
          dsec.style.display = 'none';
          state.selectedTraceId = null;
          document.querySelectorAll('.trace-item').forEach(function (el) {
            el.classList.remove('selected');
          });
        } else {
          var tsec = $('traces-section');
          if (tsec) tsec.style.display = 'none';
          state.selectedRunId = null;
          state.selectedTraceId = null;
          document.querySelectorAll('.run-item').forEach(function (el) {
            el.classList.remove('selected');
          });
        }
        return;
      }
      if (ev.key.toLowerCase() === 'j') {
        ev.preventDefault();
        var next = runs[Math.min(runs.length - 1, Math.max(0, idx + 1))];
        if (next) next.click();
        next && next.scrollIntoView({ block: 'nearest' });
      }
      if (ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        var prev = runs[Math.max(0, idx - 1)];
        if (prev) prev.click();
        prev && prev.scrollIntoView({ block: 'nearest' });
      }
      if (ev.key === 'Enter' && idx >= 0) {
        // already selected; open details if traces exist
        var tid = state.selectedTraceId;
        if (!tid && state.traces.length) {
          var first = state.traces[0];
          var tEl = document.querySelector('.trace-item');
          if (tEl && first) selectTrace(first.id, tEl, first);
        }
      }
    });
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

  function setupAutoRefresh() {
    if (state.autoRefreshId) clearInterval(state.autoRefreshId);
    state.autoRefreshId = setInterval(function () {
      refreshAll(true);
    }, 5000);
  }

  // Toasts
  function showToast(msg, type) {
    var cont = $('toast-container');
    if (!cont) {
      cont = el('div', 'toast-container');
      cont.id = 'toast-container';
      document.body.appendChild(cont);
    }
    var t = el('div', 'toast ' + (type || ''));
    t.textContent = msg;
    cont.appendChild(t);
    setTimeout(function () {
      if (t && t.parentNode) t.parentNode.removeChild(t);
    }, 2600);
  }

  // Init
  async function init() {
    // version already in HTML
    setupFilters();
    setupExports();
    setupRefresh();
    setupCloseDetails();
    setupAutoRefresh();

    // initial skeletons already in HTML; replace on load
    try {
      await loadStats();
      await loadRuns();
      // show friendly empty if none
      if (!state.runs.length) {
        var list = $('runs-list');
        if (list)
          list.innerHTML =
            '<div class="empty"><div class="icon">◌</div><div>No runs yet. Wrap your first agent!</div><small>Use the SDK or middleware, then refresh.</small></div>';
      }
    } catch (e) {
      var list = $('runs-list');
      if (list)
        list.innerHTML =
          '<div class="empty">Failed to load data. Is the dashboard server running?</div>';
      console.error('[AgentTrace] init error', e);
    }

    // expose tiny debug hook
    window.__agenttraceDashboard = {
      state: state,
      refresh: function () {
        return refreshAll(true);
      },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
