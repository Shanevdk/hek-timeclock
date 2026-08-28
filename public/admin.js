// Admin dashboard logic.
(function () {
  const $ = (id) => document.getElementById(id);
  let employees = [];
  let liveTimer = null;
  let isDev = false; // the limited-admin "dev" account (no clock-in features)
  let currentFeatures = null; // which paid features the dev has enabled for the client

  // ---- API helper ----
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
      });
    } catch (err) {
      // fetch() only rejects when the request never got a reply at all — the
      // server is stopped, the connection dropped, or the device is offline.
      // The browser's own wording for this is "Failed to fetch", which reads
      // like the app did something wrong and sends people looking in the wrong
      // place. Say what actually happened.
      throw new Error("Couldn't reach the server — it may have stopped, or you're offline. Nothing was saved.");
    }
    // A 401 on a normal request means the session expired — bounce to login.
    // The login request itself is allowed to surface its own error message.
    if (res.status === 401 && path !== '/api/admin/login') {
      showLogin();
      throw new Error('Please sign in.');
    }
    // Parse the body ourselves so a non-JSON success response (e.g. an HTML
    // fallback page from a proxy/redirect) surfaces a clear error instead of
    // silently becoming {} and crashing later (e.g. reading .toFixed).
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status}).`);
      // Some endpoints attach the upstream reason (e.g. a QuickBooks validation
      // fault) as "detail" — keep it so the caller can show what went wrong.
      if (data && data.detail) err.detail = data.detail;
      throw err;
    }
    if (data === null)
      throw new Error('The server returned an unexpected response. Please refresh the page and sign in again.');
    return data;
  }

  // Fill a table body with shimmer skeleton rows while its data loads.
  function skeletonRows(tbodyId, cols, n = 6) {
    const body = $(tbodyId);
    if (!body) return;
    const widths = ['70%', '55%', '80%', '45%', '60%'];
    let html = '';
    for (let i = 0; i < n; i++) {
      html += '<tr class="skel-row">';
      for (let c = 0; c < cols; c++)
        html += `<td><span class="skel" style="width:${widths[c % widths.length]}"></span></td>`;
      html += '</tr>';
    }
    body.innerHTML = html;
  }

  // ---- Date helpers ----
  const fmt = (iso, opts) =>
    iso ? new Date(iso).toLocaleString([], opts) : '';
  const fmtDateTime = (iso) =>
    iso
      ? new Date(iso).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  // Convert an ISO string to the value a datetime-local input expects (local tz).
  function isoToLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const off = d.getTimezoneOffset() * 60000;
    return new Date(d - off).toISOString().slice(0, 16);
  }
  // datetime-local value -> ISO (treated as local time).
  const localInputToIso = (v) => (v ? new Date(v).toISOString() : null);

  // ---- Auth ----
  function showLogin() {
    if (liveTimer) clearInterval(liveTimer);
    // Admins sign in on the main page ("/") now — send visitors without a valid
    // admin session there rather than showing a second login form here.
    window.location.replace('/');
  }
  function showApp() {
    $('loginView').style.display = 'none';
    $('app').style.display = 'block';
    loadPermissions();
    loadEmployees();
    refreshVacationCount();
    if (isDev) applyDevRestrictions();
    else {
      applyEntitlements(currentFeatures);
      // Back to whichever tab was open before the refresh; "On the clock" only
      // when there is nothing to go back to.
      if (!restoreTab()) showLive();
      // Returning from QuickBooks' consent screen lands here with the outcome
      // in the URL — let that module open its own tab on the result.
      if (window.QuickBooks) window.QuickBooks.afterLogin();
      // Show how many emails are waiting without making them open the tab.
      if (window.Inbox && currentFeatures && currentFeatures.inbox !== false)
        window.Inbox.refreshCount();
      // Same for quote requests sent in from the public estimate page.
      if (window.Estimates && currentFeatures && currentFeatures.estimate !== false)
        window.Estimates.refreshCount();
    }
  }

  // Show/hide a sidebar tab (and drop its "active" if we're hiding it).
  function setTabVisible(name, visible) {
    const tab = document.querySelector('.side-nav .tab[data-tab="' + name + '"]');
    if (tab) tab.style.display = visible ? '' : 'none';
    if (!visible) {
      const sec = $('tab-' + name);
      if (sec) sec.classList.remove('active');
    }
    syncNavGroups();
  }

  const navVisible = (el) => el.style.display !== 'none';

  // Keep the grouped nav tidy after tabs are hidden: a section with nothing
  // left under it disappears rather than sitting there as an empty heading,
  // and whichever section ends up first loses its divider so the list doesn't
  // start with a stray line.
  function syncNavGroups() {
    document.querySelectorAll('.side-nav .side-group').forEach((group) => {
      const items = [...group.querySelectorAll('.tab')];
      group.style.display = items.some(navVisible) ? '' : 'none';
    });
    const blocks = [...document.querySelectorAll('.side-nav > .side-group, .side-nav > .side-solo')];
    blocks.forEach((el) => el.classList.remove('side-first'));
    const first = blocks.find(navVisible);
    if (first) first.classList.add('side-first');
  }

  // For the real admin: hide any feature the dev has switched off. Data-driven
  // from the server's feature list (each feature key matches a sidebar tab's
  // data-tab), so a newly added feature is handled automatically — no need to
  // touch this list when features are added.
  function applyEntitlements(features) {
    if (!features) return;
    Object.keys(features).forEach((key) => {
      if (features[key] === false) setTabVisible(key, false);
    });
    syncNavGroups();
  }

  // The "dev" account is a limited admin: hide the clock-in features it can't use,
  // and reveal the "Client access" panel where it controls the client's features.
  function applyDevRestrictions() {
    if (liveTimer) clearInterval(liveTimer);
    ['live', 'sheets'].forEach((t) => setTabVisible(t, false));
    const devTab = $('devAccessTab');
    if (devTab) devTab.style.display = '';
    const healthTab = $('devHealthTab');
    if (healthTab) healthTab.style.display = '';
    syncNavGroups();
    // The dev account's login comes from the environment — hide that editor.
    ['acLabel', 'acEmail', 'acPass', 'acSave', 'acMsg'].forEach((id) => {
      const el = $(id);
      if (el) el.style.display = 'none';
    });
    // Label the signed-in account, then go back to the tab that was open before
    // the refresh, or the first one available.
    const ue = $('userEmail');
    if (ue) ue.textContent = 'dev';
    const av = $('userAvatar');
    if (av) av.textContent = 'D';
    if (restoreTab()) return;
    const firstTab = [...document.querySelectorAll('.side-nav .tab')].find(
      (t) => t.style.display !== 'none'
    );
    if (firstTab) firstTab.click();
  }

  // ---- Client access (dev only): toggle which features the client can use ----
  async function loadDevFeatures() {
    const d = await api('/api/dev/features');
    $('featMsg').textContent = '';
    $('featureToggles').innerHTML = d.features
      .map(
        (f) => `<label class="feature-row">
          <span>${esc(f.label)}</span>
          <input type="checkbox" data-feat="${f.key}" ${f.enabled ? 'checked' : ''} />
        </label>`
      )
      .join('');
  }
  const featEl = $('featureToggles');
  if (featEl) {
    featEl.addEventListener('change', async (e) => {
      const cb = e.target.closest('input[data-feat]');
      if (!cb) return;
      try {
        await api('/api/dev/features', {
          method: 'PATCH',
          body: JSON.stringify({ [cb.dataset.feat]: cb.checked }),
        });
        $('featMsg').className = 'msg ok';
        $('featMsg').textContent = 'Saved.';
      } catch (err) {
        cb.checked = !cb.checked; // revert on failure
        $('featMsg').className = 'msg err';
        $('featMsg').textContent = err.message;
      }
    });
  }

  $('loginBtn').addEventListener('click', doLogin);
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  async function doLogin() {
    $('loginMsg').textContent = '';
    try {
      const r = await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: $('email').value, password: $('pw').value }),
      });
      $('pw').value = '';
      isDev = !!(r && r.role === 'dev');
      const me = await api('/api/admin/me').catch(() => ({}));
      currentFeatures = me.features || null;
      showApp();
    } catch (e) {
      $('loginMsg').textContent = e.message;
    }
  }
  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // ---- Mobile popout menu ----
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

  // ---- Which tab is open, remembered in the URL ----
  // A refresh (or a reconnect after the session drops) comes back to the same
  // tab instead of the default one, and a tab can be linked to directly.
  //
  // The name is written as "#tab=quotes" rather than "#quotes" on purpose: a
  // bare fragment that happens to match an element id — "#map" does — makes the
  // browser scroll to it on load. Prefixing keeps that from ever happening.
  const TAB_HASH = /^#tab=([a-z-]+)$/;

  function rememberTab(name) {
    try {
      history.replaceState(null, '', location.pathname + location.search + '#tab=' + name);
    } catch (e) {
      /* history is unavailable in some embedded views — the tab still works */
    }
  }

  // The tab named in the URL, but only if it is one this account can actually
  // open. A stale link to a switched-off feature falls back to the default.
  function tabFromUrl() {
    const m = TAB_HASH.exec(location.hash || '');
    if (!m) return null;
    const tab = document.querySelector('.side-nav .tab[data-tab="' + m[1] + '"]');
    if (!tab || tab.style.display === 'none') return null;
    return tab;
  }

  // Open the tab from the URL. Returns false when there was nothing to restore,
  // so the caller can fall back to its own default.
  function restoreTab() {
    const tab = tabFromUrl();
    if (!tab) return false;
    tab.click();
    return true;
  }

  // Someone editing the address bar, or a browser restoring an older entry.
  window.addEventListener('hashchange', () => {
    const tab = tabFromUrl();
    if (tab && !tab.classList.contains('active')) tab.click();
  });

  // ---- Tabs ----
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      rememberTab(t.dataset.tab);
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.section').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('tab-' + t.dataset.tab).classList.add('active');
      if (t.dataset.tab === 'live') showLive();
      if (t.dataset.tab === 'employees') loadEmployees();
      if (t.dataset.tab === 'sheets') loadTimesheet().catch((e) => alert(e.message));
      if (t.dataset.tab === 'map') showMap();
      if (t.dataset.tab === 'timeoff') loadVacations().catch((e) => alert(e.message));
      if (t.dataset.tab === 'quotes' && window.Quotes) window.Quotes.load();
      if (t.dataset.tab === 'schedule' && window.Schedule)
        window.Schedule.loadAdmin().catch((e) => alert(e.message));
      if (t.dataset.tab === 'tasks' && window.Tasks)
        window.Tasks.loadAdmin().catch((e) => alert(e.message));
      if (t.dataset.tab === 'messages' && window.Messages)
        window.Messages.load().catch((e) => alert(e.message));
      if (t.dataset.tab === 'access') loadDevFeatures().catch((e) => alert(e.message));
      if (t.dataset.tab === 'health' && window.DevStats)
        window.DevStats.load().catch((e) => alert(e.message));
      if (t.dataset.tab === 'quickbooks' && window.QuickBooks)
        window.QuickBooks.load().catch((e) => alert(e.message));
      if (t.dataset.tab === 'pricing' && window.Pricing)
        window.Pricing.load().catch((e) => alert(e.message));
      if (t.dataset.tab === 'invoices' && window.Invoices)
        window.Invoices.load().catch((e) => alert(e.message));
      if (t.dataset.tab === 'inbox' && window.Inbox)
        window.Inbox.load().catch((e) => alert(e.message));
      if (t.dataset.tab === 'estimate' && window.Estimates)
        window.Estimates.load().catch((e) => alert(e.message));
      setMenu(false); // close the popout after choosing a tab
    });
  });

  // ---- Live view ----
  function showLive() {
    // Skeleton only on the first paint (not on the 30s refresh, to avoid flicker).
    if (!$('liveBody').children.length) skeletonRows('liveBody', 3, 3);
    refreshLive();
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(refreshLive, 30000);
  }
  function elapsed(iso) {
    const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  async function refreshLive() {
    try {
      const rows = await api('/api/admin/active');
      $('liveCount').textContent = rows.length;
      $('liveEmpty').style.display = rows.length ? 'none' : 'block';
      $('liveBody').innerHTML = rows
        .map(
          (r) =>
            `<tr><td>${esc(r.name)}</td><td>${fmtDateTime(r.clock_in)}</td>
             <td><span class="badge on">${elapsed(r.clock_in)}</span></td></tr>`
        )
        .join('');
    } catch (e) {
      /* handled by api() */
    }
  }

  // ---- Employees ----
  // Permissions come from the server as { key, label, note } — derived there
  // from the admin feature list, so a newly built feature appears here on its
  // own without this file needing a matching entry.
  let perms = [];
  const permLabel = (k) => {
    const p = perms.find((x) => x.key === k);
    return p ? p.label : k;
  };

  async function loadPermissions() {
    try {
      const d = await api('/api/admin/permissions');
      perms = (d.permissions || []).map((p) =>
        typeof p === 'string' ? { key: p, label: p, note: '' } : p
      );
    } catch (e) {
      perms = [];
    }
    // The quick-add form was replaced by the profile editor; render only if present.
    const np = $('newPerms');
    if (np) renderPermChecks(np, []);
  }

  // Render permission checkboxes into a container, checking those in `selected`.
  // Ticked boxes are held in the container's dataset rather than read off the
  // DOM, so a permission filtered out by a search is still submitted.
  function renderPermChecks(container, selected) {
    container.dataset.selected = JSON.stringify([...new Set(selected || [])]);
    // Reopening the editor should start from the full list, not the last search.
    const search = $('eaPermSearch');
    if (search && container.id === 'eaPerms') search.value = '';
    filterPermChecks(container, '');
  }

  const permSelection = (container) => {
    try {
      return new Set(JSON.parse(container.dataset.selected || '[]'));
    } catch (e) {
      return new Set();
    }
  };

  // Bold the matched run inside a label so it's obvious why a row survived.
  function markHit(text, term) {
    const safe = esc(text);
    if (!term) return safe;
    const i = text.toLowerCase().indexOf(term);
    if (i < 0) return safe;
    return (
      esc(text.slice(0, i)) +
      '<span class="perm-hit">' + esc(text.slice(i, i + term.length)) + '</span>' +
      esc(text.slice(i + term.length))
    );
  }

  // Show only the permissions matching `term`, matched against both the label
  // and its note so searching "map" or "locations" both land.
  function filterPermChecks(container, term) {
    const q = String(term || '').trim().toLowerCase();
    const sel = permSelection(container);
    const shown = perms.filter(
      (p) =>
        !q ||
        p.label.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        (p.note || '').toLowerCase().includes(q)
    );
    container.innerHTML = perms.length
      ? shown
          .map(
            (p) => `<label class="perm${p.key === 'admin' ? ' perm-admin' : ''}">
              <input type="checkbox" value="${esc(p.key)}"${sel.has(p.key) ? ' checked' : ''} />
              <span>
                <span class="perm-label">${markHit(p.label, q)}</span>
                ${p.note ? `<span class="perm-note">${markHit(p.note, q)}</span>` : ''}
              </span>
            </label>`
          )
          .join('')
      : '<span style="color:var(--muted);font-size:13px">No optional features yet.</span>';

    const empty = $('eaPermEmpty');
    if (empty && container.id === 'eaPerms')
      empty.style.display = perms.length && !shown.length ? 'block' : 'none';
    const count = $('eaPermCount');
    if (count && container.id === 'eaPerms')
      count.textContent = sel.size ? sel.size + ' granted' : 'None granted';
  }

  // Keep the dataset in step as boxes are ticked, so the selection survives
  // being filtered out of view.
  function wirePermContainer(container) {
    if (!container || container.dataset.wired) return;
    container.dataset.wired = '1';
    container.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      const sel = permSelection(container);
      if (cb.checked) sel.add(cb.value);
      else sel.delete(cb.value);
      container.dataset.selected = JSON.stringify([...sel]);
      const count = $('eaPermCount');
      if (count && container.id === 'eaPerms')
        count.textContent = sel.size ? sel.size + ' granted' : 'None granted';
    });
  }
  wirePermContainer($('eaPerms'));
  wirePermContainer($('newPerms'));

  const permSearch = $('eaPermSearch');
  if (permSearch)
    permSearch.addEventListener('input', () => filterPermChecks($('eaPerms'), permSearch.value));

  const collectPerms = (container) => [...permSelection(container)];
  const permSummary = (list) =>
    list && list.length
      ? list.map((k) => esc(permLabel(k))).join(', ')
      : '<span style="color:var(--muted)">Hours only</span>';

  // ---- Employees list: filters, sort, pagination ----
  const EMP_PER_PAGE = 20;
  let empSort = { key: 'first_name', dir: 1 };
  let empPage = 1;

  // Fall back to splitting the display name for records made before first/last.
  const empFirst = (e) => e.first_name || (e.name || '').trim().split(/\s+/)[0] || '';
  const empLast = (e) =>
    e.last_name || (e.name || '').trim().split(/\s+/).slice(1).join(' ') || '';

  // Selects used elsewhere (timesheet filter + punch modal) + Reports-To filter.
  function syncEmpSelects() {
    const opts =
      '<option value="">All employees</option>' +
      employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
    if ($('tsEmp')) $('tsEmp').innerHTML = opts;
    if ($('mEmp'))
      $('mEmp').innerHTML = employees
        .map((e) => `<option value="${e.id}">${esc(e.name)}</option>`)
        .join('');
    if ($('empReports')) {
      const keep = $('empReports').value;
      $('empReports').innerHTML =
        '<option value="">All</option>' +
        employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
      $('empReports').value = keep;
    }
  }

  async function loadEmployees() {
    // Stale-while-revalidate: if we already have the list, paint it instantly and
    // refresh in the background; otherwise show skeleton rows while it loads.
    const hadData = employees.length > 0;
    if (hadData) {
      syncEmpSelects();
      renderEmployees();
    } else {
      skeletonRows('empBody', 4);
    }
    employees = await api('/api/admin/employees');
    syncEmpSelects();
    if (!hadData) empPage = 1;
    renderEmployees();
  }

  function filteredEmployees() {
    const active = $('empActive') ? $('empActive').value : 'active';
    const type = $('empType') ? $('empType').value : '';
    const reportsTo = $('empReports') ? $('empReports').value : '';
    const q = ($('empSearch') ? $('empSearch').value : '').trim().toLowerCase();
    const rows = employees.filter((e) => {
      if (active === 'active' && !e.active) return false;
      if (active === 'inactive' && e.active) return false;
      if (type && (e.employment_type || '') !== type) return false;
      if (reportsTo && String(e.reports_to || '') !== reportsTo) return false;
      if (q) {
        const hay = [empFirst(e), empLast(e), e.name, e.email, e.job_title]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const val = (e) => (empSort.key === 'last_name' ? empLast(e) : empFirst(e)).toLowerCase();
    rows.sort((a, b) => (val(a) < val(b) ? -empSort.dir : val(a) > val(b) ? empSort.dir : 0));
    return rows;
  }

  function renderEmployees() {
    const rows = filteredEmployees();
    const pages = Math.max(1, Math.ceil(rows.length / EMP_PER_PAGE));
    if (empPage > pages) empPage = pages;
    const start = (empPage - 1) * EMP_PER_PAGE;
    const pageRows = rows.slice(start, start + EMP_PER_PAGE);
    const dash = '<span style="color:var(--muted)">—</span>';

    if ($('empEmpty')) $('empEmpty').style.display = rows.length ? 'none' : 'block';
    $('empBody').innerHTML = pageRows
      .map(
        (e) => `<tr class="clickable-row" data-id="${e.id}" title="Open ${esc(e.name)}">
          <td>${esc(empFirst(e)) || dash}${
            e.active ? '' : ' <span class="badge">inactive</span>'
          }</td>
          <td>${esc(empLast(e)) || dash}</td>
          <td>${e.job_title ? esc(e.job_title) : dash}</td>
          <td>${dash}</td>
        </tr>`
      )
      .join('');

    document.querySelectorAll('.emp-table th.sortable').forEach((th) => {
      th.classList.toggle('sort-asc', th.dataset.sort === empSort.key && empSort.dir === 1);
      th.classList.toggle('sort-desc', th.dataset.sort === empSort.key && empSort.dir === -1);
    });
    renderEmpPager(pages);
  }

  function renderEmpPager(pages) {
    const el = $('empPager');
    if (!el) return;
    if (pages <= 1) {
      el.innerHTML = '';
      return;
    }
    let html = `<button class="pg" data-pg="prev"${empPage === 1 ? ' disabled' : ''}>Previous</button>`;
    for (let p = 1; p <= pages; p++)
      html += `<button class="pg${p === empPage ? ' active' : ''}" data-pg="${p}">${p}</button>`;
    html += `<button class="pg" data-pg="next"${empPage === pages ? ' disabled' : ''}>Next</button>`;
    el.innerHTML = html;
  }

  // Filter / sort / pager / export / add wiring (guarded — elements may be absent).
  ['empActive', 'empType', 'empReports'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => { empPage = 1; renderEmployees(); });
  });
  if ($('empSearch'))
    $('empSearch').addEventListener('input', () => { empPage = 1; renderEmployees(); });
  if ($('empReset'))
    $('empReset').addEventListener('click', () => {
      if ($('empActive')) $('empActive').value = 'active';
      if ($('empType')) $('empType').value = '';
      if ($('empSearch')) $('empSearch').value = '';
      ['empLoc', 'empTeam', 'empGroup', 'empReports'].forEach((id) => { if ($(id)) $(id).selectedIndex = 0; });
      empSort = { key: 'first_name', dir: 1 };
      empPage = 1;
      renderEmployees();
    });
  document.querySelectorAll('.emp-table th.sortable').forEach((th) =>
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (empSort.key === key) empSort.dir *= -1;
      else empSort = { key, dir: 1 };
      renderEmployees();
    })
  );
  if ($('empPager'))
    $('empPager').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pg]');
      if (!b || b.disabled) return;
      const pages = Math.max(1, Math.ceil(filteredEmployees().length / EMP_PER_PAGE));
      if (b.dataset.pg === 'prev') empPage = Math.max(1, empPage - 1);
      else if (b.dataset.pg === 'next') empPage = Math.min(pages, empPage + 1);
      else empPage = Number(b.dataset.pg);
      renderEmployees();
    });
  if ($('empExport'))
    $('empExport').addEventListener('click', () => {
      const cell = (v) => {
        const s = String(v == null ? '' : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [['First Name', 'Last Name', 'Position', 'Email', 'Active'].join(',')];
      filteredEmployees().forEach((e) =>
        lines.push(
          [empFirst(e), empLast(e), e.job_title || '', e.email || '', e.active ? 'yes' : 'no']
            .map(cell)
            .join(',')
        )
      );
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
      a.download = 'employees.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    });

  // Clicking a row opens that employee's full profile editor.
  $('empBody').addEventListener('click', (ev) => {
    const row = ev.target.closest('tr[data-id]');
    if (!row) return;
    const emp = employees.find((e) => e.id === Number(row.dataset.id));
    if (emp) openEmpModal(emp);
  });

  // "Add" opens the full profile editor in new-employee mode.
  $('addEmp').addEventListener('click', () => openEmpModal(null));

  // ---- Employee profile editor ----
  let empModalId = null;
  const PROFILE_FIELDS = [
    'first_name', 'last_name', 'initials', 'phone',
    'address1', 'address2', 'city', 'province', 'postal', 'country',
    'birth_date', 'employment_type', 'vacation_weeks', 'job_title',
    'start_date', 'termination_date', 'pay_type', 'pay_rate',
  ];
  // Profile field key -> the input/select element id in the editor.
  const PF = {
    first_name: 'peFirst', last_name: 'peLast', initials: 'peInitials', phone: 'pePhone',
    address1: 'peAddr1', address2: 'peAddr2', city: 'peCity', province: 'peProvince',
    postal: 'pePostal', country: 'peCountry', birth_date: 'peBirth',
    employment_type: 'peEmpType', vacation_weeks: 'peVacation', job_title: 'peJobTitle',
    start_date: 'peStart', termination_date: 'peTerm',
    pay_type: 'pePayType', pay_rate: 'pePayRate',
  };

  // The pay rate means different things depending on the pay type, so the label
  // and placeholder follow the dropdown ($/hour vs $/year).
  function syncPayLabel() {
    const type = $('pePayType').value;
    $('pePayRateLabel').textContent =
      type === 'Salary' ? 'Salary ($/year)' : type === 'Hourly' ? 'Rate ($/hour)' : 'Pay Rate';
    $('pePayRate').placeholder =
      type === 'Salary' ? 'e.g. 65000' : type === 'Hourly' ? 'e.g. 28.50' : '—';
  }
  $('pePayType').addEventListener('change', syncPayLabel);

  function setProfileTab(name) {
    document.querySelectorAll('.ptab').forEach((t) => t.classList.toggle('active', t.dataset.ptab === name));
    document.querySelectorAll('.ppanel').forEach((p) => p.classList.remove('active'));
    const panel = $('ptab-' + name);
    if (panel) panel.classList.add('active');
  }
  document.querySelectorAll('.ptab').forEach((t) =>
    t.addEventListener('click', () => setProfileTab(t.dataset.ptab))
  );

  function openEmpModal(emp) {
    emp = emp || null;
    empModalId = emp ? emp.id : null;
    $('empModalTitle').textContent = emp ? 'General — ' + emp.name : 'New employee';
    setProfileTab('general');
    $('peId').value = emp ? emp.id : '';
    $('eaEmail').value = emp ? emp.email || '' : '';
    $('eaPass').value = '';
    $('peActive').checked = emp ? !!emp.active : true;
    PROFILE_FIELDS.forEach((k) => {
      const el = $(PF[k]);
      if (el) el.value = emp ? emp[k] || '' : '';
    });
    syncPayLabel();
    // Reports To: pick from every other employee (their manager).
    const rt = $('peReportsTo');
    if (rt) {
      const curId = emp ? emp.id : null;
      rt.innerHTML =
        '<option value="">— None —</option>' +
        employees
          .filter((o) => o.id !== curId)
          .map((o) => `<option value="${o.id}">${esc(o.name)}</option>`)
          .join('');
      rt.value = emp && emp.reports_to ? String(emp.reports_to) : '';
    }
    renderPermChecks($('eaPerms'), emp ? emp.permissions || [] : []);
    // Delete / merge only make sense for an employee that already exists.
    $('eaDelete').style.display = emp ? '' : 'none';
    $('eaMerge').style.display = emp ? '' : 'none';
    $('empModalMsg').textContent = '';
    $('empModalBack').classList.add('open');
  }

  function closeEmpModal() {
    $('empModalBack').classList.remove('open');
  }
  $('eaClose').addEventListener('click', closeEmpModal);
  $('empModalBack').addEventListener('click', (e) => {
    if (e.target === $('empModalBack')) closeEmpModal();
  });

  // Merge a save payload into a local employee object for optimistic display.
  function applyPayloadToEmp(emp, payload) {
    const next = { ...emp };
    PROFILE_FIELDS.forEach((k) => { if (payload[k] != null) next[k] = payload[k]; });
    if (payload.email != null) next.email = payload.email;
    if (payload.active != null) next.active = !!payload.active && payload.active !== 0;
    if (payload.reports_to != null) next.reports_to = payload.reports_to;
    if (payload.permissions) next.permissions = payload.permissions;
    next.name = [next.first_name, next.last_name].filter(Boolean).join(' ').trim() || next.name;
    return next;
  }

  $('eaSave').addEventListener('click', async () => {
    $('empModalMsg').textContent = '';
    const payload = {
      email: $('eaEmail').value.trim(),
      active: $('peActive').checked ? 1 : 0,
      permissions: collectPerms($('eaPerms')),
    };
    PROFILE_FIELDS.forEach((k) => {
      const el = $(PF[k]);
      if (el) payload[k] = el.value;
    });
    if ($('peReportsTo')) payload.reports_to = $('peReportsTo').value;
    if ($('eaPass').value) payload.password = $('eaPass').value;

    const editingId = empModalId;
    if (editingId) {
      // Optimistic: update the row + close immediately, reconcile with the server.
      const idx = employees.findIndex((e) => e.id === editingId);
      const prev = idx >= 0 ? employees[idx] : null;
      if (idx >= 0) {
        employees[idx] = applyPayloadToEmp(prev, payload);
        syncEmpSelects();
        renderEmployees();
      }
      closeEmpModal();
      try {
        const updated = await api('/api/admin/employees/' + editingId, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        if (idx >= 0 && updated && updated.id) {
          employees[idx] = updated;
          syncEmpSelects();
          renderEmployees();
        }
      } catch (e) {
        if (idx >= 0 && prev) {
          employees[idx] = prev;
          syncEmpSelects();
          renderEmployees();
        }
        alert(e.message);
      }
      return;
    }
    // New employee needs a server-assigned id, so create it the normal way.
    try {
      await api('/api/admin/employees', { method: 'POST', body: JSON.stringify(payload) });
      closeEmpModal();
      loadEmployees();
    } catch (e) {
      $('empModalMsg').textContent = e.message;
    }
  });

  $('eaDelete').addEventListener('click', async () => {
    if (!empModalId) return;
    const id = empModalId;
    const emp = employees.find((e) => e.id === id);
    if (!confirm(`Delete ${emp ? emp.name : 'this employee'} and all their time entries?`)) return;
    // Optimistic: remove from the list right away; restore it if the server rejects.
    const prev = employees;
    employees = employees.filter((e) => e.id !== id);
    syncEmpSelects();
    renderEmployees();
    closeEmpModal();
    try {
      await api('/api/admin/employees/' + id, { method: 'DELETE' });
      tsCache.clear(); // their punches are gone too
    } catch (e) {
      employees = prev;
      syncEmpSelects();
      renderEmployees();
      alert(e.message);
    }
  });

  $('eaMerge').addEventListener('click', () => alert('Merging employees is coming soon.'));

  // ---- Timesheets ----
  function buildQuery() {
    const p = new URLSearchParams();
    if ($('tsEmp').value) p.set('employee_id', $('tsEmp').value);
    if ($('tsFrom').value) p.set('from', $('tsFrom').value);
    if ($('tsTo').value) p.set('to', $('tsTo').value);
    return p.toString();
  }

  const tsCache = new Map(); // query string -> last timesheet response (SWR)

  // Jobs the employee ticked off at clock-out, shown as chips above their note.
  const jobChips = (r) =>
    (r.jobs || []).length
      ? `<div class="job-chips">${r.jobs
          .map(
            (j) =>
              `<span class="job-chip"${j.description ? ` title="${esc(j.description)}"` : ''}>${esc(j.address)}</span>`
          )
          .join('')}</div>`
      : '';

  // Distance travelled for a row: worked out from the jobs tagged onto it and
  // how far each is from the shop. A dash means no job on that entry had a
  // position — different from having travelled nothing.
  const kmCell = (r) =>
    r.km != null
      ? `<strong>${r.km.toFixed(1).replace(/\.0$/, '')}</strong>`
      : '<span style="color:var(--muted)">—</span>';

  function renderTimesheet(data) {
    const entries = data.entries || [];
    $('tsTotal').textContent = (data.totalHours || 0).toFixed(2);
    $('tsEntries').textContent = entries.length;
    $('tsKm').textContent = (data.totalKm || 0).toFixed(1).replace(/\.0$/, '');
    if (data.mileage) {
      $('tsRoundTrip').checked = data.mileage.round_trip !== false;
      $('tsKmLabel').textContent =
        data.mileage.round_trip !== false ? 'Km travelled (return)' : 'Km travelled (one way)';
    }
    $('tsEmpty').style.display = entries.length ? 'none' : 'block';
    $('tsBody').innerHTML = entries
      .map(
        (r) => `<tr class="clickable-row" data-punch="${r.id}" title="Click to edit this entry">
          <td>${esc(r.name)}${r.edited ? ' <span class="badge edited">edited</span>' : ''}</td>
          <td>${fmtDateTime(r.clock_in)}</td>
          <td>${r.clock_out ? fmtDateTime(r.clock_out) : '<span class="badge on">on the clock</span>'}</td>
          <td>${r.hours != null ? r.hours.toFixed(2) : '—'}</td>
          <td>${kmCell(r)}</td>
          <td>${jobChips(r)}${r.work_done ? esc(r.work_done) : '<span style="color:var(--muted)">—</span>'}${
            r.missed_reason
              ? `<div style="font-size:12px;color:var(--red)">missed: ${esc(r.missed_reason)}</div>`
              : ''
          }</td>
        </tr>`
      )
      .join('');
  }
  async function loadTimesheet() {
    const query = buildQuery();
    // Show the cached range instantly if we've loaded it before; else skeleton.
    if (tsCache.has(query)) renderTimesheet(tsCache.get(query));
    else skeletonRows('tsBody', 5);
    const data = await api('/api/admin/timesheet?' + query);
    tsCache.set(query, data);
    renderTimesheet(data);
  }

  $('tsLoad').addEventListener('click', () => loadTimesheet().catch((e) => alert(e.message)));
  $('tsExport').addEventListener('click', () => {
    window.location = '/api/admin/export.csv?' + buildQuery();
  });

  // Whether mileage counts the drive home. Changing it re-reads every range,
  // so the cached figures can't disagree with the setting.
  $('tsRoundTrip').addEventListener('change', async () => {
    try {
      await api('/api/admin/mileage', {
        method: 'PATCH',
        body: JSON.stringify({ round_trip: $('tsRoundTrip').checked }),
      });
      tsCache.clear();
      await loadTimesheet();
    } catch (e) {
      $('tsRoundTrip').checked = !$('tsRoundTrip').checked; // put it back
      alert(e.message);
    }
  });

  $('tsBody').addEventListener('click', (ev) => {
    const row = ev.target.closest('tr[data-punch]');
    if (!row) return;
    openPunchModal(Number(row.dataset.punch));
  });

  // ---- Punch modal (edit + add) ----
  let modalPunchId = null;
  let modalRows = [];

  async function openPunchModal(id) {
    // Reuse the cached timesheet if we have it, so the editor opens instantly.
    const query = buildQuery();
    let data = tsCache.get(query);
    if (!data) {
      data = await api('/api/admin/timesheet?' + query);
      tsCache.set(query, data);
    }
    modalRows = data.entries;
    const r = modalRows.find((x) => x.id === id);
    if (!r) return;
    modalPunchId = id;
    $('modalTitle').textContent = 'Edit entry';
    $('modalEmpRow').style.display = 'none';
    $('mIn').value = isoToLocalInput(r.clock_in);
    $('mOut').value = isoToLocalInput(r.clock_out);
    $('mWork').value = r.work_done || '';
    $('mReason').value = r.missed_reason || '';
    $('mNote').value = r.note || '';
    $('mDelete').style.display = 'inline';
    $('modalMsg').textContent = '';
    $('modalBack').classList.add('open');
  }

  $('tsAdd').addEventListener('click', () => {
    modalPunchId = null;
    $('modalTitle').textContent = 'Add entry';
    $('modalEmpRow').style.display = 'flex';
    $('mIn').value = '';
    $('mOut').value = '';
    $('mWork').value = '';
    $('mReason').value = '';
    $('mNote').value = '';
    $('mDelete').style.display = 'none';
    $('modalMsg').textContent = '';
    $('modalBack').classList.add('open');
  });

  $('mCancel').addEventListener('click', () => $('modalBack').classList.remove('open'));
  $('modalBack').addEventListener('click', (e) => {
    if (e.target === $('modalBack')) $('modalBack').classList.remove('open');
  });

  $('mSave').addEventListener('click', async () => {
    $('modalMsg').textContent = '';
    const payload = {
      clock_in: localInputToIso($('mIn').value),
      clock_out: $('mOut').value ? localInputToIso($('mOut').value) : '',
      work_done: $('mWork').value,
      missed_reason: $('mReason').value,
      note: $('mNote').value,
    };
    try {
      if (modalPunchId) {
        await api('/api/admin/punches/' + modalPunchId, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        payload.employee_id = Number($('mEmp').value);
        await api('/api/admin/punches', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      $('modalBack').classList.remove('open');
      tsCache.clear(); // entry changed — drop the cached ranges
      loadTimesheet();
    } catch (e) {
      $('modalMsg').textContent = e.message;
    }
  });

  $('mDelete').addEventListener('click', async () => {
    if (!modalPunchId || !confirm('Delete this time entry?')) return;
    try {
      await api('/api/admin/punches/' + modalPunchId, { method: 'DELETE' });
      $('modalBack').classList.remove('open');
      tsCache.clear();
      loadTimesheet();
    } catch (e) {
      $('modalMsg').textContent = e.message;
    }
  });

  // ---- Map (clock-in locations) ----
  let map = null;
  let mapMarkers = [];
  function mapQuery() {
    const p = new URLSearchParams();
    if ($('mapFrom').value) p.set('from', $('mapFrom').value);
    if ($('mapTo').value) p.set('to', $('mapTo').value);
    return p.toString();
  }
  // Create the Leaflet map the first time it's needed (returns null if Leaflet
  // couldn't load). Must run while the container is visible.
  function ensureMap() {
    if (map) return map;
    if (!window.L) return null;
    map = L.map('map').setView([43.65, -79.38], 8); // default view: southern Ontario
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    return map;
  }
  function activateTab(name) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.section').forEach((x) => x.classList.remove('active'));
    const tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) tab.classList.add('active');
    const sec = $('tab-' + name);
    if (sec) sec.classList.add('active');
  }
  async function showMap() {
    if (!ensureMap()) return;
    setTimeout(() => map.invalidateSize(), 0); // it was hidden until now
    await loadMap().catch((e) => alert(e.message));
  }
  // Jump the map straight to one clock-in (used by the Timesheets "Location" button).
  function focusPunch(lat, lng, name, when) {
    activateTab('map');
    if (!ensureMap()) return alert('Map could not load (no internet?).');
    setTimeout(() => {
      map.invalidateSize();
      mapMarkers.forEach((m) => map.removeLayer(m));
      mapMarkers = [];
      const mk = L.circleMarker([lat, lng], {
        radius: 9, color: '#a97f43', fillColor: '#c89b5c', fillOpacity: 0.95, weight: 2,
      }).addTo(map);
      mk.bindPopup(`<b>${esc(name)}</b><br>${fmtDateTime(when)}`).openPopup();
      mapMarkers.push(mk);
      $('mapEmpty').style.display = 'none';
      map.setView([lat, lng], 16);
    }, 0);
  }
  // ---- map badges ----
  // Drawn as divIcons rather than image pins so they follow the theme colours
  // and stay sharp at any zoom.
  const SHOP_GLYPH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 10.5 12 4l9 6.5" /><path d="M5 10v9h14v-9" />' +
    '<path d="M9.5 19v-5h5v5" /></svg>';
  const JOB_GLYPH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    // A fence: three pickets on two rails.
    '<path d="M5 21V7l2-3 2 3v14" /><path d="M11 21V7l2-3 2 3v14" />' +
    '<path d="M17 21V7l2-3 2 3v14" opacity=".55" />' +
    '<path d="M3 11h18M3 16h18" /></svg>';

  const shopIcon = () =>
    L.divIcon({
      className: 'map-badge map-badge-shop',
      html: `<span class="mb-ring"></span><span class="mb-glyph">${SHOP_GLYPH}</span>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -18],
    });

  const jobIcon = () =>
    L.divIcon({
      className: 'map-badge map-badge-job',
      html: `<span class="mb-glyph">${JOB_GLYPH}</span>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      popupAnchor: [0, -14],
    });

  const km = (n) => (n == null ? '—' : n.toFixed(1).replace(/\.0$/, '') + ' km');

  async function loadMap() {
    if (!map) return;
    // Punches and jobs are independent; fetch together so one slow query does
    // not hold up the other.
    const [rows, plan] = await Promise.all([
      api('/api/admin/locations?' + mapQuery()),
      api('/api/admin/map?' + mapQuery()),
    ]);
    mapMarkers.forEach((m) => map.removeLayer(m));
    mapMarkers = [];
    const jobs = (plan && plan.jobs) || [];
    const shop = plan && plan.shop;
    const bounds = [];

    // The shop, and the yardstick everything else is measured from.
    if (shop) {
      const mk = L.marker([shop.lat, shop.lng], {
        icon: shopIcon(),
        title: 'The shop',
        zIndexOffset: 1000, // always on top of the job pins
        draggable: true,
      }).addTo(map);
      mk.bindPopup(
        `<b>The shop</b><br>${esc(shop.address)}` +
          (shop.exact
            ? ''
            : '<br><span class="mp-warn">Approximate — drag this pin onto the yard to fix it.</span>')
      );
      // Dragging it is how the exact spot gets recorded; distances then redraw.
      mk.on('dragend', async () => {
        const p = mk.getLatLng();
        try {
          await api('/api/admin/shop', {
            method: 'PATCH',
            body: JSON.stringify({ lat: p.lat, lng: p.lng }),
          });
          await loadMap();
        } catch (e) {
          alert(e.message);
          await loadMap();
        }
      });
      mapMarkers.push(mk);
      bounds.push([shop.lat, shop.lng]);
    }

    // Scheduled jobs, each with how far it is from the shop.
    jobs.forEach((j) => {
      const mk = L.marker([j.lat, j.lng], { icon: jobIcon(), title: j.address }).addTo(map);
      const when = [j.date ? fmtDay(j.date) : 'No date set', j.time || ''].filter(Boolean).join(' · ');
      mk.bindPopup(
        `<b>${esc(j.address)}</b>` +
          (j.description ? `<br>${esc(j.description)}` : '') +
          `<br><span class="mp-dim">${esc(when)}</span>` +
          (j.crew.length ? `<br><span class="mp-dim">${esc(j.crew.join(', '))}</span>` : '') +
          `<br><b class="mp-km">${km(j.km)}</b> <span class="mp-dim">from the shop (straight line)</span>`
      );
      mapMarkers.push(mk);
      bounds.push([j.lat, j.lng]);
    });

    // Clock-ins stay as plain dots — they are readings, not places.
    rows.forEach((r) => {
      const mk = L.circleMarker([r.lat, r.lng], {
        radius: 8, color: '#a97f43', fillColor: '#c89b5c', fillOpacity: 0.9, weight: 2,
      }).addTo(map);
      mk.bindPopup(`<b>${esc(r.name)}</b><br>${fmtDateTime(r.clock_in)}`);
      mapMarkers.push(mk);
      bounds.push([r.lat, r.lng]);
    });

    renderMapLegend(jobs, plan && plan.unmapped);
    $('mapEmpty').style.display = rows.length || jobs.length ? 'none' : 'block';
    // Never zoom to just the shop — a lone pin at max zoom looks broken.
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    else if (bounds.length === 1) map.setView(bounds[0], 12);
  }

  // A list under the map: every job, nearest first, so distances can be read
  // without clicking each pin.
  function renderMapLegend(jobs, unmapped) {
    const box = $('mapJobs');
    if (!box) return;
    if (!jobs.length) {
      box.innerHTML = unmapped
        ? `<p class="status-sub" style="margin:0">${unmapped} scheduled job${unmapped > 1 ? 's have' : ' has'} no position yet — pick an address from the suggestions when adding one.</p>`
        : '<p class="status-sub" style="margin:0">No scheduled jobs in this range.</p>';
      return;
    }
    const sorted = [...jobs].sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9));
    box.innerHTML =
      `<table><thead><tr><th>Job</th><th>When</th><th>Crew</th><th>From shop</th></tr></thead><tbody>` +
      sorted
        .map(
          (j) => `<tr class="clickable-row" data-job="${j.id}">
            <td><strong>${esc(j.address)}</strong>${j.description ? `<div class="mp-dim">${esc(j.description)}</div>` : ''}</td>
            <td class="qb-dim">${j.date ? esc(fmtDay(j.date)) : '—'}${j.time ? ' ' + esc(j.time) : ''}</td>
            <td class="qb-dim">${j.crew.length ? esc(j.crew.join(', ')) : '—'}</td>
            <td><strong>${km(j.km)}</strong></td>
          </tr>`
        )
        .join('') +
      '</tbody></table>' +
      (unmapped
        ? `<p class="status-sub" style="margin:10px 0 0">${unmapped} more job${unmapped > 1 ? 's have' : ' has'} no position — pick an address from the suggestions to put ${unmapped > 1 ? 'them' : 'it'} on the map.</p>`
        : '') +
      '<p class="status-sub" style="margin:10px 0 0">Distances are straight-line from the shop, so the drive is always a little longer.</p>';
  }
  // The map tab is optional markup — only wire it if it's present on the page,
  // so a build without the map section doesn't break the whole dashboard.
  if ($('mapLoad'))
    $('mapLoad').addEventListener('click', () => loadMap().catch((e) => alert(e.message)));

  // ---- Time off (employee vacation requests) ----
  // Format a plain 'YYYY-MM-DD' as a local date (parsed as local, not UTC).
  const fmtDay = (s) => {
    if (!s) return '—';
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  };

  // Update the little pending-count badge on the "Time off" nav tab.
  function setVacationCount(n) {
    const el = $('voNavCount');
    if (!el) return;
    el.textContent = n;
    el.style.display = n > 0 ? '' : 'none';
  }

  async function refreshVacationCount() {
    try {
      const d = await api('/api/admin/vacations?status=pending');
      setVacationCount(d.pending || 0);
    } catch (e) {
      /* non-fatal: the badge just stays hidden */
    }
  }

  async function loadVacations() {
    const status = $('voFilter') ? $('voFilter').value : 'pending';
    const d = await api('/api/admin/vacations?status=' + encodeURIComponent(status));
    setVacationCount(d.pending || 0);
    const rows = d.requests || [];
    $('voAdminEmpty').style.display = rows.length ? 'none' : 'block';
    $('voAdminBody').innerHTML = rows
      .map(
        (r) => `<tr>
          <td>${esc(r.employee_name)}</td>
          <td>${fmtDay(r.start_date)}${r.end_date !== r.start_date ? ' – ' + fmtDay(r.end_date) : ''}</td>
          <td>${r.days}</td>
          <td>${r.reason ? esc(r.reason) : '<span style="color:var(--muted)">—</span>'}${
            r.admin_note
              ? `<div style="font-size:12px;color:var(--muted)">Note: ${esc(r.admin_note)}</div>`
              : ''
          }</td>
          <td>${fmtDateTime(r.created_at)}</td>
          <td><span class="badge status-${r.status}">${r.status}</span></td>
          <td>${
            r.status === 'pending'
              ? `<div class="row" style="gap:6px;flex-wrap:nowrap">
                  <button class="btn gold sm vo-approve" data-id="${r.id}">Approve</button>
                  <button class="btn ghost sm vo-decline" data-id="${r.id}">Decline</button>
                </div>`
              : ''
          }</td>
        </tr>`
      )
      .join('');
  }

  if ($('voFilter'))
    $('voFilter').addEventListener('change', () => loadVacations().catch((e) => alert(e.message)));

  if ($('voAdminBody'))
    $('voAdminBody').addEventListener('click', async (ev) => {
      const btn = ev.target.closest('.vo-approve, .vo-decline');
      if (!btn) return;
      const approve = btn.classList.contains('vo-approve');
      // A note is optional on approve, offered on decline so the employee sees why.
      const note = prompt(
        approve ? 'Add a note (optional):' : 'Reason for declining (optional):',
        ''
      );
      if (note === null) return; // cancelled
      try {
        await api('/api/admin/vacations/' + btn.dataset.id, {
          method: 'PATCH',
          body: JSON.stringify({
            status: approve ? 'approved' : 'declined',
            admin_note: note,
          }),
        });
        await loadVacations();
      } catch (e) {
        alert(e.message);
      }
    });

  // ---- utils ----
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Share the auth-aware API helper (and utilities) with the Quotes module,
  // which lives in a separate file so this one stays focused on the timeclock.
  window.HEKAdmin = { api, esc, showLogin };

  // ---- boot: default date range = this week, check session ----
  (function initDates() {
    const now = new Date();
    const monday = new Date(now);
    const day = (now.getDay() + 6) % 7; // 0 = Monday
    monday.setDate(now.getDate() - day);
    const toStr = (d) => d.toISOString().slice(0, 10);
    if ($('tsFrom')) $('tsFrom').value = toStr(monday);
    if ($('tsTo')) $('tsTo').value = toStr(now);
    if ($('mapFrom')) $('mapFrom').value = toStr(monday);
    if ($('mapTo')) $('mapTo').value = toStr(now);
  })();

  api('/api/admin/me')
    .then((d) => {
      if (!d.admin) return showLogin();
      isDev = d.role === 'dev';
      currentFeatures = d.features || null;
      showApp();
    })
    .catch(showLogin);
})();
