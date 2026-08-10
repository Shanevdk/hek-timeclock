// Quote builder for the admin dashboard. Lives in the "Quotes" tab.
// Uses the shared, auth-aware API helper exposed by admin.js (window.HEKAdmin).
(function () {
  const $ = (id) => document.getElementById(id);
  const A = window.HEKAdmin || {};
  const api = A.api || ((p, o) => fetch(p, o).then((r) => r.json()));
  const esc = A.esc || ((s) => String(s));

  let editingId = null; // null while building a brand-new quote
  let currentNumber = null;

  // ---- formatting ----
  const money = (n) =>
    '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Trim trailing zeros from a quantity (2.00 -> "2", 1.50 -> "1.5").
  const fmtNum = (n) => String(Math.round((Number(n) || 0) * 100) / 100);
  const fmtDate = (iso) =>
    iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const todayStr = () => {
    const d = new Date();
    const off = d.getTimezoneOffset() * 60000;
    return new Date(d - off).toISOString().slice(0, 10);
  };
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

  // HEK Fencing Inc. — company details (from hekfencing.ca), shown on the
  // printable customer quote. Edit here if any of it changes.
  const COMPANY = {
    name: 'HEK Fencing Inc.',
    serviceArea: 'Serving South-Western Ontario',
    website: 'hekfencing.ca',
    locations: ['225439 Otterville Rd, Otterville, ON', '285794 Airport Rd, Norwich, ON'],
    phones: ['Henry (519) 983-0304', 'Barend (226) 228-1136'],
    emails: ['henry@hekfencing.com', 'barend@hekfencing.com'],
  };

  // Default terms dropped onto every new quote (fully editable).
  const DEFAULT_TERMS =
    'Free estimate — quote valid for 30 days. Prices in CAD; top-quality ' +
    'materials and professional installation included unless noted. A deposit ' +
    'may be required to schedule your installation.';

  // HEK's actual services (from hekfencing.ca) — one click drops a filled row.
  const PRESETS = [
    // Farm fencing
    { label: 'Board fence', description: 'Board farm fence — supply & install', unit: 'linear ft' },
    { label: 'Woven wire', description: 'Woven wire farm fence — supply & install', unit: 'linear ft' },
    { label: 'High tensile', description: 'High tensile wire fence — supply & install', unit: 'linear ft' },
    { label: 'Vinyl ranch', description: 'Vinyl ranch fence — supply & install', unit: 'linear ft' },
    { label: 'Flex fence', description: 'Flex fence — supply & install', unit: 'linear ft' },
    // Privacy
    { label: 'Wood privacy', description: 'Wood privacy fence — supply & install', unit: 'linear ft' },
    { label: 'Vinyl privacy', description: 'Vinyl privacy fence — supply & install', unit: 'linear ft' },
    { label: 'Corrugated steel', description: 'Corrugated steel privacy fence — supply & install', unit: 'linear ft' },
    { label: 'Hybrid', description: 'Hybrid privacy fence — supply & install', unit: 'linear ft' },
    // Chain-link
    { label: 'Chain-link (black)', description: 'Chain-link fence, black — 9ga or heavier — supply & install', unit: 'linear ft' },
    { label: 'Chain-link (galv.)', description: 'Chain-link fence, galvanized — 9ga or heavier — supply & install', unit: 'linear ft' },
    // Ornamental
    { label: 'Ornamental', description: 'Ornamental wrought-iron fence — supply & install', unit: 'linear ft' },
    // Add-ons & services
    { label: 'Gate', description: 'Gate — supply & install', unit: 'each' },
    { label: 'Post pounding', description: 'Post pounding', unit: 'each' },
    { label: 'Post hole drilling', description: 'Post hole drilling (auger)', unit: 'each' },
    { label: 'Repair', description: 'Fence repair', unit: 'hour' },
    { label: 'Tear-out', description: 'Remove & haul away old fence', unit: 'linear ft' },
    { label: 'Labor', description: 'Labor', unit: 'hour' },
  ];

  // ---- line-item rows (the DOM is the source of truth, so typing never
  //      loses focus to a re-render) ----
  function addRow(item) {
    item = item || {};
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><input class="i-desc" value="${escAttr(item.description || '')}" placeholder="Description" /></td>` +
      `<td><input class="i-qty" inputmode="decimal" value="${item.qty != null && item.qty !== '' ? item.qty : ''}" /></td>` +
      `<td><input class="i-unit" value="${escAttr(item.unit || '')}" placeholder="ea / ft / hr" /></td>` +
      `<td><input class="i-price" inputmode="decimal" value="${item.unit_price != null && item.unit_price !== '' ? item.unit_price : ''}" /></td>` +
      `<td class="i-total">$0.00</td>` +
      `<td><button class="link-btn danger i-del" title="Remove line">✕</button></td>`;
    $('qItems').appendChild(tr);
    computeTotals();
  }

  function rowData() {
    return [...$('qItems').querySelectorAll('tr')].map((tr) => ({
      description: tr.querySelector('.i-desc').value.trim(),
      qty: parseFloat(tr.querySelector('.i-qty').value) || 0,
      unit: tr.querySelector('.i-unit').value.trim(),
      unit_price: parseFloat(tr.querySelector('.i-price').value) || 0,
      tr,
    }));
  }

  function computeTotals() {
    let subtotal = 0;
    rowData().forEach((r) => {
      const lineTotal = r.qty * r.unit_price;
      subtotal += lineTotal;
      r.tr.querySelector('.i-total').textContent = money(lineTotal);
    });
    const taxRate = parseFloat($('qTax').value) || 0;
    const tax = (subtotal * taxRate) / 100;
    $('qSubtotal').textContent = money(subtotal);
    $('qTaxAmt').textContent = money(tax);
    $('qTotal').textContent = money(subtotal + tax);
  }

  // ---- view switching ----
  function showList() {
    $('qList').style.display = 'block';
    $('qEditor').style.display = 'none';
  }
  function showEditor() {
    $('qList').style.display = 'none';
    $('qEditor').style.display = 'block';
    $('qMsg').textContent = '';
  }

  // ---- load / render the list ----
  async function load() {
    let rows;
    try {
      rows = await api('/api/admin/quotes');
    } catch (e) {
      return; // 401s are handled by the shared api() helper
    }
    $('qEmpty').style.display = rows.length ? 'none' : 'block';
    $('qBody').innerHTML = rows
      .map(
        (q) => `<tr class="clickable-row" data-id="${q.id}" title="Click to open this quote">
          <td>${esc(q.number)}</td>
          <td>${esc(q.customer.name || '—')}</td>
          <td>${fmtDate(q.quote_date)}</td>
          <td>${money(q.total)}</td>
          <td><span class="badge status-${esc(q.status)}">${esc(q.status)}</span></td>
          <td style="text-align:right;white-space:nowrap">
            <button class="link-btn" data-act="print" data-id="${q.id}">Print</button>
            <button class="link-btn danger" data-act="del" data-id="${q.id}">Delete</button>
          </td></tr>`
      )
      .join('');
    showList();
  }

  // ---- new / edit ----
  function resetForm() {
    ['qcName', 'qcPhone', 'qcEmail', 'qcAddress', 'qNotes'].forEach((id) => ($(id).value = ''));
    $('qItems').innerHTML = '';
    $('qTax').value = '0';
    $('qStatus').value = 'draft';
    $('qDate').value = todayStr();
    $('qMsg').textContent = '';
  }

  function newQuote() {
    editingId = null;
    currentNumber = null;
    $('qEditorTitle').textContent = 'New quote';
    resetForm();
    $('qNotes').value = DEFAULT_TERMS;
    // Nothing to bill for until the quote exists.
    if ($('qToInvoice')) $('qToInvoice').style.display = 'none';
    addRow(); // start with one blank line
    showEditor();
    $('qcName').focus();
  }

  function fill(q) {
    editingId = q.id;
    currentNumber = q.number;
    $('qEditorTitle').textContent = q.number + (q.customer.name ? ' — ' + q.customer.name : '');
    $('qcName').value = q.customer.name || '';
    $('qcPhone').value = q.customer.phone || '';
    $('qcEmail').value = q.customer.email || '';
    $('qcAddress').value = q.customer.address || '';
    $('qDate').value = q.quote_date ? q.quote_date.slice(0, 10) : todayStr();
    $('qStatus').value = q.status || 'draft';
    $('qTax').value = q.tax_rate || 0;
    $('qNotes').value = q.notes || '';
    $('qItems').innerHTML = '';
    (q.items && q.items.length ? q.items : [{}]).forEach(addRow);
    if ($('qToInvoice')) $('qToInvoice').style.display = '';
    computeTotals();
  }

  async function editQuote(id) {
    try {
      const q = await api('/api/admin/quotes/' + id);
      fill(q);
      showEditor();
    } catch (e) {
      alert(e.message);
    }
  }

  // ---- collect + save ----
  function collect() {
    return {
      customer: {
        name: $('qcName').value.trim(),
        phone: $('qcPhone').value.trim(),
        email: $('qcEmail').value.trim(),
        address: $('qcAddress').value.trim(),
      },
      quote_date: $('qDate').value || null,
      items: rowData()
        .map((r) => ({ description: r.description, qty: r.qty, unit: r.unit, unit_price: r.unit_price }))
        .filter((r) => r.description || r.qty || r.unit_price),
      tax_rate: parseFloat($('qTax').value) || 0,
      notes: $('qNotes').value.trim(),
      status: $('qStatus').value,
    };
  }

  async function save() {
    const payload = collect();
    $('qMsg').className = 'msg err';
    if (!payload.customer.name) {
      $('qMsg').textContent = 'Customer name is required.';
      return;
    }
    try {
      const q = editingId
        ? await api('/api/admin/quotes/' + editingId, { method: 'PATCH', body: JSON.stringify(payload) })
        : await api('/api/admin/quotes', { method: 'POST', body: JSON.stringify(payload) });
      editingId = q.id;
      currentNumber = q.number;
      $('qEditorTitle').textContent = q.number + (q.customer.name ? ' — ' + q.customer.name : '');
      $('qMsg').className = 'msg ok';
      $('qMsg').textContent = 'Saved ✓';
    } catch (e) {
      $('qMsg').textContent = e.message;
    }
  }

  // ---- printable / PDF quote (opens a clean customer-facing document) ----
  function openPrint(q) {
    const items = q.items || [];
    let subtotal = 0;
    const rows = items
      .map((it) => {
        const line = (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
        subtotal += line;
        return `<tr>
          <td>${esc(it.description || '')}</td>
          <td class="r">${fmtNum(it.qty)}</td>
          <td>${esc(it.unit || '')}</td>
          <td class="r">${money(it.unit_price)}</td>
          <td class="r">${money(line)}</td></tr>`;
      })
      .join('');
    const taxRate = Number(q.tax_rate) || 0;
    const tax = (subtotal * taxRate) / 100;
    const total = subtotal + tax;
    const c = q.customer || {};
    const contact = [c.phone, c.email].filter(Boolean).join(' &nbsp;•&nbsp; ');

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>${esc(q.number || 'Quote')} — HEK Fencing</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 40px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #a97f43; padding-bottom: 18px; gap: 20px; }
  .brand .logo img { width: 54px; height: 54px; vertical-align: middle; border-radius: 8px; }
  .brand .logo .name { display: inline-block; vertical-align: middle; margin-left: 12px; }
  .brand .logo .name b { font-size: 26px; letter-spacing: 4px; color: #a97f43; display: block; }
  .brand .logo .name span { font-size: 12px; letter-spacing: 3px; color: #555; }
  .brand .cinfo { margin-top: 12px; color: #666; font-size: 11.5px; line-height: 1.7; }
  .doc { text-align: right; white-space: nowrap; }
  .doc { text-align: right; }
  .doc h1 { margin: 0; font-size: 30px; letter-spacing: 3px; color: #a97f43; }
  .doc .meta { color: #555; font-size: 13px; margin-top: 6px; line-height: 1.5; }
  .to { margin: 28px 0 8px; }
  .to .lbl { text-transform: uppercase; font-size: 11px; letter-spacing: 1px; color: #999; margin-bottom: 4px; }
  .to .who { font-size: 18px; font-weight: 700; }
  .to .det { color: #555; font-size: 14px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 22px; font-size: 14px; }
  th { background: #f4f0e8; color: #6b5228; text-align: left; padding: 10px 12px; font-size: 12px; letter-spacing: .5px; text-transform: uppercase; }
  td { padding: 11px 12px; border-bottom: 1px solid #eee; }
  th.r, td.r { text-align: right; }
  .totals { width: 300px; margin-left: auto; margin-top: 18px; font-size: 14px; }
  .totals div { display: flex; justify-content: space-between; padding: 7px 12px; }
  .totals .grand { border-top: 2px solid #a97f43; font-size: 19px; font-weight: 800; color: #a97f43; margin-top: 4px; padding-top: 12px; }
  .notes { margin-top: 34px; padding-top: 16px; border-top: 1px solid #eee; color: #444; font-size: 13px; white-space: pre-wrap; line-height: 1.5; }
  .notes .lbl { text-transform: uppercase; font-size: 11px; letter-spacing: 1px; color: #999; margin-bottom: 6px; }
  .foot { margin-top: 40px; text-align: center; color: #999; font-size: 12px; }
  @media print { body { padding: 0; } .noprint { display: none; } }
  .bar { text-align: center; margin-bottom: 24px; }
  .bar button { background: #a97f43; color: #fff; border: none; padding: 10px 22px; border-radius: 8px; font-size: 15px; cursor: pointer; }
</style></head><body>
  <div class="bar noprint"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="head">
    <div class="brand">
      <div class="logo"><img src="/icon-192.png" alt="" /><span class="name"><b>HEK</b><span>FENCING INC.</span></span></div>
      <div class="cinfo">
        ${COMPANY.locations.map(esc).join(' &nbsp;•&nbsp; ')}<br />
        ${COMPANY.phones.map(esc).join(' &nbsp;•&nbsp; ')}<br />
        ${COMPANY.emails.map(esc).join(' &nbsp;•&nbsp; ')}
      </div>
    </div>
    <div class="doc">
      <h1>QUOTE</h1>
      <div class="meta">
        ${q.number ? '#' + esc(q.number) + '<br />' : ''}
        ${fmtDate(q.quote_date || todayStr())}
      </div>
    </div>
  </div>

  <div class="to">
    <div class="lbl">Prepared for</div>
    <div class="who">${esc(c.name || '')}</div>
    ${c.address ? `<div class="det">${esc(c.address)}</div>` : ''}
    ${contact ? `<div class="det">${contact}</div>` : ''}
  </div>

  <table>
    <thead><tr>
      <th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit price</th><th class="r">Total</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="5" style="color:#999">No line items.</td></tr>'}</tbody>
  </table>

  <div class="totals">
    <div><span>Subtotal</span><span>${money(subtotal)}</span></div>
    <div><span>Tax (${fmtNum(taxRate)}%)</span><span>${money(tax)}</span></div>
    <div class="grand"><span>Total</span><span>${money(total)}</span></div>
  </div>

  ${q.notes ? `<div class="notes"><div class="lbl">Notes &amp; terms</div>${esc(q.notes)}</div>` : ''}

  <div class="foot">
    ${esc(COMPANY.serviceArea)} &nbsp;•&nbsp; ${esc(COMPANY.website)} &nbsp;•&nbsp; Prices in CAD<br />
    Thank you for the opportunity to earn your business — HEK Fencing Inc.
  </div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };<\/script>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) {
      alert('Please allow pop-ups to print or save the quote as a PDF.');
      return;
    }
    w.document.write(html);
    w.document.close();
  }

  // ---- events ----
  $('qNew').addEventListener('click', newQuote);
  $('qBack').addEventListener('click', () => load());
  $('qAddRow').addEventListener('click', () => addRow());
  $('qSave').addEventListener('click', save);
  $('qTax').addEventListener('input', computeTotals);
  $('qPrint').addEventListener('click', () => {
    const p = collect();
    openPrint({ number: currentNumber, ...p });
  });

  // Bill for an accepted quote: copies the customer and pricing into a new
  // invoice rather than making anyone retype it, and marks the quote accepted.
  if ($('qToInvoice'))
    $('qToInvoice').addEventListener('click', async () => {
      if (editingId == null) return;
      if (!confirm('Create an invoice from this quote?\n\nThe quote will be marked accepted.')) return;
      $('qMsg').className = 'msg';
      $('qMsg').textContent = 'Creating…';
      try {
        const inv = await api('/api/admin/quotes/' + editingId + '/invoice', { method: 'POST' });
        $('qMsg').className = 'msg ok';
        $('qMsg').textContent = `Invoice ${inv.number} created.`;
        const tab = document.querySelector('.side-nav .tab[data-tab="invoices"]');
        if (tab && tab.style.display !== 'none') {
          tab.click();
          if (window.Invoices) window.Invoices.openById(inv.id).catch(() => {});
        }
      } catch (e) {
        $('qMsg').className = 'msg err';
        $('qMsg').textContent = e.message;
      }
    });

  $('qItems').addEventListener('input', computeTotals);
  $('qItems').addEventListener('click', (e) => {
    const del = e.target.closest('.i-del');
    if (del) {
      del.closest('tr').remove();
      computeTotals();
    }
  });

  // Quick-add preset chips.
  $('qQuick').innerHTML = PRESETS.map(
    (p, i) => `<button type="button" class="chip" data-preset="${i}">+ ${esc(p.label)}</button>`
  ).join('');
  $('qQuick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const p = PRESETS[Number(b.dataset.preset)];
    addRow({ description: p.description, unit: p.unit, qty: 1, unit_price: '' });
  });

  // List row actions (edit / print / delete).
  $('qBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    // Clicking anywhere else on the row opens that quote for editing.
    if (!btn) {
      const row = e.target.closest('tr[data-id]');
      if (row) editQuote(Number(row.dataset.id));
      return;
    }
    const id = Number(btn.dataset.id);
    try {
      if (btn.dataset.act === 'print') {
        openPrint(await api('/api/admin/quotes/' + id));
      } else if (btn.dataset.act === 'del') {
        if (!confirm('Delete this quote?')) return;
        await api('/api/admin/quotes/' + id, { method: 'DELETE' });
        load();
      }
    } catch (err) {
      alert(err.message);
    }
  });

  // Called by the Pricing tab: open a fresh quote pre-filled with the estimate.
  function activateQuotesTab() {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.section').forEach((x) => x.classList.remove('active'));
    const tab = document.querySelector('[data-tab="quotes"]');
    if (tab) tab.classList.add('active');
    if ($('tab-quotes')) $('tab-quotes').classList.add('active');
  }
  function prefill(items, opts) {
    activateQuotesTab();
    newQuote();
    $('qItems').innerHTML = '';
    (items && items.length ? items : [{}]).forEach(addRow);
    if (opts && opts.tax != null) $('qTax').value = opts.tax;
    computeTotals();
  }

  window.Quotes = { load, prefill };
})();
