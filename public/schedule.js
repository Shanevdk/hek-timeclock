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

  // What this file reads through window.Snappy (snappy.js). Its copies are
  // filed under the exact path, so every read of one uses the same constant.
  // The admin paths are only ever read on the dashboard: from the portal they
  // answer 401, and the portal takes a 401 as "signed out".
  const SCHED = '/api/admin/schedules';
  const MY_SCHED = '/api/my/schedules';
  // The employee list carries pay and personal details, so it is kept in
  // memory for the page's life like any read, and never on disk.
  const EMPS = '/api/admin/employees';
  // The board kept on the device for a quick next visit leaves out the
  // office's internal notes (billing contacts, sometimes): no card shows them,
  // and the job form always reads the job fresh.
  const BOARD_ON_DISK = (d) => ({
    ...d,
    jobs: (d.jobs || []).map((j) => {
      const { notes_internal, ...rest } = j;
      return rest;
    }),
  });
  // How far back the board's usual read goes, in days — what the server sends
  // when it isn't given a ?since= (GET /api/admin/schedules).
  const BACK_DAYS = 400;

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

  // ======================= EMPLOYEE (portal) view ==========================
  let myJobs = [];
  let myFolder = ''; // folder open on the job page
  let mineShown = false; // the list on screen is real jobs, not a placeholder
  let mineAt = 0; // when the server's list last arrived (Date.now())

  // The list paints at once from the copy kept last time — on this device,
  // for this employee only, and gone when they sign out — and again from the
  // server's answer if anything changed. Never throws: the portal calls this
  // without waiting on it.
  async function loadMine() {
    const list = $('mySchedList');
    if (!list) return;
    // Nothing to show yet: a line that only appears if the wait is long
    // enough to notice (.wait in styles.css). A kept copy replaces it at once.
    if (!mineShown) list.innerHTML = '<p class="status-sub wait">Loading your jobs…</p>';
    try {
      await Snappy.swr(api, MY_SCHED, takeMine, { persist: true });
    } catch (e) {
      if (!mineShown) {
        list.innerHTML = `<div class="card">${esc(e.message)}</div>`;
        return;
      }
      // A copy is already on screen. Keep it — offline, it's the one thing
      // they can use — and say it may be behind.
      const old = list.querySelector('[data-stale]');
      if (old) old.remove();
      list.insertAdjacentHTML(
        'afterbegin',
        '<p class="status-sub" data-stale>Couldn’t refresh just now — this is the last copy on this device, so it may be out of date.</p>'
      );
    }
  }

  // A list for the screen: the kept copy (fresh = false) or the server's. The
  // job page, if it's open, follows along when its job has changed.
  function takeMine(d, fresh) {
    const openId = openMyJobId();
    const before = openId ? JSON.stringify(myJobs.find((x) => x.id === openId) || null) : '';
    myJobs = d.jobs || [];
    mineShown = true;
    if (fresh) mineAt = Date.now();
    paintMine();
    const now = openId ? myJobs.find((x) => x.id === openId) : null;
    if (now && JSON.stringify(now) !== before) renderMyJob(now);
  }

  function paintMine() {
    const list = $('mySchedList');
    if ($('mySchedEmpty')) $('mySchedEmpty').style.display = myJobs.length ? 'none' : 'block';
    // data-press="fast": a card only opens the job page, so a mouse press
    // opens it on the way down (snappy.js). A finger still opens it on lift.
    list.innerHTML = myJobs
      .map((j) => {
        const n = fileCount(j);
        return `<div class="job-card" data-job="${j.id}" role="button" tabindex="0" data-press="fast">
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
    refreshMyJob(id);
  }

  // The job the job page is showing, or null while it's closed.
  function openMyJobId() {
    if (!$('myJobBack') || !$('myJobBack').classList.contains('open')) return null;
    return Number($('myJobBody').dataset.job) || null;
  }

  // The list's copy of the job is on screen the moment it's tapped; this
  // brings it up to date behind it — new files from the office, a changed
  // note. Usually the answer is already here: it was asked for when the finger
  // landed on the card (see the wiring below). A copy older than the list
  // itself is no use, so it's only taken if it arrived after the list did.
  function refreshMyJob(id) {
    const path = MY_SCHED + '/' + id;
    const got = Snappy.cache.fresh(path, Math.min(30000, Date.now() - mineAt))
      ? Promise.resolve(Snappy.cache.peek(path))
      : Snappy.load(api, path);
    got
      .then((job) => {
        const i = myJobs.findIndex((x) => x.id === id);
        if (!job || i < 0 || JSON.stringify(myJobs[i]) === JSON.stringify(job)) return;
        myJobs[i] = job;
        // The kept list learns it too, so the next visit doesn't paint the
        // old one first.
        Snappy.cache.update(MY_SCHED, (d) => {
          const k = (d.jobs || []).findIndex((x) => x.id === id);
          if (k >= 0) d.jobs[k] = job;
          return d;
        });
        paintMine();
        if (openMyJobId() === id) renderMyJob(job);
      })
      .catch(() => {
        /* the list's copy stays on screen; the list is read again next visit */
      });
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
    // Walking the folders only shows something, so a mouse press acts on the
    // way down (data-press="fast", snappy.js).
    const crumbHtml =
      `<button type="button" class="jf-crumb" data-my-crumb="" data-press="fast">All files</button>` +
      crumbs
        .map((seg, i) => {
          const path = crumbs.slice(0, i + 1).join('/');
          return ` / <button type="button" class="jf-crumb" data-my-crumb="${esc(path)}" data-press="fast">${esc(seg)}</button>`;
        })
        .join('');

    const rows =
      folders
        .map(
          (name) => `<div class="jf-row folder" data-my-folder="${esc(
            myFolder ? myFolder + '/' + name : name
          )}" data-press="fast"><span class="jf-name">📁 ${esc(name)}</span></div>`
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
    // A finger landing on a job — or a mouse resting on one, or the keyboard
    // reaching it — asks for that job, so the job page has its freshest copy
    // by the time the tap lands (refreshMyJob).
    Snappy.intent($('mySchedList'), '[data-job]', (el) =>
      Snappy.prefetch(api, MY_SCHED + '/' + el.dataset.job)
    );
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
  // How far back the loaded jobs go: the server sends about a year (plus every
  // undated job), and paging back further asks again from that week. Declared
  // up here because initAdmin() runs before the code further down.
  let loadedSince = null;
  let dragId = null; // job being dragged between columns
  let jfFolder = ''; // folder open in the job's file panel
  // Jobs ticked on the board. The bulk bar acts on this whole set, and
  // dragging any one of them drags every job in it.
  const selected = new Set();

  // ---- reading the board, and changing it ----
  // The board's usual read — the year or so the server sends unasked, and
  // everything ahead — goes through Snappy.swr: the copy kept from last time
  // paints at once, and the server's answer follows. Paging back past it
  // switches to ?since= reads from that week on (pagedSince), which aren't
  // kept.
  //
  // A change is drawn the moment it's made and sent in the background. A read
  // that crosses paths with one may describe the board from before it: drawn,
  // it would undo the change on screen; kept, it would paint it again next
  // visit. So such a read is refused (readJobs), and once nothing is on its
  // way any more the board is read again (settle).
  let pagedSince = null; // the week paged back to, once past the usual read
  let jobsKnown = false; // jobsCache holds real jobs, kept or fresh
  let crewKnown = false; // allEmployees likewise
  let jobsGen = 0; // the newest read; an older one that lands late is dropped
  let writes = 0; // changes still on their way to the server
  let writeSeq = 0; // goes up as each change starts and as it ends
  let lostRead = false; // a read was refused, so the board owes itself one
  let redrawAfterDrag = false; // jobs arrived mid-drag; drawn when it ends

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
    // into "To be scheduled" rather than being lost. It lands there the moment
    // it's pressed; if the server says no, it goes back and the reason shows.
    $('schedUnschedule').addEventListener('click', () => {
      if (editingId == null) return;
      const id = editingId;
      const job = currentJob();
      closeForm();
      editJobs(
        job ? [job] : [],
        (j) => Object.assign(j, { date: null, end_date: null, time: null }),
        () =>
          api(SCHED + '/' + id, {
            method: 'PATCH',
            body: JSON.stringify({ date: '', end_date: '', time: '' }),
          })
      ).catch((e) => alert(e.message));
    });

    // Gone from the board as soon as it's confirmed, and deleted behind it.
    $('schedDelete').addEventListener('click', () => {
      if (editingId == null) return;
      if (!confirm('Delete this job? This cannot be undone.')) return;
      const id = editingId;
      closeForm();
      removeJobs([id]).catch((e) => alert(e.message));
    });

    // ---- board ----
    // Paging the board only shows something, so a mouse press acts on the way
    // down (data-press="fast", snappy.js).
    ['schedPrev', 'schedNext', 'schedToday'].forEach((id) =>
      $(id).setAttribute('data-press', 'fast')
    );
    $('schedPrev').addEventListener('click', () => {
      weekStart = addDays(weekStart, -7);
      // Past what was loaded: fetch from this week back, then draw.
      if (loadedSince && weekStart < loadedSince) refreshJobs().catch((e) => alert(e.message));
      else renderBoard();
    });
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
    board.addEventListener('dragend', endDrag);
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
    board.addEventListener('drop', (e) => {
      const zone = e.target.closest('[data-drop]');
      if (!zone || dragId == null) return;
      e.preventDefault();
      const id = dragId;
      const to = zone.dataset.drop; // '' means back to the backlog
      // The move redraws the board straight away, which takes the dragged card
      // — and the dragend it would have fired — with it. Tidy up here instead.
      endDrag();
      // Dragging a ticked card drags every ticked card — a week gets planned
      // a stack at a time instead of a card at a time.
      const ids = selected.has(id) ? [...selected] : [id];
      const movers = ids
        .map((x) => jobsCache.find((j) => j.id === x))
        .filter((j) => j && (j.date || '') !== to);
      if (movers.length) moveJobs(movers, to);
    });
  }

  // A drag is over, dropped or not. dragend calls this, and so does drop (see
  // above). Jobs that arrived while the card was in the air are drawn now.
  function endDrag() {
    dragId = null;
    showScrollPad(false);
    const board = $('schedBoard');
    board.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging'));
    board.querySelectorAll('.drop-over').forEach((c) => c.classList.remove('drop-over'));
    if (redrawAfterDrag) {
      redrawAfterDrag = false;
      drawJobs();
    }
  }

  // Moves jobs to the day they were dropped on ('' = back to the backlog): on
  // the board at once, sent in the background, put back if the server says no.
  function moveJobs(movers, to) {
    editJobs(
      movers,
      (j) => slide(j, to),
      // An empty string clears the date server-side; null would be ignored,
      // because the route treats "not sent" and null the same way.
      () =>
        movers.length === 1
          ? api(SCHED + '/' + movers[0].id, {
              method: 'PATCH',
              body: JSON.stringify({ date: to }),
            })
          : api(SCHED + '/bulk', {
              method: 'PATCH',
              body: JSON.stringify({ ids: movers.map((j) => j.id), date: to }),
            })
    ).catch((err) => alert(err.message));
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

  // Only active employees can be booked — the server drops anyone else from a
  // crew when a job is saved. Someone inactive who is still on a job stays on
  // its card and in its form, marked, so the office notices and reassigns it.
  // An id missing from the list altogether keeps its old "(removed)" handling.
  const activeEmployees = () => allEmployees.filter((e) => e.active);
  const isInactive = (id) => {
    const e = allEmployees.find((x) => x.id === id);
    return !!e && !e.active;
  };

  function renderEmpChecks(assigned) {
    const sel = new Set(assigned || []);
    const active = activeEmployees();
    // Anyone inactive still on this job is listed first, ticked but locked:
    // collectEmps leaves them out, so saving takes them off, and the row says so.
    const gone = allEmployees.filter((e) => !e.active && sel.has(e.id));
    $('schedEmps').innerHTML =
      gone
        .map(
          (e) => `<label class="perm" style="cursor:default">
            <input type="checkbox" value="${e.id}" checked disabled />
            <span>
              <span class="perm-label" style="color:var(--red)">${esc(e.name)} (inactive)</span>
              <span class="perm-note">Saving this job takes them off it — tick someone else to cover.</span>
            </span>
          </label>`
        )
        .join('') +
      (active.length
        ? active
            .map(
              (e) => `<label class="perm"><input type="checkbox" value="${e.id}"${
                sel.has(e.id) ? ' checked' : ''
              } /> ${esc(e.name)}</label>`
            )
            .join('')
        : '<span style="color:var(--muted);font-size:13px">No active employees.</span>');
  }
  // The bulk bar's own copy of the crew list — it starts empty every time, so
  // nothing reaches a batch of jobs unless it was ticked here. `keepTicks`
  // is for a crew list that changed mid-visit: what was ticked stays ticked.
  function renderBulkEmps(keepTicks) {
    const box = $('schedBulkEmps');
    if (!box) return;
    const ticked = new Set(
      keepTicks ? [...box.querySelectorAll('input:checked')].map((c) => Number(c.value)) : []
    );
    const active = activeEmployees();
    box.innerHTML = active.length
      ? active
          .map(
            (e) =>
              `<label class="perm"><input type="checkbox" value="${e.id}"${
                ticked.has(e.id) ? ' checked' : ''
              } /> ${esc(e.name)}</label>`
          )
          .join('')
      : '<span style="color:var(--muted);font-size:13px">No active employees.</span>';
  }

  // A locked (inactive) row is skipped, so saving takes them off as promised.
  const collectEmps = () =>
    [...$('schedEmps').querySelectorAll('input[type="checkbox"]:checked:not(:disabled)')].map(
      (c) => Number(c.value)
    );

  async function loadAdmin() {
    if (!$('schedBoard')) return;
    if (!weekStart) weekStart = mondayOf(todayStr());
    // The bulk bar's crew ticks start empty on every visit, as they always have.
    if (crewKnown) renderBulkEmps();
    // Nothing on screen yet: a line that only appears if the wait is long
    // enough to notice (.wait). A kept copy replaces it at once.
    if (!jobsKnown) $('schedBoard').innerHTML = '<p class="status-sub wait">Loading the board…</p>';
    await Promise.all([loadCrew(), refreshJobs()]);
  }

  // The crew the board is drawn against. A copy read earlier in this visit,
  // or warmed by prefetch(), is used at once; the server's answer replaces it
  // only if something changed.
  async function loadCrew() {
    const kept = Snappy.cache.peek(EMPS);
    if (!crewKnown && Array.isArray(kept)) takeCrew(kept);
    try {
      takeCrew(await Snappy.load(api, EMPS));
    } catch (e) {
      // As before: without the list the board still draws, just without names.
      if (!crewKnown) takeCrew([]);
    }
  }

  function takeCrew(list) {
    if (crewKnown && JSON.stringify(list) === JSON.stringify(allEmployees)) return;
    const again = crewKnown;
    allEmployees = list;
    crewKnown = true;
    // A new job's form keeps whatever has been ticked in it so far. A job being
    // edited keeps its crew list as it was opened, as it always has.
    if (editingId == null)
      renderEmpChecks($('jobModalBack').classList.contains('open') ? collectEmps() : []);
    renderBulkEmps(again);
    if (jobsKnown) drawJobs();
  }

  // Reads the board: the usual window through Snappy.swr (kept copy first,
  // then the server's), or — once paged back past it — from that week.
  async function refreshJobs() {
    const gen = ++jobsGen;
    // Paging back past what's loaded asks from that week, and every read after
    // keeps asking from there, so the older weeks don't drop off again.
    if (loadedSince && weekStart && weekStart < loadedSince) pagedSince = weekStart;
    try {
      if (pagedSince) {
        const since = pagedSince;
        const d = await readJobs(SCHED + '?since=' + since);
        if (gen !== jobsGen) return;
        loadedSince = since;
        applyJobs(d, true);
        return;
      }
      await Snappy.swr(
        readJobs,
        SCHED,
        (d, fresh) => {
          // A newer read has started, or a change is on its way: the board on
          // screen is newer than this copy.
          if (gen !== jobsGen || writes) return;
          loadedSince = addDays(todayStr(), -BACK_DAYS);
          applyJobs(d, fresh);
        },
        { persist: BOARD_ON_DISK }
      );
    } catch (e) {
      if (e.stale) return; // crossed a change; the read after it brings the board
      if (!jobsKnown) $('schedBoard').innerHTML = '';
      throw e;
    }
  }

  // Reads whatever the board has loaded straight from the server — never by
  // joining a read that set off before a change — and keeps the copy.
  async function syncJobs() {
    const gen = ++jobsGen;
    const since = pagedSince;
    let d;
    try {
      d = await readJobs(since ? SCHED + '?since=' + since : SCHED);
    } catch (e) {
      if (e.stale) return; // another change came in; the read after it follows
      throw e;
    }
    if (gen !== jobsGen) return;
    loadedSince = since || addDays(todayStr(), -BACK_DAYS);
    if (!since) Snappy.cache.put(SCHED, d, BOARD_ON_DISK);
    applyJobs(d, true);
  }

  // Every read of the board goes through here. One that crossed paths with a
  // change on its way may describe the board from before that change, so it
  // is refused — nothing keeps it, nothing draws it — and the board owes
  // itself a fresh read.
  async function readJobs(path) {
    const seq = writeSeq;
    const calm = !writes;
    const d = await api(path);
    if (calm && seq === writeSeq) return d;
    lostRead = true;
    settle();
    const err = new Error('The board changed while it was being read.');
    err.stale = true;
    throw err;
  }

  // Sends one change to the server. The board already shows it (or, for a
  // save, will once it's in). Once the last change in flight is done, the
  // board is read again, quietly — the refresh that has always followed a
  // change, which also picks up anything the server worked out for itself.
  async function change(request) {
    writes++;
    writeSeq++;
    // The kept copy is from before this change: nothing should paint it now.
    Snappy.cache.drop(SCHED);
    try {
      return await request();
    } finally {
      writes--;
      writeSeq++;
      lostRead = true;
      settle();
    }
  }

  // Owed a read, and nothing is on its way any more: read now. (Before the
  // board has ever loaded there is nothing on screen to bring up to date.)
  function settle() {
    if (writes || !lostRead || !jobsKnown) return;
    lostRead = false;
    syncJobs().catch((e) => console.warn('Schedule: could not re-read the board.', e));
  }

  // Takes a list of jobs for the board: a kept copy (fresh = false) or the
  // server's answer.
  function applyJobs(d, fresh) {
    jobsCache = d.jobs || [];
    jobsKnown = true;
    // A deleted job must not linger in the selection and get written to
    // again. Only the server's answer says what's gone; a kept copy may lag.
    if (fresh) {
      const live = new Set(jobsCache.map((j) => j.id));
      [...selected].forEach((id) => live.has(id) || selected.delete(id));
    }
    drawJobs();
  }

  // Draws the board from jobsCache. Held back until the crew list is in —
  // without it every lane would read "(removed)" — and while a card is being
  // dragged, since a redraw would pull it out of the person's hand (endDrag
  // draws when it lands). Where the board was scrolled to stays put.
  function drawJobs() {
    if (!crewKnown) return;
    if (dragId != null) {
      redrawAfterDrag = true;
      return;
    }
    renderBoard();
    renderBulkBar();
    // An open job's files follow the board. Its form is the person's own work
    // in progress and is left exactly as it is.
    if (editingId != null && $('jobModalBack').classList.contains('open')) renderFiles();
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

  // One crew chip on a card. Someone inactive keeps theirs until the job is
  // saved without them — outlined rather than filled, and spelled out, so it
  // can't pass for crew.
  function chipHtml(id) {
    const name = (allEmployees.find((e) => e.id === id) || {}).name || '';
    const ini = esc(initialsFor(id));
    if (!isInactive(id)) return `<span class="sched-chip" title="${esc(name)}">${ini}</span>`;
    const ring = 'background:none;color:var(--red);box-shadow:inset 0 0 0 1px var(--red)';
    return `<span class="sched-chip" style="${ring}"
      title="${esc(name)} is inactive — open the job to reassign it">${ini} (inactive)</span>`;
  }

  // `day` is the column the card is being drawn in. A multi-day job is drawn
  // once per day it covers; only the card on its first day can be dragged, so
  // "where does this job move to" always has one obvious answer.
  function cardHtml(job, day) {
    const crew = job.employee_ids || [];
    // Someone inactive is shown but doesn't staff the job: with nobody active
    // on it, it is flagged like a job with nobody at all.
    const live = crew.filter((id) => !isInactive(id));
    const late = job.date && job.date < todayStr();
    const state = !live.length ? 'nocrew' : late ? 'past' : 'ok';
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
        <div class="sched-card-title">${esc(title)}</div>
        <div class="sched-card-icons">
          ${job.notes_driver ? '<span title="Notes for the crew">📄</span>' : ''}
          ${fileCount(job) ? `<span title="${fileCount(job)} file(s)">📎</span>` : ''}
        </div>
        <input type="checkbox" class="sched-pick" data-pick="${job.id}"${
          selected.has(job.id) ? ' checked' : ''
        } title="Select for bulk scheduling" />
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
      ${crew.length ? `<div class="sched-card-crew">${crew.map(chipHtml).join('')}</div>` : ''}
      ${live.length ? '' : '<div class="sched-unassigned">Unassigned</div>'}
      <button class="link-btn danger sched-del" data-del="${job.id}" title="Delete">✕</button>
    </article>`;
  }

  // Inside a day the jobs run in the order the crews will reach them: by start
  // time, then anything without a time, then by name so the order is stable.
  function byTime(a, b) {
    const ta = a.time || '99:99';
    const tb = b.time || '99:99';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.description || a.address || '').localeCompare(b.description || b.address || '');
  }

  // How many weeks the board draws at once. The board is a continuous run of
  // weeks rather than one week at a time — planning an install that lands three
  // weeks out shouldn't mean paging there and losing sight of where it came
  // from.
  const WEEKS_SHOWN = 8;

  // Mon–Sat. Sunday is not normally a column: nothing is booked on it, and
  // dropping it makes every other day wider. A week with something on its
  // Sunday gets the column back (see renderBoard).
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

  // Everyone with nothing booked that day. This is the number the office
  // actually schedules against — who is still free — so it sits on every day
  // whether or not anything is booked.
  function unbookedOn(jobs, day) {
    const busy = new Set();
    for (const j of jobs)
      if (jobCoversDay(j, day)) for (const id of j.employee_ids || []) busy.add(id);
    // Someone inactive can't be booked, however empty their day looks.
    return activeEmployees()
      .filter((e) => !busy.has(e.id))
      .map((e) => ({ initials: initialsFor(e.id), name: e.name || '' }))
      .sort((a, b) => a.initials.localeCompare(b.initials));
  }

  // One day is one panel: the day and date, how many jobs it holds, the jobs in
  // time order, and who is still free. The whole panel is the drop target, so a
  // card can land on the heading of a day that has nothing in it yet.
  function dayCellHtml(day, jobs, today) {
    const dayJobs = jobs.filter((j) => jobCoversDay(j, day)).sort(byTime);
    // Against every job, not just those the search shows: someone booked on a
    // job the search hides is still booked.
    const free = unbookedOn(jobsCache, day);
    const cls =
      'sched-day' +
      (day === today ? ' is-today' : '') +
      (day < today ? ' is-past' : '') +
      // On a phone the days stack, so a day with nothing on it shrinks to its
      // heading instead of holding a column's worth of blank space.
      (dayJobs.length ? '' : ' is-empty');
    return `<div class="${cls}" data-drop="${day}">
      <div class="sched-day-head">
        <span class="sched-day-name">${dayLabel(day, { weekday: 'short' })}</span>
        <span class="sched-day-date">${cellDate(day)}</span>
        ${
          dayJobs.length
            ? `<button class="sched-day-all" type="button" data-selcol="${dayJobs
                .map((j) => j.id)
                .join(',')}">${
                dayJobs.every((j) => selected.has(j.id)) ? 'None' : 'All'
              }</button>`
            : ''
        }
        <span class="sched-day-count">${dayJobs.length}</span>
      </div>
      <div class="sched-day-body">
        ${dayJobs.map((j) => cardHtml(j, day)).join('')}
      </div>
      <div class="sched-day-free" title="${esc(
        free.length ? 'Unbooked: ' + free.map((f) => f.name).join(', ') : 'Everyone is booked'
      )}">
        <span class="sched-free-label">Unbooked</span>
        <span class="sched-free-list">${
          free.length
            ? esc(free.map((f) => f.initials).join(', '))
            : '<em>Everyone is booked</em>'
        }</span>
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
    let lastDay = weekStart;
    for (let w = 0; w < WEEKS_SHOWN; w++) {
      const monday = addDays(weekStart, w * 7);
      // A Sunday with anything on it (a date-picker slip, a run over the
      // weekend) gets its column, or the job would sit on no column at all and
      // a run starting that Sunday would have no card to drag. `jobs` is
      // post-search, so searching for such a job brings its Sunday up too.
      const days = jobs.some((j) => jobCoversDay(j, addDays(monday, 6))) ? 7 : DAYS_PER_WEEK;
      let cells = '';
      for (let d = 0; d < days; d++)
        cells += dayCellHtml(addDays(monday, d), jobs, today);
      lastDay = addDays(monday, days - 1);
      // has-sun: the stylesheet gives a week with its Sunday a seventh column
      // when the board is wide enough for days side by side.
      weeks += `<section class="sched-wk">
        <div class="sched-wk-label">Week of ${cellDate(monday)}</div>
        <div class="sched-week-row${days > DAYS_PER_WEEK ? ' has-sun' : ''}">${cells}</div>
      </section>`;
    }
    $('schedRange').textContent =
      dayLabel(weekStart, { month: 'short', day: 'numeric' }) +
      ' – ' +
      dayLabel(lastDay, { month: 'short', day: 'numeric', year: 'numeric' });

    // Redrawn in place, so nothing moves under the person: the backlog keeps
    // its sideways scroll, and a focused tick box or "All" keeps the focus.
    const back = board.querySelector('.sched-backlog-body');
    const left = back ? back.scrollLeft : 0;
    const refocus = focusAgain(board);
    // While anything is ticked every card shows its tick box, not just the
    // one under the pointer.
    board.classList.toggle('selecting', selected.size > 0);
    board.innerHTML = backlog + '<div class="sched-weeks">' + weeks + '</div>';
    if (left) board.querySelector('.sched-backlog-body').scrollLeft = left;
    if (refocus) refocus();
  }

  // The control inside the board that has the keyboard focus, as a way to
  // find it again after a redraw: the same tick box, or the same day's "All",
  // wherever the redraw put them. Null when the focus is anywhere else.
  function focusAgain(board) {
    const el = document.activeElement;
    if (!el || el === board || !board.contains(el)) return null;
    const what = el.dataset.pick
      ? `[data-pick="${el.dataset.pick}"]`
      : el.dataset.selcol
        ? '[data-selcol]'
        : null;
    const box = el.closest('.sched-day, .sched-backlog');
    const zone = box && box.querySelector('[data-drop]');
    if (!what || !zone) return null;
    const day = zone.dataset.drop;
    return () => {
      const z = board.querySelector(`[data-drop="${day}"]`);
      const again = z && z.parentElement.querySelector(what);
      if (again) again.focus({ preventScroll: true });
    };
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

  // ---- changing jobs on the board ----
  // Changes jobs on the board at once and sends the change in the background.
  // If the server refuses, what the edit changed goes back as it was, and the
  // error is the caller's to show.
  function editJobs(jobs, edit, request) {
    return change(() =>
      Snappy.optimistic(() => {
        const was = jobs.map((j) => [j, { ...j }]);
        jobs.forEach(edit);
        // Only the fields this edit touched go back, so undoing it can't also
        // undo another change made to the same job meanwhile.
        const touched = was.map(([j, old]) => [j, old, Object.keys(j).filter((k) => j[k] !== old[k])]);
        drawJobs();
        return () => {
          touched.forEach(([j, old, keys]) => keys.forEach((k) => (j[k] = old[k])));
          drawJobs();
        };
      }, request)
    );
  }

  // Takes jobs off the board at once and deletes them in the background, one
  // request each. If the server refuses, they come back (ticked, if they
  // were), and the read that follows sorts out any that went before it did.
  function removeJobs(ids) {
    const gone = new Set(ids);
    return change(() =>
      Snappy.optimistic(
        () => {
          // Where each one sat, so it can go back to the same place in its
          // crew's lane rather than to the end of it.
          const removed = [];
          jobsCache.forEach((j, i) => gone.has(j.id) && removed.push([i, j]));
          const ticked = ids.filter((id) => selected.has(id));
          jobsCache = jobsCache.filter((j) => !gone.has(j.id));
          ticked.forEach((id) => selected.delete(id));
          drawJobs();
          return () => {
            for (const [i, j] of removed)
              if (!jobsCache.includes(j)) jobsCache.splice(Math.min(i, jobsCache.length), 0, j);
            ticked.forEach((id) => selected.add(id));
            drawJobs();
          };
        },
        async () => {
          for (const id of ids) await api(SCHED + '/' + id, { method: 'DELETE' });
        }
      )
    );
  }

  // Where a job lands when its first day moves to `to` ('' = no date): a run
  // keeps its length, the way the server slides it (shiftedEnd in server.js),
  // so the board doesn't jump when the server's own copy arrives.
  function slide(job, to) {
    const span = job.date && job.end_date ? daysBetween(job.date, job.end_date) : 0;
    job.date = to || null;
    job.end_date = to && span > 0 ? addDays(to, span) : null;
  }

  // What PATCH /api/admin/schedules/bulk does to each job, done here first so
  // the board shows it straight away.
  function bulkEdit(job, body) {
    if (body.date != null) {
      if (body.end_date != null) {
        // The whole selection given the same run. An end that isn't after the
        // start means a single day.
        job.date = body.date || null;
        job.end_date = job.date && body.end_date > job.date ? body.end_date : null;
      } else slide(job, body.date);
    }
    if (body.time != null) job.time = body.time || null;
    if (body.employee_ids != null) {
      // Only active employees can be booked; the server drops anyone else.
      const crew = body.employee_ids.filter((id) => activeEmployees().some((e) => e.id === id));
      const had = job.employee_ids || [];
      const mode = body.crew_mode || 'replace';
      if (mode === 'add') job.employee_ids = [...new Set([...had, ...crew])];
      else if (mode === 'remove') job.employee_ids = had.filter((id) => !crew.includes(id));
      else if (mode === 'replace') job.employee_ids = crew;
    }
  }

  // One request for the whole selection instead of one per card. The cards
  // change at once; if the server says no, they change back and it says why.
  async function bulkPatch(body) {
    if (!selected.size) return;
    const msg = $('schedBulkMsg');
    msg.textContent = '';
    const ids = [...selected];
    const jobs = ids.map((id) => jobsCache.find((j) => j.id === id)).filter(Boolean);
    $('schedBulkCrewMenu').open = false;
    try {
      await editJobs(
        jobs,
        (j) => bulkEdit(j, body),
        () =>
          api(SCHED + '/bulk', {
            method: 'PATCH',
            body: JSON.stringify({ ids, ...body }),
          })
      );
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

  // Off the board as soon as it's confirmed, deleted behind it.
  async function deleteSelected() {
    if (!selected.size) return;
    if (!confirm(`Delete ${selected.size} job(s)? This cannot be undone.`)) return;
    $('schedBulkMsg').textContent = '';
    try {
      await removeJobs([...selected]);
    } catch (e) {
      // Whatever didn't go is back on the board and ticked, so this shows.
      $('schedBulkMsg').textContent = e.message;
    }
  }

  function onBoardClick(ev) {
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
      removeJobs([id]).catch((e) => alert(e.message));
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
    const id = editingId;
    try {
      // Disabled the moment it's pressed, so it can't go twice; "Saving…" only
      // if the wait is long enough to notice (Snappy.busy). The board picks the
      // job up from the read that follows every change.
      await Snappy.busy(
        $('schedSave'),
        () =>
          change(() =>
            id != null
              ? api(SCHED + '/' + id, { method: 'PATCH', body: JSON.stringify(payload) })
              : api(SCHED, { method: 'POST', body: JSON.stringify(payload) })
          ),
        { label: 'Saving…' }
      );
      // Unless they've moved on to another job meanwhile — that form is theirs.
      if (editingId === id) closeForm();
    } catch (e) {
      if (editingId === id) msg.textContent = e.message;
      else alert(e.message);
    }
  }


  // ---- job files (admin) ----
  // Folders live on the job, so an empty one made on purpose sticks around;
  // files are uploaded into whichever folder is open.
  // Matches ATTACH_MAX_BYTES on the server. Only used to refuse an oversized
  // file before anything is uploaded — the server enforces the real limit.
  const MAX_JOB_FILE = 1024 * 1024 * 1024;

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

    // Walking the folders only shows something, so a mouse press acts on the
    // way down (data-press="fast", snappy.js). A folder's own ✕ is left alone.
    const crumbs = jfFolder.split('/').filter(Boolean);
    $('jfCrumbs').innerHTML =
      '<button type="button" class="jf-crumb" data-jf-crumb="" data-press="fast">All files</button>' +
      crumbs
        .map((seg, i) => {
          const path = crumbs.slice(0, i + 1).join('/');
          return ` / <button type="button" class="jf-crumb" data-jf-crumb="${esc(path)}" data-press="fast">${esc(seg)}</button>`;
        })
        .join('');

    const folders = childFolders(job, jfFolder);
    const files = filesIn(job, jfFolder);
    const rows =
      folders
        .map((name) => {
          const path = jfFolder ? jfFolder + '/' + name : name;
          return `<div class="jf-row folder" data-jf-folder="${esc(path)}" data-press="fast" title="Open folder">
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
            <a class="jf-dl" href="/api/admin/schedules/${job.id}/files/${f.id}?download=1"
               title="Download">⤓</a>
            <button type="button" class="jf-del" data-jf-file-del="${f.id}" title="Remove">✕</button>
          </div>`
        )
        .join('');
    $('jfList').innerHTML =
      rows || '<div class="jf-empty">Nothing here yet — drop files in, or make a folder.</div>';
  }

  // After uploads: re-read the job, so the board, the card's file count and
  // the panel can never disagree about what is filed where. An upload doesn't
  // go through change() — it can run for minutes, and the board has to stay
  // readable meanwhile — so it is marked here instead: a read that set off
  // before it finished is refused (readJobs), and the old copy is dropped.
  async function reloadFiles() {
    writeSeq++;
    Snappy.cache.drop(SCHED);
    try {
      await syncJobs();
    } catch (e) {
      // An upload's own error matters more than a refresh that didn't happen.
      if (!$('jfMsg').textContent) $('jfMsg').textContent = e.message;
    }
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
    const files = [...fileList];
    // Files go up one at a time on purpose: several gigabyte uploads at once
    // just make each other slower, and one progress figure is readable.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = files.length > 1 ? `(${i + 1}/${files.length}) ${file.name}` : file.name;
      if (file.size > MAX_JOB_FILE) {
        $('jfMsg').textContent = `"${file.name}" is too large (max 1 GB).`;
        continue;
      }
      try {
        $('jfMsg').textContent = `Uploading ${label}… 0%`;
        await window.HEKUpload.upload({
          base: '/api/admin/schedules/' + id + '/files',
          file,
          // A dropped folder keeps its shape: what it came from is filed
          // underneath the folder that is open.
          extra: { folder: [folder, subPath(file)].filter(Boolean).join('/') },
          onProgress: (frac) => {
            $('jfMsg').textContent = `Uploading ${label}… ${Math.round(frac * 100)}%`;
          },
        });
        $('jfMsg').textContent = '';
      } catch (e) {
        $('jfMsg').textContent = `${file.name}: ${e.message}`;
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
      // The server tidies the name and files its parents too, so the folder
      // appears from the read that follows the change rather than guessed here.
      await change(() =>
        api(SCHED + '/' + job.id + '/folders', {
          method: 'POST',
          body: JSON.stringify({ path: [jfFolder, name].filter(Boolean).join('/') }),
        })
      );
    } catch (e) {
      $('jfMsg').textContent = e.message;
    }
  }

  // The folder and everything in it go from the panel as soon as it's
  // confirmed; if the server refuses, they come back and the reason shows.
  async function deleteJobFolder(path) {
    const job = currentJob();
    if (!job) return;
    const inside = (p) => p === path || p.startsWith(path + '/');
    const n = (job.files || []).filter((f) => inside(f.folder || '')).length;
    if (!confirm(n ? `Delete this folder and the ${n} file(s) in it?` : 'Delete this folder?'))
      return;
    // Standing inside a folder that just went away would show nothing.
    if (inside(jfFolder)) jfFolder = '';
    try {
      await editJobs(
        [job],
        (j) => {
          j.folders = (j.folders || []).filter((p) => !inside(p));
          j.files = (j.files || []).filter((f) => !inside(f.folder || ''));
        },
        () =>
          api(SCHED + '/' + job.id + '/folders?path=' + encodeURIComponent(path), {
            method: 'DELETE',
          })
      );
    } catch (e) {
      $('jfMsg').textContent = e.message;
    }
  }

  // Off the list as soon as it's confirmed; back if the server refuses.
  async function deleteJobFile(fileId) {
    const job = currentJob();
    if (!job || !confirm('Remove this file?')) return;
    try {
      await editJobs(
        [job],
        (j) => {
          j.files = (j.files || []).filter((f) => f.id !== fileId);
        },
        () => api(SCHED + '/' + job.id + '/files/' + fileId, { method: 'DELETE' })
      );
    } catch (e) {
      $('jfMsg').textContent = e.message;
    }
  }

  // A file dropped on a folder is in it at once; back where it was if the
  // server refuses.
  async function moveJobFile(fileId, folder) {
    const job = currentJob();
    if (!job) return;
    try {
      await editJobs(
        [job],
        (j) => {
          j.files = (j.files || []).map((f) => (f.id === fileId ? { ...f, folder } : f));
        },
        () =>
          api(SCHED + '/' + job.id + '/files/' + fileId, {
            method: 'PATCH',
            body: JSON.stringify({ folder }),
          })
      );
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

  // Open one job's detail from elsewhere in the dashboard — an invoice hands
  // over the shipment it just put on the board. That screen has usually just
  // changed the job, so it's read fresh from the server, never from a kept
  // copy: a form opened on an old copy would save the old values back.
  async function openJob(id) {
    if (!$('schedBoard')) return;
    if (!weekStart) weekStart = mondayOf(todayStr());
    await Promise.all([loadCrew(), syncJobs()]);
    startEdit(Number(id));
  }

  // Asks ahead for what this page's schedule will read when it's opened. The
  // shell calls it when a pointer rests on the Schedule tab, and when idle.
  // Each page warms only its own paths: the portal never asks for an admin
  // one, which would answer 401 and sign the employee out.
  function prefetch() {
    if ($('schedBoard')) {
      // Paged back, the board reads with ?since=, which isn't kept; and while
      // a change is on its way, a read would only be refused.
      if (!pagedSince && !writes) Snappy.prefetch(readJobs, SCHED, { persist: BOARD_ON_DISK });
      Snappy.prefetch(api, EMPS);
    } else if ($('mySchedList')) {
      Snappy.prefetch(api, MY_SCHED, { persist: true });
    }
  }

  window.Schedule = { loadAdmin, loadMine, openJob, prefetch };
})();
