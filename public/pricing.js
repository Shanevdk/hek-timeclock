// Pricing calculator (admin "Pricing" tab). Auto-calculates an estimate from
// the rate book, then hands the line items straight to the quote builder.
//
// The rate book used to live in this browser's localStorage, which meant it was
// tied to one device and invisible to the server. It now lives in the database
// (see ratebook.js) so the inbox agent prices its drafts against exactly the
// same numbers the office would use by hand. Rates saved on a device before
// that change are pushed up once, the first time this loads.
(function () {
  const section = document.getElementById('tab-pricing');
  if (!section) return; // not on a page with the Pricing tab

  const H = () => window.HEKAdmin || {};
  const api = (...a) => H().api(...a);
  const $ = (id) => document.getElementById(id);
  const money = (n) =>
    '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LEGACY_KEY = 'hek-rate-book';

  let services = [];
  let byKey = {};
  let taxRate = 13;
  let built = false;
  let saveTimer = null;

  section.innerHTML = '<p class="status-sub" style="padding:40px 0">Loading the rate book…</p>';

  // ---- server-backed rate book ----
  async function fetchBook() {
    const book = await api('/api/admin/ratebook');
    // One-time migration: rates a user had saved on this device before the book
    // moved to the server. Only on a book the server has just seeded, so it can
    // never overwrite rates someone has since set properly.
    if (book.seeded) {
      let legacy = null;
      try {
        legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
      } catch (e) {
        legacy = null;
      }
      if (legacy && Object.keys(legacy).length) {
        try {
          const merged = await api('/api/admin/ratebook', {
            method: 'PATCH',
            body: JSON.stringify({ rates: legacy }),
          });
          localStorage.removeItem(LEGACY_KEY);
          return merged;
        } catch (e) {
          /* keep the server defaults if the push fails */
        }
      }
    }
    return book;
  }

  function applyBook(book) {
    services = book.services || [];
    byKey = Object.fromEntries(services.map((s) => [s.key, s]));
    if (book.tax_rate != null) taxRate = book.tax_rate;
  }

  // Rate edits are typed one keystroke at a time; batch them so the tab isn't
  // firing a request per character.
  function queueSave(rates) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api('/api/admin/ratebook', { method: 'PATCH', body: JSON.stringify({ rates }) });
        note('Rates saved.', 'ok');
      } catch (e) {
        note(e.message, 'err');
      }
    }, 600);
  }

  function note(text, kind) {
    const el = $('pcRateMsg');
    if (!el) return;
    el.className = 'msg' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  // ---- build the tab once the rates are in ----
  function build() {
    const optionsHtml =
      '<option value="">— choose —</option>' +
      services.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('');

    section.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
      <h2 style="margin:0">Pricing calculator</h2>
      <button class="btn ghost sm" id="pcRatesBtn">Edit rates</button>
    </div>
    <p class="calc-hint">Pick a fence type and enter the length or quantity — the price fills in
      automatically from your rate book. When it looks right, send it straight to a new quote.</p>

    <div class="card" id="pcRateCard" style="display:none;margin-bottom:16px">
      <h3 style="margin-top:0">Rate book <span class="rate-note">— shared by everyone, and what the AI inbox prices against</span></h3>
      <div class="rate-list" id="pcRateList"></div>
      <div class="msg" id="pcRateMsg"></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div style="overflow-x:auto">
        <table class="calc-table">
          <thead><tr>
            <th style="min-width:200px">Fence type / service</th>
            <th style="width:90px">Qty</th>
            <th style="width:90px">Unit</th>
            <th style="width:130px">Rate</th>
            <th style="width:120px">Line total</th>
            <th style="width:36px"></th>
          </tr></thead>
          <tbody id="pcRows"></tbody>
        </table>
      </div>
      <button class="btn ghost sm" id="pcAdd" style="margin-top:12px">+ Add line</button>
    </div>

    <div class="row" style="align-items:stretch">
      <div class="card" style="flex:1 1 240px">
        <div class="totals-line"><span>Subtotal</span><span id="pcSub">$0.00</span></div>
        <div class="totals-line"><span>Tax <input id="pcTax" class="tax-input" inputmode="decimal" value="${taxRate}" /> %</span><span id="pcTaxAmt">$0.00</span></div>
        <div class="totals-line grand"><span>Estimated total</span><span id="pcTotal">$0.00</span></div>
      </div>
      <div class="card" style="flex:1 1 240px;display:flex;flex-direction:column;justify-content:center;gap:10px">
        <button class="btn gold sm" id="pcToQuote">Create quote from this →</button>
        <button class="btn ghost sm" id="pcReset">Clear</button>
        <div class="msg" id="pcMsg"></div>
      </div>
    </div>`;

    // ---- rate book editor ----
    function renderRates() {
      $('pcRateList').innerHTML = services
        .map(
          (s) => `<label>${esc(s.label)} <span class="pill">per ${esc(s.unit)}</span></label>
        <input class="rate-in" data-key="${s.key}" inputmode="decimal" value="${s.price}" />`
        )
        .join('');
    }
    renderRates();

    $('pcRatesBtn').addEventListener('click', () => {
      const card = $('pcRateCard');
      card.style.display = card.style.display === 'none' ? 'block' : 'none';
    });

    $('pcRateList').addEventListener('input', (e) => {
      const inp = e.target.closest('.rate-in');
      if (!inp) return;
      const key = inp.dataset.key;
      const value = parseFloat(inp.value) || 0;
      if (byKey[key]) byKey[key].price = value;
      note('Saving…');
      queueSave(Object.fromEntries(services.map((s) => [s.key, s.price])));
      // Refresh any estimate rows using this service that weren't overridden.
      [...$('pcRows').querySelectorAll('tr')].forEach((tr) => {
        const sel = tr.querySelector('.p-svc');
        if (sel.value === key && tr.dataset.override !== '1') tr.querySelector('.p-rate').value = value;
      });
      compute();
    });

    // ---- estimate rows ----
    function addRow(preset) {
      preset = preset || {};
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><select class="p-svc">${optionsHtml}</select></td>` +
        `<td><input class="p-qty" inputmode="decimal" value="${preset.qty != null ? preset.qty : ''}" /></td>` +
        `<td class="p-unit">${preset.unit ? esc(preset.unit) : '—'}</td>` +
        `<td><input class="p-rate" inputmode="decimal" value="${preset.rate != null ? preset.rate : ''}" /></td>` +
        `<td class="p-total">$0.00</td>` +
        `<td><button class="link-btn danger p-del" title="Remove">✕</button></td>`;
      $('pcRows').appendChild(tr);
      if (preset.key) tr.querySelector('.p-svc').value = preset.key;
      compute();
    }

    function compute() {
      let subtotal = 0;
      [...$('pcRows').querySelectorAll('tr')].forEach((tr) => {
        const qty = parseFloat(tr.querySelector('.p-qty').value) || 0;
        const rate = parseFloat(tr.querySelector('.p-rate').value) || 0;
        const line = qty * rate;
        subtotal += line;
        tr.querySelector('.p-total').textContent = money(line);
      });
      const tax = (subtotal * (parseFloat($('pcTax').value) || 0)) / 100;
      $('pcSub').textContent = money(subtotal);
      $('pcTaxAmt').textContent = money(tax);
      $('pcTotal').textContent = money(subtotal + tax);
    }

    $('pcRows').addEventListener('change', (e) => {
      const sel = e.target.closest('.p-svc');
      if (!sel) return;
      const tr = sel.closest('tr');
      const svc = byKey[sel.value];
      tr.dataset.override = '0';
      tr.querySelector('.p-unit').textContent = svc ? svc.unit : '—';
      tr.querySelector('.p-rate').value = svc ? svc.price : '';
      compute();
    });
    $('pcRows').addEventListener('input', (e) => {
      if (e.target.classList.contains('p-rate')) e.target.closest('tr').dataset.override = '1';
      compute();
    });
    $('pcRows').addEventListener('click', (e) => {
      const del = e.target.closest('.p-del');
      if (del) {
        del.closest('tr').remove();
        compute();
      }
    });
    $('pcTax').addEventListener('input', compute);
    $('pcAdd').addEventListener('click', () => addRow());
    $('pcReset').addEventListener('click', () => {
      $('pcRows').innerHTML = '';
      $('pcMsg').textContent = '';
      addRow();
    });

    // ---- hand the estimate to the quote builder ----
    $('pcToQuote').addEventListener('click', () => {
      const items = [];
      [...$('pcRows').querySelectorAll('tr')].forEach((tr) => {
        const svc = byKey[tr.querySelector('.p-svc').value];
        const qty = parseFloat(tr.querySelector('.p-qty').value) || 0;
        const rate = parseFloat(tr.querySelector('.p-rate').value) || 0;
        if (!svc || (!qty && !rate)) return;
        items.push({ description: svc.label + ' — supply & install', qty, unit: svc.unit, unit_price: rate });
      });
      $('pcMsg').className = 'msg err';
      if (!items.length) {
        $('pcMsg').textContent = 'Add at least one fence type with a quantity first.';
        return;
      }
      if (window.Quotes && window.Quotes.prefill) {
        window.Quotes.prefill(items, { tax: parseFloat($('pcTax').value) || 0 });
        $('pcMsg').textContent = '';
      } else {
        $('pcMsg').textContent = 'Open the Quotes tab to use this estimate.';
      }
    });

    addRow(); // start with one empty line
    built = true;
    window.Pricing.recompute = compute;
  }

  // Build on first open, and pick up rate changes made elsewhere on later ones.
  async function load() {
    try {
      const book = await fetchBook();
      applyBook(book);
    } catch (e) {
      if (!built) {
        section.innerHTML =
          '<p class="status-sub" style="padding:40px 0">Could not load the rate book. Refresh and sign in again.</p>';
        return;
      }
    }
    if (!built) build();
    else if ($('pcRateList')) {
      // Already built — just refresh the displayed rates.
      $('pcRateList').innerHTML = services
        .map(
          (s) => `<label>${esc(s.label)} <span class="pill">per ${esc(s.unit)}</span></label>
        <input class="rate-in" data-key="${s.key}" inputmode="decimal" value="${s.price}" />`
        )
        .join('');
    }
  }

  // Loaded when the tab is first opened, not at page load — admin.js is still
  // establishing the session at that point, and a 401 here would bounce the
  // page back to the login screen mid-boot.
  window.Pricing = { load };
})();
