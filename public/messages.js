// "Messages" — the admin side of the employee bulletin board.
//
// Three views inside the Messages tab: a read board of published bulletins, a
// management table (search + status + read counts), and an editor for writing /
// scheduling a new bulletin with a live Markdown preview.
//
// Relies on window.HEKAdmin ({ api, esc }) from admin.js and window.mdToHtml
// from md.js (both loaded first).
(function () {
  const H = () => window.HEKAdmin || {};
  const api = (...a) => H().api(...a);
  const esc = (s) => (H().esc ? H().esc(s) : String(s));
  const md = (s) => (window.mdToHtml ? window.mdToHtml(s) : esc(s));
  const $ = (id) => document.getElementById(id);

  // The tab's one read, through window.Snappy (snappy.js). Its copies are
  // filed under the exact path, so every read of it uses this constant.
  const BULLETINS = '/api/admin/bulletins';

  const PER_PAGE = 15;
  let bulletins = [];
  let employees = [];
  let editingId = null; // null while creating a new bulletin
  let page = 1;
  let wired = false;
  let known = false; // `bulletins` holds real ones, kept or fresh
  let loadGen = 0; // the newest read; an older one that lands late is dropped
  let saving = false; // a publish or draft save is on its way

  // ---- reads and changes ----
  // A change shows the moment it's made where it can (a delete), and a read
  // that crosses paths with one may describe the list from before it: drawn,
  // it would undo the change on screen; kept, it would paint it again next
  // visit. So such a read is refused, and once nothing is on its way any more
  // the list is read again.
  let writes = 0; // changes still on their way to the server
  let writeSeq = 0; // goes up as each change starts and as it ends
  let lostRead = false; // a read was refused, so the list owes itself one

  async function readBulletins(path) {
    const seq = writeSeq;
    const calm = !writes;
    const d = await api(path);
    if (calm && seq === writeSeq) return d;
    lostRead = true;
    settle();
    const err = new Error('The messages changed while they were being read.');
    err.stale = true;
    throw err;
  }

  async function change(request) {
    writes++;
    writeSeq++;
    try {
      return await request();
    } finally {
      writes--;
      writeSeq++;
      settle();
    }
  }

  // Owed a read, and nothing is on its way any more: read now.
  function settle() {
    if (writes || !lostRead || !known) return;
    lostRead = false;
    refresh().catch(() => {
      /* what's on screen stands; the next visit reads again */
    });
  }

  // Reads the list straight from the server — never joining a read that set
  // off before a change — keeps the copy, and draws it.
  async function refresh() {
    const gen = ++loadGen;
    const data = await readBulletins(BULLETINS);
    if (gen !== loadGen) return;
    Snappy.cache.put(BULLETINS, data, true);
    take(data);
  }

  // After a change the server took, the list on screen is the newest copy
  // there is: keep it, so the next visit opens on it rather than the old one.
  function keepCopy() {
    if (known && !writes) Snappy.cache.put(BULLETINS, { bulletins, employees }, true);
  }

  const fmtDate = (iso) =>
    iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const statusBadge = (st) =>
    `<span class="badge status-${st === 'published' ? 'approved' : st === 'scheduled' ? 'pending' : 'declined'}">${cap(st)}</span>`;

  // ---- view switching ----
  function show(view) {
    ['msgReadView', 'msgManageView', 'msgEditView'].forEach((id) => {
      if ($(id)) $(id).style.display = 'none';
    });
    if ($(view)) $(view).style.display = 'block';
  }

  // The list paints at once from the copy kept last time (on this device, for
  // this account only), then from the server's answer if anything changed.
  async function load() {
    wire();
    // Opening the tab lands on the read board — unless a bulletin is being
    // written, which is left exactly as it is. Decided now, not when the
    // answer arrives, so it never yanks someone out of a view they've opened.
    if ($('msgEditView').style.display !== 'block') show('msgReadView');
    const gen = ++loadGen;
    // Nothing on screen yet: a line that only appears if the wait is long
    // enough to notice (.wait). A kept copy replaces it at once.
    if (!known) $('msgReadList').innerHTML = '<p class="status-sub wait">Loading messages…</p>';
    try {
      await Snappy.swr(
        readBulletins,
        BULLETINS,
        (data) => {
          // A newer read has started, or a change is on its way: the list on
          // screen is newer than this copy.
          if (gen !== loadGen || writes) return;
          take(data);
        },
        { persist: true }
      );
    } catch (e) {
      if (e.stale) return; // crossed a change; the read after it brings the list
      if (!known) $('msgReadList').innerHTML = '';
      throw e;
    }
  }

  // A list for the screen: the kept copy or the server's. Whichever view is
  // showing is redrawn in place; the editor is the person's own and is left
  // alone.
  function take(data) {
    bulletins = data.bulletins || [];
    employees = data.employees || [];
    known = true;
    renderRead();
    if ($('msgManageView').style.display === 'block') renderManage();
  }

  // ---- read board ----
  function cardHtml(b) {
    return `<div class="card msg-card">
          <div class="msg-card-head">
            <h3 class="msg-card-title">${esc(b.title)}</h3>
            <div class="msg-card-meta">
              <div>Published ${fmtDate(b.date)}</div>
              <div>${esc(cap(b.author))}</div>
            </div>
          </div>
          <div class="md-body">${md(b.content)}</div>
        </div>`;
  }

  function renderRead() {
    const pub = bulletins.filter((b) => b.status === 'published');
    $('msgReadEmpty').style.display = pub.length ? 'none' : 'block';
    const list = $('msgReadList');
    // Years of bulletins, each a page of Markdown: a few are drawn now and the
    // rest as they're scrolled toward (Snappy.chunks). Each card is only built
    // when its turn comes — chunks() joins the rows into text, and turning one
    // of these into text is what calls its toString(). A redraw keeps at least
    // as many cards as were showing, so the page doesn't jump.
    const rows = pub.map((b) => ({ toString: () => cardHtml(b) }));
    const had = list.querySelectorAll('.msg-card').length;
    Snappy.chunks(list, rows, { first: Math.max(10, had), step: 10 });
  }

  // ---- manage table ----
  function filteredManage() {
    const q = ($('msgSearch').value || '').trim().toLowerCase();
    if (!q) return bulletins;
    return bulletins.filter(
      (b) =>
        (b.title || '').toLowerCase().includes(q) ||
        (b.target || '').toLowerCase().includes(q) ||
        (b.author || '').toLowerCase().includes(q)
    );
  }

  function renderManage() {
    const rows = filteredManage();
    const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    if (page > pages) page = pages;
    const slice = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    $('msgManageEmpty').style.display = rows.length ? 'none' : 'block';
    // A row only opens the editor, so a mouse press opens it on the way down
    // (data-press="fast", snappy.js); the pager below likewise.
    $('msgManageBody').innerHTML = slice
      .map(
        (b) => `<tr class="clickable-row" data-id="${b.id}" data-press="fast">
          <td>${esc(b.title)}</td>
          <td>${esc(cap(b.author))}</td>
          <td>${esc(b.target)}</td>
          <td>${fmtDate(b.date)}</td>
          <td>${statusBadge(b.status)}</td>
          <td>${b.read_count} / ${b.audience_size}</td>
        </tr>`
      )
      .join('');
    renderPager(pages);
  }

  function renderPager(pages) {
    const el = $('msgPager');
    if (!el) return;
    if (pages <= 1) {
      el.innerHTML = '';
      return;
    }
    let html = `<button class="pg" data-pg="prev" data-press="fast"${page === 1 ? ' disabled' : ''}>Previous</button>`;
    for (let p = 1; p <= pages; p++)
      html += `<button class="pg${p === page ? ' active' : ''}" data-pg="${p}" data-press="fast">${p}</button>`;
    html += `<button class="pg" data-pg="next" data-press="fast"${page === pages ? ' disabled' : ''}>Next</button>`;
    el.innerHTML = html;
  }

  // ---- editor ----
  function currentAudience() {
    const el = document.querySelector('input[name="msgAudience"]:checked');
    return el ? el.value : 'all';
  }

  function renderEmpPick(selectedIds) {
    const sel = new Set(selectedIds || []);
    $('msgEmpPick').innerHTML = employees
      .map(
        (e) => `<label class="msg-emp-opt"><input type="checkbox" value="${e.id}" ${
          sel.has(e.id) ? 'checked' : ''
        } /> ${esc(e.name)}</label>`
      )
      .join('');
  }

  function syncAudienceUi() {
    $('msgEmpPick').style.display = currentAudience() === 'employees' ? 'grid' : 'none';
  }

  function openEditor(bulletin) {
    editingId = bulletin ? bulletin.id : null;
    $('msgEditTitle').textContent = bulletin ? 'Edit Bulletin' : 'New Bulletin';
    $('msgTitle').value = bulletin ? bulletin.title : '';
    $('msgContent').value = bulletin ? bulletin.content : '';
    $('msgDate').value = bulletin ? bulletin.publish_date || '' : '';
    const audience = bulletin ? bulletin.audience : 'all';
    document.querySelectorAll('input[name="msgAudience"]').forEach((r) => {
      r.checked = r.value === audience;
    });
    renderEmpPick(bulletin ? bulletin.employee_ids : []);
    syncAudienceUi();
    $('msgEditMsg').textContent = '';
    $('msgDeleteBtn').style.display = bulletin ? '' : 'none';
    // A published bulletin's "Publish now" becomes "Save"; keep it simple and
    // always allow re-publishing.
    $('msgPublishBtn').textContent = bulletin && bulletin.status === 'published' ? 'Save' : 'Publish now';
    updatePreview();
    show('msgEditView');
  }

  function updatePreview() {
    const src = $('msgContent').value;
    $('msgPreview').innerHTML = src.trim()
      ? md(src)
      : '<span class="status-sub" style="text-align:left">Preview will appear here...</span>';
  }

  function collectFields() {
    const audience = currentAudience();
    const employee_ids =
      audience === 'employees'
        ? [...$('msgEmpPick').querySelectorAll('input:checked')].map((c) => Number(c.value))
        : [];
    return {
      title: $('msgTitle').value,
      content: $('msgContent').value,
      audience,
      employee_ids,
      publish_at: $('msgDate').value || '',
    };
  }

  // Publishing or saving a draft sends the whole bulletin — words, audience,
  // schedule — so it isn't shown as done before the server has it. The button
  // pressed is disabled at once, with a spinner only if the wait is long
  // enough to notice (Snappy.busy), and neither button can send it twice.
  async function save(action, btn) {
    if (saving) return;
    const body = { ...collectFields(), action };
    if (!body.title.trim()) {
      $('msgEditMsg').textContent = 'A title is required.';
      return;
    }
    if (body.audience === 'employees' && !body.employee_ids.length) {
      $('msgEditMsg').textContent = 'Pick at least one employee, or choose All Employees.';
      return;
    }
    $('msgEditMsg').textContent = '';
    saving = true;
    const id = editingId;
    let saved = false;
    try {
      await Snappy.busy(btn, async () => {
        await change(() =>
          id == null
            ? api(BULLETINS, { method: 'POST', body: JSON.stringify(body) })
            : api(BULLETINS + '/' + id, { method: 'PATCH', body: JSON.stringify(body) })
        );
        saved = true;
        // The list as the server now has it — a new one with its author, date
        // and read count — before the table it belongs in is shown. If that
        // read fails, the save still stands: never offer to send it again.
        await refresh().catch((e) => console.warn('Messages: could not re-read the list.', e));
      });
    } catch (e) {
      $('msgEditMsg').textContent = e.message;
    } finally {
      saving = false;
    }
    if (!saved) return;
    show('msgManageView');
    page = 1;
    renderManage();
  }

  // ---- wiring (once) ----
  function wire() {
    if (wired) return;
    wired = true;

    // Switching views only shows something, so a mouse press acts on the way
    // down (data-press="fast", snappy.js). Not Cancel: it throws away what's
    // been written, so letting go somewhere else still has to call it off.
    ['msgManageBtn', 'msgBackBtn', 'msgNewBtn'].forEach((id) =>
      $(id).setAttribute('data-press', 'fast')
    );

    $('msgManageBtn').addEventListener('click', () => {
      page = 1;
      show('msgManageView');
      renderManage();
    });
    $('msgBackBtn').addEventListener('click', () => {
      show('msgReadView');
      renderRead();
    });
    $('msgNewBtn').addEventListener('click', () => openEditor(null));
    $('msgCancelBtn').addEventListener('click', () => {
      show('msgManageView');
      renderManage();
    });

    $('msgSearch').addEventListener('input', () => {
      page = 1;
      renderManage();
    });

    $('msgManageBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const b = bulletins.find((x) => x.id === Number(tr.dataset.id));
      if (b) openEditor(b);
    });

    $('msgPager').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pg]');
      if (!b || b.disabled) return;
      const pages = Math.max(1, Math.ceil(filteredManage().length / PER_PAGE));
      if (b.dataset.pg === 'prev') page = Math.max(1, page - 1);
      else if (b.dataset.pg === 'next') page = Math.min(pages, page + 1);
      else page = Number(b.dataset.pg);
      renderManage();
    });

    document.querySelectorAll('input[name="msgAudience"]').forEach((r) =>
      r.addEventListener('change', syncAudienceUi)
    );
    $('msgContent').addEventListener('input', updatePreview);

    $('msgPublishBtn').addEventListener('click', () => save('publish', $('msgPublishBtn')));
    $('msgDraftBtn').addEventListener('click', () => save('draft', $('msgDraftBtn')));
    // Gone from both lists and back to the table as soon as it's confirmed,
    // deleted behind that. If the server refuses, it comes back and says why.
    $('msgDeleteBtn').addEventListener('click', async () => {
      if (editingId == null) return;
      if (!confirm('Delete this message? Employees will no longer see it.')) return;
      const id = editingId;
      const at = bulletins.findIndex((b) => b.id === id);
      const gone = bulletins[at];
      show('msgManageView');
      try {
        await change(() =>
          Snappy.optimistic(
            () => {
              bulletins = bulletins.filter((b) => b.id !== id);
              renderRead();
              renderManage();
              return () => {
                // Back in its own place in the list (and so on its own page).
                if (gone && !bulletins.some((b) => b.id === id))
                  bulletins.splice(Math.min(at, bulletins.length), 0, gone);
                renderRead();
                if ($('msgManageView').style.display === 'block') renderManage();
              };
            },
            () => api(BULLETINS + '/' + id, { method: 'DELETE' })
          )
        );
        keepCopy();
      } catch (e) {
        alert(e.message);
      }
    });
  }

  // Asks ahead for the list's read. The shell calls this when a pointer rests
  // on the Messages tab, and when idle. Only the dashboard has this tab:
  // anywhere else this does nothing (an admin read from the portal would
  // answer 401, and the portal takes that as "signed out"). Listing bulletins
  // also publishes any whose scheduled day has come — due either way, and the
  // same thing any employee's portal does when it lists theirs.
  function prefetch() {
    if (!$('msgReadList') || writes) return;
    Snappy.prefetch(readBulletins, BULLETINS, { persist: true });
  }

  window.Messages = { load, prefetch };
})();
