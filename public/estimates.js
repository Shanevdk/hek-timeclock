// Estimate requests — the review screen for the public page at "/estimate".
//
// A customer prices their own job out there and presses "Request a quote";
// each one lands here. Approving a request is what turns it into a quote —
// the public page never creates one itself.
//
// The settings panel is where the admin owns the page: whether it is live,
// which services it offers, what they are called and what they cost.
//
// Relies on window.HEKAdmin ({ api, esc }) from admin.js, loaded first.
(function () {
  const H = () => window.HEKAdmin || {};
  const api = (...a) => H().api(...a);
  const esc = (s) => (H().esc ? H().esc(s) : String(s));
  const $ = (id) => document.getElementById(id);

  let settings = null;
  let book = null;
  let requests = [];
  let expanded = null; // id of the request currently opened
  let wired = false;
  let saveTimer = null; // a text change waiting to be saved
  let unread = 0; // new requests, as the sidebar badge counts them

  // Read under these exact paths everywhere, so kept copies line up. Kept in
  // memory only, never on the device: requests carry customers' names, phone
  // numbers and addresses.
  const REQUESTS = '/api/admin/estimate/requests';
  const SETTINGS = '/api/admin/estimate/settings';
  const BOOK = '/api/admin/ratebook';
  // Answers about the list can land out of order — a slow read that set off
  // before a change can arrive after it. Each read is numbered as it starts;
  // one older than what the screen already shows (a newer read, or a change
  // made here) is dropped rather than painted over it.
  let asked = 0;
  let shown = 0;

  // Whether someone is typing in a field inside `box` right now. A refresh
  // landing mid-sentence must not put the server's older words back.
  const typing = (box) => {
    const a = document.activeElement;
    return !!box && !!a && box.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  };

  const money = (n) =>
    '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtWhen = (iso) =>
    iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  // ---- shell ----
  function build() {
    const sec = $('tab-estimate');
    if (!sec || wired) return;
    sec.innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="margin:0">Estimate requests</h2>
        <!-- Only shows or hides the panel, so a mouse does it on the way down
             (data-press, snappy.js). -->
        <button class="btn ghost sm" id="esSettingsToggle" data-press="fast">Page settings</button>
      </div>

      <div class="card" id="esSettings" style="display:none;margin-bottom:16px">
        <label class="es-switch">
          <input type="checkbox" id="esEnabled" />
          <span><strong>The estimate page is live</strong>
            <span class="es-hint">When off, /estimate shows "estimates are closed" and files nothing.</span>
          </span>
        </label>

        <div class="es-url" id="esUrl"></div>

        <div class="row" style="margin-top:14px">
          <div class="field" style="flex:1 1 260px"><label>Headline</label><input id="esHeadline" /></div>
          <div class="field" style="flex:0 0 150px"><label>Minimum job charge</label>
            <input id="esMinCharge" inputmode="decimal" /></div>
        </div>
        <div class="field" style="margin-top:12px"><label>Intro text</label>
          <textarea id="esIntro" rows="2"></textarea></div>
        <div class="field" style="margin-top:12px"><label>Small print under the total</label>
          <textarea id="esFootnote" rows="2"></textarea></div>
        <div class="field" style="margin-top:12px">
          <label>Disclaimer</label>
          <textarea id="esDisclaimer" rows="4"></textarea>
          <span class="es-hint">Shown in a box on the page and again on the request form.
            A copy is saved with every request, so rewording it later never changes
            what an earlier customer was shown. Leave blank to hide it.</span>
        </div>

        <h3 style="margin:22px 0 4px">Street View photo</h3>
        <p class="status-sub" style="text-align:left;margin:0 0 12px">
          Optional. With a Google Maps key, the 3D preview also shows the customer's
          property from the road, with the fence drawn roughly where it would stand.
          The 3D fence on the aerial photo needs no key and always works.
        </p>
        <div class="row">
          <div class="field" style="flex:2 1 300px"><label>Google Maps API key</label>
            <input id="esGoogleKey" type="password" autocomplete="new-password"
                   placeholder="leave blank to keep current" /></div>
          <button class="btn gold sm" id="esSaveGoogle">Save key</button>
          <button class="link-btn danger" id="esClearGoogle">Forget key</button>
        </div>
        <p class="status-sub" style="text-align:left;margin:8px 0 0" id="esGoogleState"></p>

        <h3 style="margin:22px 0 4px">What the page offers</h3>
        <p class="status-sub" style="text-align:left;margin:0 0 12px">
          Tick a service to offer it publicly. Names and prices here are the same
          rate book the Pricing tab uses — editing one changes both.
        </p>
        <div id="esServices"></div>

        <h3 style="margin:22px 0 10px">Add a service</h3>
        <div class="row">
          <div class="field" style="flex:2 1 200px"><label>Name</label><input id="esNewLabel" placeholder="e.g. Deer fence" /></div>
          <div class="field" style="flex:0 0 130px"><label>Unit</label>
            <select id="esNewUnit"></select></div>
          <div class="field" style="flex:0 0 110px"><label>Price</label><input id="esNewPrice" inputmode="decimal" placeholder="0.00" /></div>
          <button class="btn gold sm" id="esAddService">Add</button>
        </div>
        <div class="msg err" id="esSettingsMsg"></div>
      </div>

      <div class="stat-row" id="esStats"></div>
      <div id="esList"></div>
      <p class="status-sub" id="esEmpty" style="display:none">No estimate requests yet.</p>
    `;

    // Busy at once, so a second press can't send it twice; a spinner only if
    // the server takes a moment.
    $('esSaveGoogle').addEventListener('click', async () => {
      const key = $('esGoogleKey').value.trim();
      if (!key) return;
      // Cleared only once it's saved: a refused key stays in the box to fix.
      if (await Snappy.busy($('esSaveGoogle'), () => saveSettings({ google_api_key: key })))
        $('esGoogleKey').value = '';
    });
    $('esClearGoogle').addEventListener('click', async () => {
      if (!confirm('Forget the Google Maps key? The road-level photo will stop appearing.')) return;
      await Snappy.busy($('esClearGoogle'), () => saveSettings({ clear_google_api_key: true }));
    });

    $('esSettingsToggle').addEventListener('click', () => {
      const el = $('esSettings');
      const open = el.style.display !== 'none';
      el.style.display = open ? 'none' : 'block';
      $('esSettingsToggle').textContent = open ? 'Page settings' : 'Hide settings';
    });

    // Live or off shows at once, link and all; if the server refuses, the
    // switch goes back and the reason shows under the panel.
    $('esEnabled').addEventListener('change', () => {
      const on = $('esEnabled').checked;
      const setLive = (v) => {
        $('esEnabled').checked = v;
        if (settings) settings.enabled = v;
        renderUrl();
      };
      Snappy.optimistic(
        () => {
          setLive(on);
          return () => setLive(!on);
        },
        () =>
          saveSettings({ enabled: on }).then((ok) => {
            if (!ok) throw new Error('not saved');
          })
      ).catch(() => {}); // saveSettings has already said why
    });
    ['esHeadline', 'esIntro', 'esFootnote', 'esDisclaimer', 'esMinCharge'].forEach((id) => {
      $(id).addEventListener('input', queueSaveText);
    });
    $('esAddService').addEventListener('click', () => Snappy.busy($('esAddService'), addService));

    // Service rows: tick to publish, edit name/price inline, remove.
    $('esServices').addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-pub]');
      if (cb) editService('update', { key: cb.dataset.pub, public: cb.checked });
      const unit = e.target.closest('select[data-unit]');
      if (unit) editService('update', { key: unit.dataset.unit, unit: unit.value });
    });
    $('esServices').addEventListener('blur', (e) => {
      const label = e.target.closest('input[data-label]');
      if (label) editService('update', { key: label.dataset.label, label: label.value });
      const price = e.target.closest('input[data-price]');
      if (price) editService('update', { key: price.dataset.price, price: price.value });
    }, true);
    $('esServices').addEventListener('click', (e) => {
      const rm = e.target.closest('button[data-remove]');
      if (!rm) return;
      const key = rm.dataset.remove;
      const svc = (book.services || []).find((s) => s.key === key);
      if (!confirm(`Remove "${svc ? svc.label : key}" from the rate book?`)) return;
      editService('remove', { key });
    });

    // Request cards.
    $('esList').addEventListener('click', onListClick);
    wired = true;
  }

  // ---- settings ----
  function queueSaveText() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveSettings({
        headline: $('esHeadline').value,
        intro: $('esIntro').value,
        footnote: $('esFootnote').value,
        disclaimer: $('esDisclaimer').value,
        min_charge: $('esMinCharge').value || 0,
      });
    }, 600);
  }

  // Resolves true once saved. A refusal is said under the panel, and
  // resolves false, so the caller can put back what it showed early.
  async function saveSettings(patch) {
    $('esSettingsMsg').textContent = '';
    try {
      const d = await api(SETTINGS, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      settings = d.settings;
      renderUrl();
      renderGoogle();
      return true;
    } catch (e) {
      $('esSettingsMsg').textContent = e.message;
      return false;
    }
  }

  // The key itself is never sent back to the browser — only whether one is set.
  function renderGoogle() {
    const el = $('esGoogleState');
    if (!el) return;
    const on = settings && settings.has_google_key;
    el.textContent = on
      ? 'A key is saved. Customers see the road-level photo.'
      : 'No key saved — the 3D fence on the aerial photo still works; only the road-level photo is missing.';
    if ($('esClearGoogle')) $('esClearGoogle').style.display = on ? '' : 'none';
  }

  function renderUrl() {
    const live = settings && settings.enabled;
    $('esUrl').innerHTML = live
      ? `Live at <a href="/estimate" target="_blank" rel="noopener">${esc(location.origin)}/estimate</a> — share this link with customers.`
      : 'The page is switched off. Customers visiting /estimate are told estimates are closed.';
    $('esUrl').className = 'es-url' + (live ? ' on' : '');
  }

  function renderServices() {
    const rows = (book.services || [])
      .map(
        (s) => `<div class="es-svc">
          <label class="es-pub" title="Offer this on the public page">
            <input type="checkbox" data-pub="${esc(s.key)}"${s.public ? ' checked' : ''} />
          </label>
          <input class="es-svc-label" data-label="${esc(s.key)}" value="${esc(s.label)}" />
          <select data-unit="${esc(s.key)}">${(book.units || [])
            .map((u) => `<option${u === s.unit ? ' selected' : ''}>${esc(u)}</option>`)
            .join('')}</select>
          <div class="es-price">$<input data-price="${esc(s.key)}" inputmode="decimal" value="${s.price}" /></div>
          <button class="link-btn danger" data-remove="${esc(s.key)}" title="Remove">✕</button>
        </div>`
      )
      .join('');
    $('esServices').innerHTML =
      `<div class="es-svc es-svc-head"><span></span><span>Service</span><span>Unit</span><span>Price</span><span></span></div>` + rows;
    const unitSel = $('esNewUnit');
    if (unitSel && !unitSel.options.length)
      unitSel.innerHTML = (book.units || []).map((u) => `<option>${esc(u)}</option>`).join('');
  }

  // Resolves true once the rate book has taken the change.
  async function editService(action, body) {
    $('esSettingsMsg').textContent = '';
    try {
      book = await api('/api/admin/ratebook/services', {
        method: 'POST',
        body: JSON.stringify({ action, ...body }),
      });
      // The answer is the whole book: kept, so Pricing and the invoice
      // quick-adds open on it rather than on the book from before.
      Snappy.cache.put(BOOK, book);
      renderServices();
      return true;
    } catch (e) {
      $('esSettingsMsg').textContent = e.message;
      await loadBook().catch(() => {}); // put the row back the way the server has it
      return false;
    }
  }

  async function addService() {
    const label = $('esNewLabel').value.trim();
    if (!label) {
      $('esSettingsMsg').textContent = 'Give the service a name.';
      return;
    }
    const added = await editService('add', {
      label,
      unit: $('esNewUnit').value,
      price: $('esNewPrice').value || 0,
      public: true,
    });
    // Cleared only once it's in: a refused one stays in the boxes to fix.
    if (!added) return;
    $('esNewLabel').value = '';
    $('esNewPrice').value = '';
  }

  // The rate book as the server has it now — asked for afresh, since a kept
  // copy (or a read that set off before the change) would be older.
  async function loadBook() {
    book = await api(BOOK);
    Snappy.cache.put(BOOK, book);
    renderServices();
  }

  // A link to where the fence was traced. Google Maps in satellite view at the
  // first corner — enough to recognise the property before driving out.
  function mapLink(m) {
    const first = m.start || (m.runs && m.runs[0] && m.runs[0][0]) || null;
    if (!first) return '#';
    return `https://www.google.com/maps/@?api=1&map_action=map&center=${first[0]},${first[1]}&zoom=20&basemap=satellite`;
  }

  const runCount = (m) => m.run_count || (m.runs ? m.runs.length : 0);

  // ---- requests ----
  function statusBadge(r) {
    if (r.status === 'approved') return '<span class="badge status-approved">quoted</span>';
    if (r.status === 'dismissed') return '<span class="badge">dismissed</span>';
    return '<span class="badge status-pending">new</span>';
  }

  function renderStats() {
    const waiting = requests.filter((r) => r.status === 'new');
    const value = waiting.reduce((t, r) => t + (r.total || 0), 0);
    $('esStats').innerHTML = `
      <div class="stat"><div class="n">${waiting.length}</div><div class="l">Waiting on you</div></div>
      <div class="stat"><div class="n">${money(value)}</div><div class="l">Estimated value</div></div>
      <div class="stat"><div class="n">${requests.length}</div><div class="l">Requests all time</div></div>`;
    $('esEmpty').style.display = requests.length ? 'none' : 'block';
  }

  // One request's card. Its head opens and closes the details, which only
  // shows what is already here, so a mouse does it on the way down
  // (data-press, snappy.js).
  function requestCard(r) {
    const c = r.customer || {};
    const contact = [c.phone, c.email].filter(Boolean).join(' · ');
    const open = expanded === r.id;
    return `<div class="card es-req${r.status === 'new' ? ' is-new' : ''}" data-id="${r.id}">
      <div class="es-req-head" data-toggle="${r.id}" data-press="fast">
        <div>
          <div class="es-req-who">${esc(c.name || 'Someone')} ${statusBadge(r)}</div>
          <div class="es-req-meta">${esc(contact || 'no contact details')} · ${fmtWhen(r.created_at)}</div>
        </div>
        <div class="es-req-total">${money(r.total)}</div>
      </div>
      ${open ? detail(r) : ''}
    </div>`;
  }

  // `keep`: the same list, refreshed — draw at least as many cards as are
  // already there, so the page doesn't shrink under someone scrolled down it.
  function renderRequests(keep) {
    renderStats();
    const box = $('esList');
    const drawn = keep ? box.querySelectorAll('.es-req').length : 0;
    // A screenful now and the rest as it is scrolled toward.
    Snappy.chunks(box, requests.map(requestCard), { first: Math.max(60, drawn) });
  }

  const cardEl = (id) => $('esList').querySelector(`.es-req[data-id="${id}"]`);

  // Redraws one card where it stands; the rest of the list, and how far down
  // it has been drawn, stay as they are.
  function redraw(id) {
    const el = cardEl(id);
    const r = requests.find((x) => x.id === id);
    if (el && r) el.outerHTML = requestCard(r);
  }

  // Opens or closes a card's details in place. Its head stays the same
  // element, under the pointer that pressed it. Opening drops the details
  // out from under the head (styles.css, .is-opening); closing is instant.
  function setOpen(id, on) {
    const el = cardEl(id);
    if (!el) return;
    const body = el.querySelector('.es-req-body');
    if (body) body.remove();
    const r = on && requests.find((x) => x.id === id);
    if (!r) return;
    el.insertAdjacentHTML('beforeend', detail(r));
    el.lastElementChild.classList.add('is-opening');
  }

  const isNew = (r) => (r && r.status === 'new' ? 1 : 0);

  // Changes one request on screen and in the kept copy, badge and totals
  // included. Returns what changes it back.
  function change(id, fields) {
    const before = requests.find((r) => r.id === id);
    if (!before) return () => {};
    const after = { ...before, ...fields };
    const swap = (from, to) => {
      requests = requests.map((r) => (r.id === id ? to : r));
      unread = Math.max(0, unread + isNew(to) - isNew(from));
      shown = ++asked; // newer than any read of the list already on its way
      const count = unread;
      Snappy.cache.update(REQUESTS, (d) => ({
        ...d,
        requests: (d.requests || []).map((r) => (r.id === id ? to : r)),
        unread: count,
      }));
      setCount(unread);
      renderStats();
      redraw(id);
    };
    swap(before, after);
    return () => swap(after, before);
  }

  // Takes a request off the list, on screen and in the kept copy. Returns
  // what puts it back.
  function remove(id) {
    const was = { requests, unread, expanded };
    const gone = requests.find((r) => r.id === id);
    requests = requests.filter((r) => r.id !== id);
    unread = Math.max(0, unread - isNew(gone));
    if (expanded === id) expanded = null;
    shown = ++asked;
    const count = unread;
    Snappy.cache.update(REQUESTS, (d) => ({
      ...d,
      requests: (d.requests || []).filter((r) => r.id !== id),
      unread: count,
    }));
    const el = cardEl(id);
    if (el) el.remove();
    setCount(unread);
    renderStats();
    return () => {
      requests = was.requests;
      unread = was.unread;
      expanded = was.expanded;
      shown = ++asked;
      Snappy.cache.update(REQUESTS, (d) => ({ ...d, requests: was.requests, unread: was.unread }));
      setCount(unread);
      renderRequests(true);
    };
  }

  // The list as it stands after a change made here, in the background —
  // asked for afresh, since a kept copy would be older. A failure leaves the
  // screen as it is; the next visit asks again.
  function refreshRequests() {
    const n = ++asked;
    api(REQUESTS)
      .then((d) => {
        if (n < shown) return;
        shown = n;
        Snappy.cache.put(REQUESTS, d);
        requests = d.requests || [];
        unread = d.unread || 0;
        setCount(unread);
        renderRequests(true);
      })
      .catch(() => {});
  }

  function detail(r) {
    const c = r.customer || {};
    const lines = (r.items || [])
      .map(
        (i) => `<tr><td>${esc(i.description)}</td><td>${i.qty} ${esc(i.unit)}</td>
          <td>${money(i.unit_price)}</td><td>${money(i.line_total)}</td></tr>`
      )
      .join('');
    return `<div class="es-req-body">
      <div class="es-req-cols">
        <div>
          <h4>Customer</h4>
          <div class="es-kv"><span>Name</span><span>${esc(c.name || '—')}</span></div>
          <div class="es-kv"><span>Email</span><span>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</span></div>
          <div class="es-kv"><span>Phone</span><span>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</span></div>
          <div class="es-kv"><span>Job site</span><span>${esc(c.address || r.site || '—')}</span></div>
          ${
            r.measurement
              ? `<div class="es-kv"><span>Measured</span><span>
                   <strong>${r.measurement.feet.toLocaleString('en-US')} ft</strong>
                   (${Math.round(r.measurement.metres).toLocaleString('en-US')} m)
                   over ${runCount(r.measurement)} run${runCount(r.measurement) > 1 ? 's' : ''}
                   <a href="${mapLink(r.measurement)}" target="_blank" rel="noopener">see it</a>
                 </span></div>`
              : ''
          }
          ${r.notes ? `<h4 style="margin-top:16px">What they said</h4><p class="es-notes">${esc(r.notes)}</p>` : ''}
          ${
            r.disclaimer
              ? `<h4 style="margin-top:16px">Disclaimer they were shown</h4>
                 <p class="es-notes es-shown">${esc(r.disclaimer)}</p>`
              : ''
          }
        </div>
        <div>
          <h4>What they priced</h4>
          <table class="es-items">
            <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Total</th></tr></thead>
            <tbody>${lines}</tbody>
          </table>
          <div class="totals-line"><span>Subtotal</span><span>${money(r.subtotal)}</span></div>
          <div class="totals-line"><span>Tax ${r.tax_rate}%</span><span>${money(r.tax)}</span></div>
          <div class="totals-line grand"><span>Total</span><span>${money(r.total)}</span></div>
          ${r.below_minimum ? '<p class="es-min-note">Minimum job charge applied.</p>' : ''}
        </div>
      </div>
      <div class="es-req-foot">
        ${
          r.quote_id
            ? `<span class="status-sub" style="margin:0">Already turned into a quote.</span>`
            : `<button class="btn gold sm" data-approve="${r.id}">Turn into a quote</button>
               <button class="btn ghost sm" data-dismiss="${r.id}">Dismiss</button>`
        }
        <button class="link-btn danger" data-delete="${r.id}">Delete</button>
      </div>
    </div>`;
  }

  async function onListClick(e) {
    const head = e.target.closest('[data-toggle]');
    const approve = e.target.closest('[data-approve]');
    const dismiss = e.target.closest('[data-dismiss]');
    const del = e.target.closest('[data-delete]');
    try {
      if (approve) {
        const id = Number(approve.dataset.approve);
        // It makes a quote, so it waits for the server: busy at once (a
        // second press can't make a second quote), a spinner only if the
        // wait is noticeable.
        const d = await Snappy.busy(approve, () => api(`${REQUESTS}/${id}/approve`, { method: 'POST' }));
        // The Quotes tab's kept list doesn't have the new quote yet.
        Snappy.cache.drop('/api/admin/quotes');
        change(id, { status: 'approved', quote_id: d.quote.id });
        refreshRequests();
        alert(`Created quote ${d.quote.number}. It is in the Quotes tab as a draft.`);
        return;
      }
      if (dismiss) {
        const id = Number(dismiss.dataset.dismiss);
        // A status change: shown at once, put back if the server refuses.
        await Snappy.optimistic(
          () => change(id, { status: 'dismissed' }),
          () => api(`${REQUESTS}/${id}/dismiss`, { method: 'POST' })
        );
        return;
      }
      if (del) {
        if (!confirm('Delete this request? This cannot be undone.')) return;
        const id = Number(del.dataset.delete);
        // Gone at once; back where it was if the server refuses.
        await Snappy.optimistic(
          () => remove(id),
          () => api(`${REQUESTS}/${id}`, { method: 'DELETE' })
        );
        return;
      }
      if (head) {
        const id = Number(head.dataset.toggle);
        const was = expanded;
        expanded = was === id ? null : id;
        if (was != null) setOpen(was, false);
        if (expanded != null) setOpen(expanded, true);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  // ---- load ----
  // The settings, the rate book and the requests are asked for together.
  // Each paints the copy kept from earlier in this visit at once, then the
  // server's answer if it differs.
  function load() {
    build();
    const n = ++asked;
    let painted = false;
    const reading = Snappy.swr(api, REQUESTS, (d, fresh) => {
      painted = true;
      if (n < shown) return;
      shown = n;
      requests = d.requests || [];
      unread = d.unread || 0;
      renderRequests(fresh);
      setCount(unread);
    });
    // Nothing kept and nothing drawn yet: say it's loading — but only once
    // the wait is long enough to notice (styles.css, .wait).
    if (!painted && !$('esList').children.length)
      $('esList').innerHTML = '<p class="status-sub wait">Loading requests…</p>';
    // Whether this visit has filled the panel yet: until it has, there is
    // nothing of someone's to protect from a refresh.
    let filled = false;
    let listed = false;
    return Promise.all([
      Snappy.swr(api, SETTINGS, (s) => {
        fillSettings(s.settings, filled);
        filled = true;
      }),
      Snappy.swr(api, BOOK, (b) => {
        book = b;
        // Not while a service is being edited: a refresh mustn't swap its row
        // out from under the cursor.
        if (!(listed && typing($('esServices')))) renderServices();
        listed = true;
      }),
      reading,
    ]);
  }

  // `again`: the panel was already filled on this visit.
  function fillSettings(s, again) {
    settings = s;
    // A refresh landing while someone types in the panel, or with their
    // change still waiting to be saved, leaves their words alone: those are
    // newer than the server's copy.
    if (!(saveTimer || (again && typing($('esSettings'))))) {
      $('esEnabled').checked = !!settings.enabled;
      $('esHeadline').value = settings.headline || '';
      $('esIntro').value = settings.intro || '';
      $('esFootnote').value = settings.footnote || '';
      $('esDisclaimer').value = settings.disclaimer || '';
      $('esMinCharge').value = settings.min_charge || 0;
    }
    renderUrl();
    renderGoogle();
  }

  function setCount(n) {
    const badge = $('esNavCount');
    if (!badge) return;
    badge.textContent = n;
    badge.style.display = n ? 'inline-block' : 'none';
  }

  // Badge on the sidebar without opening the tab — its own light call, not
  // the whole queue.
  async function refreshCount() {
    try {
      const d = await api('/api/admin/estimate/requests/count');
      unread = d.unread || 0;
      setCount(unread);
    } catch (e) {
      /* the badge is a nicety; a failure here shouldn't surface */
    }
  }

  // Signed in, and allowed this tab: before sign-in the answer would only be
  // "please sign in", and a feature switched off isn't worth asking about.
  function canOpen() {
    const app = $('app');
    const tab = document.querySelector('.side-nav .tab[data-tab="estimate"]');
    return !!app && app.style.display !== 'none' && !!tab && tab.style.display !== 'none';
  }

  // Warms what the tab opens on, for someone on their way to it — the shell
  // calls this on tab hover, focus or touch, and when the page is idle. The
  // same paths load() reads, kept in memory only like everything here.
  function prefetch() {
    if (!canOpen()) return;
    Snappy.prefetch(api, [REQUESTS, SETTINGS, BOOK]);
  }

  window.Estimates = { load, refreshCount, prefetch };
})();
