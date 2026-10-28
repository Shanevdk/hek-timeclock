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

  // The board's one read, through window.Snappy (snappy.js). Its copies are
  // filed under the exact path, so every read of it uses this constant.
  const TASKS = '/api/admin/tasks';

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
  let known = false; // `tasks` holds real tasks, kept or fresh
  let loadGen = 0; // the newest read; an older one that lands late is dropped
  let filterKey = ''; // what the filter menus were last filled from
  let crewKey = ''; // what the modal's assignee menu was last filled from

  // Comments on their way to the server, by task id. Each shows at once, marked
  // as sending; one the server doesn't take stays, marked, with Retry — never
  // quietly dropped.
  const outbox = new Map(); // task id -> [{ key, text, failed, error }]
  let outboxSeq = 0;

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
  // The board paints at once from the copy kept last time (on this device, for
  // this account only), then from the server's answer if anything changed.
  async function loadAdmin() {
    if (!$('taskBoard')) return;
    if (!wired) {
      wireOnce();
      wired = true;
    }
    const gen = ++loadGen;
    // Nothing on screen yet: a line that only appears if the wait is long
    // enough to notice (.wait). A kept copy replaces it at once.
    if (!known)
      $('taskBoard').innerHTML =
        '<p class="status-sub wait" style="grid-column:1/-1">Loading tasks…</p>';
    try {
      await Snappy.swr(
        readTasks,
        TASKS,
        (d) => {
          // A newer read has started, or a change is on its way: the board on
          // screen is newer than this copy.
          if (gen !== loadGen || writes) return;
          take(d);
        },
        { persist: true }
      );
    } catch (e) {
      if (e.stale) return; // crossed a change; the read after it brings the board
      if (!known) $('taskBoard').innerHTML = '';
      throw e;
    }
  }

  // A list of tasks for the screen: the kept copy or the server's.
  function take(d) {
    tasks = d.tasks || [];
    assignees = d.assignees || [];
    known = true;
    syncFilters();
    syncAssigneeSelect();
    // Not under a card that's being dragged: a redraw would pull it out of the
    // person's hand. The drop (or letting go elsewhere) redraws anyway.
    if (!$('taskBoard').querySelector('.task-card.dragging')) renderBoard();
    // An open task's feeds follow along. Its fields are the person's own, maybe
    // half-typed, and are left exactly as they are.
    const t = currentId != null ? byId(currentId) : null;
    if (t) {
      setTimer(t);
      renderAttachments(t);
      renderComments(t);
      renderTime(t);
      renderHistory(t);
    }
  }

  // ---- reads and changes ----
  // A change shows the moment it's made and goes to the server behind it. A
  // read of the board that crosses paths with one may describe it from before
  // the change: drawn, it would undo the change on screen; kept, it would
  // paint it again next visit. So such a read is refused, and once nothing is
  // on its way any more the board is read again.
  let writes = 0; // changes still on their way to the server
  let writeSeq = 0; // goes up as each change starts and as it ends
  let lostRead = false; // a read was refused, so the board owes itself one

  async function readTasks(path) {
    const seq = writeSeq;
    const calm = !writes;
    const d = await api(path);
    if (calm && seq === writeSeq) return d;
    lostRead = true;
    settle();
    const err = new Error('The tasks changed while they were being read.');
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

  // Owed a read, and nothing is on its way any more: read now, straight from
  // the server rather than joining a read that set off before the change.
  function settle() {
    if (writes || !lostRead || !known) return;
    lostRead = false;
    const gen = ++loadGen;
    readTasks(TASKS)
      .then((d) => {
        if (gen !== loadGen) return;
        Snappy.cache.put(TASKS, d, true);
        take(d);
      })
      .catch(() => {
        /* what's on screen stands; the next visit reads again */
      });
  }

  // After a change the server took, the board on screen is the newest copy
  // there is: keep it, so the next visit opens on it rather than the old one.
  // Comments still sending live apart (outbox) and are never kept.
  function keepCopy() {
    if (known && !writes) Snappy.cache.put(TASKS, { tasks, assignees }, true);
  }

  // Takes from the server's answer what a change was about, and what the
  // server wrote because of it (the history line) — not the rest, which a
  // second change still on its way may be showing differently right now.
  function absorb(t, updated, keys) {
    for (const k of [...keys, 'history', 'updated_at']) if (k in updated) t[k] = updated[k];
  }

  function syncFilters() {
    const groups = [...new Set(tasks.map((t) => t.group).filter(Boolean))].sort();
    const labels = [...new Set(tasks.flatMap((t) => t.labels || []))].sort();
    // Refilled only when something in them changed: refilling a menu that is
    // open would snap it shut under the person's pointer.
    const key = JSON.stringify([groups, labels, assignees]);
    if (key === filterKey) return;
    filterKey = key;
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
    const key = JSON.stringify(assignees);
    if (key === crewKey) return;
    crewKey = key;
    // A fresh list can arrive with a task open: its choice stays chosen.
    const sel = $('tmAssignee');
    const was = sel.value;
    sel.innerHTML =
      '<option value="">Unassigned</option>' +
      assignees.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    sel.value = was;
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
    // The columns are drawn once and only their cards are refilled after that,
    // so a redraw leaves the "+ Add task" buttons (and any wait on one) alone.
    if (!board.querySelector('.task-col'))
      board.innerHTML = COLUMNS.map(
        (c) => `<div class="task-col" data-status="${c.key}">
        <div class="col-head"><span>${c.name}</span><span class="col-count">0</span></div>
        <div class="col-body" data-status="${c.key}"></div>
        <button class="col-add" data-add="${c.key}">+ Add task</button>
      </div>`
      ).join('');
    for (const c of COLUMNS) {
      const cards = shown
        .filter((t) => t.status === c.key)
        .sort((a, b) => a.order - b.order);
      const col = board.querySelector(`.task-col[data-status="${c.key}"]`);
      col.querySelector('.col-count').textContent = cards.length;
      const body = col.querySelector('.col-body');
      // A long column (Done grows for ever) draws a screenful now and the rest
      // as it's scrolled toward. A redraw keeps at least as many cards as were
      // showing, so the page doesn't shrink and jump under the person.
      const had = body.querySelectorAll('.task-card').length;
      Snappy.chunks(
        body,
        cards.length ? cards.map(cardHtml) : ['<div class="col-empty">Drop tasks here</div>'],
        { first: Math.max(60, had) }
      );
    }
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
      if (add) return addTask(add.dataset.add, add);
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
      // Let go outside a column: the card only moved for show while it was in
      // the air, so the board goes back to how it really is.
      if (dragId != null) {
        dragId = null;
        renderBoard();
      }
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
      // Above the marker a long column keeps at its foot (Snappy.chunks), so
      // the next batch of cards still lands after the one being dragged.
      body.insertBefore(dragging, after || body.querySelector('.snappy-more'));
    });
    board.addEventListener('drop', (e) => {
      const body = e.target.closest('.col-body');
      if (!body || dragId == null) return;
      e.preventDefault();
      body.classList.remove('over');
      const status = body.dataset.status;
      const id = dragId;
      dragId = null;
      // Order = midway between the new neighbours so a single card update
      // sticks. The one above is the card drawn just before it; the one below
      // is the next in the whole column, which a long column may not have
      // drawn yet.
      const cards = [...body.querySelectorAll('.task-card')];
      const idx = cards.findIndex((c) => Number(c.dataset.id) === id);
      const prev = idx > 0 ? byId(Number(cards[idx - 1].dataset.id)) : null;
      const column = applyFilters()
        .filter((t) => t.status === status && t.id !== id)
        .sort((a, b) => a.order - b.order);
      const next = column[prev ? column.indexOf(prev) + 1 : 0] || null;
      let order;
      if (prev && next) order = (prev.order + next.order) / 2;
      else if (prev) order = prev.order + 1;
      else if (next) order = next.order - 1;
      else order = 0;
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

  // The card lands where it was dropped at once; the server hears about it
  // behind that, and if it says no the card goes back where it was.
  async function moveTask(id, status, order) {
    const t = byId(id);
    // Gone meanwhile: still redraw, so the card the drag moved for show goes.
    if (!t) return renderBoard();
    try {
      const updated = await change(() =>
        Snappy.optimistic(
          () => {
            const was = { status: t.status, order: t.order };
            t.status = status;
            t.order = order;
            renderBoard();
            return () => {
              Object.assign(t, was);
              renderBoard();
            };
          },
          () =>
            api(TASKS + '/' + id, {
              method: 'PATCH',
              body: JSON.stringify({ status, order }),
            })
        )
      );
      absorb(t, updated, ['status', 'order']);
      keepCopy();
    } catch (e) {
      alert(e.message);
    }
  }

  async function addTask(status, btn) {
    const title = prompt('New task title:');
    if (!title || !title.trim()) return;
    try {
      // The new card needs the server's number before it can be opened, so
      // this waits — but the button is disabled at once, and "Adding…" only
      // shows if the wait is long enough to notice (Snappy.busy).
      const t = await Snappy.busy(
        btn,
        () =>
          change(() =>
            api(TASKS, {
              method: 'POST',
              body: JSON.stringify({ title: title.trim(), status }),
            })
          ),
        { label: 'Adding…' }
      );
      tasks.push(t);
      keepCopy();
      syncFilters();
      renderBoard();
      openTask(t.id);
    } catch (e) {
      alert(e.message);
    }
  }

  // --------------------------------------------------------------- detail modal
  // The modal's fields: for each saved field, the input it's shown in and how
  // the task holds it. (`completed`, a tick box, is handled on its own.)
  const FIELDS = {
    title: ['tmTitle', (t) => t.title],
    description: ['tmDesc', (t) => t.description || ''],
    group: ['tmGroup', (t) => t.group || ''],
    assignee_id: ['tmAssignee', (t) => (t.assignee_id == null ? '' : String(t.assignee_id))],
    task_type: ['tmType', (t) => t.task_type || 'Other'],
    labels: ['tmLabels', (t) => (t.labels || []).join(', ')],
    priority: ['tmPriority', (t) => t.priority || 'low'],
    status: ['tmStatus', (t) => t.status],
    due_date: ['tmDue', (t) => t.due_date || ''],
    linked_record: ['tmLinked', (t) => t.linked_record || ''],
  };

  // Shows the saved value of the named fields — only those, so whatever is
  // being typed elsewhere in the form is left alone.
  function showSaved(t, keys) {
    for (const k of keys) {
      if (k === 'completed') $('tmCompleted').checked = !!t.completed;
      else if (FIELDS[k]) $(FIELDS[k][0]).value = FIELDS[k][1](t);
    }
  }

  function openTask(id) {
    const t = byId(id);
    if (!t) return;
    currentId = id;
    $('tmId').textContent = 'TASK-' + t.id;
    showSaved(t, ['completed', ...Object.keys(FIELDS)]);
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
    const saved = (t.comments || []).map(
      (c) => `<div class="tm-item"><div class="tm-item-meta">${esc(c.author)} · ${esc(
        fmtWhen(c.at)
      )}</div><div>${esc(c.text)}</div></div>`
    );
    // Then any still on their way: "Sending…" only if the wait is long enough
    // to notice (.wait); one that failed says why and offers to try again.
    const waiting = (outbox.get(t.id) || []).map((p) =>
      p.failed
        ? `<div class="tm-item is-failed"><div class="tm-item-meta">Not sent: ${esc(p.error)}
            <button type="button" class="link-btn" data-retry="${p.key}">Retry</button>
            <button type="button" class="link-btn" data-discard="${p.key}">Discard</button>
          </div><div>${esc(p.text)}</div></div>`
        : `<div class="tm-item is-sending"><div class="tm-item-meta"><span class="wait">Sending…</span></div><div>${esc(
            p.text
          )}</div></div>`
    );
    feed.innerHTML =
      saved.length || waiting.length
        ? saved.join('') + waiting.join('')
        : '<div class="tm-empty">No comments yet.</div>';
  }

  // Sends one comment from the outbox. It's on screen already, marked as
  // sending; when the server has it, it takes its place among the saved ones.
  function sendComment(id, entry) {
    entry.failed = false;
    showComments(id);
    change(() =>
      api(TASKS + '/' + id + '/comment', {
        method: 'POST',
        body: JSON.stringify({ text: entry.text }),
      })
    )
      .then((c) => {
        dropFromOutbox(id, entry.key);
        const t = byId(id);
        if (t) (t.comments = t.comments || []).push(c);
        keepCopy();
        showComments(id);
      })
      .catch((err) => {
        entry.failed = true;
        entry.error = err.message;
        showComments(id);
      });
  }

  function dropFromOutbox(id, key) {
    const left = (outbox.get(id) || []).filter((p) => p.key !== key);
    if (left.length) outbox.set(id, left);
    else outbox.delete(id);
  }

  // Redraws a task's comments, if that task is the one open.
  function showComments(id) {
    const t = byId(id);
    if (t && currentId === id) renderComments(t);
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
        // An upload runs outside change() — it can take minutes, and the board
        // has to stay readable meanwhile — so it is marked here: a read that
        // set off before it finished is refused, and the board read again.
        writeSeq++;
        const t = byId(id);
        if (t) {
          (t.attachments = t.attachments || []).push(meta);
          if (currentId === id) renderAttachments(t);
        }
        keepCopy();
        $('tmMsg').textContent = '';
      } catch (e) {
        $('tmMsg').textContent = e.message;
      }
    }
  }

  // Off the list at once; back, with the reason, if the server refuses.
  async function deleteAttachment(attId) {
    if (currentId == null) return;
    const id = currentId;
    const t = byId(id);
    if (!t) return;
    try {
      await change(() =>
        Snappy.optimistic(
          () => {
            const gone = (t.attachments || []).find((a) => a.id === attId);
            t.attachments = (t.attachments || []).filter((a) => a.id !== attId);
            if (currentId === id) renderAttachments(t);
            return () => {
              // Put back just this one: an upload may have landed meanwhile.
              if (gone) t.attachments = (t.attachments || []).concat(gone);
              if (currentId === id) renderAttachments(t);
            };
          },
          () => api(TASKS + '/' + id + '/attachments/' + attId, { method: 'DELETE' })
        )
      );
      keepCopy();
    } catch (e) {
      $('tmMsg').textContent = e.message;
    }
  }

  function showTab(name) {
    document.querySelectorAll('.tm-tab').forEach((b) => b.classList.toggle('active', b.dataset.tmtab === name));
    document.querySelectorAll('.tm-panel').forEach((p) => p.classList.toggle('active', p.id === 'tmtab-' + name));
  }

  // A field change the way the task holds it, so the card can redraw before
  // the server answers: an assignee is a number, with a name for the avatar.
  function asHeld(patch) {
    const out = { ...patch };
    if ('assignee_id' in patch) {
      const a = assignees.find((x) => String(x.id) === String(patch.assignee_id));
      out.assignee_id = a ? a.id : null;
      out.assignee_name = a ? a.name : null;
    }
    return out;
  }

  // Save one field. The card shows it at once; the server's answer then fills
  // in what it worked out (the history line, the assignee's name). If the
  // server says no, that field — and only that one — goes back to what's
  // saved, and the reason shows.
  async function save(patch) {
    if (currentId == null) return;
    const id = currentId;
    const t = byId(id);
    if (!t) return;
    const held = asHeld(patch);
    try {
      const updated = await change(() =>
        Snappy.optimistic(
          () => {
            const was = {};
            for (const k of Object.keys(held)) was[k] = t[k];
            Object.assign(t, held);
            syncFilters();
            renderBoard();
            return () => {
              Object.assign(t, was);
              syncFilters();
              renderBoard();
              if (currentId === id) showSaved(t, Object.keys(patch));
            };
          },
          () =>
            api(TASKS + '/' + id, {
              method: 'PATCH',
              body: JSON.stringify(patch),
            })
        )
      );
      absorb(t, updated, Object.keys(held));
      keepCopy();
      syncFilters();
      renderBoard();
      if (currentId === id) {
        renderHistory(t);
        $('tmAssignee').value = t.assignee_id == null ? '' : String(t.assignee_id);
      }
    } catch (e) {
      if (currentId === id) $('tmMsg').textContent = e.message;
      else alert(e.message);
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

    // Comments / Time / History only show something, so a mouse press acts on
    // the way down (data-press="fast", snappy.js). Not Close: a half-typed
    // field saves as it loses focus, which has to happen before the task shuts.
    document.querySelectorAll('.tm-tab').forEach((b) => {
      b.setAttribute('data-press', 'fast');
      b.addEventListener('click', () => showTab(b.dataset.tmtab));
    });

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

    // Add a comment (Enter to send). It shows straight away, marked as
    // sending, and the box clears for the next one; the text lives on in the
    // outbox until the server has it.
    $('tmCommentInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const text = $('tmCommentInput').value.trim();
      if (!text || currentId == null) return;
      const id = currentId;
      const entry = { key: ++outboxSeq, text, failed: false, error: '' };
      outbox.set(id, (outbox.get(id) || []).concat(entry));
      $('tmCommentInput').value = '';
      sendComment(id, entry);
    });
    // A comment that didn't go: try again, or let it go on purpose.
    $('tmComments').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-retry], [data-discard]');
      if (!btn || currentId == null) return;
      const id = currentId;
      const key = Number(btn.dataset.retry || btn.dataset.discard);
      const entry = (outbox.get(id) || []).find((p) => p.key === key);
      if (!entry) return;
      if (btn.dataset.retry) sendComment(id, entry);
      else {
        dropFromOutbox(id, key);
        showComments(id);
      }
    });

    // Work timer. Not shown as running until the server says so — it's time
    // being counted — but the button is disabled at once so it can't be
    // pressed twice, with a spinner only if the wait is long enough to notice.
    $('tmTimer').addEventListener('click', async () => {
      if (currentId == null) return;
      const id = currentId;
      const t = byId(id);
      const action = t && t.timer_running ? 'stop' : 'start';
      try {
        const updated = await Snappy.busy($('tmTimer'), () =>
          change(() =>
            api(TASKS + '/' + id + '/timer', {
              method: 'POST',
              body: JSON.stringify({ action }),
            })
          )
        );
        if (t) absorb(t, updated, ['timer_running', 'time_seconds']);
        keepCopy();
        if (t && currentId === id) {
          setTimer(t);
          renderTime(t);
        }
      } catch (err) {
        $('tmMsg').textContent = err.message;
      }
    });

    // Delete. Gone from the board as soon as it's confirmed, and deleted
    // behind it. If the server refuses, the card comes back and says why.
    $('tmDelete').addEventListener('click', async () => {
      if (currentId == null) return;
      const t = byId(currentId);
      if (!confirm(`Delete TASK-${currentId}${t ? ' — ' + t.title : ''}?`)) return;
      const id = currentId;
      closeTask();
      try {
        await change(() =>
          Snappy.optimistic(
            () => {
              tasks = tasks.filter((x) => x.id !== id);
              syncFilters();
              renderBoard();
              return () => {
                if (t && !byId(id)) tasks = tasks.concat(t);
                syncFilters();
                renderBoard();
              };
            },
            () => api(TASKS + '/' + id, { method: 'DELETE' })
          )
        );
        outbox.delete(id);
        keepCopy();
      } catch (e) {
        alert(e.message);
      }
    });
  }

  // Asks ahead for the board's read. The shell calls this when a pointer rests
  // on the Tasks tab, and when idle. Only the dashboard has a board: anywhere
  // else this does nothing (an admin read from the portal would answer 401,
  // and the portal takes that as "signed out").
  function prefetch() {
    if (!$('taskBoard') || writes) return;
    Snappy.prefetch(readTasks, TASKS, { persist: true });
  }

  window.Tasks = { loadAdmin, prefetch };
})();
