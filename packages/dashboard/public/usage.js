/**
 * AgentTrace Usage Dashboard — Complete Vanilla Rewrite
 * Live SSE + polling. Cost projections, per-agent, Top Tools, responsive.
 */
(function () {
  'use strict';

  var state = {
    active: [],
    todayStats: null,
    recent: [],
    topAgents: [],
    feed: [],
    sseConnected: false,
    autoRefreshId: null,
    lastRefresh: null,
    es: null,
    eventCount: 0,
  };

  function $(id) {
    return document.getElementById(id);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtCost(c) {
    if (c == null) return '$0.0000';
    return '$' + Number(c).toFixed(4);
  }
  function fmtNum(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString();
  }
  function fmtTokens(n) {
    if (n == null) return '0';
    var v = Number(n);
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return v.toLocaleString();
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return isNaN(d.getTime())
      ? ''
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function fmtDay(d) {
    if (typeof d === 'string') return d.slice(5);
    return d.toISOString().slice(5, 10);
  }
  function timeAgo(ts) {
    if (!ts) return 'never';
    var secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (secs < 5) return 'just now';
    if (secs < 60) return secs + 's ago';
    var m = Math.floor(secs / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }
  function getTodayStart() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function get7DaysAgo() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 6);
    return d.getTime();
  }

  async function fetchJSON(url) {
    var res = await fetch(url);
    if (!res.ok) throw new Error('Request failed: ' + res.status);
    return res.json();
  }

  async function loadActive() {
    state.active = await fetchJSON('/api/usage/active');
  }
  async function loadTodayStats() {
    var from = getTodayStart();
    state.todayStats = await fetchJSON('/api/usage/stats?fromDate=' + from);
  }
  async function loadRecent() {
    state.recent = await fetchJSON('/api/usage?limit=50');
  }
  async function loadGlobalTop() {
    var s = await fetchJSON('/api/usage/stats');
    state.topAgents = s && s.topAgents ? s.topAgents : [];
  }
  async function load7d() {
    var from = get7DaysAgo();
    return (await fetchJSON('/api/usage?fromDate=' + from + '&limit=2000')) || [];
  }

  async function refreshAll(alsoLine) {
    try {
      await Promise.all([loadActive(), loadTodayStats(), loadRecent(), loadGlobalTop()]);
      state.lastRefresh = Date.now();
      renderSummary();
      renderBar();
      renderTopAgents();
      renderRecent();
      renderPerAgent();
      renderTopTools();
      renderProjections();
      updateLast();
      if (alsoLine) {
        var recs = await load7d();
        renderLine(recs);
      }
    } catch (e) {
      console.warn('[Usage] refresh', e);
    }
  }

  function updateLast() {
    var el = $('last-updated');
    if (el && state.lastRefresh) el.textContent = 'Updated ' + timeAgo(state.lastRefresh);
  }

  function renderSummary() {
    var now = Date.now();
    var TH = 30 * 60 * 1000;
    var act = (state.active || []).filter(function (a) {
      return now - (Date.parse(a.lastActive || 0) || 0) <= TH;
    }).length;
    var t = state.todayStats || { totalActions: 0, totalCostUsd: 0, totalTokens: 0 };

    var aEl = $('active-agents');
    if (aEl) aEl.textContent = String(act);
    var actEl = $('actions-today');
    if (actEl) actEl.textContent = fmtNum(t.totalActions || 0);
    var cEl = $('cost-today');
    if (cEl) cEl.textContent = fmtCost(t.totalCostUsd || 0);
    var tokEl = $('tokens-today');
    if (tokEl) tokEl.textContent = fmtTokens(t.totalTokens || 0);
  }

  // Projections from today's rate
  function renderProjections() {
    var t = state.todayStats || { totalCostUsd: 0 };
    var rateEl = $('spend-rate');
    var dEl = $('proj-daily');
    var mEl = $('proj-monthly');

    var now = Date.now();
    var dayStart = getTodayStart();
    var elapsed = Math.max(1, now - dayStart);
    var frac = Math.min(1, elapsed / 86400000);
    var hourly = (t.totalCostUsd || 0) / (elapsed / 3600000);
    var daily = (t.totalCostUsd || 0) / frac;
    var monthly = daily * 30;

    if (rateEl) rateEl.textContent = isFinite(hourly) ? fmtCost(hourly) + '/hr' : '—';
    if (dEl) dEl.textContent = isFinite(daily) ? fmtCost(daily) : '—';
    if (mEl) mEl.textContent = isFinite(monthly) ? fmtCost(monthly) : '—';
  }

  // Bar chart (actions by type)
  function renderBar() {
    var c = $('bar-chart');
    if (!c) return;
    c.innerHTML = '';
    var by = (state.todayStats && state.todayStats.actionsByType) || {};
    var entries = Object.keys(by).map(function (k) {
      return { type: k, count: by[k] || 0 };
    });
    entries.sort(function (a, b) {
      return b.count - a.count;
    });
    entries = entries.slice(0, 8);
    if (!entries.length) {
      c.appendChild(el('div', 'empty small', 'No actions recorded today'));
      return;
    }
    var max = 0;
    entries.forEach(function (e) {
      if (e.count > max) max = e.count;
    });
    if (max === 0) max = 1;

    var wrap = el('div', 'bar-chart');
    var palette = [
      '#3b82f6',
      '#22c55e',
      '#eab308',
      '#f59e0b',
      '#a78bfa',
      '#60a5fa',
      '#34d399',
      '#facc15',
    ];
    entries.forEach(function (e, i) {
      var pct = Math.max(8, Math.round((e.count / max) * 100));
      var b = el('div', 'bar');
      b.style.height = pct + '%';
      b.style.width = Math.max(20, Math.floor(120 / entries.length)) + 'px';
      b.style.background = palette[i % palette.length];
      b.title = e.type + ': ' + e.count;
      b.appendChild(el('div', 'bar-value', String(e.count)));
      b.appendChild(el('div', 'bar-label', e.type));
      wrap.appendChild(b);
    });
    c.appendChild(wrap);
  }

  // Line chart (SVG)
  function renderLine(recs) {
    var c = $('line-chart');
    if (!c) return;
    c.innerHTML = '';

    var byDay = {};
    (recs || []).forEach(function (r) {
      var d = new Date(r.createdAt || Date.now());
      var k =
        d.getFullYear() +
        '-' +
        String(d.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(d.getDate()).padStart(2, '0');
      byDay[k] = (byDay[k] || 0) + (r.costUsd || 0);
    });

    var days = [];
    var base = new Date();
    base.setHours(0, 0, 0, 0);
    for (var i = 6; i >= 0; i--) {
      var dt = new Date(base);
      dt.setDate(base.getDate() - i);
      var k =
        dt.getFullYear() +
        '-' +
        String(dt.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(dt.getDate()).padStart(2, '0');
      days.push({ key: k, label: fmtDay(dt), cost: byDay[k] || 0 });
    }

    var maxC = 0;
    days.forEach(function (d) {
      if (d.cost > maxC) maxC = d.cost;
    });
    if (maxC <= 0) maxC = 0.0001;

    var W = 520,
      H = 140,
      L = 36,
      R = 8,
      T = 10,
      B = 20;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'line-chart');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');

    // grid
    for (var g = 0; g <= 3; g++) {
      var gy = T + (g * (H - T - B)) / 3;
      var ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('x1', L);
      ln.setAttribute('y1', gy);
      ln.setAttribute('x2', W - R);
      ln.setAttribute('y2', gy);
      ln.setAttribute('stroke', '#242429');
      ln.setAttribute('stroke-width', '1');
      svg.appendChild(ln);
    }

    var ax = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ax.setAttribute('x1', L);
    ax.setAttribute('y1', H - B);
    ax.setAttribute('x2', W - R);
    ax.setAttribute('y2', H - B);
    ax.setAttribute('stroke', '#242429');
    ax.setAttribute('stroke-width', '1');
    svg.appendChild(ax);

    var n = days.length;
    var pw = W - L - R;
    var ph = H - T - B;
    var pts = [];
    for (var j = 0; j < n; j++) {
      var x = L + (n === 1 ? pw / 2 : (j * pw) / (n - 1));
      var y = H - B - (days[j].cost / maxC) * ph;
      pts.push({ x: x, y: y, val: days[j].cost, label: days[j].label });
    }

    if (pts.length > 1) {
      var area = 'M ' + pts[0].x + ' ' + (H - B);
      pts.forEach(function (p) {
        area += ' L ' + p.x + ' ' + p.y;
      });
      area += ' L ' + pts[pts.length - 1].x + ' ' + (H - B) + ' Z';
      var ap = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      ap.setAttribute('d', area);
      ap.setAttribute('fill', 'rgba(59,130,246,0.08)');
      ap.setAttribute('stroke', 'none');
      svg.appendChild(ap);

      var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.setAttribute(
        'points',
        pts
          .map(function (p) {
            return p.x + ',' + p.y;
          })
          .join(' '),
      );
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', '#3b82f6');
      poly.setAttribute('stroke-width', '2');
      poly.setAttribute('stroke-linejoin', 'round');
      poly.setAttribute('stroke-linecap', 'round');
      svg.appendChild(poly);
    }

    pts.forEach(function (p) {
      var cir = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      cir.setAttribute('cx', p.x);
      cir.setAttribute('cy', p.y);
      cir.setAttribute('r', '2.5');
      cir.setAttribute('fill', '#3b82f6');
      cir.setAttribute('stroke', '#0a0a0c');
      cir.setAttribute('stroke-width', '1.5');
      svg.appendChild(cir);

      var tx = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      tx.setAttribute('x', p.x);
      tx.setAttribute('y', H - 4);
      tx.setAttribute('text-anchor', 'middle');
      tx.textContent = p.label;
      svg.appendChild(tx);

      if (p.val > 0) {
        var ty = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        ty.setAttribute('x', p.x);
        ty.setAttribute('y', Math.max(T + 8, p.y - 6));
        ty.setAttribute('text-anchor', 'middle');
        ty.setAttribute('fill', '#e8e8eb');
        ty.textContent = '$' + p.val.toFixed(3);
        svg.appendChild(ty);
      }
    });

    var yl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    yl.setAttribute('x', 4);
    yl.setAttribute('y', T + 10);
    yl.setAttribute('fill', '#9a9aa0');
    yl.textContent = '$' + maxC.toFixed(2);
    svg.appendChild(yl);

    c.appendChild(svg);
  }

  function renderTopAgents() {
    var tb = $('top-agents-table');
    if (!tb) return;
    var tbod = tb.querySelector('tbody');
    if (!tbod) return;
    tbod.innerHTML = '';
    var rows = state.topAgents || [];
    var cnt = $('top-agents-count');
    if (cnt) cnt.textContent = rows.length + '';
    if (!rows.length) {
      tbod.innerHTML = '<tr><td colspan="4" class="empty small">No usage data yet</td></tr>';
      return;
    }
    rows.slice(0, 8).forEach(function (a) {
      var tr = el('tr');
      tr.innerHTML =
        '<td class="agent">' +
        escapeHtml(a.agentName || '') +
        '</td><td class="num">' +
        fmtNum(a.actions || 0) +
        '</td><td class="num">' +
        fmtTokens(a.tokens || 0) +
        '</td><td class="num cost">' +
        fmtCost(a.costUsd || 0) +
        '</td>';
      tbod.appendChild(tr);
    });
  }

  function renderRecent() {
    var tb = $('recent-actions-table');
    if (!tb) return;
    var tbod = tb.querySelector('tbody');
    if (!tbod) return;
    tbod.innerHTML = '';
    var rows = state.recent || [];
    var cnt = $('recent-count');
    if (cnt) cnt.textContent = rows.length + '';
    if (!rows.length) {
      tbod.innerHTML = '<tr><td colspan="4" class="empty small">No actions recorded yet</td></tr>';
      return;
    }
    rows.slice(0, 15).forEach(function (r) {
      var tr = el('tr');
      var act = (r.action || '') + (r.target ? ':' + r.target : '');
      tr.innerHTML =
        '<td>' +
        fmtTime(r.createdAt) +
        '</td><td class="agent">' +
        escapeHtml(r.agentName || '') +
        '</td><td>' +
        escapeHtml(act) +
        '</td><td class="num cost">' +
        fmtCost(r.costUsd || 0) +
        '</td>';
      tbod.appendChild(tr);
    });
  }

  function renderPerAgent() {
    var tb = $('per-agent-table');
    if (!tb) return;
    var tbod = tb.querySelector('tbody');
    if (!tbod) return;
    tbod.innerHTML = '';
    var rows = (state.todayStats && state.todayStats.topAgents) || state.topAgents || [];
    if (!rows.length) {
      tbod.innerHTML =
        '<tr><td colspan="4" class="empty small">No per-agent data for today</td></tr>';
      return;
    }
    rows.slice(0, 10).forEach(function (a) {
      var tr = el('tr');
      tr.innerHTML =
        '<td class="agent">' +
        escapeHtml(a.agentName || '') +
        '</td><td class="num">' +
        fmtNum(a.actions || 0) +
        '</td><td class="num">' +
        fmtTokens(a.tokens || 0) +
        '</td><td class="num cost">' +
        fmtCost(a.costUsd || 0) +
        '</td>';
      tbod.appendChild(tr);
    });
  }

  function renderTopTools() {
    var tb = $('top-tools-table');
    if (!tb) return;
    var tbod = tb.querySelector('tbody');
    if (!tbod) return;
    tbod.innerHTML = '';
    var tools = (state.todayStats && state.todayStats.topTools) || [];
    var cnt = $('top-tools-count');
    if (cnt) cnt.textContent = tools.length + '';
    if (!tools.length) {
      tbod.innerHTML =
        '<tr><td colspan="3" class="empty small">No tool calls recorded today</td></tr>';
      return;
    }
    tools.slice(0, 10).forEach(function (t) {
      var tr = el('tr');
      tr.innerHTML =
        '<td>' +
        escapeHtml(t.name || '') +
        '</td><td class="num">' +
        fmtNum(t.count || 0) +
        '</td><td class="num">' +
        (t.avgLatencyMs || 0) +
        'ms</td>';
      tbod.appendChild(tr);
    });
  }

  // Live feed
  function addToFeed(rec) {
    if (!rec) return;
    state.feed.unshift(rec);
    if (state.feed.length > 50) state.feed.pop();
    state.eventCount++;

    var feed = $('activity-feed');
    if (!feed) return;
    var empty = feed.querySelector('.empty');
    if (empty) empty.remove();

    var item = el('div', 'activity-item');
    item.style.animation = 'fadeSlideIn 0.2s ease';

    var tm = el('span', 'activity-time', fmtTime(rec.createdAt));
    var ag = el('span', 'activity-agent', rec.agentName || 'agent');
    ag.title = rec.agentName || '';
    var actStr = (rec.action || '') + (rec.target ? ':' + rec.target : '');
    var ac = el('span', 'activity-action', actStr);
    ac.title = actStr;
    var cs = el('span', 'activity-cost', fmtCost(rec.costUsd));

    var dot = el('span');
    dot.style.cssText =
      'display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;vertical-align:middle;';
    dot.style.background =
      rec.status === 'failure'
        ? 'var(--error)'
        : rec.status === 'timeout'
          ? '#f59e0b'
          : 'var(--success)';

    item.appendChild(tm);
    item.appendChild(dot);
    item.appendChild(ag);
    item.appendChild(ac);
    item.appendChild(cs);

    if (feed.firstChild) feed.insertBefore(item, feed.firstChild);
    else feed.appendChild(item);

    while (feed.children.length > 50) feed.removeChild(feed.lastChild);

    var fc = $('feed-count');
    if (fc) fc.textContent = state.feed.length + ' events';
  }

  function setupSSE() {
    var dot = $('live-dot');
    var sseSt = $('sse-status');

    function setConn(ok) {
      state.sseConnected = !!ok;
      if (dot) {
        dot.classList.toggle('off', !ok);
        dot.title = ok ? 'Live — connected' : 'Live — disconnected';
      }
      if (sseSt) {
        sseSt.classList.toggle('sse-on', ok);
        sseSt.classList.toggle('sse-off', !ok);
        sseSt.title = ok ? 'SSE connected' : 'SSE disconnected (polling)';
      }
    }
    setConn(false);

    try {
      var es = new EventSource('/api/usage/stream');
      state.es = es;
      es.addEventListener('connected', function () {
        setConn(true);
      });
      es.addEventListener('usage', function (ev) {
        try {
          var rec = JSON.parse(ev.data);
          addToFeed(rec);
          state.recent.unshift(rec);
          if (state.recent.length > 50) state.recent.pop();
          renderRecent();
          if (state.todayStats) {
            var ds = getTodayStart();
            if (rec.createdAt >= ds) {
              state.todayStats.totalActions = (state.todayStats.totalActions || 0) + 1;
              state.todayStats.totalTokens =
                (state.todayStats.totalTokens || 0) + (rec.tokensUsed || 0);
              state.todayStats.totalCostUsd =
                (state.todayStats.totalCostUsd || 0) + (rec.costUsd || 0);
              renderSummary();
              renderProjections();
            }
          }
        } catch (_) {}
      });
      es.onerror = function () {
        setConn(false);
      };
      es.onopen = function () {
        setConn(true);
      };
    } catch (e) {
      setConn(false);
    }
  }

  function setupAuto() {
    if (state.autoRefreshId) clearInterval(state.autoRefreshId);
    state.autoRefreshId = setInterval(function () {
      refreshAll(false).catch(function () {});
      updateLast();
    }, 5000);
  }

  function setupRefreshBtn() {
    var btn = $('refresh-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        btn.classList.add('spinning');
        refreshAll(true)
          .catch(function () {})
          .finally(function () {
            setTimeout(function () {
              btn.classList.remove('spinning');
            }, 600);
          });
      });
    }
  }

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
    }, 2400);
  }

  function init() {
    setupRefreshBtn();
    setupAuto();
    setupSSE();

    refreshAll(true)
      .then(function () {
        var feed = $('activity-feed');
        if (feed && state.feed.length === 0 && state.recent.length) {
          var seed = state.recent.slice(0, 8).reverse();
          seed.forEach(function (r) {
            addToFeed(r);
          });
        }
      })
      .catch(function (e) {
        var f = $('activity-feed');
        if (f)
          f.innerHTML =
            '<div class="empty">Failed to load usage data. Is the server running?</div>';
        console.error('[Usage] init', e);
      });

    window.__agenttraceUsage = {
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
