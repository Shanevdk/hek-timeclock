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

  // A job runs from `date` to `end_date` inclusive. `end_date` is null for the
  // ordinary one-day job, so these two helpers are the only places that have to
  // know the difference.
  const jobDays = (job) =>
    job.date && job.end_date ? daysBetween(job.date, job.end_date) + 1 : job.date ? 1 : 0;
  const jobCoversDay = (job, day) =>
    !!job.date && (job.end_date ? job.date <= day && day <= job.end_date : job.date === day);

  // Friendly "when" label from the stored date (YYYY-MM-DD) + time (HH:MM).
  // A multi-day job reads as a range, so the crew can see it isn't a one-day
  // visit before they open it.
  function fmtWhen(job) {
    if (!job.date) return 'No date set';
    const d = new Date(job.date + 'T' + (job.time || '00:00'));
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    let day = d.toLocaleDateString([], opts);
    if (job.end_date)
      day += ' – ' + new Date(job.end_date + 'T00:00').toLocaleDateString([], opts);
    return job.time
      ? day + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : day;
  }

  // Human-readable file size for the file lists.
  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  // A rough icon for the file, so a list of names is scannable.
  function fileIcon(f) {
    const t = (f.content_type || '').toLowerCase();
    const ext = (f.filename || '').split('.').pop().toLowerCase();
    if (t.startsWith('image/')) return '🖼️';
    if (t === 'application/pdf' || ext === 'pdf') return '📄';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
    if (['doc', 'docx'].includes(ext)) return '📝';
    if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
    return '📎';
  }

  // The folders sitting directly inside `path`, taken from the first segment of
  // every path below it — so a folder something is filed under always shows up,
  // even if it was never made on its own.
  function childFolders(job, path) {
    const prefix = path ? path + '/' : '';
    const out = new Set();
    const add = (p) => {
      if (!p || !p.startsWith(prefix)) return;
      const seg = p.slice(prefix.length).split('/')[0];
      if (seg) out.add(seg);
    };
    (job.folders || []).forEach(add);
    (job.files || []).forEach((f) => add(f.folder || ''));
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  const filesIn = (job, path) =>
    (job.files || [])
      .filter((f) => (f.folder || '') === path)
      .sort((a, b) => a.filename.localeCompare(b.filename));

  // How many files the job holds, folders and all — the count on the card.
  const fileCount = (job) => (job.files || []).length;

  // Read a File as base64 (strips the "data:*;base64," prefix).
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Could not read the file.'));
      r.readAsDataURL(file);
    });
  }

  // ======================= EMPLOYEE (portal) view ==========================
  let myJobs = [];
  let myFolder = ''; // folder open on the job page

  async function loadMine() {
    const list = $('mySchedList');
    if (!list) return;
    try {
      const d = await api('/api/my/schedules');
      myJobs = d.jobs || [];
    } catch (e) {
      list.innerHTML = `<div class="card">${esc(e.message)}</div>`;
      return;
    }
    if ($('mySchedEmpty')) $('mySchedEmpty').style.display = myJobs.length ? 'none' : 'block';
    list.innerHTML = myJobs
      .map((j) => {
        const n = fileCount(j);
        return `<div class="job-card" data-job="${j.id}" role="button" tabindex="0">
          <div class="job-when">${esc(fmtWhen(j))}</div>
          ${j.description ? `<div class="job-desc">${esc(j.description)}</div>` : ''}
          <div class="job-addr-line">📍 ${esc(j.address)}</div>
          <div class="job-card-foot">
            ${j.job_type && j.job_type !== 'Delivery' ? `<span class="sched-tag">${esc(j.job_type)}</span>` : ''}
            ${n ? `<span class="sched-tag">📎 ${n}</span>` : ''}
            <span class="job-open-sub">Tap to open</span>
          </div>
        </div>`;
      })
      .join('');
  }

  // ---- the employee's job page ----
  // Tapping a job opens everything about it: where it is, what it is, the notes
  // the office left for the crew, and the job's files.
  function openMyJob(id) {
    const j = myJobs.find((x) => x.id === id);
    if (!j || !$('myJobBack')) return;
    myFolder = '';
    $('myJobBack').classList.add('open');
    renderMyJob(j);
  }
  function closeMyJob() {
    if ($('myJobBack')) $('myJobBack').classList.remove('open');
  }

  function renderMyJob(j) {
    // The body remembers which job it is showing, so the folder clicks below
    // can re-render the right one.
    $('myJobBody').dataset.job = j.id;
    $('myJobTitle').textContent =
      (j.description || '').split('\n')[0].trim() || j.address || 'Job';
    $('myJobWhen').textContent = fmtWhen(j);

    const folders = childFolders(j, myFolder);
    const files = filesIn(j, myFolder);
    const crumbs = myFolder.split('/').filter(Boolean);
    const crumbHtml =
      `<button type="button" class="jf-crumb" data-my-crumb="">All files</button>` +
      crumbs
        .map((seg, i) => {
          const path = crumbs.slice(0, i + 1).join('/');
          return ` / <button type="button" class="jf-crumb" data-my-crumb="${esc(path)}">${esc(seg)}</button>`;
        })
        .join('');

    const rows =
      folders
        .map(
          (name) => `<div class="jf-row folder" data-my-folder="${esc(
            myFolder ? myFolder + '/' + name : name
          )}"><span class="jf-name">📁 ${esc(name)}</span></div>`
        )
        .join('') +
      files
        .map(
          (f) => `<a class="jf-row" href="/api/my/schedules/${j.id}/files/${f.id}"
            target="_blank" rel="noopener">
            <span class="jf-name">${fileIcon(f)} ${esc(f.filename)}</span>
            <span class="jf-size">${fmtBytes(f.size || 0)}</span>
          </a>`
        )
        .join('');

    $('myJobBody').innerHTML = `
      <a class="btn gold job-go" href="${mapsUrl(j)}" target="_blank" rel="noopener">
        <span class="job-addr">📍 ${esc(j.address)}</span>
        <span class="job-go-sub">Tap for directions</span>
      </a>
      <dl class="myjob-facts">
        <dt>Type</dt><dd>${esc(j.job_type || 'Delivery')}</dd>
        ${j.due_date ? `<dt>Required by</dt><dd>${esc(j.due_date)}</dd>` : ''}
        ${j.confirmed ? '<dt>Appointment</dt><dd>Confirmed</dd>' : ''}
      </dl>
      ${j.description ? `<div class="myjob-block"><h4>Details</h4><p>${esc(j.description)}</p></div>` : ''}
      ${j.notes_driver ? `<div class="myjob-block"><h4>Notes for you</h4><p>${esc(j.notes_driver)}</p></div>` : ''}
      <div class="myjob-block">
        <h4>Files</h4>
        <div class="jf-crumbs" id="myJobCrumbs">${crumbHtml}</div>
        <div class="jf-list" id="myJobFiles">${
          rows || '<div class="jf-empty">Nothing filed here.</div>'
        }</div>
      </div>`;
  }

  // Wire the portal's job page once, if we're on the portal.
  if ($('mySchedList')) {
    const open = (e) => {
      const card = e.target.closest('[data-job]');
      if (card) openMyJob(Number(card.dataset.job));
    };
    $('mySchedList').addEventListener('click', open);
    $('mySchedList').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(e);
      }
    });
    if ($('myJobBack')) {
      $('myJobClose').addEventListener('click', closeMyJob);
      $('myJobBack').addEventListener('click', (e) => {
        if (e.target === $('myJobBack')) closeMyJob();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMyJob();
      });
      // Walking in and out of the job's folders.
      $('myJobBody').addEventListener('click', (e) => {
        const crumb = e.target.closest('[data-my-crumb]');
        const folder = e.target.closest('[data-my-folder]');
        const hit = crumb || folder;
        if (!hit) return;
        myFolder = crumb ? crumb.dataset.myCrumb : folder.dataset.myFolder;
        const id = Number(($('myJobBody').dataset.job) || 0);
        const j = myJobs.find((x) => x.id === id);
        if (j) renderMyJob(j);
      });
    }
  }

  // ========================= ADMIN (dashboard) =============================
  let editingId = null;
  let picked = { lat: null, lng: null }; // coords from the last chosen suggestion
  let allEmployees = [];
  let jobsCache = [];
  let weekStart = null; // Monday of the week on screen (YYYY-MM-DD)
  let dragId = null; // job being dragged between columns
  let jfFolder = ''; // folder open in the job's file panel
  // Jobs ticked on the board. The bulk bar acts on this whole set, and
  // dragging any one of them drags every job in it.
  const selected = new Set();

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
    $('schedEnd').addEventListener('change', paintHeader);
    $('jobModalBack').addEventListener('click', (e) => {
      if (e.target === $('jobModalBack')) closeForm();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('jobModalBack').classList.contains('open')) closeForm();
      else if (selected.size) clearSelection();
    });

    // Takes the date off without touching anything else — the job drops back
    // into "To be scheduled" rather than being lost.
    $('schedUnschedule').addEventListener('click', async () => {
      if (editingId == null) return;
      try {
        await api('/api/admin/schedules/' + editingId, {
          method: 'PATCH',
          body: JSON.stringify({ date: '', end_date: '', time: '' }),
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
    $('schedToday').addEventListener('click', () => {
      weekStart = mondayOf(todayStr());
      renderBoard();
      // The run starts at today's week, so the top of the board IS today.
      $('schedBoard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('schedSearch').addEventListener('input', renderBoard);
    $('schedNew').addEventListener('click', () => openForm(null));
    initFiles();
    initScrollPad();

    // ---- bulk bar ----
    $('schedBulkApply').addEventListener('click', applyBulk);
    $('schedBulkUnschedule').addEventListener('click', () =>
      bulkPatch({ date: '', end_date: '', time: '' })
    );
    $('schedBulkDelete').addEventListener('click', deleteSelected);
    $('schedBulkClear').addEventListener('click', clearSelection);

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
      showScrollPad(true);
    });
    board.addEventListener('dragend', () => {
      dragId = null;
      showScrollPad(false);
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
      // Dragging a ticked card drags every ticked card — a week gets planned
      // a stack at a time instead of a card at a time.
      const ids = selected.has(id) ? [...selected] : [id];
      const movers = ids
        .map((x) => jobsCache.find((j) => j.id === x))
        .filter((j) => j && (j.date || '') !== to);
      if (!movers.length) return;
      try {
        // An empty string clears the date server-side; null would be ignored,
        // because the route treats "not sent" and null the same way.
        if (movers.length === 1) {
          await api('/api/admin/schedules/' + movers[0].id, {
            method: 'PATCH',
            body: JSON.stringify({ date: to }),
          });
        } else {
          await api('/api/admin/schedules/bulk', {
            method: 'PATCH',
            body: JSON.stringify({ ids: movers.map((j) => j.id), date: to }),
          });
        }
        await refreshJobs();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  // ---- drag scroll pad ----
  // A native HTML5 drag does not scroll the page, and the board now runs
  // several screens deep, so a card cannot reach a week that is off-screen on
  // its own. These two buttons only exist while a card is in hand: hold the
  // pointer over one and the page walks under the card until you leave it.
  let scrollTimer = null; // interval handle while a button is held

  function showScrollPad(on) {
    const pad = $("schedScroll");
    if (!pad) return;
    pad.classList.toggle("on", on);
    pad.setAttribute("aria-hidden", on ? "false" : "true");
    if (!on) stopScrolling();
  }

  function stopScrolling() {
    if (scrollTimer) clearInterval(scrollTimer);
    scrollTimer = null;
    const pad = $("schedScroll");
    if (pad) pad.querySelectorAll("button").forEach((b) => b.classList.remove("pulling"));
  }

  function startScrolling(btn, step) {
    stopScrolling();
    btn.classList.add("pulling");
    // A timer rather than requestAnimationFrame: rAF is suspended outright
    // whenever the tab is not painting, which would leave the button looking
    // active while nothing moved. A timer only slows down.
    scrollTimer = setInterval(() => window.scrollBy(0, step), 16);
  }

  function initScrollPad() {
    const pad = $("schedScroll");
    if (!pad) return;
    const speeds = { schedScrollUp: -12, schedScrollDown: 12 }; // px per frame
    for (const [id, step] of Object.entries(speeds)) {
      const btn = $(id);
      if (!btn) continue;
      // dragover, not mouseenter: while a drag is in progress the pointer
      // events never fire, and dragover is the only signal the button gets.
      btn.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!scrollTimer) startScrolling(btn, step);
      });
      btn.addEventListener("dragleave", stopScrolling);
      // Dropping ON the button should do nothing but stop the scroll — it is
      // not a day, so there is no date to move the job to.
      btn.addEventListener("drop", (e) => {
        e.preventDefault();
        stopScrolling();
      });
    }
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
  // Whole days from `a` to `b` — how long a multi-day job runs for.
  function daysBetween(a, b) {
    return Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / DAY_MS);
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

  function renderEmpChecks(assigned) {
    const sel = new Set(assigned || []);
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
  // The bulk bar's own copy of the crew list — it starts empty every time, so
  // nothing reaches a batch of jobs unless it was ticked here.
  function renderBulkEmps() {
    const box = $('schedBulkEmps');
    if (!box) return;
    box.innerHTML = allEmployees.length
      ? allEmployees
          .map(
            (e) =>
              `<label class="perm"><input type="checkbox" value="${e.id}" /> ${esc(
                e.name
              )}</label>`
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
    renderBulkEmps();
    await refreshJobs();
  }

  async function refreshJobs() {
    const d = await api('/api/admin/schedules');
    jobsCache = d.jobs || [];
    // A deleted job must not linger in the selection and get written to again.
    const live = new Set(jobsCache.map((j) => j.id));
    [...selected].forEach((id) => live.has(id) || selected.delete(id));
    renderBoard();
    renderBulkBar();
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

  // `day` is the column the card is being drawn in. A multi-day job is drawn
  // once per day it covers; only the card on its first day can be dragged, so
  // "where does this job move to" always has one obvious answer.
  function cardHtml(job, day) {
    const crew = job.employee_ids || [];
    const late = job.date && job.date < todayStr();
    const state = !crew.length ? 'nocrew' : late ? 'past' : 'ok';
    // The first line of the description names the job; the rest is detail that
    // belongs on the card too — a card you have to open to recognise is no use
    // on a board you are meant to read at a glance.
    const lines = (job.description || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const title = lines.shift() || job.address;
    // Late against what the customer asked for — the thing worth spotting from
    // across the room.
    const overdue = job.due_date && job.date && job.date > job.due_date;
    const total = jobDays(job);
    const multi = total > 1 && day;
    const nth = multi ? daysBetween(job.date, day) + 1 : 0;
    const isStart = !multi || nth === 1;
    return `<article class="sched-card ${state}${selected.has(job.id) ? ' selected' : ''}${
              multi ? ' spans' + (isStart ? ' span-start' : ' span-mid') : ''
            }"
              ${isStart ? 'draggable="true"' : ''} data-id="${job.id}"
              title="${
                multi && !isStart
                  ? `Day ${nth} of ${total} · click to open · drag from its first day to move it`
                  : 'Click to open · tick (or ctrl-click) to select · drag to another day'
              }">
      <div class="sched-card-top">
        <input type="checkbox" class="sched-pick" data-pick="${job.id}"${
          selected.has(job.id) ? ' checked' : ''
        } title="Select for bulk scheduling" />
        <div class="sched-card-title">${esc(title)}</div>
        <div class="sched-card-icons">
          ${job.notes_driver ? '<span title="Notes for the crew">📄</span>' : ''}
          ${fileCount(job) ? `<span title="${fileCount(job)} file(s)">📎</span>` : ''}
          ${crew.length > 1 ? `<span class="sched-x">× ${crew.length}</span>` : ''}
        </div>
      </div>
      ${lines.map((l) => `<div class="sched-card-line">${esc(l)}</div>`).join('')}
      ${multi ? `<div class="sched-span">Day ${nth} of ${total}</div>` : ''}
      <a class="sched-card-addr" href="${mapsUrl(job)}" target="_blank" rel="noopener"
         title="Open directions">📍 ${esc(job.address)}</a>
      ${
        job.due_date
          ? `<div class="sched-req${overdue ? ' late' : ''}">Req: ${esc(
              dayLabel(job.due_date, { month: 'short', day: 'numeric' })
            )}</div>`
          : ''
      }
      <div class="sched-card-meta">
        ${job.time ? `<span class="sched-card-time">${esc(job.time)}</span>` : ''}
        ${job.job_type && job.job_type !== 'Delivery' ? `<span class="sched-tag">${esc(job.job_type)}</span>` : ''}
        ${job.confirmed ? '<span class="sched-tag ok">Confirmed</span>' : ''}
      </div>
      ${
        crew.length
          ? `<div class="sched-card-crew">${crew
              .map(
                (id) =>
                  `<span class="sched-chip" title="${esc(
                    (allEmployees.find((e) => e.id === id) || {}).name || ''
                  )}">${esc(initialsFor(id))}</span>`
              )
              .join('')}</div>`
          : '<div class="sched-unassigned">Unassigned</div>'
      }
      <button class="link-btn danger sched-del" data-del="${job.id}" title="Delete">✕</button>
      <span class="sched-card-open" aria-hidden="true">↗</span>
    </article>`;
  }

  // Inside a day, jobs sit under whoever is on them — one lane per crew member,
  // then everything still unassigned. A dispatcher reads the board by person
  // ("what is Coltyn on for Tuesday"), not as an undifferentiated pile of cards.
  // A job with several people on it appears in each of their lanes and carries a
  // × count, so nobody has to open it to see that it is shared.
  function groupsForDay(dayJobs) {
    const byEmp = new Map();
    const loose = [];
    for (const j of dayJobs) {
      const crew = j.employee_ids || [];
      if (!crew.length) {
        loose.push(j);
        continue;
      }
      for (const id of crew) {
        if (!byEmp.has(id)) byEmp.set(id, []);
        byEmp.get(id).push(j);
      }
    }
    const groups = [...byEmp.entries()]
      .map(([id, jobs]) => ({
        id,
        name: (allEmployees.find((e) => e.id === id) || {}).name || '(removed)',
        jobs,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (loose.length) groups.push({ id: null, name: 'Unassigned', jobs: loose });
    return groups;
  }

  // A stable colour per crew member, so the same person reads as the same colour
  // on every day of every week. Derived from the id rather than stored, so
  // adding somebody never recolours anyone else.
  const crewHue = (id) => (Number(id) * 47) % 360;

  function groupHtml(g, day) {
    const cards = g.jobs.map((j) => cardHtml(j, day)).join('');
    if (g.id == null)
      return `<section class="sched-group loose">
        <div class="sched-group-head">Unassigned (${g.jobs.length})</div>
        ${cards}
      </section>`;
    return `<section class="sched-group" style="--crew-hue:${crewHue(g.id)}">
      <div class="sched-group-head named">
        <span class="sched-group-name">${esc(g.name)}</span>
        <span class="sched-group-count">${g.jobs.length}</span>
      </div>
      ${cards}
    </section>`;
  }

  // How many weeks the board draws at once. The board is a continuous run of
  // weeks rather than one week at a time — planning an install that lands three
  // weeks out shouldn't mean paging there and losing sight of where it came
  // from.
  const WEEKS_SHOWN = 8;

  // Mon–Sat. Sunday is deliberately not a column: nothing is booked on it, and
  // dropping it makes every other day wider.
  const DAYS_PER_WEEK = 6;

  // "Dec 14", but "Jan 1, 2027" once the date leaves the current year — the
  // year only earns its space when it has actually changed.
  function cellDate(day) {
    const thisYear = new Date().getFullYear();
    const [y] = day.split('-').map(Number);
    return dayLabel(
      day,
      y === thisYear
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' }
    );
  }

  // Everyone with nothing booked that day, by initials. This is the number the
  // office actually schedules against — who is still free — so it sits on every
  // day whether or not anything is booked.
  function unbookedOn(jobs, day) {
    const busy = new Set();
    for (const j of jobs)
      if (jobCoversDay(j, day)) for (const id of j.employee_ids || []) busy.add(id);
    return allEmployees
      .filter((e) => !busy.has(e.id))
      .map((e) => initialsFor(e.id))
      .sort((a, b) => a.localeCompare(b));
  }

  function dayCellHtml(day, jobs, today) {
    const dayJobs = jobs.filter((j) => jobCoversDay(j, day));
    const free = unbookedOn(jobs, day);
    const cls =
      'sched-day' +
      (day === today ? ' is-today' : '') +
      (day < today ? ' is-past' : '') +
      // On a phone the days stack, so a day with nothing on it shrinks to a
      // strip instead of holding a column's worth of blank space.
      (dayJobs.length ? '' : ' is-empty');
    return `<div class="${cls}">
      <div class="sched-day-head">
        <span class="sched-day-name">${dayLabel(day, { weekday: 'short' })}</span>
        ${
          dayJobs.length
            ? `<button class="sched-day-all" type="button" data-selcol="${dayJobs
                .map((j) => j.id)
                .join(',')}">${
                dayJobs.every((j) => selected.has(j.id)) ? 'None' : 'All'
              }</button>`
            : ''
        }
        <span class="sched-day-date">${cellDate(day)}</span>
      </div>
      <div class="sched-day-body" data-drop="${day}">
        ${groupsForDay(dayJobs).map((g) => groupHtml(g, day)).join('')}
      </div>
      <div class="sched-day-free">
        <div class="sched-free-label">Unbooked:</div>
        <div class="sched-free-list">${
          free.length ? esc(free.join(', ')) : '<em>Everyone is booked</em>'
        }</div>
      </div>
    </div>`;
  }

  function renderBoard() {
    const board = $('schedBoard');
    if (!board) return;
    const needle = ($('schedSearch').value || '').trim().toLowerCase();
    const match = (j) =>
      !needle ||
      (j.address || '').toLowerCase().includes(needle) ||
      (j.description || '').toLowerCase().includes(needle);

    const jobs = jobsCache.filter(match);
    const today = todayStr();
    const lastDay = addDays(weekStart, WEEKS_SHOWN * 7 - (7 - DAYS_PER_WEEK) - 1);
    $('schedRange').textContent =
      dayLabel(weekStart, { month: 'short', day: 'numeric' }) +
      ' – ' +
      dayLabel(lastDay, { month: 'short', day: 'numeric', year: 'numeric' });
    $('schedEmpty').style.display = jobsCache.length ? 'none' : 'block';

    // Jobs with no date at all live above the calendar rather than in a column
    // of their own — they belong to no week, and a full-height backlog beside a
    // multi-week grid would be mostly empty space.
    const loose = jobs.filter((j) => !j.date);
    const backlog = `<div class="sched-backlog">
      <div class="sched-backlog-head">
        <span class="sched-backlog-name">To be scheduled</span>
        ${
          loose.length
            ? `<button class="sched-day-all" type="button" data-selcol="${loose
                .map((j) => j.id)
                .join(',')}">${
                loose.every((j) => selected.has(j.id)) ? 'None' : 'All'
              }</button>`
            : ''
        }
        <span class="sched-backlog-count">${loose.length}</span>
      </div>
      <div class="sched-backlog-body" data-drop="">
        ${
          loose.map((j) => cardHtml(j, null)).join('') ||
          '<p class="sched-col-empty">Everything has a date. Drop a card here to unschedule it.</p>'
        }
      </div>
    </div>`;

    let weeks = '';
    for (let w = 0; w < WEEKS_SHOWN; w++) {
      const monday = addDays(weekStart, w * 7);
      let cells = '';
      for (let d = 0; d < DAYS_PER_WEEK; d++)
        cells += dayCellHtml(addDays(monday, d), jobs, today);
      weeks += `<div class="sched-week-row">${cells}</div>`;
    }

    board.innerHTML = backlog + '<div class="sched-weeks">' + weeks + '</div>';
  }

  // ---- selecting jobs ----
  function setSelected(id, on, defer) {
    if (on) selected.add(id);
    else selected.delete(id);
    if (!defer) paintSelection();
  }
  function clearSelection() {
    selected.clear();
    paintSelection();
  }
  // The cards carry the tick state, so both have to be repainted together.
  function paintSelection() {
    renderBoard();
    renderBulkBar();
  }

  function renderBulkBar() {
    const bar = $('schedBulk');
    if (!bar) return;
    bar.hidden = selected.size === 0;
    if (!selected.size) {
      $('schedBulkMsg').textContent = '';
      return;
    }
    $('schedBulkCount').textContent =
      selected.size + (selected.size === 1 ? ' job selected' : ' jobs selected');
  }

  // One request for the whole selection instead of one per card.
  async function bulkPatch(body) {
    if (!selected.size) return;
    const msg = $('schedBulkMsg');
    msg.textContent = 'Saving…';
    try {
      await api('/api/admin/schedules/bulk', {
        method: 'PATCH',
        body: JSON.stringify({ ids: [...selected], ...body }),
      });
      msg.textContent = '';
      $('schedBulkCrewMenu').open = false;
      await refreshJobs();
    } catch (e) {
      msg.textContent = e.message;
    }
  }

  async function applyBulk() {
    const body = {};
    const date = $('schedBulkDate').value;
    const end = $('schedBulkEnd').value;
    const time = $('schedBulkTime').value;
    if (date) body.date = date;
    // A run needs a first day to hang off, and every selected job gets the
    // same one — so "through" only counts alongside a date.
    if (end) {
      if (!date) {
        $('schedBulkMsg').textContent = 'Pick the start date as well as the day it runs through to.';
        return;
      }
      if (end < date) {
        $('schedBulkMsg').textContent = "The last day can't be before the first.";
        return;
      }
      body.end_date = end;
    }
    if (time) body.time = time;
    // Crew only moves when a name is actually ticked — an empty list would
    // otherwise wipe the crew off every selected job by accident.
    const crew = [...$('schedBulkEmps').querySelectorAll('input:checked')].map((c) =>
      Number(c.value)
    );
    if (crew.length) {
      body.employee_ids = crew;
      body.crew_mode = $('schedBulkCrewMode').value;
    }
    if (!Object.keys(body).length) {
      $('schedBulkMsg').textContent = 'Pick a date, a time or a crew member first.';
      return;
    }
    await bulkPatch(body);
  }

  async function deleteSelected() {
    if (!selected.size) return;
    if (!confirm(`Delete ${selected.size} job(s)? This cannot be undone.`)) return;
    const msg = $('schedBulkMsg');
    msg.textContent = 'Deleting…';
    try {
      for (const id of [...selected])
        await api('/api/admin/schedules/' + id, { method: 'DELETE' });
      selected.clear();
      msg.textContent = '';
    } catch (e) {
      msg.textContent = e.message;
    }
    await refreshJobs();
  }

  async function onBoardClick(ev) {
    if (ev.target.closest('a')) return; // let the address link open the map

    const pick = ev.target.closest('input[data-pick]');
    if (pick) return setSelected(Number(pick.dataset.pick), pick.checked);

    // "All" on a column head ticks (or unticks) that whole day at once.
    const colAll = ev.target.closest('button[data-selcol]');
    if (colAll) {
      const ids = colAll.dataset.selcol.split(',').map(Number);
      const on = !ids.every((id) => selected.has(id));
      ids.forEach((id) => setSelected(id, on, true));
      return paintSelection();
    }
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
    if (!card) return;
    const id = Number(card.dataset.id);
    // Ctrl/cmd/shift-click picks a card up into the selection instead of
    // opening it — quicker than aiming at the tick box.
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return setSelected(id, !selected.has(id));
    startEdit(id);
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
    const end = $('schedEnd').value;
    const long = { weekday: 'long', month: 'long', day: 'numeric' };
    $('jobWhen').textContent = !d
      ? 'Not scheduled'
      : end && end > d
        ? dayLabel(d, { weekday: 'short', month: 'short', day: 'numeric' }) +
          ' – ' +
          dayLabel(end, { weekday: 'short', month: 'short', day: 'numeric' }) +
          ' · ' + (daysBetween(d, end) + 1) + ' days'
        : dayLabel(d, long);
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
    $('schedEnd').value = j.end_date || '';
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
    // A job always opens at the top of its own filing cabinet.
    jfFolder = '';
    $('jfMsg').textContent = '';
    renderFiles();
    paintHeader();
    openForm(j);
  }

  function resetForm() {
    editingId = null;
    picked = { lat: null, lng: null };
    $('schedAddr').value = '';
    $('schedDesc').value = '';
    $('schedDate').value = '';
    $('schedEnd').value = '';
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
    jfFolder = '';
    if ($('jfMsg')) $('jfMsg').textContent = '';
    renderFiles();
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
    const end = $('schedEnd').value;
    const start = $('schedDate').value;
    if (end && !start) {
      msg.textContent = 'Give the job a start date before setting the day it runs through to.';
      return;
    }
    if (end && start && end < start) {
      msg.textContent = "The last day can't be before the first.";
      return;
    }
    const payload = {
      address,
      description: $('schedDesc').value,
      date: start,
      end_date: end,
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


  // ---- job files (admin) ----
  // Folders live on the job, so an empty one made on purpose sticks around;
  // files are uploaded into whichever folder is open.
  const MAX_JOB_FILE = 4 * 1024 * 1024;

  function currentJob() {
    return jobsCache.find((j) => j.id === editingId) || null;
  }

  function renderFiles() {
    if (!$('jfPanel')) return;
    const job = currentJob();
    // A file has to hang off something — until the job is saved there is no id
    // to hang it on, so the panel stays shut.
    $('jfPanel').style.display = job ? '' : 'none';
    $('jfLocked').style.display = job ? 'none' : '';
    if (!job) return;

    const crumbs = jfFolder.split('/').filter(Boolean);
    $('jfCrumbs').innerHTML =
      '<button type="button" class="jf-crumb" data-jf-crumb="">All files</button>' +
      crumbs
        .map((seg, i) => {
          const path = crumbs.slice(0, i + 1).join('/');
          return ` / <button type="button" class="jf-crumb" data-jf-crumb="${esc(path)}">${esc(seg)}</button>`;
        })
        .join('');

    const folders = childFolders(job, jfFolder);
    const files = filesIn(job, jfFolder);
    const rows =
      folders
        .map((name) => {
          const path = jfFolder ? jfFolder + '/' + name : name;
          return `<div class="jf-row folder" data-jf-folder="${esc(path)}" title="Open folder">
            <span class="jf-name">📁 ${esc(name)}</span>
            <button type="button" class="jf-del" data-jf-folder-del="${esc(path)}" title="Delete folder">✕</button>
          </div>`;
        })
        .join('') +
      files
        .map(
          (f) => `<div class="jf-row" draggable="true" data-jf-file="${f.id}">
            <a class="jf-name" href="/api/admin/schedules/${job.id}/files/${f.id}"
               target="_blank" rel="noopener" title="${esc(f.filename)}">${fileIcon(f)} ${esc(f.filename)}</a>
            <span class="jf-size">${fmtBytes(f.size || 0)}</span>
            <button type="button" class="jf-del" data-jf-file-del="${f.id}" title="Remove">✕</button>
          </div>`
        )
        .join('');
    $('jfList').innerHTML =
      rows || '<div class="jf-empty">Nothing here yet — drop files in, or make a folder.</div>';
  }

  // Every change re-reads the job, so the board, the card's file count and the
  // panel can never disagree about what is filed where.
  async function reloadFiles() {
    await refreshJobs();
    renderFiles();
  }

  // The folder a dropped file came from, if the browser told us — a folder pick
  // sets webkitRelativePath, a folder drop gets _relPath from the walk below.
  function subPath(file) {
    const rel = file.webkitRelativePath || file._relPath || '';
    return rel.split('/').slice(0, -1).join('/');
  }

  async function uploadJobFiles(fileList) {
    const job = currentJob();
    if (!job) return;
    const id = job.id;
    const folder = jfFolder;
    for (const file of [...fileList]) {
      if (file.size > MAX_JOB_FILE) {
        $('jfMsg').textContent = `"${file.name}" is too large (max 4 MB).`;
        continue;
      }
      try {
        $('jfMsg').textContent = `Uploading ${file.name}…`;
        const data = await fileToBase64(file);
        await api('/api/admin/schedules/' + id + '/files', {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            content_type: file.type,
            // A dropped folder keeps its shape: what it came from is filed
            // underneath the folder that is open.
            folder: [folder, subPath(file)].filter(Boolean).join('/'),
            data,
          }),
        });
        $('jfMsg').textContent = '';
      } catch (e) {
        $('jfMsg').textContent = e.message;
      }
    }
    await reloadFiles();
  }

  // Walk a dropped directory, so dropping a whole folder files everything in it
  // instead of quietly doing nothing.
  async function filesFromDrop(dt) {
    const entries = [...(dt.items || [])]
      .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (!entries.some((e) => e.isDirectory)) return [...dt.files];

    const out = [];
    const walk = (entry, prefix) =>
      entry.isDirectory ? readDir(entry, prefix) : readFile(entry, prefix);
    const readFile = (entry, prefix) =>
      new Promise((resolve) =>
        entry.file((f) => {
          f._relPath = prefix + f.name;
          out.push(f);
          resolve();
        }, resolve)
      );
    // readEntries hands back at most a batch at a time, so it is called until
    // it comes back empty.
    const readDir = async (dir, prefix) => {
      const reader = dir.createReader();
      const kids = [];
      for (;;) {
        const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (!batch.length) break;
        kids.push(...batch);
      }
      for (const k of kids) await walk(k, prefix + dir.name + '/');
    };
    for (const e of entries) await walk(e, '');
    return out;
  }

  async function newJobFolder() {
    const job = currentJob();
    if (!job) return;
    const name = prompt('Folder name', 'Photos');
    if (!name) return;
    try {
      await api('/api/admin/schedules/' + job.id + '/folders', {
        method: 'POST',
        body: JSON.stringify({ path: [jfFolder, name].filter(Boolean).join('/') }),
      });
      await reloadFiles();
    } catch (e) {
      $('jfMsg').textContent = e.message;
    }
  }

  async function deleteJobFolder(path) {
    const job = currentJob();
    if (!job) return;
    const n = (job.files || []).filter(
      (f) => (f.folder || '') === path || (f.folder || '').startsWith(path + '/')
    ).length;
    if (!confirm(n ? `Delete this folder and the ${n} file(s) in it?` : 'Delete this folder?'))
      return;
    try {
      await api('/api/admin/schedules/' + job.id + '/folders?path=' + encodeURIComponent(path), {
        method: 'DELETE',
      });
      // Standing inside a folder that just went away would show nothing.
      if (jfFolder === path || jfFolder.startsWith(path + '/')) jfFolder = '';
      await reloadFiles();
    } catch (e) {
      $('jfMsg').textContent = e.message;
    }
  }

  async function deleteJobFile(fileId) {
    const job = currentJob();
    if (!job || !confirm('Remove this file?')) return;
    try {
      await api('/api/admin/schedules/' + job.id + '/files/' + fileId, { method: 'DELETE' });
      await reloadFiles();
    } catch (e) {
      $('jfMsg').textContent = e.message;
    }
  }

  async function moveJobFile(fileId, folder) {
    const job = currentJob();
    if (!job) return;
    try {
      await api('/api/admin/schedules/' + job.id + '/files/' + fileId, {
        method: 'PATCH',
        body: JSON.stringify({ folder }),
      });
      await reloadFiles();
    } catch (e) {
      $('jfMsg').textContent = e.message;
    }
  }

  function initFiles() {
    if (!$('jfPanel')) return;
    $('jfNewFolder').addEventListener('click', newJobFolder);
    $('jfBrowse').addEventListener('click', () => $('jfFile').click());
    $('jfFile').addEventListener('change', (e) => {
      if (e.target.files.length) uploadJobFiles(e.target.files);
      e.target.value = ''; // allow re-picking the same file
    });

    const drop = $('jfDrop');
    ['dragenter', 'dragover'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add('over');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.remove('over');
      })
    );
    drop.addEventListener('drop', async (e) => {
      if (!e.dataTransfer) return;
      const files = await filesFromDrop(e.dataTransfer);
      if (files.length) uploadJobFiles(files);
    });

    // Walking into folders, and the per-row delete buttons.
    $('jfList').addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // the file link opens the file
      const folderDel = e.target.closest('[data-jf-folder-del]');
      if (folderDel) return deleteJobFolder(folderDel.dataset.jfFolderDel);
      const fileDel = e.target.closest('[data-jf-file-del]');
      if (fileDel) return deleteJobFile(fileDel.dataset.jfFileDel);
      const folder = e.target.closest('[data-jf-folder]');
      if (folder) {
        jfFolder = folder.dataset.jfFolder;
        renderFiles();
      }
    });
    $('jfCrumbs').addEventListener('click', (e) => {
      const crumb = e.target.closest('[data-jf-crumb]');
      if (!crumb) return;
      jfFolder = crumb.dataset.jfCrumb;
      renderFiles();
    });

    // Dragging a file onto a folder row files it in there.
    let dragFile = null;
    $('jfList').addEventListener('dragstart', (e) => {
      const row = e.target.closest('[data-jf-file]');
      if (!row) return;
      dragFile = row.dataset.jfFile;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragFile);
    });
    $('jfList').addEventListener('dragover', (e) => {
      const row = e.target.closest('[data-jf-folder]');
      if (!row || !dragFile) return;
      e.preventDefault();
      row.classList.add('drop-over');
    });
    $('jfList').addEventListener('dragleave', (e) => {
      const row = e.target.closest('[data-jf-folder]');
      if (row) row.classList.remove('drop-over');
    });
    $('jfList').addEventListener('drop', (e) => {
      const row = e.target.closest('[data-jf-folder]');
      if (!row || !dragFile) return;
      e.preventDefault();
      e.stopPropagation();
      const id = dragFile;
      dragFile = null;
      moveJobFile(id, row.dataset.jfFolder);
    });
    $('jfList').addEventListener('dragend', () => {
      dragFile = null;
      $('jfList').querySelectorAll('.drop-over').forEach((r) => r.classList.remove('drop-over'));
    });
  }

  window.Schedule = { loadAdmin, loadMine };
})();
