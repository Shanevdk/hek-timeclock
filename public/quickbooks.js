// "QuickBooks" — the admin side of the payroll sync.
//
// Five cards, top to bottom in the order you'd set them up: the connection,
// the pay schedule, who-is-who matching, the pay period itself (what would be
// pushed, then the push), and a history of pushes.
//
// Nothing here pays anybody. QuickBooks has no public way for an app to run a
// payroll or move money, so this gets the hours in and a person still clicks
// "Run payroll" there. The wording in the UI says so plainly on purpose.
//
// Relies on window.HEKAdmin ({ api, esc }) from admin.js, loaded first.
(function () {
  const H = () => window.HEKAdmin || {};
  const api = (...a) => H().api(...a);
  const esc = (s) => (H().esc ? H().esc(s) : String(s));
  const $ = (id) => document.getElementById(id);

  const DAY_MS = 86400000;
  let status = null; // last /status response
  let period = null; // { start, end } currently shown
  let preview = null; // last /preview response
  let qboEmployees = null; // QuickBooks' employee list, fetched on demand
  let ourEmployees = []; // ours, for the matching table
  let wired = false;
  let banner = null; // message carried over from the OAuth redirect

  // ---- helpers ----
  const n2 = (v) => (Number(v) || 0).toFixed(2);
  const addDays = (day, n) => {
    const [y, m, d] = String(day).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
  };
  const prettyDay = (day) => {
    if (!day) return '—';
    const [y, m, d] = String(day).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };
  const prettyWhen = (iso) =>
    iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

  function say(id, text, kind) {
    const el = $(id);
    if (!el) return;
    el.className = 'msg' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  // Cards past the connection are pointless until there is a connection.
  function setCardsEnabled(on) {
    ['qbSettingsCard', 'qbMapCard', 'qbPeriodCard', 'qbRunsCard'].forEach((id) => {
      const el = $(id);
      if (el) el.classList.toggle('qb-disabled', !on);
    });
  }

  // ---- connection ----
  function renderConnection() {
    const s = status || {};
    const badge = $('qbEnvBadge');
    if (badge) {
      badge.style.display = s.configured ? '' : 'none';
      badge.textContent = s.production ? 'Live company' : 'Sandbox';
      badge.className = 'badge ' + (s.production ? 'on' : 'edited');
    }

    if (!s.configured) {
      $('qbConn').innerHTML =
        '<p class="qb-state off">No Intuit app keys yet.</p>' +
        '<p class="status-sub qb-lead">Create an app at <strong>developer.intuit.com</strong>, ' +
        'then put its Client ID and Client Secret in the <strong>Intuit app</strong> box below. ' +
        'Once they are saved, a Connect button appears here.</p>';
    } else if (!s.connected) {
      $('qbConn').innerHTML =
        '<p class="qb-state off">Not connected to a QuickBooks company.</p>' +
        '<button class="btn gold sm" id="qbConnect">Connect QuickBooks</button>';
    } else {
      const expires = s.refresh_expires_at ? new Date(s.refresh_expires_at) : null;
      // Intuit expires the connection roughly every 100 days even when it is in
      // constant use, so this is worth showing before payroll day finds out.
      const soon = expires && expires - Date.now() < 14 * 24 * DAY_MS;
      $('qbConn').innerHTML =
        `<p class="qb-state on">Connected to <strong>${esc(s.company || 'QuickBooks company ' + s.realm_id)}</strong></p>` +
        `<p class="status-sub qb-lead">Connected ${prettyWhen(s.connected_at)}` +
        (s.connected_by ? ` by ${esc(s.connected_by)}` : '') +
        (expires
          ? ` · access ${soon ? '<strong>expires</strong>' : 'expires'} ${prettyDay(expires.toISOString().slice(0, 10))}`
          : '') +
        '</p>' +
        '<button class="btn ghost sm" id="qbDisconnect">Disconnect</button>';
    }

    const needs = $('qbNeeds');
    const list = (s.needs || []).slice();
    if (s.connected && s.mapping && s.mapping.matched < s.mapping.total)
      list.push(
        `Match the remaining ${s.mapping.total - s.mapping.matched} of ${s.mapping.total} hourly employees to QuickBooks.`
      );
    if (list.length) {
      needs.style.display = '';
      needs.innerHTML =
        '<div class="qb-need-title">Before hours can be pushed</div><ul>' +
        list.map((t) => `<li>${esc(t)}</li>`).join('') +
        '</ul>';
    } else {
      needs.style.display = 'none';
      needs.innerHTML = '';
    }

    setCardsEnabled(!!s.connected);

    const c = $('qbConnect');
    if (c)
      c.addEventListener('click', () => {
        // A full page navigation, not a fetch: Intuit's consent screen has to be
        // shown to the person clicking, and it sends the browser back here.
        window.location.href = '/api/admin/quickbooks/connect';
      });
    const d = $('qbDisconnect');
    if (d)
      d.addEventListener('click', async () => {
        if (
          !confirm(
            'Disconnect QuickBooks?\n\nHours already pushed stay in QuickBooks, but this app ' +
              'will forget which entries it created — reconnecting and syncing the same period ' +
              'again would add a second copy of those hours.'
          )
        )
          return;
        try {
          status = await api('/api/admin/quickbooks/disconnect', { method: 'POST' });
          qboEmployees = null;
          renderConnection();
          renderSettings();
          say('qbConnMsg', 'Disconnected.', 'ok');
        } catch (e) {
          say('qbConnMsg', e.message, 'err');
        }
      });
  }

  // ---- Intuit app keys ----
  function renderCredentials() {
    const c = (status && status.credentials) || {};
    $('qbClientId').value = c.client_id || '';
    $('qbClientSecret').value = '';
    $('qbClientSecret').placeholder = c.has_secret
      ? 'saved — leave blank to keep'
      : 'paste the Client Secret';
    $('qbEnvironment').value = c.production ? 'production' : 'sandbox';
    $('qbRedirectUri').value = c.redirect_uri || '';

    // Say plainly where each value is coming from. Without this, someone with
    // env vars set edits a box, saves, and can't tell whether it took effect.
    const src = c.source || {};
    const fromEnv = Object.keys(src).filter((k) => src[k] === 'env');
    const badge = $('qbCredsSource');
    if (fromEnv.length) {
      badge.style.display = '';
      badge.className = 'badge edited';
      badge.textContent =
        fromEnv.length === Object.keys(src).length
          ? 'from environment variables'
          : 'partly from environment variables';
    } else {
      badge.style.display = 'none';
    }

    const hint = [];
    if (c.suggested_redirect_uri)
      hint.push(
        `This must match a Redirect URI on the Intuit app <em>exactly</em>. For this deployment that is <code>${esc(c.suggested_redirect_uri)}</code>.`
      );
    if (!c.redirect_uri && c.suggested_redirect_uri)
      hint.push('Left blank, that URL is used automatically.');
    if (c.secret_unreadable)
      hint.push(
        '<strong>The saved secret can no longer be decrypted</strong> — SESSION_SECRET changed. Paste the Client Secret again.'
      );
    if (!c.can_store)
      hint.push(
        '<strong>SESSION_SECRET is still the placeholder</strong>, so a secret cannot be stored safely yet. Set it to a long random value first.'
      );
    if (c.updated_at) hint.push(`Last changed ${prettyWhen(c.updated_at)}.`);
    $('qbRedirectHint').innerHTML = hint.join(' ');

    $('qbClearSecret').style.display = c.has_secret && src.client_secret === 'settings' ? '' : 'none';
  }

  async function saveCredentials() {
    say('qbCredsMsg', 'Saving…');
    try {
      const wasConnected = status && status.connected;
      status = await api('/api/admin/quickbooks/credentials', {
        method: 'PATCH',
        body: JSON.stringify({
          client_id: $('qbClientId').value,
          client_secret: $('qbClientSecret').value || undefined,
          redirect_uri: $('qbRedirectUri').value,
          production: $('qbEnvironment').value === 'production',
        }),
      });
      renderCredentials();
      renderConnection();
      say(
        'qbCredsMsg',
        status.disconnected
          ? 'Saved. The keys changed, so the old QuickBooks connection was dropped — reconnect above.'
          : wasConnected
            ? 'Saved.'
            : 'Saved. Now click Connect QuickBooks above.',
        'ok'
      );
    } catch (e) {
      say('qbCredsMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
    }
  }

  // ---- pay schedule ----
  function renderSettings() {
    const s = (status && status.settings) || {};
    $('qbAnchor').value = s.period_anchor || '';
    $('qbLength').value = String(s.period_days || 14);
    $('qbOtWeekly').value = s.ot_weekly ? String(s.ot_weekly) : '0';
    $('qbOtDaily').value = s.ot_daily ? String(s.ot_daily) : '0';
    $('qbRegItem').value = s.regular_item_id || '';
    $('qbOtItem').value = s.overtime_item_id || '';
    $('qbAuto').checked = s.auto_sync !== false;
  }

  async function saveSettings() {
    say('qbSettingsMsg', 'Saving…');
    try {
      status = await api('/api/admin/quickbooks/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          period_anchor: $('qbAnchor').value,
          period_days: $('qbLength').value,
          ot_weekly: $('qbOtWeekly').value || 0,
          ot_daily: $('qbOtDaily').value || 0,
          regular_item_id: $('qbRegItem').value,
          overtime_item_id: $('qbOtItem').value,
          auto_sync: $('qbAuto').checked,
        }),
      });
      renderSettings();
      renderConnection();
      say('qbSettingsMsg', 'Saved.', 'ok');
      period = null; // the period grid moved — re-derive it
      await loadPeriod();
    } catch (e) {
      say('qbSettingsMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
    }
  }

  // ---- invoicing ----
  // QuickBooks requires a product/service on every sales line, so these two
  // pickers are what let an invoice be pushed at all.
  let qboItems = null;
  let qboTaxCodes = null;

  async function loadInvoiceOptions({ force } = {}) {
    if (!status || !status.connected) return;
    if (!force && qboItems && qboTaxCodes) return renderInvoiceSettings();
    say('qbInvoiceMsg', 'Loading from QuickBooks…');
    try {
      const [i, t] = await Promise.all([
        api('/api/admin/quickbooks/items'),
        api('/api/admin/quickbooks/taxcodes'),
      ]);
      qboItems = i.items || [];
      qboTaxCodes = t.taxcodes || [];
      renderInvoiceSettings();
      say('qbInvoiceMsg', qboItems.length ? '' : 'QuickBooks has no products or services set up yet.');
    } catch (e) {
      say('qbInvoiceMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
    }
  }

  function renderInvoiceSettings() {
    const s = (status && status.settings) || {};
    const opt = (list, sel, blank) =>
      `<option value="">${blank}</option>` +
      list
        .map((x) => `<option value="${esc(x.id)}"${x.id === String(sel || '') ? ' selected' : ''}>${esc(x.name)}</option>`)
        .join('');
    if (qboItems) $('qbInvItem').innerHTML = opt(qboItems, s.invoice_item_id, '— choose a product/service —');
    if (qboTaxCodes) $('qbInvTax').innerHTML = opt(qboTaxCodes, s.invoice_tax_code_id, '— none —');
  }

  async function saveInvoiceSettings() {
    say('qbInvoiceMsg', 'Saving…');
    try {
      status = await api('/api/admin/quickbooks/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          invoice_item_id: $('qbInvItem').value,
          invoice_tax_code_id: $('qbInvTax').value,
        }),
      });
      renderInvoiceSettings();
      say('qbInvoiceMsg', 'Saved. Invoices can now be sent from the Invoices tab.', 'ok');
    } catch (e) {
      say('qbInvoiceMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
    }
  }

  // ---- who is who ----
  async function loadMapping({ force } = {}) {
    if (!status || !status.connected) return;
    say('qbMapMsg', '');
    const jobs = [api('/api/admin/employees')];
    if (force || !qboEmployees) jobs.push(api('/api/admin/quickbooks/qbo-employees'));
    try {
      const [emps, qbo] = await Promise.all(jobs);
      ourEmployees = (emps || []).filter((e) => e.active && e.pay_type !== 'Salary');
      if (qbo) qboEmployees = qbo.employees || [];
      renderMapping();
    } catch (e) {
      say('qbMapMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
    }
  }

  function renderMapping() {
    const body = $('qbMapBody');
    $('qbMapEmpty').style.display = ourEmployees.length ? 'none' : 'block';
    const options = (selected) =>
      ['<option value="">— not matched —</option>']
        .concat(
          (qboEmployees || []).map(
            (q) =>
              `<option value="${esc(q.id)}"${String(selected) === q.id ? ' selected' : ''}>` +
              `${esc(q.name)}${q.active ? '' : ' (inactive)'}</option>`
          )
        )
        .join('');
    body.innerHTML = ourEmployees
      .map((e) => {
        const pay = e.pay_type ? `${esc(e.pay_type)}${e.pay_rate ? ' · $' + esc(e.pay_rate) : ''}` : '—';
        return `<tr>
          <td>${esc(e.name)}</td>
          <td class="qb-dim">${pay}</td>
          <td><select class="qb-map-select" data-emp="${e.id}">${options(e.qbo_employee_id)}</select></td>
        </tr>`;
      })
      .join('');
  }

  // `quiet` skips the follow-up refresh so a bulk match doesn't fire a status
  // and preview request per person; the caller refreshes once at the end.
  async function setMapping(employeeId, qboId, { quiet } = {}) {
    if (!quiet) say('qbMapMsg', 'Saving…');
    try {
      await api('/api/admin/quickbooks/mapping', {
        method: 'PATCH',
        body: JSON.stringify({ employee_id: employeeId, qbo_employee_id: qboId }),
      });
      const emp = ourEmployees.find((e) => e.id === employeeId);
      if (emp) emp.qbo_employee_id = qboId || '';
      if (!quiet) {
        say('qbMapMsg', 'Saved.', 'ok');
        await refreshAfterMapping();
      }
      return true;
    } catch (e) {
      say('qbMapMsg', e.message, 'err');
      renderMapping(); // put the dropdown back to what is actually stored
      return false;
    }
  }

  // Matching changes who the period can be pushed for, so both the "before you
  // can push" list and the preview need to catch up.
  async function refreshAfterMapping() {
    status = await api('/api/admin/quickbooks/status');
    renderConnection();
    await loadPeriod(period ? { start: period.start } : undefined);
  }

  // Fill in the people whose names match exactly. Anything ambiguous is left
  // alone — a wrong match here pays the wrong person.
  async function autoMatch() {
    if (!qboEmployees) await loadMapping({ force: true });
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const byName = new Map();
    for (const q of qboEmployees || []) {
      const k = norm(q.name);
      byName.set(k, byName.has(k) ? null : q); // a duplicate name is not a match
    }
    const taken = new Set(ourEmployees.map((e) => e.qbo_employee_id).filter(Boolean));
    let matched = 0;
    let skipped = 0;
    for (const e of ourEmployees) {
      if (e.qbo_employee_id) continue;
      const hit = byName.get(norm(e.name));
      if (!hit || taken.has(hit.id)) {
        skipped++;
        continue;
      }
      if (await setMapping(e.id, hit.id, { quiet: true })) {
        taken.add(hit.id);
        matched++;
      }
    }
    renderMapping();
    if (matched) await refreshAfterMapping();
    say(
      'qbMapMsg',
      matched
        ? `Matched ${matched} by name.${skipped ? ` ${skipped} still need doing by hand.` : ''}`
        : 'No exact name matches left — pick the rest by hand.',
      matched ? 'ok' : ''
    );
  }

  // ---- the pay period ----
  async function loadPeriod(opts) {
    if (!status || !status.connected) return;
    if (!status.settings || !status.settings.period_anchor) {
      $('qbRange').textContent = 'Set the pay schedule first';
      return;
    }
    say('qbSyncMsg', '');
    const query = opts && opts.start ? '?start=' + encodeURIComponent(opts.start) : '';
    try {
      preview = await api('/api/admin/quickbooks/preview' + query);
      period = preview.period;
      renderPreview();
    } catch (e) {
      $('qbRange').textContent = '';
      say('qbSyncMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
    }
  }

  function renderPreview() {
    const p = preview || {};
    const t = p.totals || {};
    $('qbRange').textContent = period ? `${prettyDay(period.start)} – ${prettyDay(period.end)}` : '';
    $('qbStatHours').textContent = n2(t.hours);
    $('qbStatReg').textContent = n2(t.regular);
    $('qbStatOt').textContent = n2(t.overtime);
    $('qbStatPeople').textContent = t.employees || 0;

    const warn = $('qbWarnings');
    const list = p.warnings || [];
    warn.innerHTML = list.length
      ? '<ul class="qb-warn-list">' + list.map((w) => `<li>${esc(w.message)}</li>`).join('') + '</ul>'
      : '';

    const rows = p.employees || [];
    $('qbPreviewEmpty').style.display = rows.length ? 'none' : 'block';
    $('qbPreviewBody').innerHTML = rows
      .map((r) => {
        const match = r.qbo_employee_id
          ? '<span class="badge on">matched</span>'
          : '<span class="badge status-declined">not matched</span>';
        return `<tr>
          <td>${esc(r.name)}</td>
          <td class="qb-dim">${r.days.length}</td>
          <td>${n2(r.regular)}</td>
          <td>${r.overtime > 0 ? '<strong>' + n2(r.overtime) + '</strong>' : n2(r.overtime)}</td>
          <td>${n2(r.total)}</td>
          <td>${match}</td>
        </tr>`;
      })
      .join('');

    const pushable = rows.filter((r) => r.qbo_employee_id).length;
    const btn = $('qbSync');
    btn.disabled = pushable === 0;
    btn.textContent = pushable
      ? `Push ${pushable} employee${pushable === 1 ? '' : 's'} to QuickBooks`
      : 'Nothing to push';
    if (p.already_pushed)
      say('qbSyncMsg', `${p.already_pushed} entries from this period are already in QuickBooks — pushing again updates them in place.`);
  }

  async function sync() {
    const rows = (preview && preview.employees) || [];
    const pushable = rows.filter((r) => r.qbo_employee_id);
    if (!pushable.length) return;
    const t = preview.totals || {};
    if (
      !confirm(
        `Push ${prettyDay(period.start)} – ${prettyDay(period.end)} to QuickBooks?\n\n` +
          `${pushable.length} employees · ${n2(t.hours)} hours (${n2(t.regular)} regular, ${n2(t.overtime)} overtime)\n\n` +
          'This writes the hours into QuickBooks. It does not pay anyone — you still run ' +
          'payroll there.'
      )
    )
      return;
    const btn = $('qbSync');
    btn.disabled = true;
    say('qbSyncMsg', 'Pushing…');
    try {
      const r = await api('/api/admin/quickbooks/sync', {
        method: 'POST',
        body: JSON.stringify({ start: period.start }),
      });
      const bits = [];
      if (r.created) bits.push(`${r.created} added`);
      if (r.updated) bits.push(`${r.updated} updated`);
      if (r.deleted) bits.push(`${r.deleted} removed`);
      if (r.unchanged) bits.push(`${r.unchanged} unchanged`);
      if (r.failed) bits.push(`${r.failed} failed`);
      const summary = bits.length ? bits.join(', ') + '.' : 'Nothing to do.';
      say(
        'qbSyncMsg',
        r.ok
          ? `${summary} Open QuickBooks and run payroll when you're ready.`
          : `${summary} ${(r.errors || []).map((e) => e.message).join(' ')}`,
        r.ok ? 'ok' : 'err'
      );
      await loadPeriod({ start: period.start });
      await loadRuns();
    } catch (e) {
      say('qbSyncMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ---- history ----
  async function loadRuns() {
    if (!status || !status.connected) return;
    try {
      const d = await api('/api/admin/quickbooks/runs');
      const runs = d.runs || [];
      $('qbRunsEmpty').style.display = runs.length ? 'none' : 'block';
      $('qbRunsBody').innerHTML = runs
        .map((r) => {
          const bits = [];
          if (r.created) bits.push(`${r.created} added`);
          if (r.updated) bits.push(`${r.updated} updated`);
          if (r.deleted) bits.push(`${r.deleted} removed`);
          if (r.unchanged) bits.push(`${r.unchanged} unchanged`);
          if (r.failed) bits.push(`${r.failed} failed`);
          const badge = r.ok
            ? '<span class="badge on">ok</span>'
            : '<span class="badge status-declined">problem</span>';
          return `<tr>
            <td>${prettyDay(r.start)} – ${prettyDay(r.end)}</td>
            <td class="qb-dim">${prettyWhen(r.finished_at || r.started_at)}</td>
            <td class="qb-dim">${esc(r.trigger === 'cron' ? 'scheduled' : r.actor || 'admin')}</td>
            <td>${badge} <span class="qb-dim">${esc(bits.join(', ') || 'nothing to do')}</span></td>
          </tr>`;
        })
        .join('');
    } catch (e) {
      /* history is nice to have; a failure here shouldn't block the page */
    }
  }

  // ---- wiring ----
  function wire() {
    if (wired) return;
    wired = true;

    $('qbSaveSettings').addEventListener('click', saveSettings);
    $('qbSaveInvoice').addEventListener('click', saveInvoiceSettings);
    $('qbInvRefresh').addEventListener('click', () => loadInvoiceOptions({ force: true }));
    $('qbSaveCreds').addEventListener('click', saveCredentials);
    $('qbUseSuggested').addEventListener('click', () => {
      const c = (status && status.credentials) || {};
      if (c.suggested_redirect_uri) $('qbRedirectUri').value = c.suggested_redirect_uri;
    });
    $('qbClearSecret').addEventListener('click', async () => {
      if (
        !confirm(
          'Forget the saved Client Secret?\n\nThe sync will stop working until you enter it again.'
        )
      )
        return;
      try {
        status = await api('/api/admin/quickbooks/credentials', {
          method: 'PATCH',
          body: JSON.stringify({ clear_client_secret: true }),
        });
        renderCredentials();
        renderConnection();
        say('qbCredsMsg', 'Secret forgotten.', 'ok');
      } catch (e) {
        say('qbCredsMsg', e.message, 'err');
      }
    });
    $('qbMapRefresh').addEventListener('click', () => loadMapping({ force: true }));
    $('qbMapAuto').addEventListener('click', () => autoMatch().catch((e) => say('qbMapMsg', e.message, 'err')));
    $('qbMapBody').addEventListener('change', (ev) => {
      const sel = ev.target.closest('select[data-emp]');
      if (sel) setMapping(Number(sel.dataset.emp), sel.value);
    });

    const len = () => (status && status.settings && status.settings.period_days) || 14;
    $('qbPrev').addEventListener('click', () => period && loadPeriod({ start: addDays(period.start, -len()) }));
    $('qbNext').addEventListener('click', () => period && loadPeriod({ start: addDays(period.start, len()) }));
    $('qbJump').addEventListener('change', () => {
      if ($('qbJump').value) loadPeriod({ start: $('qbJump').value });
    });
    $('qbReload').addEventListener('click', () => period && loadPeriod({ start: period.start }));
    $('qbSync').addEventListener('click', () => sync());
  }

  async function load() {
    wire();
    try {
      status = await api('/api/admin/quickbooks/status');
    } catch (e) {
      say('qbConnMsg', e.message, 'err');
      return;
    }
    renderConnection();
    renderCredentials();
    renderSettings();
    if (banner) {
      say('qbConnMsg', banner.text, banner.kind);
      banner = null;
    }
    if (status.connected) {
      await loadMapping();
      await loadInvoiceOptions();
      await loadPeriod();
      await loadRuns();
    }
  }

  // Coming back from Intuit's consent screen: the callback redirects here with
  // the outcome in the URL. Open the tab on it and tidy the address bar so a
  // refresh doesn't show a stale result.
  function afterLogin() {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('quickbooks');
    if (!outcome) return;
    banner =
      outcome === 'connected'
        ? { text: 'QuickBooks connected.', kind: 'ok' }
        : { text: params.get('message') || 'QuickBooks could not be connected.', kind: 'err' };
    window.history.replaceState({}, '', window.location.pathname);
    const tab = document.querySelector('.side-nav .tab[data-tab="quickbooks"]');
    if (tab && tab.style.display !== 'none') tab.click();
  }

  window.QuickBooks = { load, afterLogin };
})();
