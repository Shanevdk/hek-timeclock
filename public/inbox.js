// AI inbox — the review screen for emails the agent has read.
//
// Each lead shows the original email beside the estimate drafted from it, with
// whatever the agent couldn't work out listed as the questions to ask. Nothing
// becomes a quote until someone presses Approve, and the draft is editable
// right here — a correction made while reviewing is what gets saved.
//
// Relies on window.HEKAdmin ({ api, esc }) from admin.js, loaded first.
(function () {
  const H = () => window.HEKAdmin || {};
  const api = (...a) => H().api(...a);
  const esc = (s) => (H().esc ? H().esc(s) : String(s));
  const $ = (id) => document.getElementById(id);

  let status = null;
  let leads = [];
  let expanded = null; // id of the lead currently opened
  let wired = false;
  const approving = new Set(); // ids of leads whose Approve is on its way

  // Read under these exact paths everywhere, so kept copies line up. Kept in
  // memory only, never on the device: this is people's email.
  const STATUS = '/api/admin/inbox/status';
  const LEADS = '/api/admin/inbox/leads';
  // Answers about the list can land out of order — a slow read that set off
  // before a change can arrive after it. Each read is numbered as it starts;
  // one older than what the screen already shows (a newer read, or a change
  // made here) is dropped rather than painted over it.
  let asked = 0;
  let shown = 0;
  let onScreen = null; // the leads path whose answer is drawn

  // A read that must reflect a change just made here: never the kept copy,
  // never a request that set off before the change. Kept afterwards.
  const reread = (path) =>
    api(path).then((d) => {
      Snappy.cache.put(path, d);
      return d;
    });

  // Whether someone is typing in a field inside `box` right now. A refresh
  // landing mid-sentence must not put the server's older values back.
  const typing = (box) => {
    const a = document.activeElement;
    return !!box && !!a && box.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  };

  const money = (n) =>
    '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
  const fmtWhen = (iso) =>
    iso
      ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';

  function say(id, text, kind) {
    const el = $(id);
    if (!el) return;
    el.className = 'msg' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  // ---- status + settings ----
  function renderStatus() {
    const s = status || {};
    const needs = $('ibNeeds');
    if (s.needs && s.needs.length) {
      needs.style.display = '';
      needs.innerHTML =
        '<div class="qb-need-title">Before the agent can run</div><ul>' +
        s.needs.map((t) => `<li>${esc(t)}</li>`).join('') +
        '</ul>';
    } else {
      needs.style.display = 'none';
    }

    renderCount();

    const last = s.last_scan;
    if (last) say('ibMsg', ...lastScanLine(last, s.scanning));
  }

  // The sidebar's count of emails waiting for review.
  function renderCount() {
    const count = (status && status.counts && status.counts.new) || 0;
    const nav = $('ibNavCount');
    if (nav) {
      nav.textContent = count;
      nav.style.display = count ? '' : 'none';
    }
  }

  // How the last scan went, as [text, kind]. A scan that failed or was cut off
  // says so plainly: otherwise it looks just like a quiet inbox.
  function lastScanLine(last, scanning) {
    if (!last.finished_at)
      return scanning
        ? [`Scanning — started ${fmtWhen(last.started_at)}.`, '']
        : [
            `The scan started ${fmtWhen(last.started_at)} never finished — the server stopped it. The next scan carries on from where it got to.`,
            'err',
          ];
    const when = fmtWhen(last.finished_at);
    if (last.error)
      return [`Last scan ${when} failed: ${last.error}${last.detail ? ' ' + last.detail : ''}`, 'err'];
    const bits = [`${last.considered || 0} read`];
    if (last.leads) bits.push(`${last.leads} quote request${last.leads === 1 ? '' : 's'}`);
    if (last.not_quotes) bits.push(`${last.not_quotes} not relevant`);
    if (last.skipped) bits.push(`${last.skipped} skipped unread`);
    if (last.failed) bits.push(`${last.failed} failed`);
    if (last.remaining) bits.push(`${last.remaining} left for the next scan`);
    const first = last.failed && last.errors && last.errors[0] ? ' ' + last.errors[0].message : '';
    return [`Last scan ${when} — ${bits.join(', ')}.${first}`, last.failed ? 'err' : ''];
  }

  function renderSettings() {
    const s = (status && status.settings) || {};
    $('ibUser').value = s.user || '';
    $('ibHost').value = s.host || '';
    $('ibPort').value = s.port || 993;
    $('ibFolder').value = s.folder || 'INBOX';
    $('ibLookback').value = s.lookback_days || 3;
    $('ibMax').value = s.max_per_scan || 25;
    $('ibEnabled').checked = !!s.enabled;
    $('ibAuto').checked = s.auto_scan !== false;
    $('ibPass').placeholder = status && status.has_password ? 'saved — leave blank to keep' : 'app password';
    $('ibModel').innerHTML = ((status && status.models) || [])
      .map((m) => `<option value="${esc(m)}"${m === s.model ? ' selected' : ''}>${esc(m)}</option>`)
      .join('');
  }

  async function saveSettings() {
    // No "Saving…" straight away: the button goes busy at once, and shows a
    // spinner only if the save takes long enough to need one.
    say('ibSettingsMsg', '');
    try {
      status = await Snappy.busy($('ibSaveSettings'), () =>
        api('/api/admin/inbox/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            user: $('ibUser').value,
            password: $('ibPass').value || undefined,
            host: $('ibHost').value,
            port: $('ibPort').value,
            folder: $('ibFolder').value,
            model: $('ibModel').value,
            lookback_days: $('ibLookback').value,
            max_per_scan: $('ibMax').value,
            enabled: $('ibEnabled').checked,
            auto_scan: $('ibAuto').checked,
          }),
        })
      );
      // The answer is the whole status: kept, so the tab next opens on it.
      Snappy.cache.put(STATUS, status);
      $('ibPass').value = '';
      renderSettings();
      renderStatus();
      say('ibSettingsMsg', 'Saved.', 'ok');
    } catch (e) {
      say('ibSettingsMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
    }
  }

  // ---- leads ----
  function itemRows(lead) {
    const items = (lead.draft && lead.draft.items) || [];
    if (!items.length)
      return `<tr><td colspan="5" class="qb-dim">The agent couldn't identify any line items — add them below.</td></tr>`;
    return items
      .map(
        (it) => `<tr>
        <td><input class="l-desc" value="${escAttr(it.description || '')}" /></td>
        <td><input class="l-qty" inputmode="decimal" value="${escAttr(it.qty || '')}" /></td>
        <td><input class="l-unit" value="${escAttr(it.unit || '')}" /></td>
        <td><input class="l-price" inputmode="decimal" value="${escAttr(it.unit_price || '')}" /></td>
        <td><button class="link-btn danger l-del" title="Remove">✕</button></td>
      </tr>`
      )
      .join('');
  }

  // Mail the agent drafted nothing for, and why — shown above the empty draft.
  const NO_DRAFT = {
    not_quote:
      "The agent judged this isn't a quote request, so nothing was drafted. Approving it anyway will create an empty quote you can fill in.",
    skipped:
      "The agent didn't read this one — mailing lists and no-reply senders are almost never customers. If it is a quote request, fill in the estimate and approve it.",
    failed:
      "The agent couldn't read this one, so nothing was drafted. If it is a quote request, fill in the estimate and approve it.",
  };

  function badgeFor(lead) {
    const ai = lead.ai || {};
    if (lead.status === 'not_quote') return '<span class="badge status-draft">Not a quote</span>';
    if (lead.status === 'skipped') return '<span class="badge status-draft">Skipped</span>';
    if (lead.status === 'failed') return '<span class="badge status-declined">Couldn\'t read</span>';
    // Approved or dismissed mail the agent never read has no confidence to show.
    if (!ai.confidence) return '';
    const conf = ai.confidence;
    const cls = conf === 'high' ? 'status-approved' : conf === 'medium' ? 'status-pending' : 'status-declined';
    return `<span class="badge ${cls}">${esc(conf)} confidence</span>`;
  }

  // One lead's card. Its head opens and closes the details, which only shows
  // what is already here, so a mouse does it on the way down (data-press,
  // snappy.js).
  function leadCard(lead) {
    const open = expanded === lead.id;
    const ai = lead.ai || {};
    return `<div class="lead ${open ? 'open' : ''}" data-id="${lead.id}">
      <div class="lead-head" data-toggle="${lead.id}" data-press="fast">
        <div class="lead-head-main">
          <div class="lead-subject">${esc(lead.subject || '(no subject)')}</div>
          <div class="lead-from">${esc(lead.from_name || lead.from_email)}${
            lead.from_name ? ` &lt;${esc(lead.from_email)}&gt;` : ''
          } · ${fmtWhen(lead.received_at)}</div>
        </div>
        <div class="lead-head-side">${badgeFor(lead)}</div>
      </div>
      <div class="lead-summary">${esc(ai.summary || ai.reason || '')}</div>
      ${open ? leadBody(lead) : ''}
    </div>`;
  }

  // The opened part of a card: the email beside the estimate drafted from it.
  function leadBody(lead) {
    const ai = lead.ai || {};
    const draft = lead.draft || {};
    const c = draft.customer || {};
    const missing = (ai.missing || [])
      .map((m) => `<li>${esc(m)}</li>`)
      .join('');
    return `<div class="lead-body">
        ${
          missing
            ? `<div class="lead-missing"><div class="qb-need-title">Still to ask them</div><ul>${missing}</ul></div>`
            : ''
        }
        <div class="lead-cols">
          <div class="lead-col">
            <h4>The email</h4>
            <pre class="lead-email">${esc(lead.body || '')}</pre>
          </div>
          <div class="lead-col">
            <h4>Drafted estimate</h4>
            ${NO_DRAFT[lead.status] ? `<p class="status-sub qb-lead">${NO_DRAFT[lead.status]}</p>` : ''}
            <div class="pgrid">
              <div class="field"><label>Customer</label><input class="l-name" value="${escAttr(c.name || '')}" /></div>
              <div class="field"><label>Phone</label><input class="l-phone" value="${escAttr(c.phone || '')}" /></div>
              <div class="field"><label>Email</label><input class="l-email" value="${escAttr(c.email || '')}" /></div>
              <div class="field"><label>Job site</label><input class="l-address" value="${escAttr(c.address || '')}" /></div>
            </div>
            <table class="items-table" style="margin-top:12px">
              <thead><tr>
                <th style="min-width:160px">Description</th>
                <th style="width:70px">Qty</th>
                <th style="width:90px">Unit</th>
                <th style="width:90px">Price</th>
                <th style="width:32px"></th>
              </tr></thead>
              <tbody class="l-items">${itemRows(lead)}</tbody>
            </table>
            <div class="row" style="margin-top:10px;align-items:center">
              <button class="btn ghost sm l-add">+ Add line</button>
              <div class="field" style="flex:0 1 110px"><label>Tax %</label>
                <input class="l-tax" inputmode="decimal" value="${escAttr(draft.tax_rate != null ? draft.tax_rate : 13)}" /></div>
              <div class="lead-total" style="margin-left:auto">Total <strong class="l-total">$0.00</strong></div>
            </div>
          </div>
        </div>
        <div class="lead-actions">
          ${
            lead.quote_id
              ? `<span class="qb-dim">Approved — quote #${lead.quote_id}.</span>`
              : `<button class="btn ghost sm l-dismiss">Dismiss</button>
                 <button class="btn gold sm l-approve"${approving.has(lead.id) ? ' disabled' : ''}>Approve → create quote</button>`
          }
          <span class="msg l-msg"></span>
        </div>
      </div>`;
  }

  function renderLeads() {
    $('ibEmpty').style.display = leads.length ? 'none' : 'block';
    // The open card may hold corrections not yet approved. A refresh redraws
    // every other card but keeps that one exactly as it is.
    const keep = expanded != null ? $('ibLeads').querySelector(`.lead.open[data-id="${expanded}"]`) : null;
    $('ibLeads').innerHTML = leads.map(leadCard).join('');
    const drawn = keep && leadEl(expanded);
    if (drawn) drawn.replaceWith(keep);
    else if (expanded != null && !leads.some((l) => l.id === expanded)) expanded = null;
    if (expanded != null) recomputeLead(expanded);
  }

  const leadEl = (id) => $('ibLeads').querySelector(`.lead[data-id="${id}"]`);

  // Opens or closes a card in place. Its head stays the same element, under
  // the pointer that pressed it. Opening drops the details out from under the
  // head (styles.css, .is-opening); closing is instant.
  function setOpen(id, on) {
    const el = leadEl(id);
    if (!el) return;
    const lead = on && leads.find((l) => l.id === id);
    el.classList.toggle('open', !!lead);
    const body = el.querySelector('.lead-body');
    if (body) body.remove();
    if (lead) {
      el.insertAdjacentHTML('beforeend', leadBody(lead));
      el.lastElementChild.classList.add('is-opening');
      recomputeLead(id);
    }
  }

  // A lead dismissed on screen at once: off a list of what still needs
  // looking at, and off the sidebar count. Returns what puts it back — the
  // very card, with any corrections typed into it.
  function dismissLocally(id) {
    const lead = leads.find((l) => l.id === id);
    const card = leadEl(id);
    const path = leadsPath();
    const was = { leads, expanded, counts: status && status.counts ? { ...status.counts } : null };
    // "Everything" and "Dismissed" still list it; the other lists don't.
    const stays = ['all', 'dismissed'].includes($('ibFilter').value);
    const after = (list) =>
      stays ? list.map((l) => (l.id === id ? { ...l, status: 'dismissed' } : l)) : list.filter((l) => l.id !== id);
    leads = after(leads);
    if (expanded === id) expanded = null;
    if (lead && status && status.counts && lead.status !== 'dismissed') {
      status.counts = {
        ...status.counts,
        [lead.status]: Math.max(0, (status.counts[lead.status] || 0) - 1),
        dismissed: (status.counts.dismissed || 0) + 1,
      };
    }
    shown = ++asked; // newer than any read of the list already on its way
    const counts = status && status.counts;
    Snappy.cache.update(path, (d) => ({ ...d, leads: after(d.leads || []) }));
    if (counts) Snappy.cache.update(STATUS, (s) => ({ ...s, counts }));
    renderCount();
    renderLeads();
    return () => {
      // Opened again as it was — unless another card has been opened since.
      const free = expanded == null;
      leads = was.leads;
      if (free) expanded = was.expanded;
      if (status && was.counts) status.counts = was.counts;
      shown = ++asked;
      Snappy.cache.update(path, (d) => ({ ...d, leads: was.leads }));
      if (was.counts) Snappy.cache.update(STATUS, (s) => ({ ...s, counts: was.counts }));
      renderCount();
      renderLeads();
      const now = free && leadEl(id);
      if (now && card) now.replaceWith(card);
    };
  }

  function readDraft(id) {
    const el = leadEl(id);
    if (!el) return null;
    const items = [...el.querySelectorAll('.l-items tr')]
      .map((tr) => {
        const desc = tr.querySelector('.l-desc');
        if (!desc) return null;
        return {
          description: desc.value.trim(),
          qty: parseFloat(tr.querySelector('.l-qty').value) || 0,
          unit: tr.querySelector('.l-unit').value.trim(),
          unit_price: parseFloat(tr.querySelector('.l-price').value) || 0,
        };
      })
      .filter((it) => it && (it.description || it.qty || it.unit_price));
    return {
      customer: {
        name: el.querySelector('.l-name').value.trim(),
        phone: el.querySelector('.l-phone').value.trim(),
        email: el.querySelector('.l-email').value.trim(),
        address: el.querySelector('.l-address').value.trim(),
      },
      items,
      tax_rate: parseFloat(el.querySelector('.l-tax').value) || 0,
      notes: '',
    };
  }

  function recomputeLead(id) {
    const el = leadEl(id);
    if (!el) return;
    const draft = readDraft(id);
    if (!draft) return;
    const subtotal = draft.items.reduce((s, it) => s + it.qty * it.unit_price, 0);
    const total = subtotal * (1 + draft.tax_rate / 100);
    const out = el.querySelector('.l-total');
    if (out) out.textContent = money(total);
  }

  // "Not a quote request" also lists what the agent skipped unread (mailing
  // lists, no-reply senders) and what it couldn't read: nobody has looked at
  // any of it, and any of it may still be a customer.
  const FILTER_STATUSES = { not_quote: ['not_quote', 'skipped', 'failed'] };

  function leadsPath() {
    const filter = $('ibFilter').value;
    // One request: the server takes several statuses separated by commas.
    return LEADS + '?status=' + encodeURIComponent((FILTER_STATUSES[filter] || [filter]).join(','));
  }

  // The leads for the filter picked: the copy kept from earlier in this visit
  // at once, then the server's answer if it differs. `fresh` skips the kept
  // copy, for a read straight after a change made here.
  function loadLeads({ fresh } = {}) {
    const path = leadsPath();
    const n = ++asked;
    let painted = false;
    const paint = (d) => {
      painted = true;
      // Another filter picked since, or a newer answer (or a change made
      // here) already on screen: this one is out of date.
      if (path !== leadsPath() || n < shown) return;
      shown = n;
      onScreen = path;
      const when = (l) => Date.parse(l.received_at) || 0;
      leads = (d.leads || []).sort((a, b) => when(b) - when(a));
      $('ibListTitle').textContent =
        $('ibFilter').selectedOptions[0] ? $('ibFilter').selectedOptions[0].textContent : 'Leads';
      renderLeads();
    };
    if (fresh) return reread(path).then(paint);
    const reading = Snappy.swr(api, path, paint);
    // A list not drawn yet this visit: rather than leave another filter's
    // leads showing under this one, say it's loading — but only once the
    // wait is long enough to notice (styles.css, .wait).
    if (!painted && path !== onScreen) {
      $('ibEmpty').style.display = 'none';
      $('ibLeads').innerHTML = '<p class="status-sub wait">Loading…</p>';
    }
    return reading;
  }

  async function scan() {
    let failure = null;
    // Busy at once, so a second press can't start a second scan. A spinner,
    // and the line saying what's happening, appear only once the scan has
    // taken long enough to need them.
    await Snappy.busy($('ibScan'), async () => {
      say('ibMsg', 'Reading the mailbox…', 'wait');
      try {
        await api('/api/admin/inbox/scan', { method: 'POST' });
      } catch (e) {
        failure = e;
      }
      // Whatever a scan filed before it stopped stays filed, so the counts and
      // the list are worth refreshing either way. The status line then shows how
      // the scan went.
      try {
        status = await reread(STATUS);
        renderStatus();
        await loadLeads({ fresh: true });
      } catch (e) {
        failure = failure || e;
      }
    });
    // A scan turned away before it started (agent off, one already running)
    // leaves no record, so its reason goes here, over the last scan's line.
    if (failure) say('ibMsg', failure.detail ? `${failure.message} ${failure.detail}` : failure.message, 'err');
  }

  // After a change made here, the counts and the list as the server now has
  // them, in the background. A failure leaves the screen as it is.
  function refreshAfterChange() {
    reread(STATUS)
      .then((s) => {
        status = s;
        renderStatus();
      })
      .catch(() => {});
    loadLeads({ fresh: true }).catch(() => {});
  }

  // ---- wiring ----
  function wire() {
    if (wired) return;
    wired = true;

    // Only shows or hides the settings, so a mouse does it on the way down
    // (data-press, snappy.js). The button lives in admin.html.
    $('ibSettingsBtn').dataset.press = 'fast';
    $('ibSettingsBtn').addEventListener('click', () => {
      const card = $('ibSettingsCard');
      card.style.display = card.style.display === 'none' ? 'block' : 'none';
    });
    $('ibSaveSettings').addEventListener('click', saveSettings);
    $('ibScan').addEventListener('click', scan);
    $('ibFilter').addEventListener('change', () => {
      expanded = null;
      loadLeads().catch((e) => say('ibMsg', e.message, 'err'));
    });

    $('ibTest').addEventListener('click', async () => {
      // A mail server can take a while to answer; the line saying so appears
      // only if it does (.wait), and the button is busy meanwhile.
      say('ibSettingsMsg', 'Connecting…', 'wait');
      try {
        const r = await Snappy.busy($('ibTest'), () =>
          api('/api/admin/inbox/test', {
            method: 'POST',
            body: JSON.stringify({
              user: $('ibUser').value,
              password: $('ibPass').value || undefined,
              host: $('ibHost').value,
              port: $('ibPort').value,
              folder: $('ibFolder').value,
              secure: true,
            }),
          })
        );
        say('ibSettingsMsg', `Connected — ${r.messages} messages in ${r.folder}.`, 'ok');
      } catch (e) {
        say('ibSettingsMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
      }
    });

    $('ibClearPass').addEventListener('click', async () => {
      if (!confirm('Forget the saved mail password? The agent will stop until you enter it again.'))
        return;
      try {
        status = await Snappy.busy($('ibClearPass'), () =>
          api('/api/admin/inbox/settings', {
            method: 'PATCH',
            body: JSON.stringify({ clear_password: true, enabled: false }),
          })
        );
        Snappy.cache.put(STATUS, status);
        renderSettings();
        renderStatus();
        say('ibSettingsMsg', 'Password forgotten.', 'ok');
      } catch (e) {
        say('ibSettingsMsg', e.message, 'err');
      }
    });

    // One delegated handler for every lead card.
    $('ibLeads').addEventListener('click', async (ev) => {
      const toggle = ev.target.closest('[data-toggle]');
      if (toggle) {
        const id = Number(toggle.dataset.toggle);
        const was = expanded;
        expanded = was === id ? null : id;
        if (was != null) setOpen(was, false);
        if (expanded != null) setOpen(expanded, true);
        return;
      }
      const card = ev.target.closest('.lead');
      if (!card) return;
      const id = Number(card.dataset.id);

      if (ev.target.closest('.l-del')) {
        ev.target.closest('tr').remove();
        recomputeLead(id);
        return;
      }
      if (ev.target.closest('.l-add')) {
        const body = card.querySelector('.l-items');
        // Clear the "nothing identified" placeholder row on first add.
        if (!body.querySelector('.l-desc')) body.innerHTML = '';
        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td><input class="l-desc" placeholder="Description" /></td>` +
          `<td><input class="l-qty" inputmode="decimal" /></td>` +
          `<td><input class="l-unit" /></td>` +
          `<td><input class="l-price" inputmode="decimal" /></td>` +
          `<td><button class="link-btn danger l-del" title="Remove">✕</button></td>`;
        body.appendChild(tr);
        return;
      }
      if (ev.target.closest('.l-dismiss')) {
        // A status change: gone at once, put back (with the reason on it) if
        // the server refuses.
        try {
          await Snappy.optimistic(
            () => dismissLocally(id),
            () => api(LEADS + '/' + id + '/dismiss', { method: 'POST' })
          );
        } catch (e) {
          const el = leadEl(id);
          const msg = el && el.querySelector('.l-msg');
          if (msg) {
            msg.className = 'msg err';
            msg.textContent = e.message;
          } else say('ibMsg', e.message, 'err');
          return;
        }
        refreshAfterChange();
        return;
      }
      if (ev.target.closest('.l-approve')) {
        // One click, one quote: a second click while the first is on its way
        // would create another. It makes a quote, so it waits for the
        // server — busy at once, a spinner only if the wait is noticeable.
        if (approving.has(id)) return;
        approving.add(id);
        let r;
        try {
          r = await Snappy.busy(ev.target.closest('.l-approve'), () =>
            api(LEADS + '/' + id + '/approve', {
              method: 'POST',
              body: JSON.stringify({ draft: readDraft(id) }),
            })
          );
        } catch (e) {
          approving.delete(id);
          // Looked up again: the card may have been redrawn in the meantime.
          const el = leadEl(id);
          const btn = el && el.querySelector('.l-approve');
          const msg = el && el.querySelector('.l-msg');
          if (btn) btn.disabled = false;
          if (msg) {
            msg.className = 'msg err';
            msg.textContent = e.message;
          } else say('ibMsg', e.message, 'err');
          return;
        }
        approving.delete(id);
        // The Quotes tab's kept list doesn't have the new quote yet.
        Snappy.cache.drop('/api/admin/quotes');
        // Said on the card if it is still open: it opens and closes in place,
        // so it may have been closed while the quote was being made.
        const done = `Quote ${r.quote.number} created.`;
        const open = leadEl(id);
        const msg = open && open.querySelector('.l-msg');
        if (msg) {
          msg.className = 'msg ok';
          msg.textContent = done;
        }
        expanded = null;
        let refreshed = true;
        try {
          status = await reread(STATUS);
          renderStatus();
          await loadLeads({ fresh: true });
        } catch (e) {
          refreshed = false;
          say('ibMsg', e.message, 'err');
        }
        // Closed meanwhile: said at the top instead.
        if (!msg && refreshed) say('ibMsg', done, 'ok');
        if (window.Quotes) window.Quotes.load().catch(() => {});
      }
    });

    $('ibLeads').addEventListener('input', (ev) => {
      const card = ev.target.closest('.lead');
      if (card) recomputeLead(Number(card.dataset.id));
    });
  }

  // The status and the leads are asked for together. Each paints the copy
  // kept from earlier in this visit at once, then the server's answer if it
  // differs.
  function load() {
    wire();
    let opened = false;
    let filled = false; // the settings form filled once on this visit
    const reading = Snappy.swr(api, STATUS, (s) => {
      status = s;
      renderStatus();
      // Once filled, a refresh doesn't refill the form under someone's
      // cursor: what they are in the middle of changing is newer.
      if (!(filled && typing($('ibSettingsCard')))) renderSettings();
      filled = true;
      // Open settings straight away when there's nothing configured yet.
      if (!opened && status.needs && status.needs.length && !status.has_password) {
        opened = true;
        $('ibSettingsCard').style.display = 'block';
      }
    }).catch((e) => say('ibMsg', e.message, 'err'));
    return Promise.all([reading, loadLeads()]);
  }

  // Lets the sidebar show a count without opening the tab — and keeps the
  // status it read, so opening the tab paints at once.
  async function refreshCount() {
    try {
      status = await Snappy.load(api, STATUS);
      renderStatus();
    } catch (e) {
      /* the badge is a nicety; a failure here shouldn't surface */
    }
  }

  // Signed in, and allowed this tab: before sign-in the answer would only be
  // "please sign in", and a feature switched off isn't worth asking about.
  function canOpen() {
    const app = $('app');
    const tab = document.querySelector('.side-nav .tab[data-tab="inbox"]');
    return !!app && app.style.display !== 'none' && !!tab && tab.style.display !== 'none';
  }

  // Warms what the tab opens on, for someone on their way to it — the shell
  // calls this on tab hover, focus or touch, and when the page is idle. The
  // same paths load() reads, kept in memory only.
  function prefetch() {
    if (!canOpen()) return;
    Snappy.prefetch(api, [STATUS, leadsPath()]);
  }

  window.Inbox = { load, refreshCount, prefetch };
})();
