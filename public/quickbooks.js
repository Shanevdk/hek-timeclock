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
  let periodAsked = 0; // numbers each pay-period read, so only the latest paints

  // The two reads here that never leave this server: the connection status and
  // the push history. Everything else under /api/admin/quickbooks that reads
  // (items, tax codes, QuickBooks' employees) asks Intuit, so nothing ever
  // fetches those ahead of time. Kept in memory only — the status carries the
  // Intuit app's settings.
  const STATUS = '/api/admin/quickbooks/status';
  const RUNS = '/api/admin/quickbooks/runs';

  // Whether someone is typing in a field inside `box` right now. A refresh
  // landing mid-entry must not put the server's older values back.
  const typing = (box) => {
    const a = document.activeElement;
    return !!box && !!a && box.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  };

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
      const soon = expires && expires - Date.now() < 14 * DAY_MS;
      $('qbConn').innerHTML =
        `<p class="qb-state on">Connected to <strong>${esc(s.company || 'QuickBooks company ' + s.realm_id)}</strong></p>` +
        `<p class="status-sub qb-lead">Connected ${prettyWhen(s.connected_at)}` +
        (s.connected_by ? ` by ${esc(s.connected_by)}` : '') +
        (expires
          ? ` · access ${soon ? '<strong>expires</strong>' : 'expires'} ${prettyDay(expires.toISOString().slice(0, 10))}`
          : '') +
        '</p>' +
        // Reconnect renews the sign-in in place (an expired or revoked one, or
        // after the app keys changed) and keeps the record of what was pushed —
        // unlike Disconnect, which is for leaving QuickBooks altogether.
        '<button class="btn ghost sm" id="qbConnect">Reconnect</button> ' +
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
        // Busy from the press until the browser has left, so a second click
        // can't start a second sign-in; a spinner if the hand-off is slow. If
        // the page is somehow still here a while later, the button comes back.
        Snappy.busy(c, () => new Promise((resolve) => setTimeout(resolve, 10000)));
        // A full page navigation, not a fetch: Intuit's consent screen has to be
        // shown to the person clicking, and it sends the browser back here.
        window.location.href = '/api/admin/quickbooks/connect';
      });
    const d = $('qbDisconnect');
    if (d)
      d.addEventListener('click', async () => {
        if (
          !confirm(
            'Disconnect QuickBooks?\n\nHours and invoices already pushed stay in QuickBooks. ' +
              'If the sign-in has expired, use Reconnect instead.'
          )
        )
          return;
        try {
          // Waits for QuickBooks to let go: busy at once, spinner if slow.
          status = await Snappy.busy(d, () => api('/api/admin/quickbooks/disconnect', { method: 'POST' }));
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

  // The saves below say nothing the moment they start: the button goes busy
  // at once (no second press), and shows a spinner only if the wait is
  // noticeable.
  async function saveCredentials() {
    say('qbCredsMsg', '');
    try {
      const wasConnected = status && status.connected;
      status = await Snappy.busy($('qbSaveCreds'), () =>
        api('/api/admin/quickbooks/credentials', {
          method: 'PATCH',
          body: JSON.stringify({
            client_id: $('qbClientId').value,
            client_secret: $('qbClientSecret').value || undefined,
            redirect_uri: $('qbRedirectUri').value,
            production: $('qbEnvironment').value === 'production',
          }),
        })
      );
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
    say('qbSettingsMsg', '');
    try {
      status = await Snappy.busy($('qbSaveSettings'), () =>
        api('/api/admin/quickbooks/settings', {
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
        })
      );
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
    // Intuit can be slow; the line saying so appears only if it is (.wait).
    say('qbInvoiceMsg', 'Loading from QuickBooks…', 'wait');
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
    say('qbInvoiceMsg', '');
    try {
      status = await Snappy.busy($('qbSaveInvoice'), () =>
        api('/api/admin/quickbooks/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            invoice_item_id: $('qbInvItem').value,
            invoice_tax_code_id: $('qbInvTax').value,
          }),
        })
      );
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
  // `el`, the dropdown that was changed, is held still until the server has
  // the match: who is matched to whom decides whose pay the hours go to, so
  // it is never shown as saved before it is.
  async function setMapping(employeeId, qboId, { quiet, el } = {}) {
    // A select can't show a spinner, so the line says it — only once the wait
    // is long enough to notice (.wait).
    if (!quiet) say('qbMapMsg', 'Saving…', 'wait');
    try {
      await Snappy.busy(el, () =>
        api('/api/admin/quickbooks/mapping', {
          method: 'PATCH',
          body: JSON.stringify({ employee_id: employeeId, qbo_employee_id: qboId }),
        })
      );
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
    status = await api(STATUS);
    Snappy.cache.put(STATUS, status);
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
    // Earlier, Earlier, Later in quick succession: only the last period asked
    // for is painted, whatever order the answers come back in. Always asked
    // afresh, never from a kept copy — these are the numbers a push confirms.
    const n = ++periodAsked;
    try {
      const p = await api('/api/admin/quickbooks/preview' + query);
      if (n !== periodAsked) return;
      preview = p;
      period = preview.period;
      renderPreview();
    } catch (e) {
      if (n !== periodAsked) return;
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
    const start = period.start;
    // Hours into the company's books: nothing is shown as pushed before
    // QuickBooks says so. Busy from the press, so there's no second push; the
    // spinner and the line below appear only once the wait is noticeable.
    say('qbSyncMsg', 'Pushing…', 'wait');
    try {
      await Snappy.busy($('qbSync'), async () => {
        const r = await api('/api/admin/quickbooks/sync', {
          method: 'POST',
          body: JSON.stringify({ start }),
        });
        const bits = [];
        if (r.created) bits.push(`${r.created} added`);
        if (r.updated) bits.push(`${r.updated} updated`);
        if (r.deleted) bits.push(`${r.deleted} removed`);
        if (r.unchanged) bits.push(`${r.unchanged} unchanged`);
        if (r.adopted) bits.push(`${r.adopted} found already in QuickBooks`);
        if (r.kept) bits.push(`${r.kept} left as they were`);
        if (r.failed) bits.push(`${r.failed} failed`);
        const summary = bits.length ? bits.join(', ') + '.' : 'Nothing to do.';
        // The period and the history first, then the outcome: reloading the
        // period clears this line, and the outcome is the part to read.
        await loadPeriod({ start });
        await loadRuns({ fresh: true });
        say(
          'qbSyncMsg',
          r.ok
            ? `${summary} Open QuickBooks and run payroll when you're ready.`
            : `${summary} ${(r.errors || []).map((e) => e.message).join(' ')}`,
          r.ok ? 'ok' : 'err'
        );
      });
    } catch (e) {
      say('qbSyncMsg', e.detail ? `${e.message} ${e.detail}` : e.message, 'err');
    }
  }

  // ---- history ----
  // The copy kept from earlier in this visit at once, then the server's answer
  // if it differs. `fresh` skips the kept copy, for straight after a push.
  async function loadRuns({ fresh } = {}) {
    if (!status || !status.connected) return;
    try {
      if (fresh) {
        const d = await api(RUNS);
        Snappy.cache.put(RUNS, d);
        renderRuns(d.runs || []);
      } else {
        await Snappy.swr(api, RUNS, (d) => renderRuns(d.runs || []));
      }
    } catch (e) {
      /* history is nice to have; a failure here shouldn't block the page */
    }
  }

  function renderRuns(runs) {
    $('qbRunsEmpty').style.display = runs.length ? 'none' : 'block';
    $('qbRunsBody').innerHTML = runs
      .map((r) => {
        const bits = [];
        if (r.created) bits.push(`${r.created} added`);
        if (r.updated) bits.push(`${r.updated} updated`);
        if (r.deleted) bits.push(`${r.deleted} removed`);
        if (r.unchanged) bits.push(`${r.unchanged} unchanged`);
        if (r.adopted) bits.push(`${r.adopted} found already there`);
        if (r.kept) bits.push(`${r.kept} left as they were`);
        if (r.failed) bits.push(`${r.failed} failed`);
        // A run that never got going (the sign-in expired, say) says why; one
        // that stopped part-way says so.
        if (r.error) bits.push(r.error);
        if (r.incomplete) bits.push('stopped part-way — sync again to finish');
        const badge = r.ok
          ? '<span class="badge on">ok</span>'
          : r.incomplete
            ? '<span class="badge status-pending">unfinished</span>'
            : '<span class="badge status-declined">problem</span>';
        return `<tr>
          <td>${prettyDay(r.start)} – ${prettyDay(r.end)}</td>
          <td class="qb-dim">${prettyWhen(r.finished_at || r.started_at)}</td>
          <td class="qb-dim">${esc(r.trigger === 'cron' ? 'scheduled' : r.actor || 'admin')}</td>
          <td>${badge} <span class="qb-dim">${esc(bits.join(', ') || 'nothing to do')}</span></td>
        </tr>`;
      })
      .join('');
  }

  // ---- wiring ----
  function wire() {
    if (wired) return;
    wired = true;

    $('qbSaveSettings').addEventListener('click', saveSettings);
    $('qbSaveInvoice').addEventListener('click', saveInvoiceSettings);
    // Asks Intuit, which can be slow: busy at once, so it isn't asked twice.
    $('qbInvRefresh').addEventListener('click', () =>
      Snappy.busy($('qbInvRefresh'), () => loadInvoiceOptions({ force: true }))
    );
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
        status = await Snappy.busy($('qbClearSecret'), () =>
          api('/api/admin/quickbooks/credentials', {
            method: 'PATCH',
            body: JSON.stringify({ clear_client_secret: true }),
          })
        );
        renderCredentials();
        renderConnection();
        say('qbCredsMsg', 'Secret forgotten.', 'ok');
      } catch (e) {
        say('qbCredsMsg', e.message, 'err');
      }
    });
    // Both ask Intuit and can take a while: busy at once, so neither runs twice.
    $('qbMapRefresh').addEventListener('click', () =>
      Snappy.busy($('qbMapRefresh'), () => loadMapping({ force: true }))
    );
    $('qbMapAuto').addEventListener('click', () =>
      Snappy.busy($('qbMapAuto'), autoMatch).catch((e) => say('qbMapMsg', e.message, 'err'))
    );
    $('qbMapBody').addEventListener('change', (ev) => {
      const sel = ev.target.closest('select[data-emp]');
      if (sel) setMapping(Number(sel.dataset.emp), sel.value, { el: sel });
    });

    // Moving between pay periods only shows one, so a mouse does it on the
    // way down (data-press, snappy.js). The buttons live in admin.html.
    ['qbPrev', 'qbNext', 'qbReload'].forEach((id) => {
      $(id).dataset.press = 'fast';
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

  // The connection paints at once from the status kept earlier in this visit,
  // then from the server's answer if that differs; the rest of the tab
  // follows the server's answer.
  async function load() {
    wire();
    let filled = false;
    try {
      await Snappy.swr(api, STATUS, (s) => {
        status = s;
        renderConnection();
        // Once the forms have been filled, a refresh doesn't refill one
        // someone is typing in: their entry is newer than the server's.
        if (!(filled && typing($('tab-quickbooks')))) {
          renderCredentials();
          renderSettings();
        }
        filled = true;
      });
    } catch (e) {
      say('qbConnMsg', e.message, 'err');
      return;
    }
    if (banner) {
      say('qbConnMsg', banner.text, banner.kind);
      banner = null;
    }
    if (status.connected) {
      // The pay period and the history are read here; matching and the
      // invoice pickers ask Intuit, which can be slow. Neither waits for the
      // other — but the Intuit reads still go one after another, as before.
      await Promise.all([
        (async () => {
          await loadMapping();
          await loadInvoiceOptions();
        })(),
        loadPeriod(),
        loadRuns(),
      ]);
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

  // Signed in, and allowed this tab: before sign-in the answer would only be
  // "please sign in", and a feature switched off isn't worth asking about.
  function canOpen() {
    const app = $('app');
    const tab = document.querySelector('.side-nav .tab[data-tab="quickbooks"]');
    return !!app && app.style.display !== 'none' && !!tab && tab.style.display !== 'none';
  }

  // Warms the connection status for someone on their way to the tab (the
  // shell calls this on tab hover, focus or touch, and when idle). Only the
  // status: it is answered from this server's own records. Nothing that asks
  // Intuit — items, tax codes, QuickBooks' employees, the connect hand-off —
  // is ever fetched ahead of time, and neither is the pay-period preview,
  // which is always read fresh before a push.
  function prefetch() {
    if (!canOpen()) return;
    Snappy.prefetch(api, STATUS);
  }

  window.QuickBooks = { load, afterLogin, prefetch };
})();
