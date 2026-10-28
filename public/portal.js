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
    // `background` marks a prefetch from snappy.js — a guess at what someone
    // might open next. It means something here, not to fetch().
    const { background, ...init } = opts;
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    if (res.status === 401 && path !== '/api/login') {
      // A guess at the next tab never signs anyone out: their next real
      // request deals with an expired login the usual way.
      if (background) throw new Error('Please sign in.');
      // Everything this device kept for that session goes with it.
      Snappy.cache.clear();
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
    // A change went through. Forget every copy read from the same resource, so
    // no screen paints the state from before it (snappy.js).
    if ((init.method || 'GET').toUpperCase() !== 'GET') Snappy.cache.dropFor(path);
    if (data === null)
      throw new Error('The server returned an unexpected response. Please refresh the page and sign in again.');
    return data;
  }

  // Read `path` again after a change, with a request of its own. Snappy.load()
  // would join a read already on its way — one sent before the change — and
  // paint the state the change replaced.
  async function reread(path, persist) {
    const data = await api(path);
    Snappy.cache.put(path, data, persist);
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
  // What /api/me said about who is signed in. This device keeps that answer
  // (snappy.js), so the next visit opens straight onto their portal while the
  // server confirms it; meKey() names whose kept copies these are.
  const ME = '/api/me';
  const meKey = (d) => 'employee:' + d.id;
  let appShown = false; // the portal is up for `me`
  // Sign-ins and sign-outs on this page, so a slower answer to an earlier
  // "who is signed in?" can't undo one.
  let authChanges = 0;
  let tabLoad = null; // the opening tab's load; warming the others waits for it
  let warmed = false; // the next tabs have been warmed for this sign-in

  // quotes.js, schedule.js and the rest load after this file. The portal can
  // open before they're in; whatever needs one of them waits for this.
  const ready = new Promise((resolve) => {
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    else resolve();
  });

  function showLogin() {
    appShown = false;
    me = null;
    warmed = false;
    closeClockModal(); // never left open over the sign-in form
    $('app').style.display = 'none';
    $('loginView').style.display = 'block';
  }
  function showApp() {
    appShown = true;
    $('loginView').style.display = 'none';
    $('app').style.display = 'block';
    applyPermissions();
    $('sideUser').textContent = me && me.name ? me.name : '';
    // Back to the tab that was open before the refresh; hours otherwise.
    // applyPermissions() has already run, so a tab they cannot see is skipped.
    const back = tabFromUrl();
    if (back) {
      back.click();
    } else {
      showTab('hours');
      tabLoad = loadMyHours().catch(report);
    }
    refreshMessageCount();
    // Asked of the server every time, never painted from a kept copy: what the
    // clock button says has to be true now.
    refreshClock(true);
    warmNextTabs();
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
  // Returns true when the tab on screen was one of those taken away, and they
  // have been moved to their hours.
  function applyPermissions() {
    const perms = (me && me.permissions) || [];
    let moved = false;
    Object.entries(GATED_TABS).forEach(([perm, navId]) => {
      const nav = $(navId);
      if (!nav) return;
      const ok = perms.includes(perm);
      // Empty string, not "block": the grouped nav lays tabs out with flex so
      // the unread badge sits on the right, and forcing block would undo it.
      nav.style.display = ok ? '' : 'none';
      if (!ok) {
        nav.classList.remove('active');
        const sec = $('tab-' + perm);
        if (sec && sec.classList.contains('active')) {
          sec.classList.remove('active');
          const hours = document.querySelector('.tab[data-tab="hours"]');
          if (hours) hours.classList.add('active');
          const hoursSec = $('tab-hours');
          if (hoursSec) hoursSec.classList.add('active');
          moved = true;
        }
      }
    });
    syncNavGroups();
    return moved;
  }

  // A heading with nothing under it is worse than no heading, so a group whose
  // tabs are all hidden disappears with them, and whichever group ends up first
  // loses its divider — otherwise the list opens with a stray line.
  function syncNavGroups() {
    const visible = (el) => el.style.display !== 'none';
    document.querySelectorAll('.side-nav .side-group').forEach((group) => {
      const items = [...group.querySelectorAll('.tab')];
      group.style.display = items.some(visible) ? '' : 'none';
    });
    const groups = [...document.querySelectorAll('.side-nav > .side-group')];
    groups.forEach((g) => g.classList.remove('side-first'));
    const first = groups.find(visible);
    if (first) first.classList.add('side-first');
  }

  const can = (perm) => ((me && me.permissions) || []).includes(perm);

  $('loginBtn').addEventListener('click', doLogin);
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  async function doLogin() {
    const btn = $('loginBtn');
    if (btn.disabled) return; // Enter pressed again while the first try is on its way
    $('loginMsg').textContent = '';
    let r;
    try {
      // The button answers the press at once; "Signing in…" and its spinner
      // only appear if the server is slow to.
      r = await Snappy.busy(
        btn,
        () =>
          api('/api/login', {
            method: 'POST',
            body: JSON.stringify({ email: $('email').value, password: $('pw').value }),
          }),
        { label: 'Signing in…' }
      );
    } catch (e) {
      $('loginMsg').textContent = e.message;
      return;
    }
    // A shared device: whoever was signed in here before, everything kept for
    // them goes before anything of this person's is shown.
    Snappy.cache.clear();
    const turn = ++authChanges;
    $('pw').value = '';
    if (r.role === 'admin') {
      window.location = r.redirect || '/';
      return;
    }
    // The sign-in answer says who this is and when the login runs out, just as
    // /api/me would: take it as that, and open the portal on it.
    if (r.session_expires) {
      me = null;
      confirmMe(r);
      return;
    }
    // A server that doesn't say when the login ends: copies can only be kept on
    // this device until then, so ask /api/me, which does.
    me = r;
    showApp();
    api(ME)
      .then((d) => {
        if (turn === authChanges) confirmMe(d);
      })
      .catch(() => {});
  }

  $('logoutBtn').addEventListener('click', async () => {
    authChanges++;
    // Nothing kept on this device outlives the session it was kept for.
    Snappy.cache.clear();
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    me = null;
    showLogin();
  });

  // The server's word on who is signed in: at boot, and after a sign-in.
  function confirmMe(d) {
    if (d.role === 'admin') {
      // This browser is signed in to the dashboard instead; nothing an
      // employee left on it belongs there.
      Snappy.cache.clear();
      window.location = d.redirect || '/';
      return;
    }
    if (d.role !== 'employee') {
      // Signed out, or never signed in: nothing kept may outlive that.
      Snappy.cache.clear();
      showLogin();
      return;
    }
    if (me && meKey(me) !== meKey(d)) {
      // Someone else has signed in on this device since that copy was kept —
      // in another tab, say. Start over rather than leave their screens up.
      me = null;
      appShown = false;
      Snappy.cache.clear();
      window.location.reload();
      return;
    }
    Snappy.cache.identify(meKey(d), d.session_expires);
    Snappy.cache.put(ME, d, true);
    const before = me;
    me = d;
    if (!appShown) return showApp();
    // Already open on the kept copy: re-apply only what changed.
    if (shapeOf(before) !== shapeOf(d)) reapply();
  }

  // What about the signed-in employee shapes the screen.
  const shapeOf = (m) =>
    JSON.stringify([m.name, m.email, [...(m.permissions || [])].sort(), m.can_clock]);

  // A permission granted or taken away, or a new name, since the kept copy the
  // portal opened on.
  function reapply() {
    $('sideUser').textContent = me && me.name ? me.name : '';
    if (applyPermissions()) {
      // The tab on screen went away with it; they're on their hours now.
      rememberTab('hours');
      loadMyHours().catch(report);
    }
  }

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
  // Which tab is open, remembered in the URL, so a refresh comes back to the
  // same place. Written as "#tab=hours" rather than "#hours" so the browser
  // never mistakes it for an element to scroll to.
  const TAB_HASH = /^#tab=([a-z-]+)$/;

  function rememberTab(name) {
    try {
      history.replaceState(null, '', location.pathname + location.search + '#tab=' + name);
    } catch (e) {
      /* history is unavailable in some embedded views — the tab still works */
    }
  }

  // Only a tab this employee actually has; a stale link to a feature they were
  // never granted falls back to their hours.
  function tabFromUrl() {
    const m = TAB_HASH.exec(location.hash || '');
    if (!m) return null;
    const tab = document.querySelector('.side-nav .tab[data-tab="' + m[1] + '"]');
    if (!tab || tab.style.display === 'none') return null;
    return tab;
  }

  window.addEventListener('hashchange', () => {
    const tab = tabFromUrl();
    if (tab && !tab.classList.contains('active')) tab.click();
  });

  // The switch itself — which tab is lit, which section shows, the phone menu
  // closing — happens first and all at once, before anything is asked of the
  // server. Then the tab loads, painting a kept copy straight away if there
  // is one.
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      const name = t.dataset.tab;
      rememberTab(name);
      showTab(name);
      setMenu(false); // close the popout after choosing a tab
      tabLoad = loadTab(name);
    });
  });

  // A tab that failed to load says so, the way each tab always has — except
  // once they've been signed out, which can now happen while a tab opened from
  // a kept copy is still loading.
  function report(e) {
    if (appShown) alert(e.message);
  }

  // What opening a tab loads. Resolves once its data is in.
  function loadTab(name) {
    if (name === 'hours') return loadMyHours().catch(report);
    if (name === 'messages') return openMessages().catch(report);
    if (name === 'timeoff') return loadMyVacations().catch(report);
    if (name === 'tasks') return loadMyTasks().catch(report);
    if (name === 'map') return openMap().catch(report);
    if (name === 'schedule' || name === 'quotes') {
      const mod = name === 'schedule' ? window.Schedule : window.Quotes;
      if (!mod) {
        // Opened from a kept copy before that tab's file is in: load it as
        // soon as it is, if the tab is still the one on screen.
        if (document.readyState === 'loading')
          return ready.then(() => (isOpen(name) ? loadTab(name) : null));
        return null;
      }
      return name === 'schedule' ? mod.loadMine() : mod.load();
    }
    return null;
  }

  // ---- getting ahead of the next tab ----
  // A tab's data is asked for the moment someone shows interest in it — a
  // mouse resting on it, keyboard focus, a finger landing — so it's usually
  // here by the time the tab opens. Reads only, and a warm-up that meets an
  // expired login never signs anyone out (see `background` in api()).
  function prefetchTab(name) {
    if (!me) return;
    if (name === 'hours') Snappy.prefetch(api, hoursPath());
    else if (name === 'messages') Snappy.prefetch(api, BULLETINS, { persist: true });
    else if (name === 'timeoff') Snappy.prefetch(api, MY_VACATIONS);
    else if (name === 'tasks') {
      if (can('tasks')) Snappy.prefetch(api, MY_TASKS, { persist: true });
    } else if (name === 'map') {
      if (!can('map')) return;
      Snappy.prefetch(api, myMapPath());
      Snappy.leaflet().catch(() => {});
    } else if (name === 'quotes') {
      if (can('quotes') && window.Quotes && window.Quotes.prefetch) window.Quotes.prefetch();
    } else if (name === 'schedule') {
      // The read schedule.js's loadMine() makes, warmed from here rather than
      // through Schedule.prefetch(): an admin-only read is always refused on
      // this page, so nothing here should risk asking for one.
      Snappy.prefetch(api, '/api/my/schedules');
    }
    // Pricing: nothing to warm. Its rate book is an admin-only read.
  }
  Snappy.intent(document.querySelector('.side-nav'), '.tab', (t) => prefetchTab(t.dataset.tab));

  const tabShown = (name) => {
    const t = document.querySelector('.side-nav .tab[data-tab="' + name + '"]');
    return !!t && t.style.display !== 'none';
  };
  const isOpen = (name) => {
    const sec = $('tab-' + name);
    return !!sec && sec.classList.contains('active');
  };

  // Once the first tab has its data, warm the likeliest next few while the
  // portal sits idle: one at a time, a second apart, so they never crowd the
  // screen being looked at. Then the map library, when there's a map or a
  // quote site plan to draw.
  function warmNextTabs() {
    if (warmed) return;
    warmed = true;
    const steps = ['schedule', 'messages', 'timeoff', 'tasks', 'quotes', 'hours']
      .filter((name) => tabShown(name) && !isOpen(name))
      .slice(0, 4)
      .map((name) => () => prefetchTab(name));
    // The map library ahead of time, unless the device is saving data.
    if ((can('map') || can('quotes')) && !Snappy.quiet())
      steps.push(() => Snappy.leaflet().catch(() => {}));
    const next = () => {
      const step = steps.shift();
      if (!step || !me) return; // done, or they've signed out meanwhile
      step();
      setTimeout(() => Snappy.idle(next), 1000);
    };
    Promise.resolve(tabLoad)
      .catch(() => {})
      .then(() => Snappy.idle(next));
  }

  // ---- map ("map" permission): their own clock-in pins ----
  let map = null;
  let mapMarkers = [];
  let mapBuilding = null; // the map on its way while Leaflet loads
  let mapSeq = 0;

  // Create the Leaflet map the first time it's needed. Leaflet itself arrives
  // with the first map opened (snappy.js), not with the sign-in page. Rejects
  // when it can't load — offline, say — and the next call tries again.
  function ensureMap() {
    if (map) return Promise.resolve(map);
    if (!mapBuilding)
      mapBuilding = Snappy.leaflet()
        .then((L) => {
          $('map').innerHTML = ''; // a "couldn't load" note from an earlier try
          map = L.map('map').setView([43.65, -79.38], 8); // default view: southern Ontario
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors',
          }).addTo(map);
          return map;
        })
        .finally(() => {
          mapBuilding = null;
        });
    return mapBuilding;
  }

  // Said where the map should be, so the empty box explains itself.
  function mapUnavailable() {
    if (!map && $('map'))
      $('map').innerHTML =
        '<p class="status-sub" style="padding:22px;margin:0">The map couldn’t load — check ' +
        'the internet connection, then open this tab again.</p>';
  }

  async function openMap() {
    if (!can('map')) return;
    try {
      await ensureMap();
    } catch (e) {
      return mapUnavailable();
    }
    // Leaflet can take a moment the first time. Carry on only if the map is
    // still the tab on screen; opening it again picks up from here.
    if (!isOpen('map')) return;
    // The section was hidden until now: size the map before anything is
    // drawn, and once more after this frame in case the layout was settling.
    map.invalidateSize();
    setTimeout(() => map.invalidateSize(), 0);
    await loadMap();
  }

  function myMapPath() {
    const p = new URLSearchParams();
    if ($('mapFrom').value) p.set('from', $('mapFrom').value);
    if ($('mapTo').value) p.set('to', $('mapTo').value);
    return '/api/my/locations?' + p.toString();
  }

  // Their pins for the range picked: the last copy at once, then the server's
  // answer if it differs. Kept in memory only — where someone clocked in never
  // goes to disk.
  async function loadMap() {
    if (!map) return;
    const seq = ++mapSeq;
    await Snappy.swr(api, myMapPath(), (rows) => {
      if (seq === mapSeq) drawMyMap(rows); // not over a range picked since
    });
  }

  function drawMyMap(rows) {
    mapMarkers.forEach((m) => map.removeLayer(m));
    mapMarkers = [];
    $('mapEmpty').style.display = rows.length ? 'none' : 'block';
    if (!rows.length) return;
    const bounds = [];
    rows.forEach((r) => {
      const mk = L.circleMarker([r.lat, r.lng], {
        radius: 8, color: '#ac7d3f', fillColor: '#c3965a', fillOpacity: 0.9, weight: 2,
      }).addTo(map);
      mk.bindPopup('<b>' + esc(r.name) + '</b><br>' + fmtDateTime(r.clock_in));
      mapMarkers.push(mk);
      bounds.push([r.lat, r.lng]);
    });
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
  }
  $('mapLoad').addEventListener('click', () =>
    Snappy.busy($('mapLoad'), async () => {
      // Also the way to try again after the map library failed to load.
      try {
        await ensureMap();
      } catch (e) {
        return mapUnavailable();
      }
      await loadMap();
    }).catch((e) => alert(e.message))
  );

  // ---- my tasks ("tasks" permission) ----
  // A plain list of what's assigned to them rather than the admin's kanban:
  // they can move a card along and comment, but not reshape the board.
  const TASK_COLS = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
  const TASK_PRIOS = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
  const MY_TASKS = '/api/my/tasks';
  let tasksSeq = 0;
  let taskMoves = 0; // status changes still on their way to the server

  // The last copy at once — kept on this device too, so the next visit opens
  // with their tasks already there — then the server's answer if it differs.
  // `afterChange` reads afresh once a change has gone through.
  async function loadMyTasks(afterChange) {
    if (!can('tasks')) return;
    const seq = ++tasksSeq;
    const draw = (d) => {
      if (seq === tasksSeq) renderMyTasks(d); // not over a newer read
    };
    if (afterChange) return draw(await reread(MY_TASKS, true));
    await Snappy.swr(api, MY_TASKS, draw, { persist: true });
  }

  // "3 open · 5 total", from the cards as they stand.
  function countMyTasks() {
    const sels = [...$('mtList').querySelectorAll('.mt-status')];
    const open = sels.filter((s) => s.value !== 'done').length;
    $('mtCount').textContent = sels.length ? open + ' open · ' + sels.length + ' total' : '';
  }

  function renderMyTasks(d) {
    const tasks = d.tasks || [];
    const box = $('mtList');
    // A newer copy can arrive while they're writing a comment: what they've
    // typed, and where the cursor was, survive the redraw.
    const typed = {};
    box.querySelectorAll('.mt-comment-in').forEach((el) => {
      if (el.value) typed[el.dataset.task] = el.value;
    });
    const a = document.activeElement;
    const focus =
      a && box.contains(a) && a.classList.contains('mt-comment-in')
        ? { task: a.dataset.task, from: a.selectionStart, to: a.selectionEnd }
        : null;
    $('mtEmpty').style.display = tasks.length ? 'none' : 'block';
    box.innerHTML = tasks
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
            <select class="mt-status" data-task="${t.id}" data-status="${esc(t.status)}">
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
    countMyTasks();
    const input = (task) => box.querySelector('.mt-comment-in[data-task="' + task + '"]');
    Object.keys(typed).forEach((task) => {
      const el = input(task);
      if (el) el.value = typed[task];
    });
    const el = focus && input(focus.task);
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(focus.from, focus.to);
      } catch (e) {
        /* the caret simply lands at the end */
      }
    }
  }

  // Moving a card along shows at once: it fades when done, and the count
  // above changes. If the server refuses, it goes back where it was.
  $('mtList').addEventListener('change', async (e) => {
    const sel = e.target.closest('.mt-status');
    if (!sel) return;
    const card = sel.closest('.mt-card');
    const was = sel.dataset.status;
    const now = sel.value;
    const show = (status) => {
      sel.value = status;
      sel.dataset.status = status;
      if (card) card.classList.toggle('mt-done', status === 'done');
      countMyTasks();
    };
    taskMoves++;
    try {
      await Snappy.optimistic(
        () => {
          show(now);
          // No kept copy may paint the old status meanwhile.
          Snappy.cache.drop(MY_TASKS);
          return () => show(was);
        },
        () =>
          api('/api/my/tasks/' + sel.dataset.task, {
            method: 'PATCH',
            body: JSON.stringify({ status: now }),
          })
      );
    } catch (err) {
      alert(err.message);
    } finally {
      taskMoves--;
    }
    // Then the server's own list, kept for next time — once every move made
    // meanwhile has landed too, so none of them is drawn as it was.
    if (!taskMoves) loadMyTasks(true).catch(() => {});
  });

  $('mtList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.mt-comment-btn');
    if (!btn) return;
    const input = $('mtList').querySelector('.mt-comment-in[data-task="' + btn.dataset.task + '"]');
    if (!input || !input.value.trim()) return;
    try {
      // Disabled at once so it can't post twice; the spinner only if it's slow.
      await Snappy.busy(btn, () =>
        api('/api/my/tasks/' + btn.dataset.task + '/comment', {
          method: 'POST',
          body: JSON.stringify({ text: input.value }),
        })
      );
    } catch (err) {
      alert(err.message);
      return;
    }
    input.value = ''; // posted, so not something to carry through the redraw
    await loadMyTasks(true).catch((err) => alert(err.message));
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

  // Small sub-line under the hours showing how the total was reached, so a
  // figure that doesn't match clock-in→clock-out explains itself.
  const adjustNote = (r) => {
    const bits = [];
    if (r.shop_hours) bits.push('+' + r.shop_hours + ' shop');
    if (r.lunch_hours) bits.push('−' + r.lunch_hours + ' lunch');
    return bits.length
      ? `<div style="font-size:11px;color:var(--muted)">${bits.join(' · ')}</div>`
      : '';
  };

  function hoursPath() {
    return '/api/my/timesheet?' + buildQuery();
  }
  let hoursSeq = 0;

  // Their hours for the range picked: a range read before paints at once, then
  // again if the server's answer differs. Kept in memory only — hours are pay,
  // and never go to disk. `afterChange` reads afresh after a punch.
  async function loadMyHours(afterChange) {
    const seq = ++hoursSeq;
    const path = hoursPath();
    const draw = (data) => {
      if (seq === hoursSeq) renderMyHours(data); // not over a range picked since
    };
    if (afterChange) return draw(await reread(path));
    await Snappy.swr(api, path, draw);
  }

  function renderMyHours(data) {
    const entries = data.entries || [];
    $('myTotal').textContent = (data.totalHours || 0).toFixed(2);
    $('myEntries').textContent = entries.length;
    $('myKm').textContent = (data.totalKm || 0).toFixed(1).replace(/\.0$/, '');
    $('myEmpty').style.display = entries.length ? 'none' : 'block';
    $('myBody').innerHTML = entries
      .map(
        (r) => `<tr>
          <td>${fmtDateTime(r.clock_in)}</td>
          <td>${r.clock_out ? fmtDateTime(r.clock_out) : '<span class="badge on">on the clock</span>'}</td>
          <td>${r.hours != null ? r.hours.toFixed(2) : '—'}${adjustNote(r)}</td>
          <td>${
            r.km != null
              ? r.km.toFixed(1).replace(/\.0$/, '')
              : '<span style="color:var(--muted)">—</span>'
          }</td>
          <td>${jobChips(r)}${r.work_done ? esc(r.work_done) : '<span style="color:var(--muted)">—</span>'}${
            r.missed_reason
              ? `<div style="font-size:12px;color:var(--red)">missed: ${esc(r.missed_reason)}</div>`
              : ''
          }</td>
        </tr>`
      )
      .join('');
  }

  $('myLoad').addEventListener('click', () =>
    Snappy.busy($('myLoad'), () => loadMyHours()).catch((e) => alert(e.message))
  );

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

  // The board is kept on this device as well as in memory, so the next visit
  // opens with the unread badge, and the messages, already there.
  const BULLETINS = '/api/my/bulletins';

  function showMessageCount(data) {
    const nav = $('navMessages');
    if (nav) nav.style.display = '';
    const badge = $('msgNavCount');
    if (!badge) return;
    // Whatever is on the board counts as read once it's open on screen.
    const n = isOpen('messages') ? 0 : data.unread || 0;
    badge.textContent = n;
    badge.style.display = n ? 'inline-block' : 'none';
  }

  // Update the unread badge (and hide the tab entirely if the board feature is
  // switched off for this org). Runs on load without opening the tab.
  // `afterChange` reads afresh once read marks have gone through.
  async function refreshMessageCount(afterChange) {
    try {
      if (afterChange) showMessageCount(await reread(BULLETINS, true));
      else await Snappy.swr(api, BULLETINS, showMessageCount, { persist: true });
    } catch (e) {
      // Feature turned off (403) or another error — hide the tab quietly.
      const nav = $('navMessages');
      if (nav) nav.style.display = 'none';
    }
  }

  // Open the board: show the messages and mark any unread ones as read. The
  // badge clears the moment the board is on screen; the read marks go to the
  // server in the background, and nothing waits for them.
  async function openMessages() {
    const data = await Snappy.swr(
      api,
      BULLETINS,
      (d) => {
        renderMessages(d.bulletins || []);
        showMessageCount(d);
      },
      { persist: true }
    );
    const unread = (data.bulletins || []).filter((b) => !b.read);
    if (!unread.length) return;
    // No kept copy may bring the badge back before the marks land.
    Snappy.cache.update(BULLETINS, (d) => {
      (d.bulletins || []).forEach((b) => {
        b.read = true;
      });
      d.unread = 0;
    });
    Promise.all(
      unread.map((b) => api('/api/my/bulletins/' + b.id + '/read', { method: 'POST' }).catch(() => {}))
    ).then(() => refreshMessageCount(true));
  }

  // ---- in-app clock (Clock in / Clock out) ----
  // The sidebar button is how every employee punches in and out. If a punch from
  // an earlier day was never closed, the same button opens a "missed clock-out"
  // form instead, which has to be resolved before clocking in again.
  // `jobs` are the scheduled jobs for `day` (the day a clock-out would be
  // recorded against). The server decides that day, so the browser's own
  // timezone can't disagree about which one it is.
  const CLOCK_UNKNOWN = { canClock: true, clockedIn: false, since: null, missed: null, day: null, jobs: [] };
  let clock = { ...CLOCK_UNKNOWN };
  // Whether `clock` is the server's answer for whoever is signed in now, and
  // that answer while it's on its way.
  let clockKnown = false;
  let clockCheck = null;
  let clockSeq = 0;
  let nowTimer = null;
  let lastOutBoundary = null; // quarter-hour the clock-out picker was built for

  const fmtTime = (d) =>
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtShortTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Shift length so far, e.g. "7h 32m" — shown next to the live clock so they
  // can see the hours the punch is about to record. `adjustHours` folds in the
  // shop/load time and lunch they've picked, so the figure on screen is the
  // one that will actually be paid.
  function fmtElapsed(fromIso, to, adjustHours = 0) {
    const mins = Math.max(
      0,
      Math.round((to - new Date(fromIso)) / 60000) + Math.round(adjustHours * 60)
    );
    return Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
  }

  // Net effect of the two pickers: shop/load time added, lunch taken off.
  function clockAdjust() {
    if ($('cmShopWrap').style.display === 'none') return 0;
    return (Number($('cmShop').value) || 0) - (Number($('cmLunch').value) || 0);
  }

  // The longest shift a missed clock-out can record (the server enforces it too).
  const MAX_SHIFT_MS = 24 * 60 * 60 * 1000;

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

  // What the clock buttons say comes from the server every time, never from a
  // kept copy. `fresh` (at sign-in) starts from not knowing: the buttons take
  // their plain "Clock In" look, and the line under them says it's checking —
  // shown only if the answer takes long enough to be worth saying (.wait).
  function refreshClock(fresh) {
    const seq = ++clockSeq;
    if (fresh) {
      clockKnown = false;
      clock = { ...CLOCK_UNKNOWN };
      renderClockWidget();
      $('clockStatus').innerHTML = '<span class="wait">Checking the clock…</span>';
    }
    clockCheck = (async () => {
      try {
        const s = await api('/api/my/clock-status');
        if (seq !== clockSeq) return; // a newer check (another sign-in, say) has the say
        clock = {
          canClock: s.canClock !== false,
          clockedIn: !!s.clockedIn,
          since: s.since || null,
          missed: s.missed || null,
          day: s.day || null,
          jobs: Array.isArray(s.jobs) ? s.jobs : [],
        };
        clockKnown = true;
        renderClockWidget();
      } catch (e) {
        if (seq === clockSeq) $('clockStatus').textContent = '';
      }
    })();
    return clockCheck;
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
        ? '· ' + fmtElapsed(clock.since, end, clockAdjust()) + ' total'
        : '';
  }

  // Quarter-hour pickers for shop/load time and lunch. Both count in 0.25hr
  // steps; "None" is the default so nothing is added or taken off unless they
  // say so.
  function hourOptions(maxHours) {
    const opts = ['<option value="0">None</option>'];
    // Counted in quarters rather than adding 0.25 repeatedly, so the values
    // stay exact (0.75, not 0.7500000000000001).
    for (let q = 1; q <= maxHours * 4; q++) {
      const v = q / 4;
      opts.push('<option value="' + v + '">' + v + ' hr</option>');
    }
    return opts.join('');
  }

  // Checkboxes for the jobs this employee was scheduled on that day. Ticking
  // none is allowed — not every day's work is on the schedule, and clocking out
  // should never be blocked by a missing job.
  function renderJobPicks(show) {
    const jobs = clock.jobs || [];
    $('cmJobsWrap').style.display = show ? 'block' : 'none';
    if (!show) return;
    $('cmJobsLabel').textContent = clock.missed
      ? 'Project — which job were you on that day?'
      : 'Project — which job were you on today?';
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

  async function openClockModal() {
    setMenu(false); // the button lives in the drawer on a phone — get it out of the way
    // Which form this is depends on whether they're on the clock. That answer
    // is normally long in, and then the modal opens on the press itself; just
    // after signing in it can still be on its way, and the form waits for it
    // rather than guess.
    if (!clockKnown && clockCheck) await clockCheck;
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
      // A shift can't run past a day, nor finish in the future (the server
      // says the same).
      const latest = new Date(Math.min(start.getTime() + MAX_SHIFT_MS, Date.now()));
      $('cmMissedOut').min = toLocalInput(start);
      $('cmMissedOut').max = toLocalInput(latest);
      $('cmMissedOut').value = toLocalInput(end > start ? (end < latest ? end : latest) : start);
      $('cmMissedReason').value = '';
    }
    $('cmRemarksLabel').textContent = missed
      ? 'Job description — what did you work on that day?'
      : inNow
        ? 'Job description — what did you work on today?'
        : 'Remarks (optional)';
    $('cmRemarks').placeholder = inNow || missed
      ? 'e.g. installed 120ft chain-link fence at Maple St'
      : 'Remarks (optional)';
    $('cmRemarks').value = '';

    // Kms, shop/load time, lunch and extra notes all belong to finishing a day.
    const finishing = !!(inNow || missed);
    ['cmKmWrap', 'cmShopWrap', 'cmLunchWrap', 'cmNotesWrap'].forEach((id) => {
      $(id).style.display = finishing ? 'block' : 'none';
    });
    if (finishing) {
      $('cmKm').value = '';
      $('cmShop').innerHTML = hourOptions(8);
      $('cmLunch').innerHTML = hourOptions(4);
      $('cmShop').value = '0';
      $('cmLunch').value = '0';
      $('cmNotes').value = '';
    }

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

  // What the clock-out and missed-clock-out forms both send on top of the
  // work description: the hand-typed kilometres, the two time adjustments and
  // any extra notes.
  function extraFields() {
    return {
      km: $('cmKm').value === '' ? null : Number($('cmKm').value),
      shopHours: Number($('cmShop').value) || 0,
      lunchHours: Number($('cmLunch').value) || 0,
      notes: $('cmNotes').value,
    };
  }

  // A punch is pay, so it is never shown as done before the server confirms
  // it. The button is disabled the moment it's pressed, so it can't punch
  // twice; its spinner shows only if the wait passes 150 ms — finding their
  // location on the way in can take a few seconds.
  async function confirmClock() {
    $('cmMsg').textContent = '';
    try {
      await Snappy.busy($('cmConfirm'), punch);
    } catch (e) {
      $('cmMsg').textContent = e.message;
      return;
    }
    closeClockModal();
    // The punch changed their hours, and clocking in may have added a pin.
    Snappy.cache.drop('/api/my/timesheet');
    Snappy.cache.drop('/api/my/locations');
    await refreshClock();
    // Keep the hours view current if they're looking at it.
    loadMyHours(true).catch(() => {});
  }

  // The request itself, whichever of the three forms is open.
  async function punch() {
    if (clock.missed) {
      // The box holds a time on this phone's clock with no zone attached;
      // send the instant it means, as the regular clock-out does.
      const finish = new Date($('cmMissedOut').value);
      if (!$('cmMissedOut').value || isNaN(finish)) throw new Error('Enter the time you finished.');
      await api('/api/my/resolve-missed', {
        method: 'POST',
        body: JSON.stringify({
          punchId: clock.missed.punchId,
          clockOut: finish.toISOString(),
          workDone: $('cmRemarks').value,
          reason: $('cmMissedReason').value,
          jobIds: selectedJobIds(),
          ...extraFields(),
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
          ...extraFields(),
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
  }

  $('clockBtn').addEventListener('click', openClockModal);
  $('clockBtnBar').addEventListener('click', openClockModal);
  $('cmConfirm').addEventListener('click', confirmClock);
  $('cmCancel').addEventListener('click', closeClockModal);
  $('cmTime').addEventListener('click', tickNow);
  // Keep the total in step with a hand-picked finish time and the two
  // adjustments.
  $('cmOut').addEventListener('change', tickNow);
  $('cmShop').addEventListener('change', tickNow);
  $('cmLunch').addEventListener('change', tickNow);
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

  // Their requests: the last copy at once, then the server's answer if it
  // differs. Kept in memory only. `afterChange` reads afresh once a request
  // has been sent or cancelled.
  const MY_VACATIONS = '/api/my/vacations';
  let voSeq = 0;
  async function loadMyVacations(afterChange) {
    const seq = ++voSeq;
    const draw = (data) => {
      if (seq === voSeq) renderMyVacations(data); // not over a newer read
    };
    if (afterChange) return draw(await reread(MY_VACATIONS));
    await Snappy.swr(api, MY_VACATIONS, draw);
  }

  function renderMyVacations(data) {
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
      // Disabled at once so it can't be sent twice; "Sending…" and a spinner
      // only if the server is slow. It comes back with the new request listed.
      await Snappy.busy(
        $('voSubmit'),
        async () => {
          await api('/api/my/vacations', {
            method: 'POST',
            body: JSON.stringify({
              start_date: $('voFrom').value,
              end_date: $('voTo').value,
              reason: $('voReason').value,
            }),
          });
          $('voReason').value = '';
          await loadMyVacations(true);
        },
        { label: 'Sending…' }
      );
    } catch (e) {
      $('voMsg').textContent = e.message;
    }
  });

  // Cancelling takes the request off the list at once. If the server refuses
  // (it was decided meanwhile, say), it comes back and they're told why.
  $('voBody').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.vo-cancel');
    if (!btn) return;
    if (!confirm('Cancel this vacation request?')) return;
    const id = btn.dataset.id;
    try {
      await Snappy.optimistic(
        () => dropVacationRow(btn.closest('tr'), id),
        () => api('/api/my/vacations/' + id, { method: 'DELETE' })
      );
    } catch (e) {
      alert(e.message);
    }
    // Then the server's own list, either way.
    loadMyVacations(true).catch(() => {});
  });

  // The row leaves the list, and the kept copy with it, so a quick return to
  // this tab can't bring it back. Returns what puts it back.
  function dropVacationRow(row, id) {
    const body = $('voBody');
    const next = row.nextElementSibling;
    const empty = $('voEmpty').style.display;
    row.remove();
    if (!body.children.length) $('voEmpty').style.display = 'block';
    Snappy.cache.update(MY_VACATIONS, (d) => {
      d.requests = (d.requests || []).filter((r) => String(r.id) !== String(id));
    });
    return () => {
      body.insertBefore(row, next && next.parentNode === body ? next : null);
      $('voEmpty').style.display = empty;
      // That edited copy is wrong now: read it afresh next time.
      Snappy.cache.drop(MY_VACATIONS);
    };
  }

  // ---- boot: default date range = this week, then restore session ----
  (function initDates() {
    const now = new Date();
    const monday = new Date(now);
    const day = (now.getDay() + 6) % 7; // 0 = Monday
    monday.setDate(now.getDate() - day);
    // This device's calendar day. toISOString would give the UTC day, which is
    // already tomorrow every evening in Ontario.
    const p2 = (n) => String(n).padStart(2, '0');
    const toStr = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    $('myFrom').value = toStr(monday);
    $('myTo').value = toStr(now);
    // Time-off pickers default to today.
    $('voFrom').value = toStr(now);
    $('voTo').value = toStr(now);
  })();

  // Ask who is signed in straight away — on a cold server this is also the
  // request that wakes it.
  const meCall = api(ME);

  // When this device kept the answer for an employee login that hasn't run
  // out, open on it now, before the rest of the page has even loaded: no
  // sign-in form in between, the right tab straight away, each tab painting
  // from its own kept copy. The server's answer then confirms it, adjusts it,
  // or ends it (confirmMe). Their clock status is never among the kept copies.
  const resumed = Snappy.cache.resume();
  const kept = resumed && resumed.startsWith('employee:') ? Snappy.cache.peek(ME) : undefined;
  const fromCopy = !!(kept && kept.role === 'employee' && meKey(kept) === resumed);
  if (fromCopy) {
    me = kept;
    showApp();
  }

  meCall
    .then((d) => {
      if (!authChanges) confirmMe(d); // a sign-in or sign-out since has the say
    })
    .catch(() => {
      // No answer at all — offline, or the server is down. With the kept copy
      // on screen, stay on it; without one, the sign-in form is all there is.
      if (!fromCopy && !authChanges) showLogin();
    });
})();
