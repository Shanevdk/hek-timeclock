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
  let saveTimer = null;

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
        <button class="btn ghost sm" id="esSettingsToggle">Page settings</button>
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

    $('esSaveGoogle').addEventListener('click', async () => {
      const key = $('esGoogleKey').value.trim();
      if (!key) return;
      await saveSettings({ google_api_key: key });
      $('esGoogleKey').value = '';
    });
    $('esClearGoogle').addEventListener('click', async () => {
      if (!confirm('Forget the Google Maps key? The road-level photo will stop appearing.')) return;
      await saveSettings({ clear_google_api_key: true });
    });

    $('esSettingsToggle').addEventListener('click', () => {
      const el = $('esSettings');
      const open = el.style.display !== 'none';
      el.style.display = open ? 'none' : 'block';
      $('esSettingsToggle').textContent = open ? 'Page settings' : 'Hide settings';
    });

    $('esEnabled').addEventListener('change', () => saveSettings({ enabled: $('esEnabled').checked }));
    ['esHeadline', 'esIntro', 'esFootnote', 'esDisclaimer', 'esMinCharge'].forEach((id) => {
      $(id).addEventListener('input', queueSaveText);
    });
    $('esAddService').addEventListener('click', addService);

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
      saveSettings({
        headline: $('esHeadline').value,
        intro: $('esIntro').value,
        footnote: $('esFootnote').value,
        disclaimer: $('esDisclaimer').value,
        min_charge: $('esMinCharge').value || 0,
      });
    }, 600);
  }

  async function saveSettings(patch) {
    $('esSettingsMsg').textContent = '';
    try {
      const d = await api('/api/admin/estimate/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      settings = d.settings;
      renderUrl();
      renderGoogle();
    } catch (e) {
      $('esSettingsMsg').textContent = e.message;
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

  async function editService(action, body) {
    $('esSettingsMsg').textContent = '';
    try {
      book = await api('/api/admin/ratebook/services', {
        method: 'POST',
        body: JSON.stringify({ action, ...body }),
      });
      renderServices();
    } catch (e) {
      $('esSettingsMsg').textContent = e.message;
      await loadBook(); // put the row back the way the server has it
    }
  }

  async function addService() {
    const label = $('esNewLabel').value.trim();
    if (!label) {
      $('esSettingsMsg').textContent = 'Give the service a name.';
      return;
    }
    await editService('add', {
      label,
      unit: $('esNewUnit').value,
      price: $('esNewPrice').value || 0,
      public: true,
    });
    $('esNewLabel').value = '';
    $('esNewPrice').value = '';
  }

  async function loadBook() {
    book = await api('/api/admin/ratebook');
    renderServices();
  }

  // A link to where the fence was traced. Google Maps in satellite view at the
  // first corner — enough to recognise the property before driving out.
  function mapLink(m) {
    const first = (m.runs && m.runs[0] && m.runs[0][0]) || null;
    if (!first) return '#';
    return `https://www.google.com/maps/@?api=1&map_action=map&center=${first[0]},${first[1]}&zoom=20&basemap=satellite`;
  }

  // ---- requests ----
  function statusBadge(r) {
    if (r.status === 'approved') return '<span class="badge status-approved">quoted</span>';
    if (r.status === 'dismissed') return '<span class="badge">dismissed</span>';
    return '<span class="badge status-pending">new</span>';
  }

  function renderRequests() {
    const nNew = requests.filter((r) => r.status === 'new').length;
    const value = requests.filter((r) => r.status === 'new').reduce((t, r) => t + (r.total || 0), 0);
    $('esStats').innerHTML = `
      <div class="stat"><div class="n">${nNew}</div><div class="l">Waiting on you</div></div>
      <div class="stat"><div class="n">${money(value)}</div><div class="l">Estimated value</div></div>
      <div class="stat"><div class="n">${requests.length}</div><div class="l">Requests all time</div></div>`;

    $('esEmpty').style.display = requests.length ? 'none' : 'block';
    $('esList').innerHTML = requests
      .map((r) => {
        const c = r.customer || {};
        const contact = [c.phone, c.email].filter(Boolean).join(' · ');
        const open = expanded === r.id;
        return `<div class="card es-req${r.status === 'new' ? ' is-new' : ''}" data-id="${r.id}">
          <div class="es-req-head" data-toggle="${r.id}">
            <div>
              <div class="es-req-who">${esc(c.name || 'Someone')} ${statusBadge(r)}</div>
              <div class="es-req-meta">${esc(contact || 'no contact details')} · ${fmtWhen(r.created_at)}</div>
            </div>
            <div class="es-req-total">${money(r.total)}</div>
          </div>
          ${open ? detail(r) : ''}
        </div>`;
      })
      .join('');
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
                   over ${r.measurement.runs.length} run${r.measurement.runs.length > 1 ? 's' : ''}
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
        approve.disabled = true;
        const d = await api(`/api/admin/estimate/requests/${id}/approve`, { method: 'POST' });
        await load();
        alert(`Created quote ${d.quote.number}. It is in the Quotes tab as a draft.`);
        return;
      }
      if (dismiss) {
        await api(`/api/admin/estimate/requests/${Number(dismiss.dataset.dismiss)}/dismiss`, { method: 'POST' });
        await load();
        return;
      }
      if (del) {
        if (!confirm('Delete this request? This cannot be undone.')) return;
        await api(`/api/admin/estimate/requests/${Number(del.dataset.delete)}`, { method: 'DELETE' });
        await load();
        return;
      }
      if (head) {
        const id = Number(head.dataset.toggle);
        expanded = expanded === id ? null : id;
        renderRequests();
      }
    } catch (err) {
      alert(err.message);
    }
  }

  // ---- load ----
  async function load() {
    build();
    const [s, d] = await Promise.all([
      api('/api/admin/estimate/settings'),
      api('/api/admin/estimate/requests'),
    ]);
    settings = s.settings;
    $('esEnabled').checked = !!settings.enabled;
    $('esHeadline').value = settings.headline || '';
    $('esIntro').value = settings.intro || '';
    $('esFootnote').value = settings.footnote || '';
    $('esDisclaimer').value = settings.disclaimer || '';
    $('esMinCharge').value = settings.min_charge || 0;
    renderUrl();
    renderGoogle();
    await loadBook();
    requests = d.requests || [];
    renderRequests();
    setCount(d.unread || 0);
  }

  function setCount(n) {
    const badge = $('esNavCount');
    if (!badge) return;
    badge.textContent = n;
    badge.style.display = n ? 'inline-block' : 'none';
  }

  // Badge on the sidebar without opening the tab.
  async function refreshCount() {
    try {
      const d = await api('/api/admin/estimate/requests');
      setCount(d.unread || 0);
    } catch (e) {
      /* the badge is a nicety; a failure here shouldn't surface */
    }
  }

  window.Estimates = { load, refreshCount };
})();
