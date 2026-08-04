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

  // Show/hide feature nav based on the granted permissions. Hours, messages,
  // schedule and time off are baseline and stay visible to everyone; only the
  // tabs listed here are earned. A tab they lost while signed in is also
  // deactivated, so they aren't left staring at a section they can't refresh.
  const GATED_TABS = {
    quotes: 'navQuotes',
    tasks: 'navTasks',
    pricing: 'navPricing',
    map: 'navMap',
  };
  function applyPermissions() {
    const perms = (me && me.permissions) || [];
    Object.entries(GATED_TABS).forEach(([perm, navId]) => {
      const nav = $(navId);
      if (!nav) return;
      const ok = perms.includes(perm);
      nav.style.display = ok ? 'block' : 'none';
      if (!ok) {
        nav.classList.remove('active');
        const sec = $('tab-' + perm);
        if (sec && sec.classList.contains('active')) {
          sec.classList.remove('active');
          const hours = document.querySelector('.tab[data-tab="hours"]');
          if (hours) hours.classList.add('active');
          const hoursSec = $('tab-hours');
          if (hoursSec) hoursSec.classList.add('active');
        }
      }
    });
  }
  const can = (perm) => ((me && me.permissions) || []).includes(perm);

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

  // ---- mobile popout menu ----
  // On a phone the sidebar slides off-canvas; the top bar's hamburger brings it
  // (and the clock button) back.
  function setMenu(open) {
    $('sidebar').classList.toggle('open', open);
    $('sidebarBackdrop').classList.toggle('open', open);
    $('menuToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  $('menuToggle').addEventListener('click', () =>
    setMenu(!$('sidebar').classList.contains('open'))
  );
  $('sidebarBackdrop').addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

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
      if (t.dataset.tab === 'tasks') loadMyTasks().catch((e) => alert(e.message));
      if (t.dataset.tab === 'map') openMap().catch((e) => alert(e.message));
      setMenu(false); // close the popout after choosing a tab
    });
  });

  // ---- map ("map" permission): their own clock-in pins ----
  let map = null;
  let mapMarkers = [];

  function ensureMap() {
    if (map) return map;
    if (!window.L) return null; // Leaflet didn't load (offline) — handled by the caller
    map = L.map('map').setView([43.65, -79.38], 8); // default view: southern Ontario
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    return map;
  }

  async function openMap() {
    if (!can('map')) return;
    if (!ensureMap()) return alert('Map could not load (no internet?).');
    setTimeout(() => map.invalidateSize(), 0); // the section was hidden until now
    await loadMap();
  }

  async function loadMap() {
    if (!map) return;
    const p = new URLSearchParams();
    if ($('mapFrom').value) p.set('from', $('mapFrom').value);
    if ($('mapTo').value) p.set('to', $('mapTo').value);
    const rows = await api('/api/my/locations?' + p.toString());
    mapMarkers.forEach((m) => map.removeLayer(m));
    mapMarkers = [];
    $('mapEmpty').style.display = rows.length ? 'none' : 'block';
    if (!rows.length) return;
    const bounds = [];
    rows.forEach((r) => {
      const mk = L.circleMarker([r.lat, r.lng], {
        radius: 8, color: '#a97f43', fillColor: '#c89b5c', fillOpacity: 0.9, weight: 2,
      }).addTo(map);
      mk.bindPopup('<b>' + esc(r.name) + '</b><br>' + fmtDateTime(r.clock_in));
      mapMarkers.push(mk);
      bounds.push([r.lat, r.lng]);
    });
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
  }
  $('mapLoad').addEventListener('click', () => loadMap().catch((e) => alert(e.message)));

  // ---- my tasks ("tasks" permission) ----
  // A plain list of what's assigned to them rather than the admin's kanban:
  // they can move a card along and comment, but not reshape the board.
  const TASK_COLS = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
  const TASK_PRIOS = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

  async function loadMyTasks() {
    if (!can('tasks')) return;
    const d = await api('/api/my/tasks');
    const tasks = d.tasks || [];
    const open = tasks.filter((t) => t.status !== 'done').length;
    $('mtCount').textContent = tasks.length
      ? open + ' open · ' + tasks.length + ' total'
      : '';
    $('mtEmpty').style.display = tasks.length ? 'none' : 'block';
    $('mtList').innerHTML = tasks
      .map(
        (t) => `<div class="card mt-card${t.status === 'done' ? ' mt-done' : ''}" data-task="${t.id}">
          <div class="mt-head">
            <h3 class="mt-title">${esc(t.title)}</h3>
            <span class="badge prio-${esc(t.priority)}">${esc(TASK_PRIOS[t.priority] || t.priority)}</span>
          </div>
          ${t.description ? `<p class="mt-desc">${esc(t.description)}</p>` : ''}
          <div class="mt-meta">
            ${t.due_date ? `<span>Due ${esc(t.due_date)}</span>` : ''}
            ${t.group ? `<span>${esc(t.group)}</span>` : ''}
            ${t.task_type ? `<span>${esc(t.task_type)}</span>` : ''}
          </div>
          <div class="mt-actions">
            <label>Status</label>
            <select class="mt-status" data-task="${t.id}">
              ${Object.entries(TASK_COLS)
                .map(
                  ([k, name]) =>
                    `<option value="${k}"${t.status === k ? ' selected' : ''}>${esc(name)}</option>`
                )
                .join('')}
            </select>
          </div>
          ${
            (t.comments || []).length
              ? `<div class="mt-comments">${t.comments
                  .map(
                    (c) =>
                      `<div class="mt-comment"><b>${esc(c.author)}</b> ${esc(c.text)}</div>`
                  )
                  .join('')}</div>`
              : ''
          }
          <div class="mt-add">
            <input class="mt-comment-in" data-task="${t.id}" placeholder="Add a comment…" />
            <button class="btn ghost sm mt-comment-btn" data-task="${t.id}" type="button">Post</button>
          </div>
        </div>`
      )
      .join('');
  }

  $('mtList').addEventListener('change', async (e) => {
    const sel = e.target.closest('.mt-status');
    if (!sel) return;
    try {
      await api('/api/my/tasks/' + sel.dataset.task, {
        method: 'PATCH',
        body: JSON.stringify({ status: sel.value }),
      });
      await loadMyTasks();
    } catch (err) {
      alert(err.message);
      await loadMyTasks(); // put the dropdown back where it was
    }
  });

  $('mtList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.mt-comment-btn');
    if (!btn) return;
    const input = $('mtList').querySelector('.mt-comment-in[data-task="' + btn.dataset.task + '"]');
    if (!input || !input.value.trim()) return;
    btn.disabled = true;
    try {
      await api('/api/my/tasks/' + btn.dataset.task + '/comment', {
        method: 'POST',
        body: JSON.stringify({ text: input.value }),
      });
      await loadMyTasks();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- my hours ----
  function buildQuery() {
    const p = new URLSearchParams();
    if ($('myFrom').value) p.set('from', $('myFrom').value);
    if ($('myTo').value) p.set('to', $('myTo').value);
    return p.toString();
  }

  // Jobs tagged at clock-out, shown as chips above the free-text work note.
  const jobChips = (r) =>
    (r.jobs || []).length
      ? `<div class="job-chips">${r.jobs
          .map(
            (j) =>
              `<span class="job-chip"${j.description ? ` title="${esc(j.description)}"` : ''}>${esc(j.address)}</span>`
          )
          .join('')}</div>`
      : '';

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
          <td>${jobChips(r)}${r.work_done ? esc(r.work_done) : '<span style="color:var(--muted)">—</span>'}${
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
  // The sidebar button is how every employee punches in and out. If a punch from
  // an earlier day was never closed, the same button opens a "missed clock-out"
  // form instead, which has to be resolved before clocking in again.
  // `jobs` are the scheduled jobs for `day` (the day a clock-out would be
  // recorded against). The server decides that day, so the browser's own
  // timezone can't disagree about which one it is.
  let clock = { canClock: true, clockedIn: false, since: null, missed: null, day: null, jobs: [] };
  let nowTimer = null;
  let lastOutBoundary = null; // quarter-hour the clock-out picker was built for

  const fmtTime = (d) =>
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtShortTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Shift length so far, e.g. "7h 32m" — shown next to the live clock so they
  // can see the hours the punch is about to record.
  function fmtElapsed(fromIso, to) {
    const mins = Math.max(0, Math.round((to - new Date(fromIso)) / 60000));
    return Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
  }

  // 'YYYY-MM-DDTHH:mm' in local time — the format <input type="datetime-local">
  // expects (toISOString would shift the value into UTC).
  function toLocalInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes())
    );
  }

  // Best-effort device GPS, so the admin map still gets a clock-in location.
  // Resolves null (never rejects) if location is denied, unavailable, or slow —
  // clocking in is never blocked by location being off.
  function getLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      );
    });
  }

  // Reflect the current status on both clock buttons — the sidebar one (desktop)
  // and the top-bar one (phone). Only one of them is visible at a time.
  function renderClockWidget() {
    const missed = !!clock.missed;
    // Salaried staff have no clock. They still see it while a punch is open, so
    // an entry started before they moved onto salary can be closed off.
    const show = clock.canClock || clock.clockedIn || missed;
    $('clockWidget').style.display = show ? '' : 'none';
    // '' hands the bar button back to the stylesheet, which shows it on a phone
    // and hides it on desktop; 'none' hides it at every width.
    $('clockBtnBar').style.display = show ? '' : 'none';
    if (!show) return;
    const label = missed ? 'Fix Clock Out' : clock.clockedIn ? 'Clock Out' : 'Clock In';
    const aria = missed
      ? 'Resolve missed clock-out'
      : clock.clockedIn ? 'Clock out' : 'Clock in';
    ['clockBtn', 'clockBtnBar'].forEach((id) => {
      $(id).classList.toggle('on', clock.clockedIn || missed);
      $(id).setAttribute('aria-label', aria);
    });
    $('clockLabel').textContent = label;
    $('clockLabelBar').textContent = label;
    $('clockStatus').textContent = missed
      ? 'Missed clock-out from ' + fmtDay(clock.missed.day)
      : clock.clockedIn
        ? 'On the clock since ' + fmtDateTime(clock.since)
        : 'Not clocked in';
  }

  async function refreshClock() {
    try {
      const s = await api('/api/my/clock-status');
      clock = {
        canClock: s.canClock !== false,
        clockedIn: !!s.clockedIn,
        since: s.since || null,
        missed: s.missed || null,
        day: s.day || null,
        jobs: Array.isArray(s.jobs) ? s.jobs : [],
      };
      renderClockWidget();
    } catch (e) {
      $('clockStatus').textContent = '';
    }
  }

  // 'HH:MM' in the browser's local time.
  const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

  // The times they can clock out at: "now", then every quarter hour back to
  // their clock-in. Built backwards from now, so a time later than now is never
  // on the list to begin with — there is nothing to type in and be rejected for.
  function renderOutTimes() {
    const now = new Date();
    const start = new Date(clock.since);
    lastOutBoundary = Math.floor(now.getTime() / 900000);
    const opts = ['<option value="">Now — ' + fmtShortTime(now) + '</option>'];
    const step = new Date(now);
    step.setSeconds(0, 0);
    step.setMinutes(Math.floor(step.getMinutes() / 15) * 15);
    // Capped at a day's worth of quarter hours so a bad clock-in timestamp
    // can't spin this into a huge list.
    for (let i = 0; i < 96 && step > start; i++) {
      // Skip a boundary that is effectively "now" — it would just repeat the
      // first option under a different label.
      if (now - step >= 60000)
        opts.push(
          '<option value="' + hhmm(step) + '">' +
            fmtShortTime(step) + ' · ' + fmtElapsed(clock.since, step) +
          '</option>'
        );
      step.setMinutes(step.getMinutes() - 15);
    }
    $('cmOut').innerHTML = opts.join('');
  }

  // The chosen clock-out time as a Date, built on the clock-in's own day (a
  // normal clock-out can't cross midnight — that is the missed-clock-out flow).
  // Empty value = the "Now" option; the server stamps the time itself.
  function chosenOut() {
    const v = $('cmOut').value;
    if (!v || !clock.since) return null;
    const [h, m] = v.split(':').map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
    const d = new Date(clock.since);
    d.setHours(h, m, 0, 0);
    return d;
  }

  function tickNow() {
    const now = new Date();
    $('cmNow').textContent = fmtTime(now);

    // Keep the picker honest while the modal sits open: refresh the "Now"
    // label every tick, and rebuild the list once a new quarter hour passes so
    // the newly-elapsed slot becomes selectable (keeping their choice).
    if (clock.clockedIn && !clock.missed && $('cmOutWrap').style.display !== 'none') {
      const boundary = Math.floor(now.getTime() / 900000);
      if (boundary !== lastOutBoundary) {
        const keep = $('cmOut').value;
        lastOutBoundary = boundary;
        renderOutTimes();
        $('cmOut').value = keep;
        if (!$('cmOut').selectedOptions.length) $('cmOut').value = '';
      }
      const first = $('cmOut').options[0];
      if (first) first.textContent = 'Now — ' + fmtShortTime(now);
    }
    // Count up to the finish time they picked, not to "now" — otherwise a
    // backdated clock-out would show hours it isn't actually going to record.
    // A missed clock-out has its own finish-time field, so skip it there.
    const end = clock.missed ? null : chosenOut() || now;
    $('cmElapsed').textContent =
      clock.clockedIn && !clock.missed && clock.since && end
        ? '· ' + fmtElapsed(clock.since, end) + ' on the clock'
        : '';
  }

  // Checkboxes for the jobs this employee was scheduled on that day. Ticking
  // none is allowed — not every day's work is on the schedule, and clocking out
  // should never be blocked by a missing job.
  function renderJobPicks(show) {
    const jobs = clock.jobs || [];
    $('cmJobsWrap').style.display = show ? 'block' : 'none';
    if (!show) return;
    $('cmJobsLabel').textContent = clock.missed
      ? 'What job did you work on that day?'
      : 'What job did you work on today?';
    $('cmJobs').innerHTML = jobs.length
      ? jobs
          .map(
            (j) => `
        <label class="cm-job">
          <input type="checkbox" class="cm-job-cb" value="${j.id}" />
          <span>
            <span class="cm-job-name">${esc(j.address)}</span>
            ${j.description ? `<span class="cm-job-sub">${esc(j.description)}</span>` : ''}
          </span>
        </label>`
          )
          .join('')
      : '<p class="cm-job-empty">No jobs scheduled for you that day — just describe the work below.</p>';
  }

  function selectedJobIds() {
    return [...document.querySelectorAll('.cm-job-cb:checked')].map((cb) => Number(cb.value));
  }

  function openClockModal() {
    setMenu(false); // the button lives in the drawer on a phone — get it out of the way
    const missed = clock.missed;
    const inNow = clock.clockedIn;
    $('cmTitle').textContent = missed ? 'Missed Clock Out' : inNow ? 'Clock Out' : 'Clock In';
    $('cmName').textContent = me && me.name ? me.name : '';
    $('cmSub').textContent = inNow
      ? 'On the clock since ' + fmtDateTime(clock.since)
      : '(Not Clocked In)';
    $('cmConfirm').textContent = missed ? 'Submit' : inNow ? 'Clock Out' : 'Clock In';

    // Missed clock-out asks for the finish time and why it was missed; a normal
    // clock-out asks what they worked on; clocking in takes optional remarks.
    $('cmMissedWrap').style.display = missed ? 'block' : 'none';
    $('cmReasonWrap').style.display = missed ? 'block' : 'none';
    if (missed) {
      $('cmMissedIntro').textContent =
        'You clocked in on ' + fmtDateTime(missed.clockIn) + ' and never clocked out.';
      const start = new Date(missed.clockIn);
      const end = new Date(start);
      end.setHours(17, 0, 0, 0); // a sensible default: 5pm that day
      $('cmMissedOut').min = toLocalInput(start);
      $('cmMissedOut').value = toLocalInput(end > start ? end : start);
      $('cmMissedReason').value = '';
    }
    $('cmRemarksLabel').textContent = missed
      ? 'What did you do that day?'
      : inNow
        ? 'What did you work on today?'
        : 'Remarks (optional)';
    $('cmRemarks').placeholder = inNow || missed
      ? 'e.g. installed 120ft chain-link fence at Maple St'
      : 'Remarks (optional)';
    $('cmRemarks').value = '';

    // A normal clock-out defaults to now but can be set earlier, for when they
    // left the site well before remembering to hit the button.
    const canPickOut = inNow && !missed;
    $('cmOutWrap').style.display = canPickOut ? 'block' : 'none';
    if (canPickOut) {
      renderOutTimes();
      $('cmOutHint').textContent =
        'Pick an earlier time if you finished before clocking out. Clocked in at ' +
        fmtShortTime(new Date(clock.since)) + '.';
    }

    // The job picker belongs to finishing a day, not starting one.
    renderJobPicks(!!(inNow || missed));
    $('cmMsg').textContent = '';

    tickNow();
    if (nowTimer) clearInterval(nowTimer);
    nowTimer = setInterval(tickNow, 1000);
    $('clockModalBack').classList.add('open');
    (missed ? $('cmMissedOut') : $('cmRemarks')).focus();
  }

  function closeClockModal() {
    $('clockModalBack').classList.remove('open');
    if (nowTimer) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
  }

  async function confirmClock() {
    $('cmMsg').textContent = '';
    const btn = $('cmConfirm');
    btn.disabled = true;
    try {
      if (clock.missed) {
        await api('/api/my/resolve-missed', {
          method: 'POST',
          body: JSON.stringify({
            punchId: clock.missed.punchId,
            clockOut: $('cmMissedOut').value,
            workDone: $('cmRemarks').value,
            reason: $('cmMissedReason').value,
            jobIds: selectedJobIds(),
          }),
        });
      } else if (clock.clockedIn) {
        const out = chosenOut();
        await api('/api/my/clock-out', {
          method: 'POST',
          body: JSON.stringify({
            remarks: $('cmRemarks').value,
            jobIds: selectedJobIds(),
            clockOut: out ? out.toISOString() : null,
          }),
        });
      } else {
        const loc = await getLocation();
        await api('/api/my/clock-in', {
          method: 'POST',
          body: JSON.stringify({
            remarks: $('cmRemarks').value,
            lat: loc ? loc.lat : null,
            lng: loc ? loc.lng : null,
          }),
        });
      }
      closeClockModal();
      await refreshClock();
      // Keep the hours view current if they're looking at it.
      loadMyHours().catch(() => {});
    } catch (e) {
      $('cmMsg').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  $('clockBtn').addEventListener('click', openClockModal);
  $('clockBtnBar').addEventListener('click', openClockModal);
  $('cmConfirm').addEventListener('click', confirmClock);
  $('cmCancel').addEventListener('click', closeClockModal);
  $('cmTime').addEventListener('click', tickNow);
  // Keep the "on the clock" total in step with a hand-picked finish time.
  $('cmOut').addEventListener('change', tickNow);
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
