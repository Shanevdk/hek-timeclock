// "My Tasks" board for the admin/dev dashboard.
//
// A kanban board (To Do / In Progress / Done) of task cards. Anyone with
// dashboard access can create tasks; a task is assigned to a single employee who
// holds the "My Tasks" permission. Cards are dragged between columns, and each
// card opens a detail "inside menu" with description, comments, time and history.
//
// Relies on window.HEKAdmin ({ api, esc }) exposed by admin.js (loaded first).
(function () {
  const H = () => window.HEKAdmin || {};
  const api = (...a) => H().api(...a);
  const esc = (s) => (H().esc ? H().esc(s) : String(s));
  const $ = (id) => document.getElementById(id);

  const COLUMNS = [
    { key: 'todo', name: 'To Do' },
    { key: 'in_progress', name: 'In Progress' },
    { key: 'done', name: 'Done' },
  ];
  const PRIORITIES = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

  let tasks = [];
  let assignees = [];
  let currentId = null; // task open in the detail modal
  let wired = false;

  const byId = (id) => tasks.find((t) => t.id === id);
  const initials = (name) =>
    (name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?';

  function fmtDue(d) {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  function fmtDur(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  // Server-enforced; this only refuses an oversized file early.
  const MAX_ATTACH = 1024 * 1024 * 1024;

  // -------------------------------------------------------------- load + render
  async function loadAdmin() {
    if (!$('taskBoard')) return;
    if (!wired) {
      wireOnce();
      wired = true;
    }
    const d = await api('/api/admin/tasks');
    tasks = d.tasks || [];
    assignees = d.assignees || [];
    syncFilters();
    syncAssigneeSelect();
    renderBoard();
  }

  function syncFilters() {
    const groups = [...new Set(tasks.map((t) => t.group).filter(Boolean))].sort();
    const labels = [...new Set(tasks.flatMap((t) => t.labels || []))].sort();
    fillSelect($('tkGroup'), groups, 'All groups');
    fillSelect($('tkLabel'), labels, 'All labels');
    const asg = $('tkAssignee');
    const keep = asg.value;
    asg.innerHTML =
      '<option value="">Everyone</option><option value="none">Unassigned</option>' +
      assignees.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    asg.value = keep;
  }
  function fillSelect(sel, values, allLabel) {
    const keep = sel.value;
    sel.innerHTML =
      `<option value="">${allLabel}</option>` +
      values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    sel.value = keep;
  }
  function syncAssigneeSelect() {
    $('tmAssignee').innerHTML =
      '<option value="">Unassigned</option>' +
      assignees.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  }

  function applyFilters() {
    const q = $('tkSearch').value.trim().toLowerCase();
    const group = $('tkGroup').value;
    const asg = $('tkAssignee').value;
    const pri = $('tkPriority').value;
    const label = $('tkLabel').value;
    return tasks.filter((t) => {
      if (q && !(`task-${t.id} ${t.title} ${t.description}`.toLowerCase().includes(q))) return false;
      if (group && t.group !== group) return false;
      if (asg === 'none' && t.assignee_id != null) return false;
      if (asg && asg !== 'none' && String(t.assignee_id) !== asg) return false;
      if (pri && t.priority !== pri) return false;
      if (label && !(t.labels || []).includes(label)) return false;
      return true;
    });
  }

  function renderBoard() {
    const shown = applyFilters();
    $('tkCount').textContent = `${shown.length} task${shown.length === 1 ? '' : 's'}`;
    const board = $('taskBoard');
    board.innerHTML = COLUMNS.map((c) => {
      const cards = shown
        .filter((t) => t.status === c.key)
        .sort((a, b) => a.order - b.order);
      return `<div class="task-col" data-status="${c.key}">
        <div class="col-head"><span>${c.name}</span><span class="col-count">${cards.length}</span></div>
        <div class="col-body" data-status="${c.key}">
          ${cards.map(cardHtml).join('') || '<div class="col-empty">Drop tasks here</div>'}
        </div>
        <button class="col-add" data-add="${c.key}">+ Add task</button>
      </div>`;
    }).join('');
  }

  function cardHtml(t) {
    const labels = (t.labels || [])
      .slice(0, 3)
      .map((l) => `<span class="tc-label">${esc(l)}</span>`)
      .join('');
    return `<div class="task-card${t.completed ? ' done' : ''}" draggable="true" data-id="${t.id}">
      <div class="tc-top">
        <span class="tc-id">TASK-${t.id}</span>
        <span class="tc-pri pri-${t.priority}">${PRIORITIES[t.priority] || t.priority}</span>
      </div>
      <div class="tc-title">${esc(t.title)}</div>
      ${labels ? `<div class="tc-labels">${labels}</div>` : ''}
      <div class="tc-foot">
        ${t.group ? `<span class="tc-group">${esc(t.group)}</span>` : ''}
        <span class="tc-spacer"></span>
        ${t.due_date ? `<span class="tc-due">${esc(fmtDue(t.due_date))}</span>` : ''}
        ${
          t.assignee_name
            ? `<span class="tc-avatar" title="${esc(t.assignee_name)}">${esc(initials(t.assignee_name))}</span>`
            : ''
        }
      </div>
    </div>`;
  }

  // ------------------------------------------------------------------- events
  function wireOnce() {
    ['tkSearch', 'tkGroup', 'tkAssignee', 'tkPriority', 'tkLabel'].forEach((id) => {
      const el = $(id);
      el.addEventListener(id === 'tkSearch' ? 'input' : 'change', renderBoard);
    });
    $('tkReset').addEventListener('click', () => {
      ['tkSearch', 'tkGroup', 'tkAssignee', 'tkPriority', 'tkLabel'].forEach((id) => ($(id).value = ''));
      renderBoard();
    });

    const board = $('taskBoard');
    // Open a card, or add a task from a column footer.
    board.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) return addTask(add.dataset.add);
      const card = e.target.closest('.task-card');
      if (card && !card.classList.contains('dragging')) openTask(Number(card.dataset.id));
    });

    // Drag and drop between columns.
    let dragId = null;
    board.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.task-card');
      if (!card) return;
      dragId = Number(card.dataset.id);
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    board.addEventListener('dragend', (e) => {
      const card = e.target.closest('.task-card');
      if (card) card.classList.remove('dragging');
      board.querySelectorAll('.col-body.over').forEach((b) => b.classList.remove('over'));
    });
    board.addEventListener('dragover', (e) => {
      const body = e.target.closest('.col-body');
      if (!body) return;
      e.preventDefault();
      board.querySelectorAll('.col-body.over').forEach((b) => b.classList.remove('over'));
      body.classList.add('over');
      const after = dragAfter(body, e.clientY);
      const dragging = board.querySelector('.dragging');
      if (!dragging) return;
      if (after == null) body.appendChild(dragging);
      else body.insertBefore(dragging, after);
    });
    board.addEventListener('drop', (e) => {
      const body = e.target.closest('.col-body');
      if (!body || dragId == null) return;
      e.preventDefault();
      body.classList.remove('over');
      const status = body.dataset.status;
      // Order = midway between the new neighbours so a single card update sticks.
      const siblings = [...body.querySelectorAll('.task-card')];
      const idx = siblings.findIndex((c) => Number(c.dataset.id) === dragId);
      const prev = siblings[idx - 1] ? byId(Number(siblings[idx - 1].dataset.id)) : null;
      const next = siblings[idx + 1] ? byId(Number(siblings[idx + 1].dataset.id)) : null;
      let order;
      if (prev && next) order = (prev.order + next.order) / 2;
      else if (prev) order = prev.order + 1;
      else if (next) order = next.order - 1;
      else order = 0;
      const id = dragId;
      dragId = null;
      moveTask(id, status, order);
    });

    wireModal();
  }

  function dragAfter(container, y) {
    const cards = [...container.querySelectorAll('.task-card:not(.dragging)')];
    let closest = { offset: -Infinity, el: null };
    for (const c of cards) {
      const box = c.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset, el: c };
    }
    return closest.el;
  }

  async function moveTask(id, status, order) {
    const t = byId(id);
    if (!t) return;
    const prev = { status: t.status, order: t.order };
    t.status = status;
    t.order = order;
    renderBoard();
    try {
      const updated = await api('/api/admin/tasks/' + id, {
        method: 'PATCH',
        body: JSON.stringify({ status, order }),
      });
      Object.assign(t, updated);
    } catch (e) {
      Object.assign(t, prev);
      renderBoard();
      alert(e.message);
    }
  }

  async function addTask(status) {
    const title = prompt('New task title:');
    if (!title || !title.trim()) return;
    try {
      const t = await api('/api/admin/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: title.trim(), status }),
      });
      tasks.push(t);
      syncFilters();
      renderBoard();
      openTask(t.id);
    } catch (e) {
      alert(e.message);
    }
  }

  // --------------------------------------------------------------- detail modal
  function openTask(id) {
    const t = byId(id);
    if (!t) return;
    currentId = id;
    $('tmId').textContent = 'TASK-' + t.id;
    $('tmCompleted').checked = !!t.completed;
    $('tmTitle').value = t.title;
    $('tmDesc').value = t.description || '';
    $('tmGroup').value = t.group || '';
    $('tmAssignee').value = t.assignee_id == null ? '' : String(t.assignee_id);
    $('tmType').value = t.task_type || 'Other';
    $('tmLabels').value = (t.labels || []).join(', ');
    $('tmPriority').value = t.priority || 'low';
    $('tmStatus').value = t.status;
    $('tmDue').value = t.due_date || '';
    $('tmLinked').value = t.linked_record || '';
    $('tmMsg').textContent = '';
    setTimer(t);
    renderAttachments(t);
    renderComments(t);
    renderTime(t);
    renderHistory(t);
    showTab('comments');
    $('taskModalBack').classList.add('open');
  }
  function closeTask() {
    $('taskModalBack').classList.remove('open');
    currentId = null;
  }

  function setTimer(t) {
    $('tmTimer').textContent = t.timer_running ? '■ Stop' : '▶ Start';
    $('tmTimer').classList.toggle('running', !!t.timer_running);
  }
  function renderComments(t) {
    const feed = $('tmComments');
    feed.innerHTML = (t.comments || []).length
      ? t.comments
          .map(
            (c) => `<div class="tm-item"><div class="tm-item-meta">${esc(c.author)} · ${esc(
              fmtWhen(c.at)
            )}</div><div>${esc(c.text)}</div></div>`
          )
          .join('')
      : '<div class="tm-empty">No comments yet.</div>';
  }
  function renderHistory(t) {
    const feed = $('tmHistory');
    feed.innerHTML = (t.history || []).length
      ? t.history
          .slice()
          .reverse()
          .map((h) => `<div class="tm-item"><div class="tm-item-meta">${esc(fmtWhen(h.at))}</div><div>${esc(h.text)}</div></div>`)
          .join('')
      : '<div class="tm-empty">No history yet.</div>';
  }
  function renderTime(t) {
    $('tmTimeTotal').textContent = fmtDur(t.time_seconds || 0);
  }

  function renderAttachments(t) {
    const list = $('tmAttach');
    const items = t.attachments || [];
    if (!items.length) {
      list.innerHTML = '<div class="tm-empty">No attachments yet.</div>';
      return;
    }
    list.innerHTML = items
      .map(
        (a) => `<div class="tm-att" data-att="${a.id}">
          <a class="tm-att-name" href="/api/admin/tasks/${t.id}/attachments/${a.id}" target="_blank" rel="noopener" title="${esc(a.filename)}">📎 ${esc(a.filename)}</a>
          <span class="tm-att-size">${fmtBytes(a.size || 0)}</span>
          <a class="tm-att-dl" href="/api/admin/tasks/${t.id}/attachments/${a.id}?download=1"
             title="Download">⤓</a>
          <button type="button" class="tm-att-del" data-att-del="${a.id}" title="Remove">✕</button>
        </div>`
      )
      .join('');
  }

  async function uploadFiles(fileList) {
    if (currentId == null) return;
    const id = currentId;
    const files = [...fileList];
    for (const file of files) {
      if (file.size > MAX_ATTACH) {
        $('tmMsg').textContent = `"${file.name}" is too large (max 1 GB).`;
        continue;
      }
      try {
        $('tmMsg').textContent = `Uploading ${file.name}… 0%`;
        // Straight to storage in parts — the app never carries the bytes, so the
        // old ~4 MB serverless ceiling no longer applies. See public/uploader.js.
        const meta = await window.HEKUpload.upload({
          base: '/api/admin/tasks/' + id + '/attachments',
          file,
          onProgress: (frac) => {
            $('tmMsg').textContent = `Uploading ${file.name}… ${Math.round(frac * 100)}%`;
          },
        });
        const t = byId(id);
        if (t) {
          (t.attachments = t.attachments || []).push(meta);
          if (currentId === id) renderAttachments(t);
        }
        $('tmMsg').textContent = '';
      } catch (e) {
        $('tmMsg').textContent = e.message;
      }
    }
  }

  async function deleteAttachment(attId) {
    if (currentId == null) return;
    const id = currentId;
    try {
      await api('/api/admin/tasks/' + id + '/attachments/' + attId, { method: 'DELETE' });
      const t = byId(id);
      if (t) {
        t.attachments = (t.attachments || []).filter((a) => a.id !== attId);
        renderAttachments(t);
      }
    } catch (e) {
      $('tmMsg').textContent = e.message;
    }
  }

  function showTab(name) {
    document.querySelectorAll('.tm-tab').forEach((b) => b.classList.toggle('active', b.dataset.tmtab === name));
    document.querySelectorAll('.tm-panel').forEach((p) => p.classList.toggle('active', p.id === 'tmtab-' + name));
  }

  // Save one field, keep the local copy + board in sync.
  async function save(patch) {
    if (currentId == null) return;
    const id = currentId;
    try {
      const updated = await api('/api/admin/tasks/' + id, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const t = byId(id);
      if (t) Object.assign(t, updated);
      syncFilters();
      renderBoard();
      if (currentId === id && t) {
        renderHistory(t);
        $('tmAssignee').value = t.assignee_id == null ? '' : String(t.assignee_id);
      }
    } catch (e) {
      $('tmMsg').textContent = e.message;
      const t = byId(id);
      if (t) openTask(id); // revert the field to the server truth
    }
  }

  function wireModal() {
    $('tmClose').addEventListener('click', closeTask);
    $('taskModalBack').addEventListener('click', (e) => {
      if (e.target === $('taskModalBack')) closeTask();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('taskModalBack').classList.contains('open')) closeTask();
    });

    document.querySelectorAll('.tm-tab').forEach((b) =>
      b.addEventListener('click', () => showTab(b.dataset.tmtab))
    );

    // Auto-save fields. Text fields save on blur/Enter; selects on change.
    $('tmTitle').addEventListener('change', () => {
      const v = $('tmTitle').value.trim();
      if (v) save({ title: v });
    });
    $('tmDesc').addEventListener('change', () => save({ description: $('tmDesc').value }));
    $('tmGroup').addEventListener('change', () => save({ group: $('tmGroup').value }));
    $('tmLinked').addEventListener('change', () => save({ linked_record: $('tmLinked').value }));
    $('tmLabels').addEventListener('change', () =>
      save({ labels: $('tmLabels').value.split(',').map((s) => s.trim()).filter(Boolean) })
    );
    $('tmStatus').addEventListener('change', () => save({ status: $('tmStatus').value }));
    $('tmAssignee').addEventListener('change', () => save({ assignee_id: $('tmAssignee').value || null }));
    $('tmType').addEventListener('change', () => save({ task_type: $('tmType').value }));
    $('tmPriority').addEventListener('change', () => save({ priority: $('tmPriority').value }));
    $('tmDue').addEventListener('change', () => save({ due_date: $('tmDue').value || null }));
    $('tmCompleted').addEventListener('change', () => save({ completed: $('tmCompleted').checked }));

    // Attachments: browse, drag-and-drop, and per-file delete.
    $('tmBrowse').addEventListener('click', () => $('tmFile').click());
    $('tmFile').addEventListener('change', (e) => {
      if (e.target.files.length) uploadFiles(e.target.files);
      e.target.value = ''; // allow re-selecting the same file
    });
    const drop = $('tmDrop');
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
    drop.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
    });
    $('tmAttach').addEventListener('click', (e) => {
      const del = e.target.closest('[data-att-del]');
      if (del) deleteAttachment(del.dataset.attDel);
    });

    // Add a comment (Enter to send).
    $('tmCommentInput').addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const text = $('tmCommentInput').value.trim();
      if (!text || currentId == null) return;
      const id = currentId;
      try {
        const c = await api('/api/admin/tasks/' + id + '/comment', {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
        const t = byId(id);
        if (t) {
          (t.comments = t.comments || []).push(c);
          renderComments(t);
        }
        $('tmCommentInput').value = '';
      } catch (err) {
        $('tmMsg').textContent = err.message;
      }
    });

    // Work timer.
    $('tmTimer').addEventListener('click', async () => {
      if (currentId == null) return;
      const id = currentId;
      const t = byId(id);
      const action = t && t.timer_running ? 'stop' : 'start';
      try {
        const updated = await api('/api/admin/tasks/' + id + '/timer', {
          method: 'POST',
          body: JSON.stringify({ action }),
        });
        if (t) Object.assign(t, updated);
        setTimer(t);
        renderTime(t);
      } catch (err) {
        $('tmMsg').textContent = err.message;
      }
    });

    // Delete.
    $('tmDelete').addEventListener('click', async () => {
      if (currentId == null) return;
      const t = byId(currentId);
      if (!confirm(`Delete TASK-${currentId}${t ? ' — ' + t.title : ''}?`)) return;
      const id = currentId;
      try {
        await api('/api/admin/tasks/' + id, { method: 'DELETE' });
        tasks = tasks.filter((x) => x.id !== id);
        closeTask();
        syncFilters();
        renderBoard();
      } catch (e) {
        $('tmMsg').textContent = e.message;
      }
    });
  }

  window.Tasks = { loadAdmin };
})();
