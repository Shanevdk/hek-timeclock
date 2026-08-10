// Job scheduling — shared by the admin dashboard and the employee portal.
//
//   Admin:    create / edit jobs — address (with autocomplete), description,
//             date & time, and which employees are assigned.
//   Employee: see the jobs assigned to them and tap the address to open their
//             phone's map app with turn-by-turn directions straight there.
//
// Both pages expose window.HEKAdmin ({ api, esc }); this file is loaded after
// admin.js / portal.js so that helper is ready when these functions run.
(function () {
  const H = () => window.HEKAdmin || {};
  const api = (...a) => H().api(...a);
  const esc = (s) => (H().esc ? H().esc(s) : String(s));
  const $ = (id) => document.getElementById(id);

  // A directions link that opens the map app straight to the destination.
  // Prefer exact coordinates (from geocoding); fall back to the typed address.
  function mapsUrl(job) {
    const dest =
      job.lat != null && job.lng != null
        ? `${job.lat},${job.lng}`
        : encodeURIComponent(job.address);
    return 'https://www.google.com/maps/dir/?api=1&destination=' + dest;
  }

  // Friendly "when" label from the stored date (YYYY-MM-DD) + time (HH:MM).
  function fmtWhen(job) {
    if (!job.date) return 'No date set';
    const d = new Date(job.date + 'T' + (job.time || '00:00'));
    const day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return job.time
      ? day + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : day;
  }

  // ======================= EMPLOYEE (portal) view ==========================
  async function loadMine() {
    const list = $('mySchedList');
    if (!list) return;
    let jobs = [];
    try {
      const d = await api('/api/my/schedules');
      jobs = d.jobs || [];
    } catch (e) {
      list.innerHTML = `<div class="card">${esc(e.message)}</div>`;
      return;
    }
    if ($('mySchedEmpty')) $('mySchedEmpty').style.display = jobs.length ? 'none' : 'block';
    list.innerHTML = jobs
      .map(
        (j) => `<div class="job-card">
          <div class="job-when">${esc(fmtWhen(j))}</div>
          ${j.description ? `<div class="job-desc">${esc(j.description)}</div>` : ''}
          <a class="btn gold job-go" href="${mapsUrl(j)}" target="_blank" rel="noopener">
            <span class="job-addr">📍 ${esc(j.address)}</span>
            <span class="job-go-sub">Tap for directions</span>
          </a>
        </div>`
      )
      .join('');
  }

  // ========================= ADMIN (dashboard) =============================
  let editingId = null;
  let picked = { lat: null, lng: null }; // coords from the last chosen suggestion
  let allEmployees = [];
  let jobsCache = [];
  let weekStart = null; // Monday of the week on screen (YYYY-MM-DD)
  let dragId = null; // job being dragged between columns

  // Wire the admin form once, if we're on the admin page.
  // The board only exists on the dashboard, so it's what tells the two pages
  // apart — the portal loads this same file for its own read-only view.
  if ($('schedBoard')) initAdmin();

  function initAdmin() {
    const addr = $('schedAddr');
    const box = $('schedSuggest');
    let timer = null;

    addr.addEventListener('input', () => {
      picked = { lat: null, lng: null }; // editing the text invalidates a prior pick
      const q = addr.value.trim();
      clearTimeout(timer);
      if (q.length < 3) return hideSuggest();
      timer = setTimeout(() => runGeocode(q), 350);
    });

    async function runGeocode(q) {
      try {
        const d = await api('/api/admin/geocode?q=' + encodeURIComponent(q));
        const rs = d.results || [];
        if (!rs.length) return hideSuggest();
        box._results = rs;
        box.innerHTML = rs
          .map((r, i) => `<div class="addr-item" data-i="${i}">${esc(r.label)}</div>`)
          .join('');
        box.style.display = 'block';
      } catch (e) {
        hideSuggest();
      }
    }
    function hideSuggest() {
      box.innerHTML = '';
      box.style.display = 'none';
    }

    box.addEventListener('click', (e) => {
      const item = e.target.closest('.addr-item');
      if (!item) return;
      const r = (box._results || [])[Number(item.dataset.i)];
      if (!r) return;
      addr.value = r.label;
      picked = { lat: r.lat, lng: r.lng };
      hideSuggest();
    });
    // Click elsewhere closes the suggestion list.
    document.addEventListener('click', (e) => {
      if (e.target !== addr && !box.contains(e.target)) hideSuggest();
    });

    $('schedSave').addEventListener('click', saveJob);
    $('schedCancel').addEventListener('click', closeForm);
    // The heading tracks what's typed, so it never describes a different job.
    $('schedDesc').addEventListener('input', paintHeader);
    $('schedAddr').addEventListener('input', paintHeader);
    $('schedDate').addEventListener('change', paintHeader);
    $('jobModalBack').addEventListener('click', (e) => {
      if (e.target === $('jobModalBack')) closeForm();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('jobModalBack').classList.contains('open')) closeForm();
    });

    // Takes the date off without touching anything else — the job drops back
    // into "To be scheduled" rather than being lost.
    $('schedUnschedule').addEventListener('click', async () => {
      if (editingId == null) return;
      try {
        await api('/api/admin/schedules/' + editingId, {
          method: 'PATCH',
          body: JSON.stringify({ date: '', time: '' }),
        });
        closeForm();
        await refreshJobs();
      } catch (e) {
        $('schedMsg').textContent = e.message;
      }
    });

    $('schedDelete').addEventListener('click', async () => {
      if (editingId == null) return;
      if (!confirm('Delete this job? This cannot be undone.')) return;
      try {
        await api('/api/admin/schedules/' + editingId, { method: 'DELETE' });
        closeForm();
        await refreshJobs();
      } catch (e) {
        $('schedMsg').textContent = e.message;
      }
    });

    // ---- board ----
    $('schedPrev').addEventListener('click', () => { weekStart = addDays(weekStart, -7); renderBoard(); });
    $('schedNext').addEventListener('click', () => { weekStart = addDays(weekStart, 7); renderBoard(); });
    $('schedToday').addEventListener('click', () => { weekStart = mondayOf(todayStr()); renderBoard(); });
    $('schedSearch').addEventListener('input', renderBoard);
    $('schedNew').addEventListener('click', () => openForm(null));

    const board = $('schedBoard');
    board.addEventListener('click', onBoardClick);

    // Dragging a card onto a day moves the job to that day; onto the backlog
    // takes the date off again. The columns are the whole point of this view,
    // so this is the fastest way to plan a week.
    board.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.sched-card');
      if (!card) return;
      dragId = Number(card.dataset.id);
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox needs something in the payload before it will start a drag.
      e.dataTransfer.setData('text/plain', String(dragId));
    });
    board.addEventListener('dragend', () => {
      dragId = null;
      board.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging'));
      board.querySelectorAll('.drop-over').forEach((c) => c.classList.remove('drop-over'));
    });
    board.addEventListener('dragover', (e) => {
      const zone = e.target.closest('[data-drop]');
      if (!zone || dragId == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('drop-over');
    });
    board.addEventListener('dragleave', (e) => {
      const zone = e.target.closest('[data-drop]');
      if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drop-over');
    });
    board.addEventListener('drop', async (e) => {
      const zone = e.target.closest('[data-drop]');
      if (!zone || dragId == null) return;
      e.preventDefault();
      zone.classList.remove('drop-over');
      const id = dragId;
      dragId = null;
      const to = zone.dataset.drop; // '' means back to the backlog
      const job = jobsCache.find((j) => j.id === id);
      if (!job || (job.date || '') === to) return;
      try {
        // An empty string clears the date server-side; null would be ignored,
        // because the route treats "not sent" and null the same way.
        await api('/api/admin/schedules/' + id, {
          method: 'PATCH',
          body: JSON.stringify({ date: to }),
        });
        await refreshJobs();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  // ---- dates ----
  const DAY_MS = 86400000;
  const todayStr = () => {
    const d = new Date();
    return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  function addDays(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
  }
  // The Monday on or before `day`, so a week always starts the same way.
  function mondayOf(day) {
    const [y, m, d] = day.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return addDays(day, -((dt.getUTCDay() + 6) % 7));
  }
  const dayLabel = (day, opts) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], { timeZone: 'UTC', ...opts });
  };

  function renderEmpChecks(selected) {
    const sel = new Set(selected || []);
    $('schedEmps').innerHTML = allEmployees.length
      ? allEmployees
          .map(
            (e) => `<label class="perm"><input type="checkbox" value="${e.id}"${
              sel.has(e.id) ? ' checked' : ''
            } /> ${esc(e.name)}</label>`
          )
          .join('')
      : '<span style="color:var(--muted);font-size:13px">No employees yet.</span>';
  }
  const collectEmps = () =>
    [...$('schedEmps').querySelectorAll('input[type="checkbox"]:checked')].map((c) =>
      Number(c.value)
    );

  async function loadAdmin() {
    if (!$('schedBoard')) return;
    if (!weekStart) weekStart = mondayOf(todayStr());
    try {
      allEmployees = await api('/api/admin/employees');
    } catch (e) {
      allEmployees = [];
    }
    if (editingId == null) renderEmpChecks([]);
    await refreshJobs();
  }

  async function refreshJobs() {
    const d = await api('/api/admin/schedules');
    jobsCache = d.jobs || [];
    renderBoard();
  }

  // Initials for the crew chips on a card. Falls back to the first letters of
  // the name when nobody has filled the initials field in.
  function initialsFor(id) {
    const e = allEmployees.find((x) => x.id === id);
    if (!e) return '?';
    if (e.initials) return e.initials.slice(0, 3).toUpperCase();
    return (e.name || '?')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || '')
      .join('')
      .toUpperCase();
  }

  function cardHtml(job) {
    const crew = job.employee_ids || [];
    const late = job.date && job.date < todayStr();
    const state = !crew.length ? 'nocrew' : late ? 'past' : 'ok';
    const title = (job.description || '').split('\n')[0].trim() || job.address;
    // Late against what the customer asked for — the thing worth spotting from
    // across the room.
    const overdue = job.due_date && job.date && job.date > job.due_date;
    return `<article class="sched-card ${state}" draggable="true" data-id="${job.id}"
              title="Click to open · drag to another day">
      <div class="sched-card-title">${esc(title)}</div>
      <a class="sched-card-addr" href="${mapsUrl(job)}" target="_blank" rel="noopener"
         title="Open directions">📍 ${esc(job.address)}</a>
      <div class="sched-card-meta">
        ${job.time ? `<span class="sched-card-time">${esc(job.time)}</span>` : ''}
        ${job.job_type && job.job_type !== 'Delivery' ? `<span class="sched-tag">${esc(job.job_type)}</span>` : ''}
        ${job.confirmed ? '<span class="sched-tag ok">Confirmed</span>' : ''}
      </div>
      ${
        job.due_date
          ? `<div class="sched-req${overdue ? ' late' : ''}">Req: ${esc(
              dayLabel(job.due_date, { month: 'short', day: 'numeric' })
            )}</div>`
          : ''
      }
      <div class="sched-card-foot">
        ${
          crew.length
            ? crew.map((id) => `<span class="sched-chip" title="${esc(
                (allEmployees.find((e) => e.id === id) || {}).name || ''
              )}">${esc(initialsFor(id))}</span>`).join('')
            : '<span class="sched-nocrew">No crew yet</span>'
        }
        <button class="link-btn danger sched-del" data-del="${job.id}" title="Delete">✕</button>
      </div>
    </article>`;
  }

  const columnHtml = (opts) =>
    `<div class="sched-col ${opts.cls || ''}">
      <div class="sched-col-head">
        <div class="sched-col-name">${opts.name}</div>
        ${opts.sub ? `<div class="sched-col-sub">${opts.sub}</div>` : ''}
        <span class="sched-col-count">${opts.jobs.length}</span>
      </div>
      <div class="sched-col-body"${opts.drop != null ? ` data-drop="${opts.drop}"` : ''}>
        ${opts.jobs.map(cardHtml).join('') || `<p class="sched-col-empty">${opts.empty || ''}</p>`}
      </div>
    </div>`;

  function renderBoard() {
    const board = $('schedBoard');
    if (!board) return;
    const needle = ($('schedSearch').value || '').trim().toLowerCase();
    const match = (j) =>
      !needle ||
      (j.address || '').toLowerCase().includes(needle) ||
      (j.description || '').toLowerCase().includes(needle);

    const jobs = jobsCache.filter(match);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const weekEnd = days[6];
    $('schedRange').textContent =
      dayLabel(weekStart, { month: 'short', day: 'numeric' }) +
      ' – ' +
      dayLabel(weekEnd, { month: 'short', day: 'numeric', year: 'numeric' });
    $('schedEmpty').style.display = jobsCache.length ? 'none' : 'block';

    const today = todayStr();
    const cols = [
      columnHtml({
        cls: 'backlog',
        name: 'To be scheduled',
        sub: 'No date yet',
        drop: '',
        jobs: jobs.filter((j) => !j.date),
        empty: 'Everything has a date.',
      }),
      ...days.map((day) =>
        columnHtml({
          cls: 'day' + (day === today ? ' is-today' : '') + (day < today ? ' is-past' : ''),
          name: dayLabel(day, { weekday: 'short' }),
          sub: dayLabel(day, { month: 'short', day: 'numeric' }),
          drop: day,
          jobs: jobs.filter((j) => j.date === day),
          empty: '',
        })
      ),
      // A dispatcher's checklist, not a bucket — these cards also sit in their
      // own day column, which is why this one takes no drops.
      columnHtml({
        cls: 'needcrew',
        name: 'Needs a crew',
        sub: 'This week',
        jobs: jobs.filter(
          (j) => j.date && j.date >= weekStart && j.date <= weekEnd && !(j.employee_ids || []).length
        ),
        empty: 'Every job this week has a crew.',
      }),
    ];
    board.innerHTML = cols.join('');
  }

  async function onBoardClick(ev) {
    if (ev.target.closest('a')) return; // let the address link open the map
    const del = ev.target.closest('button[data-del]');
    if (del) {
      ev.stopPropagation();
      const id = Number(del.dataset.del);
      if (!confirm('Delete this job?')) return;
      try {
        await api('/api/admin/schedules/' + id, { method: 'DELETE' });
        await refreshJobs();
      } catch (e) {
        alert(e.message);
      }
      return;
    }
    const card = ev.target.closest('.sched-card');
    if (card) startEdit(Number(card.dataset.id));
  }

  // ---- job detail modal ----
  function openForm(job) {
    if (!job) resetForm();
    $('jobModalBack').classList.add('open');
    if (!job) $('schedAddr').focus();
  }
  function closeForm() {
    $('jobModalBack').classList.remove('open');
    resetForm();
  }

  // The heading mirrors the card: who it's for on the left, when it lands on
  // the right, so the modal is recognisably the same job you clicked.
  function paintHeader() {
    const title = ($('schedDesc').value || '').split('\n')[0].trim();
    $('jobTitle').textContent = title || $('schedAddr').value.trim() || 'New job';
    const d = $('schedDate').value;
    $('jobWhen').textContent = d
      ? dayLabel(d, { weekday: 'long', month: 'long', day: 'numeric' })
      : 'Not scheduled';
    $('jobWhen').classList.toggle('unscheduled', !d);
  }

  function startEdit(id) {
    const j = jobsCache.find((x) => x.id === id);
    if (!j) return;
    editingId = id;
    $('schedAddr').value = j.address || '';
    picked = { lat: j.lat, lng: j.lng };
    $('schedDesc').value = j.description || '';
    $('schedDate').value = j.date || '';
    $('schedTime').value = j.time || '';
    $('schedDue').value = j.due_date || '';
    $('schedType').value = j.job_type || 'Delivery';
    $('schedNotesDriver').value = j.notes_driver || '';
    $('schedNotesInternal').value = j.notes_internal || '';
    $('schedConfirmed').checked = !!j.confirmed;
    renderEmpChecks(j.employee_ids || []);
    $('schedUnschedule').style.display = j.date ? '' : 'none';
    $('schedDelete').style.display = '';
    $('schedMsg').textContent = '';
    paintHeader();
    openForm(j);
  }

  function resetForm() {
    editingId = null;
    picked = { lat: null, lng: null };
    $('schedAddr').value = '';
    $('schedDesc').value = '';
    $('schedDate').value = '';
    $('schedTime').value = '';
    $('schedDue').value = '';
    $('schedType').value = 'Delivery';
    $('schedNotesDriver').value = '';
    $('schedNotesInternal').value = '';
    $('schedConfirmed').checked = false;
    $('schedSuggest').innerHTML = '';
    $('schedSuggest').style.display = 'none';
    renderEmpChecks([]);
    // Nothing to unschedule or delete until the job exists.
    $('schedUnschedule').style.display = 'none';
    $('schedDelete').style.display = 'none';
    $('schedMsg').textContent = '';
    paintHeader();
  }

  async function saveJob() {
    const msg = $('schedMsg');
    msg.className = 'msg err';
    msg.textContent = '';
    const address = $('schedAddr').value.trim();
    if (!address) {
      msg.textContent = 'Enter an address.';
      return;
    }
    const payload = {
      address,
      description: $('schedDesc').value,
      date: $('schedDate').value,
      time: $('schedTime').value,
      due_date: $('schedDue').value,
      job_type: $('schedType').value,
      notes_driver: $('schedNotesDriver').value,
      notes_internal: $('schedNotesInternal').value,
      confirmed: $('schedConfirmed').checked,
      lat: picked.lat,
      lng: picked.lng,
      employee_ids: collectEmps(),
    };
    $('schedSave').disabled = true;
    try {
      if (editingId != null) {
        await api('/api/admin/schedules/' + editingId, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/api/admin/schedules', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      closeForm();
      await refreshJobs();
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      $('schedSave').disabled = false;
    }
  }

  window.Schedule = { loadAdmin, loadMine };
})();
