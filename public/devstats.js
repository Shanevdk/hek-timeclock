// App health — the dev account's view of how the app is actually being used.
//
// Charts are hand-built SVG rather than a charting library: three simple forms
// on one screen is not worth 100kB of dependency, and it keeps the whole thing
// working offline.
//
// Two rules shape what is drawn here. Visits and errors are never put on one
// pair of axes — they differ by orders of magnitude, and a second y-scale is
// the easiest way to make a chart lie — so they are separate charts sharing an
// x-axis. And each chart carries a single series, so no legend is needed: the
// title names the thing.
//
// Relies on window.HEKAdmin ({ api, esc }) from admin.js, loaded first.
(function () {
  const H = () => window.HEKAdmin || {};
  const api = (...a) => H().api(...a);
  const esc = (s) => (H().esc ? H().esc(s) : String(s));
  const $ = (id) => document.getElementById(id);

  let data = null;
  let days = 30;
  let wired = false;

  const nf = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  const dayLabel = (d) => {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const fmtWhen = (iso) =>
    iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  // Megabytes are the unit the server reports, but nobody reads "20480 MB".
  // Split so the tile can set the unit in its own smaller type; one rule for
  // both readouts, or the same number rounds two ways on the same screen.
  const sizeParts = (mb) => {
    if (mb == null) return ['—', ''];
    if (mb >= 1024) return [(mb / 1024).toFixed(mb >= 10240 ? 0 : 1), 'GB'];
    return [String(Math.round(mb)), 'MB'];
  };
  const fmtSize = (mb) => {
    const [n, unit] = sizeParts(mb);
    return unit ? n + ' ' + unit : n;
  };

  // Three states rather than a gradient, because what the reader needs from
  // this is whether to do something about it, and that has three answers.
  function storageState(pct) {
    if (pct >= 90) return { tone: 'crit', tile: 'bad', word: 'Nearly full' };
    if (pct >= 75) return { tone: 'warn', tile: 'warn', word: 'Filling up' };
    return { tone: 'ok', tile: 'good', word: 'Plenty of room' };
  }

  function uptime(s) {
    if (s == null) return '—';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  // ---- the charts ----
  // A line for counts over time. One series, so the colour carries no identity
  // and the title does the labelling.
  function lineChart(series, key, opts) {
    const o = opts || {};
    const W = 720;
    const HGT = 190;
    const padL = 44;
    const padR = 14;
    const padT = 14;
    const padB = 26;
    const values = series.map((d) => Number(d[key]) || 0);
    const max = Math.max(1, ...values);
    // Round the top of the scale up so the axis reads in whole numbers.
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    const top = Math.ceil(max / step) * step || 1;
    const x = (i) => padL + (i * (W - padL - padR)) / Math.max(series.length - 1, 1);
    const y = (v) => padT + (1 - v / top) * (HGT - padT - padB);

    const pts = values.map((v, i) => [x(i), y(v)]);
    const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area =
      'M' + pts[0][0].toFixed(1) + ' ' + y(0) + ' ' +
      pts.map((p) => 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') +
      ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + y(0) + ' Z';

    // Three gridlines is enough to read a value off; more is chartjunk.
    const ticks = [0, top / 2, top];
    const grid = ticks
      .map(
        (t) =>
          `<line class="dv-grid" x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" />` +
          `<text class="dv-axis" x="${padL - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${nf(Math.round(t))}</text>`
      )
      .join('');

    // Date labels at the ends and the middle only — a label per day collides.
    const marks = [0, Math.floor(series.length / 2), series.length - 1];
    const xLabels = marks
      .map((i) => {
        const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
        return `<text class="dv-axis" x="${x(i).toFixed(1)}" y="${HGT - 8}" text-anchor="${anchor}">${esc(dayLabel(series[i].day))}</text>`;
      })
      .join('');

    // One hit target per day, wider than the mark, so the tooltip is easy to
    // catch on a dense series.
    const bandW = (W - padL - padR) / Math.max(series.length, 1);
    const hits = series
      .map(
        (d, i) =>
          `<rect class="dv-hit" x="${(x(i) - bandW / 2).toFixed(1)}" y="${padT}" width="${bandW.toFixed(1)}" height="${HGT - padT - padB}" data-i="${i}" />`
      )
      .join('');

    const last = values[values.length - 1];
    return `<svg viewBox="0 0 ${W} ${HGT}" class="dv-svg" preserveAspectRatio="none"
                 role="img" aria-label="${esc(o.label || key)} per day">
      ${grid}${xLabels}
      <path class="dv-area ${o.tone || ''}" d="${area}" />
      <path class="dv-line ${o.tone || ''}" d="${path}" />
      <circle class="dv-last ${o.tone || ''}" cx="${x(series.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4" />
      <g class="dv-cursor" style="display:none">
        <line class="dv-crosshair" y1="${padT}" y2="${HGT - padB}" />
        <circle class="dv-dot ${o.tone || ''}" r="5" />
      </g>
      ${hits}
    </svg>`;
  }

  // Horizontal bars for "which parts get used" — magnitude against a shared
  // baseline, which a bar reads better than anything else.
  function barList(rows) {
    if (!rows.length) return '<p class="status-sub" style="margin:0">Nothing recorded yet.</p>';
    const max = Math.max(...rows.map((r) => r.n));
    return (
      '<div class="dv-bars">' +
      rows
        .map(
          (r) => `<div class="dv-bar-row">
            <span class="dv-bar-label">${esc(r.name)}</span>
            <span class="dv-bar-track"><span class="dv-bar" style="width:${Math.max((r.n / max) * 100, 1.5)}%"></span></span>
            <span class="dv-bar-n">${nf(r.n)}</span>
          </div>`
        )
        .join('') +
      '</div>'
    );
  }

  function tile(n, label, opts) {
    const o = opts || {};
    return `<div class="dv-tile${o.tone ? ' ' + o.tone : ''}">
      <div class="dv-tile-n">${n}</div>
      <div class="dv-tile-l">${esc(label)}</div>
      ${o.sub ? `<div class="dv-tile-s">${esc(o.sub)}</div>` : ''}
    </div>`;
  }

  // A single ratio against a limit, which is a meter — not a chart and not a
  // two-slice pie. The track is a wash of whatever colour the fill is, so the
  // state reads across the whole bar; the state is also written out in words,
  // since green-amber-red is exactly the run a colourblind reader cannot
  // separate and the bar must never be the only thing carrying it.
  function storageMeter(st) {
    if (!st) return '';
    const s = storageState(st.pct);
    const note =
      st.basis === 'disk'
        ? 'Disk on the database server, shared by every database on it'
        : 'Against the ' + fmtSize(st.limit_mb) + ' the plan allows';
    return `<div class="dv-meter-title">Database storage</div>
      <p class="dv-meter-note">${esc(note)}</p>
      <div class="dv-meter ${s.tone}">
        <div class="dv-meter-top">
          <span class="dv-meter-word">${esc(s.word)} — ${esc(fmtSize(st.free_mb))} free</span>
          <span class="dv-meter-pct">${nf(st.pct)}% used</span>
        </div>
        <div class="dv-meter-track" role="img"
             aria-label="${esc(fmtSize(st.used_mb))} of ${esc(fmtSize(st.limit_mb))} used, ${esc(fmtSize(st.free_mb))} free">
          <span class="dv-meter-fill" style="width:${Math.max(Number(st.pct) || 0, 1.5)}%"></span>
        </div>
        <div class="dv-meter-ends">
          <span>${esc(fmtSize(st.used_mb))} used</span>
          <span>${esc(fmtSize(st.limit_mb))} total</span>
        </div>
      </div>`;
  }

  // ---- the screen ----
  function render() {
    const s = data.series;
    const today = s[s.length - 1] || {};
    const totalVisits = s.reduce((t, d) => t + d.visitors, 0);
    const totalReq = s.reduce((t, d) => t + d.requests, 0);
    const totalErr = s.reduce((t, d) => t + d.errors, 0);
    const served = s.filter((d) => d.avg_ms != null);
    const avgMs = served.length
      ? Math.round(served.reduce((t, d) => t + d.avg_ms, 0) / served.length)
      : null;
    const sys = data.system || {};
    const tot = data.totals || {};
    const st = sys.storage || null;
    const stFree = st ? sizeParts(st.free_mb) : null;
    const stState = st ? storageState(st.pct) : null;

    $('tab-health').innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="margin:0">App health</h2>
        <div class="row" style="gap:6px;margin:0">
          <select id="dvDays" class="dv-range">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
          <button class="btn ghost sm" id="dvRefresh">Refresh</button>
        </div>
      </div>

      <div class="dv-tiles">
        ${tile(nf(today.visitors), 'Visitors today', { sub: nf(totalVisits) + ' in ' + data.days + ' days' })}
        ${tile(nf(today.requests), 'Requests today', { sub: nf(totalReq) + ' in ' + data.days + ' days' })}
        ${tile(nf(totalErr), 'Errors', {
          tone: totalErr ? 'bad' : 'good',
          sub: totalErr ? 'in the last ' + data.days + ' days' : 'none — all clear',
        })}
        ${tile(avgMs == null ? '—' : avgMs + '<span class="dv-unit">ms</span>', 'Average response', {
          sub: 'across days with traffic',
        })}
        ${
          st
            ? tile(stFree[0] + '<span class="dv-unit">' + stFree[1] + '</span>', 'Storage left', {
                tone: stState.tile,
                sub: nf(st.pct) + '% of ' + fmtSize(st.limit_mb) + ' used',
              })
            : tile('—', 'Storage left', { sub: 'the database did not report it' })
        }
      </div>

      <div class="card dv-card">
        <div class="dv-head">
          <h3>Visitors a day</h3>
          <span class="dv-note">People, counted once each per day</span>
        </div>
        <div class="dv-plot" id="dvVisitors"></div>
      </div>

      <div class="card dv-card">
        <div class="dv-head">
          <h3>Requests a day</h3>
          <span class="dv-note">Pages and API calls together</span>
        </div>
        <div class="dv-plot" id="dvRequests"></div>
      </div>

      <div class="card dv-card">
        <div class="dv-head">
          <h3>Errors a day</h3>
          <span class="dv-note">Server errors only (HTTP 500)</span>
        </div>
        <div class="dv-plot" id="dvErrors"></div>
      </div>

      <div class="dv-cols">
        <div class="card dv-card">
          <div class="dv-head"><h3>What gets used</h3><span class="dv-note">Requests per area</span></div>
          ${barList(data.routes || [])}
        </div>
        <div class="card dv-card">
          <div class="dv-head"><h3>Who is using it</h3><span class="dv-note">Requests by kind of account</span></div>
          ${barList(
            Object.entries(data.who || {})
              .map(([name, n]) => ({ name, n }))
              .sort((a, b) => b.n - a.n)
          )}
        </div>
      </div>

      <div class="card dv-card">
        <div class="dv-head">
          <h3>Recent errors</h3>
          ${data.errors.length ? '<button class="btn ghost sm" id="dvClearErrors">Clear the list</button>' : ''}
        </div>
        ${
          data.errors.length
            ? `<table class="dv-errors">
                 <thead><tr><th>When</th><th>Where</th><th>What happened</th><th>Who</th></tr></thead>
                 <tbody>${data.errors
                   .map(
                     (e) => `<tr class="dv-err-row" title="${esc(e.stack || '')}">
                       <td class="qb-dim">${esc(fmtWhen(e.at))}</td>
                       <td><strong>${esc(e.route)}</strong><div class="qb-dim">${esc(e.method)} ${esc(e.path)}</div></td>
                       <td>${esc(e.message)}</td>
                       <td class="qb-dim">${esc(e.who)}</td>
                     </tr>`
                   )
                   .join('')}</tbody>
               </table>
               <p class="status-sub" style="margin:10px 0 0">Hover a row for the stack trace. The list keeps the newest 50; the daily counts above go back further.</p>`
            : '<p class="status-sub" style="margin:0">No errors recorded. That is the good outcome.</p>'
        }
      </div>

      <div class="dv-cols">
        <div class="card dv-card">
          <div class="dv-head"><h3>What the app holds</h3></div>
          <div class="dv-kvs">
            <div><span>Employees</span><span>${nf(tot.employees)} <span class="qb-dim">(${nf(tot.active)} active)</span></span></div>
            <div><span>Time entries</span><span>${nf(tot.punches)} <span class="qb-dim">(${nf(tot.openPunches)} on the clock)</span></span></div>
            <div><span>Scheduled jobs</span><span>${nf(tot.schedules)}</span></div>
            <div><span>Quotes</span><span>${nf(tot.quotes)}</span></div>
            <div><span>Invoices</span><span>${nf(tot.invoices)}</span></div>
            <div><span>Estimate requests</span><span>${nf(tot.requests)}</span></div>
            <div><span>Tasks</span><span>${nf(tot.tasks)}</span></div>
          </div>
        </div>
        <div class="card dv-card">
          <div class="dv-head"><h3>The server</h3></div>
          <div class="dv-kvs">
            <div><span>Running for</span><span>${esc(uptime(sys.uptime_s))}</span></div>
            <div><span>Started</span><span>${esc(fmtWhen(sys.started_at))}</span></div>
            <div><span>Node</span><span>${esc(sys.node || '—')}</span></div>
            <div><span>Memory</span><span>${nf(sys.memory_mb)} MB</span></div>
            <div><span>Database</span><span>${esc(sys.db || '—')}</span></div>
            <div><span>Database size</span><span>${sys.db_mb == null ? '—' : nf(sys.db_mb) + ' MB'}</span></div>
            <div><span>Collections</span><span>${nf(sys.db_collections)}</span></div>
          </div>
          ${storageMeter(st)}
        </div>
      </div>

      <details class="dv-table-view">
        <summary>See the numbers as a table</summary>
        <table class="dv-errors">
          <thead><tr><th>Day</th><th>Visitors</th><th>Pages</th><th>API</th><th>Requests</th><th>Errors</th><th>Avg ms</th></tr></thead>
          <tbody>${s
            .slice()
            .reverse()
            .map(
              (d) => `<tr><td>${esc(d.day)}</td><td>${nf(d.visitors)}</td><td>${nf(d.pages)}</td>
                 <td>${nf(d.api)}</td><td>${nf(d.requests)}</td><td>${nf(d.errors)}</td>
                 <td>${d.avg_ms == null ? '—' : nf(d.avg_ms)}</td></tr>`
            )
            .join('')}</tbody>
        </table>
      </details>

      <div class="dv-tip" id="dvTip" style="display:none"></div>
    `;

    $('dvVisitors').innerHTML = lineChart(s, 'visitors', { label: 'Visitors' });
    $('dvRequests').innerHTML = lineChart(s, 'requests', { label: 'Requests' });
    $('dvErrors').innerHTML = lineChart(s, 'errors', { label: 'Errors', tone: 'bad' });

    $('dvDays').value = String(data.days);
    $('dvDays').addEventListener('change', () => {
      days = Number($('dvDays').value) || 30;
      load().catch((e) => alert(e.message));
    });
    $('dvRefresh').addEventListener('click', () => load().catch((e) => alert(e.message)));
    const clear = $('dvClearErrors');
    if (clear)
      clear.addEventListener('click', async () => {
        if (!confirm('Clear the recorded errors? The daily counts stay.')) return;
        await api('/api/dev/stats/errors', { method: 'DELETE' }).catch((e) => alert(e.message));
        load().catch((e) => alert(e.message));
      });

    wireHover('dvVisitors', s, 'visitors', 'visitor');
    wireHover('dvRequests', s, 'requests', 'request');
    wireHover('dvErrors', s, 'errors', 'error');
  }

  // Crosshair + tooltip. An SVG chart on a screen is an interactive thing;
  // without this the reader can only guess at a day's value.
  function wireHover(boxId, series, key, noun) {
    const box = $(boxId);
    const svg = box.querySelector('svg');
    const cursor = svg.querySelector('.dv-cursor');
    const line = cursor.querySelector('line');
    const dot = cursor.querySelector('circle');
    const tip = $('dvTip');

    box.addEventListener('mousemove', (e) => {
      const hit = e.target.closest('.dv-hit');
      if (!hit) return;
      const i = Number(hit.dataset.i);
      const d = series[i];
      const pts = svg.querySelectorAll('.dv-hit');
      const r = pts[i].getBoundingClientRect();
      const cx = Number(pts[i].getAttribute('x')) + Number(pts[i].getAttribute('width')) / 2;
      // The line path holds the y for this point; read it back off the path.
      const path = svg.querySelector('.dv-line');
      const len = path.getTotalLength();
      let py = 0;
      for (let t = 0; t <= len; t += Math.max(len / 400, 0.5)) {
        const p = path.getPointAtLength(t);
        if (p.x >= cx) { py = p.y; break; }
      }
      cursor.style.display = '';
      line.setAttribute('x1', cx);
      line.setAttribute('x2', cx);
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', py);

      const n = d[key];
      tip.innerHTML =
        `<b>${esc(dayLabel(d.day))}</b><br>${nf(n)} ${esc(noun)}${n === 1 ? '' : 's'}` +
        (key === 'requests' && d.avg_ms != null ? `<br><span class="qb-dim">${nf(d.avg_ms)} ms average</span>` : '');
      tip.style.display = 'block';
      const wrap = box.getBoundingClientRect();
      tip.style.left = Math.min(Math.max(r.left + r.width / 2 - wrap.left, 10), wrap.width - 120) + 'px';
      tip.style.top = box.offsetTop - 4 + 'px';
    });
    box.addEventListener('mouseleave', () => {
      cursor.style.display = 'none';
      tip.style.display = 'none';
    });
  }

  async function load() {
    const box = $('tab-health');
    if (!box) return;
    if (!wired) {
      box.innerHTML = '<p class="status-sub">Loading…</p>';
      wired = true;
    }
    data = await api('/api/dev/stats?days=' + days);
    render();
  }

  window.DevStats = { load };
})();
