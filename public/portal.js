// Employee portal logic (the login page at "/").
//
// After signing in, the employee always sees their own hours, plus any extra
// features the admin has granted them (permissions). Admin credentials on this
// same form redirect straight to the admin dashboard.
(function () {
  const $ = (id) => document.getElementById(id);
  let me = null; // { role, id, name, email, permissions }

  // ---- utils ----
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Auth-aware API helper. A 401 (session expired) bounces back to the login
  // gate; the login request itself surfaces its own error message.
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401 && path !== '/api/login') {
      showLogin();
      throw new Error('Please sign in.');
    }
    // Parse the body ourselves so a non-JSON success response (e.g. an HTML
    // fallback page) surfaces a clear error instead of silently becoming {}
    // and crashing later (e.g. reading .toFixed on a missing field).
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      data = null;
    }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
    if (data === null)
      throw new Error('The server returned an unexpected response. Please refresh the page and sign in again.');
    return data;
  }

  // Shared with the Quotes module (quotes.js), which loads right after this file.
  window.HEKAdmin = { api, esc, showLogin };

  const fmtDateTime = (iso) =>
    iso
      ? new Date(iso).toLocaleString([], {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        })
      : '—';

  // ---- auth / views ----
  function showLogin() {
    $('app').style.display = 'none';
    $('loginView').style.display = 'block';
  }
  function showApp() {
    $('loginView').style.display = 'none';
    $('app').style.display = 'block';
    applyPermissions();
    $('sideUser').textContent = me && me.name ? me.name : '';
    showTab('hours');
    loadMyHours().catch((e) => alert(e.message));
    refreshMessageCount();
    refreshClock();
  }

  // Show/hide feature nav based on the granted permissions.
  function applyPermissions() {
    const perms = (me && me.permissions) || [];
    $('navQuotes').style.display = perms.includes('quotes') ? 'block' : 'none';
  }

  $('loginBtn').addEventListener('click', doLogin);
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  async function doLogin() {
    $('loginMsg').textContent = '';
    try {
      const r = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email: $('email').value, password: $('pw').value }),
      });
      $('pw').value = '';
      if (r.role === 'admin') {
        window.location = r.redirect || '/';
        return;
      }
      me = r;
      showApp();
    } catch (e) {
      $('loginMsg').textContent = e.message;
    }
  }

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    me = null;
    showLogin();
  });

  // ---- tabs ----
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.section').forEach((x) => x.classList.remove('active'));
    const tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) tab.classList.add('active');
    const sec = $('tab-' + name);
    if (sec) sec.classList.add('active');
  }
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      showTab(t.dataset.tab);
      if (t.dataset.tab === 'hours') loadMyHours().catch((e) => alert(e.message));
      if (t.dataset.tab === 'messages') openMessages().catch((e) => alert(e.message));
      if (t.dataset.tab === 'schedule' && window.Schedule) window.Schedule.loadMine();
      if (t.dataset.tab === 'timeoff') loadMyVacations().catch((e) => alert(e.message));
      if (t.dataset.tab === 'quotes' && window.Quotes) window.Quotes.load();
    });
  });

  // ---- my hours ----
  function buildQuery() {
    const p = new URLSearchParams();
    if ($('myFrom').value) p.set('from', $('myFrom').value);
    if ($('myTo').value) p.set('to', $('myTo').value);
    return p.toString();
  }

  async function loadMyHours() {
    const data = await api('/api/my/timesheet?' + buildQuery());
    const entries = data.entries || [];
    $('myTotal').textContent = (data.totalHours || 0).toFixed(2);
    $('myEntries').textContent = entries.length;
    $('myEmpty').style.display = entries.length ? 'none' : 'block';
    $('myBody').innerHTML = entries
      .map(
        (r) => `<tr>
          <td>${fmtDateTime(r.clock_in)}</td>
          <td>${r.clock_out ? fmtDateTime(r.clock_out) : '<span class="badge on">on the clock</span>'}</td>
          <td>${r.hours != null ? r.hours.toFixed(2) : '—'}</td>
          <td>${r.work_done ? esc(r.work_done) : '<span style="color:var(--muted)">—</span>'}${
            r.missed_reason
              ? `<div style="font-size:12px;color:var(--red)">missed: ${esc(r.missed_reason)}</div>`
              : ''
          }</td>
        </tr>`
      )
      .join('');
  }

  $('myLoad').addEventListener('click', () => loadMyHours().catch((e) => alert(e.message)));

  // ---- messages (bulletin board) ----
  const md = (s) => (window.mdToHtml ? window.mdToHtml(s) : esc(s));
  const fmtMsgDate = (iso) =>
    iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  function renderMessages(list) {
    $('msgEmpty').style.display = list.length ? 'none' : 'block';
    $('msgList').innerHTML = list
      .map(
        (b) => `<div class="card msg-card">
          <div class="msg-card-head">
            <h3 class="msg-card-title">${esc(b.title)}</h3>
            <div class="msg-card-meta"><div>Published ${fmtMsgDate(b.published_at)}</div></div>
          </div>
          <div class="md-body">${md(b.content)}</div>
        </div>`
      )
      .join('');
  }

  // Update the unread badge (and hide the tab entirely if the board feature is
  // switched off for this org). Runs on load without opening the tab.
  async function refreshMessageCount() {
    try {
      const data = await api('/api/my/bulletins');
      const nav = $('navMessages');
      if (nav) nav.style.display = '';
      const badge = $('msgNavCount');
      if (badge) {
        badge.textContent = data.unread || 0;
        badge.style.display = data.unread ? 'inline-block' : 'none';
      }
    } catch (e) {
      // Feature turned off (403) or another error — hide the tab quietly.
      const nav = $('navMessages');
      if (nav) nav.style.display = 'none';
    }
  }

  // Open the board: show the messages and mark any unread ones as read.
  async function openMessages() {
    const data = await api('/api/my/bulletins');
    const list = data.bulletins || [];
    renderMessages(list);
    const unread = list.filter((b) => !b.read);
    if (unread.length) {
      await Promise.all(
        unread.map((b) => api('/api/my/bulletins/' + b.id + '/read', { method: 'POST' }).catch(() => {}))
      );
      await refreshMessageCount();
    }
  }

  // ---- in-app clock (Clock in / Clock out) ----
  let clock = { clockedIn: false, since: null };
  let nowTimer = null;

  const fmtTime = (d) =>
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Reflect the current status on the sidebar button.
  function renderClockWidget() {
    const canApp = me && me.can_app_clock;
    $('clockWidget').style.display = canApp ? 'block' : 'none';
    if (!canApp) return;
    $('clockBtn').classList.toggle('on', clock.clockedIn);
    $('clockLabel').textContent = clock.clockedIn ? 'Clock Out' : 'Clock In';
    $('clockBtn').setAttribute('aria-label', clock.clockedIn ? 'Clock out' : 'Clock in');
    $('clockStatus').textContent = clock.clockedIn
      ? 'On the clock since ' + fmtDateTime(clock.since)
      : 'Not clocked in';
  }

  async function refreshClock() {
    if (!(me && me.can_app_clock)) {
      $('clockWidget').style.display = 'none';
      return;
    }
    try {
      const s = await api('/api/my/clock-status');
      clock = { clockedIn: !!s.clockedIn, since: s.since || null };
      renderClockWidget();
    } catch (e) {
      $('clockWidget').style.display = 'none';
    }
  }

  function tickNow() {
    $('cmNow').textContent = fmtTime(new Date());
  }

  function openClockModal() {
    const inNow = clock.clockedIn;
    $('cmTitle').textContent = inNow ? 'Clock Out' : 'Clock In';
    $('cmName').textContent = me && me.name ? me.name : '';
    $('cmSub').textContent = inNow
      ? 'On the clock since ' + fmtDateTime(clock.since)
      : '(Not Clocked In)';
    $('cmConfirm').textContent = inNow ? 'Clock Out' : 'Clock In';
    $('cmRemarks').value = '';
    $('cmMsg').textContent = '';
    tickNow();
    if (nowTimer) clearInterval(nowTimer);
    nowTimer = setInterval(tickNow, 1000);
    $('clockModalBack').classList.add('open');
    $('cmRemarks').focus();
  }

  function closeClockModal() {
    $('clockModalBack').classList.remove('open');
    if (nowTimer) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
  }

  async function confirmClock() {
    const wasIn = clock.clockedIn;
    const path = wasIn ? '/api/my/clock-out' : '/api/my/clock-in';
    $('cmMsg').textContent = '';
    try {
      await api(path, {
        method: 'POST',
        body: JSON.stringify({ remarks: $('cmRemarks').value }),
      });
      closeClockModal();
      await refreshClock();
      // Keep the hours view current if they're looking at it.
      loadMyHours().catch(() => {});
    } catch (e) {
      $('cmMsg').textContent = e.message;
    }
  }

  $('clockBtn').addEventListener('click', openClockModal);
  $('cmConfirm').addEventListener('click', confirmClock);
  $('cmCancel').addEventListener('click', closeClockModal);
  $('cmTime').addEventListener('click', tickNow);
  $('clockModalBack').addEventListener('click', (e) => {
    if (e.target === $('clockModalBack')) closeClockModal();
  });

  // ---- time off ----
  // Format a plain 'YYYY-MM-DD' as a local date (parsed as local, not UTC, so
  // the day never shifts across time zones).
  const fmtDay = (s) => {
    if (!s) return '—';
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  };
  const voStatusBadge = (st) =>
    `<span class="badge status-${st}">${st}</span>`;

  async function loadMyVacations() {
    const data = await api('/api/my/vacations');
    const rows = data.requests || [];
    $('voEmpty').style.display = rows.length ? 'none' : 'block';
    $('voBody').innerHTML = rows
      .map(
        (r) => `<tr>
          <td>${fmtDay(r.start_date)}${r.end_date !== r.start_date ? ' – ' + fmtDay(r.end_date) : ''}</td>
          <td>${r.days}</td>
          <td>${r.reason ? esc(r.reason) : '<span style="color:var(--muted)">—</span>'}${
            r.admin_note
              ? `<div style="font-size:12px;color:var(--muted)">Note: ${esc(r.admin_note)}</div>`
              : ''
          }</td>
          <td>${voStatusBadge(r.status)}</td>
          <td>${
            r.status === 'pending'
              ? `<button class="btn ghost sm vo-cancel" data-id="${r.id}">Cancel</button>`
              : ''
          }</td>
        </tr>`
      )
      .join('');
  }

  $('voSubmit').addEventListener('click', async () => {
    $('voMsg').textContent = '';
    try {
      await api('/api/my/vacations', {
        method: 'POST',
        body: JSON.stringify({
          start_date: $('voFrom').value,
          end_date: $('voTo').value,
          reason: $('voReason').value,
        }),
      });
      $('voReason').value = '';
      await loadMyVacations();
    } catch (e) {
      $('voMsg').textContent = e.message;
    }
  });

  $('voBody').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.vo-cancel');
    if (!btn) return;
    if (!confirm('Cancel this vacation request?')) return;
    try {
      await api('/api/my/vacations/' + btn.dataset.id, { method: 'DELETE' });
      await loadMyVacations();
    } catch (e) {
      alert(e.message);
    }
  });

  // ---- boot: default date range = this week, then restore session ----
  (function initDates() {
    const now = new Date();
    const monday = new Date(now);
    const day = (now.getDay() + 6) % 7; // 0 = Monday
    monday.setDate(now.getDate() - day);
    const toStr = (d) => d.toISOString().slice(0, 10);
    $('myFrom').value = toStr(monday);
    $('myTo').value = toStr(now);
    // Time-off pickers default to today.
    $('voFrom').value = toStr(now);
    $('voTo').value = toStr(now);
  })();

  api('/api/me')
    .then((d) => {
      if (d.role === 'admin') {
        window.location = d.redirect || '/';
        return;
      }
      if (d.role === 'employee') {
        me = d;
        showApp();
      } else {
        showLogin();
      }
    })
    .catch(showLogin);
})();
