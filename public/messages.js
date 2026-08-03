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

  const PER_PAGE = 15;
  let bulletins = [];
  let employees = [];
  let editingId = null; // null while creating a new bulletin
  let page = 1;
  let wired = false;

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

  async function load() {
    wire();
    const data = await api('/api/admin/bulletins');
    bulletins = data.bulletins || [];
    employees = data.employees || [];
    renderRead();
    if ($('msgManageView').style.display === 'block') renderManage();
    if ($('msgReadView').style.display === 'none' && $('msgEditView').style.display === 'none')
      show('msgReadView');
  }

  // ---- read board ----
  function renderRead() {
    const pub = bulletins.filter((b) => b.status === 'published');
    $('msgReadEmpty').style.display = pub.length ? 'none' : 'block';
    $('msgReadList').innerHTML = pub
      .map(
        (b) => `<div class="card msg-card">
          <div class="msg-card-head">
            <h3 class="msg-card-title">${esc(b.title)}</h3>
            <div class="msg-card-meta">
              <div>Published ${fmtDate(b.date)}</div>
              <div>${esc(cap(b.author))}</div>
            </div>
          </div>
          <div class="md-body">${md(b.content)}</div>
        </div>`
      )
      .join('');
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
    $('msgManageBody').innerHTML = slice
      .map(
        (b) => `<tr class="clickable-row" data-id="${b.id}">
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
    let html = `<button class="pg" data-pg="prev"${page === 1 ? ' disabled' : ''}>Previous</button>`;
    for (let p = 1; p <= pages; p++)
      html += `<button class="pg${p === page ? ' active' : ''}" data-pg="${p}">${p}</button>`;
    html += `<button class="pg" data-pg="next"${page === pages ? ' disabled' : ''}>Next</button>`;
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

  async function save(action) {
    const body = { ...collectFields(), action };
    if (!body.title.trim()) {
      $('msgEditMsg').textContent = 'A title is required.';
      return;
    }
    if (body.audience === 'employees' && !body.employee_ids.length) {
      $('msgEditMsg').textContent = 'Pick at least one employee, or choose All Employees.';
      return;
    }
    try {
      if (editingId == null) {
        await api('/api/admin/bulletins', { method: 'POST', body: JSON.stringify(body) });
      } else {
        await api('/api/admin/bulletins/' + editingId, { method: 'PATCH', body: JSON.stringify(body) });
      }
      await load();
      show('msgManageView');
      page = 1;
      renderManage();
    } catch (e) {
      $('msgEditMsg').textContent = e.message;
    }
  }

  // ---- wiring (once) ----
  function wire() {
    if (wired) return;
    wired = true;

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

    $('msgPublishBtn').addEventListener('click', () => save('publish'));
    $('msgDraftBtn').addEventListener('click', () => save('draft'));
    $('msgDeleteBtn').addEventListener('click', async () => {
      if (editingId == null) return;
      if (!confirm('Delete this message? Employees will no longer see it.')) return;
      try {
        await api('/api/admin/bulletins/' + editingId, { method: 'DELETE' });
        await load();
        show('msgManageView');
        renderManage();
      } catch (e) {
        $('msgEditMsg').textContent = e.message;
      }
    });
  }

  window.Messages = { load };
})();
