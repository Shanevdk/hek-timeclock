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

    const count = (s.counts && s.counts.new) || 0;
    const nav = $('ibNavCount');
    if (nav) {
      nav.textContent = count;
      nav.style.display = count ? '' : 'none';
    }

    const last = s.last_scan;
    if (last) {
      const bits = [`${last.considered || 0} read`];
      if (last.leads) bits.push(`${last.leads} quote request${last.leads === 1 ? '' : 's'}`);
      if (last.not_quotes) bits.push(`${last.not_quotes} not relevant`);
      if (last.failed) bits.push(`${last.failed} failed`);
      say('ibMsg', `Last scan ${fmtWhen(last.finished_at || last.started_at)} — ${bits.join(', ')}.`);
    }
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
    say('ibSettingsMsg', 'Saving…');
    try {
      status = await api('/api/admin/inbox/settings', {
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
      });
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
        <td><input class="l-qty" inputmode="decimal" value="${it.qty || ''}" /></td>
        <td><input class="l-unit" value="${escAttr(it.unit || '')}" /></td>
        <td><input class="l-price" inputmode="decimal" value="${it.unit_price || ''}" /></td>
        <td><button class="link-btn danger l-del" title="Remove">✕</button></td>
      </tr>`
      )
      .join('');
  }

  function leadCard(lead) {
    const open = expanded === lead.id;
    const ai = lead.ai || {};
    const draft = lead.draft || {};
    const c = draft.customer || {};
    const conf = ai.confidence || 'low';
    const confBadge =
      lead.status === 'not_quote'
        ? '<span class="badge status-draft">Not a quote</span>'
        : `<span class="badge ${conf === 'high' ? 'status-approved' : conf === 'medium' ? 'status-pending' : 'status-declined'}">${esc(conf)} confidence</span>`;

    const missing = (ai.missing || [])
      .map((m) => `<li>${esc(m)}</li>`)
      .join('');

    return `<div class="lead ${open ? 'open' : ''}" data-id="${lead.id}">
      <div class="lead-head" data-toggle="${lead.id}">
        <div class="lead-head-main">
          <div class="lead-subject">${esc(lead.subject || '(no subject)')}</div>
          <div class="lead-from">${esc(lead.from_name || lead.from_email)}${
            lead.from_name ? ` &lt;${esc(lead.from_email)}&gt;` : ''
          } · ${fmtWhen(lead.received_at)}</div>
        </div>
        <div class="lead-head-side">${confBadge}</div>
      </div>
      <div class="lead-summary">${esc(ai.summary || ai.reason || '')}</div>
      ${
        open
          ? `<div class="lead-body">
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
            ${
              lead.status === 'not_quote'
                ? `<p class="status-sub qb-lead">The agent judged this isn't a quote request, so nothing was drafted. Approving it anyway will create an empty quote you can fill in.</p>`
                : ''
            }
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
                <input class="l-tax" inputmode="decimal" value="${draft.tax_rate != null ? draft.tax_rate : 13}" /></div>
              <div class="lead-total" style="margin-left:auto">Total <strong class="l-total">$0.00</strong></div>
            </div>
          </div>
        </div>
        <div class="lead-actions">
          ${
            lead.quote_id
              ? `<span class="qb-dim">Approved — quote #${lead.quote_id}.</span>`
              : `<button class="btn ghost sm l-dismiss">Dismiss</button>
                 <button class="btn gold sm l-approve">Approve → create quote</button>`
          }
          <span class="msg l-msg"></span>
        </div>
      </div>`
          : ''
      }
    </div>`;
  }

  function renderLeads() {
    $('ibEmpty').style.display = leads.length ? 'none' : 'block';
    $('ibLeads').innerHTML = leads.map(leadCard).join('');
    if (expanded != null) recomputeLead(expanded);
  }

  const leadEl = (id) => $('ibLeads').querySelector(`.lead[data-id="${id}"]`);

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

  async function loadLeads() {
    const d = await api('/api/admin/inbox/leads?status=' + encodeURIComponent($('ibFilter').value));
    leads = d.leads || [];
    $('ibListTitle').textContent =
      $('ibFilter').selectedOptions[0] ? $('ibFilter').selectedOptions[0].textContent : 'Leads';
    renderLeads();
  }

  async function scan() {
    const btn = $('ibScan');
    btn.disabled = true;
    say('ibMsg', 'Reading the mailbox…');
    try {
      const r = await api('/api/admin/inbox/scan', { method: 'POST' });
      const bits = [`${r.considered} email${r.considered === 1 ? '' : 's'} read`];
      if (r.leads) bits.push(`${r.leads} quote request${r.leads === 1 ? '' : 's'} found`);
      if (r.not_quotes) bits.push(`${r.not_quotes} not relevant`);
      if (r.failed) bits.push(`${r.failed} failed`);
      say(
        'ibMsg',
        bits.join(', ') + '.' + (r.errors && r.errors.length ? ' ' + r.errors[0].message : ''),
        r.ok ? 'ok' : 'err'
      );
      status = await api('/api/admin/inbox/status');
      renderStatus();
      await loadLeads();
    } catch (e) {
      say('ibMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ---- wiring ----
  function wire() {
    if (wired) return;
    wired = true;

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
      say('ibSettingsMsg', 'Connecting…');
      try {
        const r = await api('/api/admin/inbox/test', {
          method: 'POST',
          body: JSON.stringify({
            user: $('ibUser').value,
            password: $('ibPass').value || undefined,
            host: $('ibHost').value,
            port: $('ibPort').value,
            folder: $('ibFolder').value,
            secure: true,
          }),
        });
        say('ibSettingsMsg', `Connected — ${r.messages} messages in ${r.folder}.`, 'ok');
      } catch (e) {
        say('ibSettingsMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
      }
    });

    $('ibClearPass').addEventListener('click', async () => {
      if (!confirm('Forget the saved mail password? The agent will stop until you enter it again.'))
        return;
      try {
        status = await api('/api/admin/inbox/settings', {
          method: 'PATCH',
          body: JSON.stringify({ clear_password: true, enabled: false }),
        });
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
        expanded = expanded === id ? null : id;
        renderLeads();
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
        try {
          await api('/api/admin/inbox/leads/' + id + '/dismiss', { method: 'POST' });
          expanded = null;
          status = await api('/api/admin/inbox/status');
          renderStatus();
          await loadLeads();
        } catch (e) {
          card.querySelector('.l-msg').className = 'msg err';
          card.querySelector('.l-msg').textContent = e.message;
        }
      }
      if (ev.target.closest('.l-approve')) {
        const msg = card.querySelector('.l-msg');
        try {
          const r = await api('/api/admin/inbox/leads/' + id + '/approve', {
            method: 'POST',
            body: JSON.stringify({ draft: readDraft(id) }),
          });
          msg.className = 'msg ok';
          msg.textContent = `Quote ${r.quote.number} created.`;
          expanded = null;
          status = await api('/api/admin/inbox/status');
          renderStatus();
          await loadLeads();
          if (window.Quotes) window.Quotes.load().catch(() => {});
        } catch (e) {
          msg.className = 'msg err';
          msg.textContent = e.message;
        }
      }
    });

    $('ibLeads').addEventListener('input', (ev) => {
      const card = ev.target.closest('.lead');
      if (card) recomputeLead(Number(card.dataset.id));
    });
  }

  async function load() {
    wire();
    try {
      status = await api('/api/admin/inbox/status');
    } catch (e) {
      say('ibMsg', e.message, 'err');
      return;
    }
    renderStatus();
    renderSettings();
    // Open settings straight away when there's nothing configured yet.
    if (status.needs && status.needs.length && !status.has_password)
      $('ibSettingsCard').style.display = 'block';
    await loadLeads();
  }

  // Lets the sidebar show a count without opening the tab.
  async function refreshCount() {
    try {
      status = await api('/api/admin/inbox/status');
      renderStatus();
    } catch (e) {
      /* the badge is a nicety; a failure here shouldn't surface */
    }
  }

  window.Inbox = { load, refreshCount };
})();
