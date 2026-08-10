// Invoices — the money-owed side of the Quotes tab.
//
// An invoice differs from a quote in the two things that matter to the books:
// it has a due date and it tracks what has actually been paid. "Paid" and
// "overdue" are never stored — the server works them out from the payments and
// the due date, so the badge next to an invoice can't disagree with the numbers
// underneath it.
//
// Relies on window.HEKAdmin ({ api, esc }) from admin.js, loaded first.
(function () {
  const H = () => window.HEKAdmin || {};
  const api = (...a) => H().api(...a);
  const esc = (s) => (H().esc ? H().esc(s) : String(s));
  const $ = (id) => document.getElementById(id);

  let invoices = [];
  let totals = {};
  let editingId = null;
  let current = null; // the invoice being edited, as the server last returned it
  let qbLink = null; // deep link into QuickBooks for the invoice being edited
  let services = []; // rate book, for quick-add buttons
  let wired = false;

  const money = (n) =>
    '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtNum = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fmtDate = (iso) =>
    iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
  const todayStr = () => {
    const d = new Date();
    return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const dateInput = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');

  const COMPANY = {
    name: 'HEK Fencing Inc.',
    serviceArea: 'Serving South-Western Ontario',
    website: 'hekfencing.ca',
    locations: ['225439 Otterville Rd, Otterville, ON', '285794 Airport Rd, Norwich, ON'],
    phones: ['Henry (519) 983-0304', 'Barend (226) 228-1136'],
    emails: ['henry@hekfencing.com', 'barend@hekfencing.com'],
  };
  const DEFAULT_TERMS =
    'Payment due within 30 days of the invoice date. Prices in CAD. ' +
    'Cheques payable to HEK Fencing Inc. Thank you for your business.';

  const badge = (status) => {
    const cls =
      status === 'paid'
        ? 'status-approved'
        : status === 'overdue'
          ? 'status-declined'
          : status === 'sent'
            ? 'status-pending'
            : status === 'void'
              ? 'status-draft'
              : 'status-draft';
    return `<span class="badge ${cls}">${esc(status.charAt(0).toUpperCase() + status.slice(1))}</span>`;
  };

  function show(view) {
    $('invList').style.display = view === 'list' ? 'block' : 'none';
    $('invEditor').style.display = view === 'editor' ? 'block' : 'none';
  }

  // ---- list ----
  async function load() {
    wire();
    const d = await api('/api/admin/invoices');
    invoices = d.invoices || [];
    totals = d.totals || {};
    renderList();
    show('list');
  }

  function renderList() {
    $('invStatOutstanding').textContent = money(totals.outstanding);
    $('invStatOverdue').textContent = money(totals.overdue);
    $('invStatPaid').textContent = money(totals.paid);
    $('invStatCount').textContent = totals.count || 0;

    const needle = ($('invSearch').value || '').trim().toLowerCase();
    const filter = $('invFilter').value;
    const rows = invoices.filter((i) => {
      if (filter && i.status !== filter) return false;
      if (!needle) return true;
      return (
        (i.number || '').toLowerCase().includes(needle) ||
        ((i.customer && i.customer.name) || '').toLowerCase().includes(needle)
      );
    });

    $('invEmpty').style.display = rows.length ? 'none' : 'block';
    $('invBody').innerHTML = rows
      .map(
        (i) => `<tr class="clickable-row" data-id="${i.id}" title="Open this invoice">
          <td>${esc(i.number)}</td>
          <td>${esc((i.customer && i.customer.name) || '')}</td>
          <td class="qb-dim">${fmtDate(i.issue_date)}</td>
          <td class="qb-dim">${fmtDate(i.due_date)}</td>
          <td>${money(i.total)}</td>
          <td>${i.balance > 0 ? '<strong>' + money(i.balance) + '</strong>' : money(i.balance)}</td>
          <td>${badge(i.status)}</td>
        </tr>`
      )
      .join('');
  }

  // ---- line items (the DOM is the source of truth while typing) ----
  function addRow(item) {
    item = item || {};
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><input class="i-desc" value="${escAttr(item.description || '')}" placeholder="Description" /></td>` +
      `<td><input class="i-qty" inputmode="decimal" value="${item.qty != null && item.qty !== '' ? item.qty : ''}" /></td>` +
      `<td><input class="i-unit" value="${escAttr(item.unit || '')}" placeholder="ft" /></td>` +
      `<td><input class="i-price" inputmode="decimal" value="${item.unit_price != null && item.unit_price !== '' ? item.unit_price : ''}" /></td>` +
      `<td class="i-total">$0.00</td>` +
      `<td><button class="link-btn danger i-del" title="Remove">✕</button></td>`;
    $('invItems').appendChild(tr);
    compute();
  }

  function readItems() {
    return [...$('invItems').querySelectorAll('tr')]
      .map((tr) => ({
        description: tr.querySelector('.i-desc').value.trim(),
        qty: parseFloat(tr.querySelector('.i-qty').value) || 0,
        unit: tr.querySelector('.i-unit').value.trim(),
        unit_price: parseFloat(tr.querySelector('.i-price').value) || 0,
      }))
      .filter((it) => it.description || it.qty || it.unit_price);
  }

  function compute() {
    let subtotal = 0;
    [...$('invItems').querySelectorAll('tr')].forEach((tr) => {
      const line =
        (parseFloat(tr.querySelector('.i-qty').value) || 0) *
        (parseFloat(tr.querySelector('.i-price').value) || 0);
      subtotal += line;
      tr.querySelector('.i-total').textContent = money(line);
    });
    const taxRate = parseFloat($('invTax').value) || 0;
    const tax = (subtotal * taxRate) / 100;
    const total = subtotal + tax;
    const paid = current ? current.paid : 0;
    $('invSubtotal').textContent = money(subtotal);
    $('invTaxAmt').textContent = money(tax);
    $('invTotal').textContent = money(total);
    $('invPaid').textContent = money(paid);
    $('invBalance').textContent = money(total - paid);
  }

  // ---- editor ----
  function newInvoice(prefill) {
    editingId = null;
    current = null;
    $('invEditorTitle').textContent = 'New invoice';
    const p = prefill || {};
    const c = p.customer || {};
    $('icName').value = c.name || '';
    $('icPhone').value = c.phone || '';
    $('icEmail').value = c.email || '';
    $('icAddress').value = c.address || '';
    $('invIssue').value = todayStr();
    const due = new Date();
    due.setDate(due.getDate() + 30);
    $('invDue').value = new Date(due - due.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    $('invStatus').value = 'draft';
    $('invTax').value = p.tax_rate != null ? p.tax_rate : 13;
    $('invNotes').value = DEFAULT_TERMS;
    $('invItems').innerHTML = '';
    (p.items && p.items.length ? p.items : [{}]).forEach(addRow);
    $('invDerived').textContent = '';
    $('invMsg').textContent = '';
    $('invDelete').style.display = 'none';
    $('invPayCard').style.display = 'none';
    // Nothing to send until it has been saved and has a number.
    qbLink = null;
    $('invQbBox').style.display = 'none';
    compute();
    show('editor');
  }

  async function openInvoice(id) {
    const inv = await api('/api/admin/invoices/' + id);
    editingId = id;
    current = inv;
    $('invEditorTitle').textContent = 'Invoice ' + inv.number;
    const c = inv.customer || {};
    $('icName').value = c.name || '';
    $('icPhone').value = c.phone || '';
    $('icEmail').value = c.email || '';
    $('icAddress').value = c.address || '';
    $('invIssue').value = dateInput(inv.issue_date);
    $('invDue').value = dateInput(inv.due_date);
    $('invStatus').value = inv.stored_status;
    $('invTax').value = inv.tax_rate;
    $('invNotes').value = inv.notes || '';
    $('invItems').innerHTML = '';
    (inv.items && inv.items.length ? inv.items : [{}]).forEach(addRow);

    // The stored status is what you set; this line explains what the invoice
    // actually is right now, and why.
    const bits = [];
    if (inv.status !== inv.stored_status) bits.push(`Currently <strong>${esc(inv.status)}</strong>.`);
    if (inv.quote_id) bits.push(`Converted from quote #${inv.quote_id}.`);
    $('invDerived').innerHTML = bits.join(' ');

    $('invDelete').style.display = inv.payments.length ? 'none' : '';
    $('invPayCard').style.display = '';
    renderPayments(inv);
    renderQbBox(inv);
    $('invMsg').textContent = '';
    compute();
    show('editor');
  }

  // ---- QuickBooks (sending) ----
  // QuickBooks is what actually emails a customer, so this app only ever pushes
  // the invoice across and asks QuickBooks to send it.
  function renderQbBox(inv) {
    const box = $('invQbBox');
    // Only for a saved invoice — there is nothing to push until it exists.
    if (!inv || !inv.id) {
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    const q = inv.qbo || null;
    const sent = q && q.sent_at;
    const pushed = q && q.id;
    $('invQbState').textContent = sent ? 'Emailed' : pushed ? 'In QuickBooks' : 'Not sent yet';
    $('invQbState').className = 'qb-send-state' + (sent ? ' is-sent' : pushed ? ' is-pushed' : '');
    $('invQbHint').textContent = sent
      ? `Emailed by QuickBooks${q.sent_to ? ' to ' + q.sent_to : ''} on ${fmtDate(q.sent_at)}. Sending again resends it.`
      : pushed
        ? 'This invoice is in QuickBooks. Emailing it sends QuickBooks’ own invoice, with its payment link.'
        : 'Push this invoice into QuickBooks first, then QuickBooks emails it to the customer.';
    $('invQbPush').textContent = pushed ? 'Update it in QuickBooks' : 'Send to QuickBooks';
    $('invQbSend').disabled = !pushed;
    $('invQbSend').textContent = sent ? 'Email it again' : 'Email it to the customer';
    const open = $('invQbOpen');
    if (pushed && qbLink) {
      open.href = qbLink;
      open.style.display = '';
    } else {
      open.style.display = 'none';
    }
    $('invQbMsg').textContent = '';
  }

  async function qbPush() {
    const btn = $('invQbPush');
    btn.disabled = true;
    $('invQbMsg').className = 'msg';
    $('invQbMsg').textContent = 'Sending to QuickBooks…';
    try {
      const d = await api(`/api/admin/invoices/${editingId}/quickbooks`, { method: 'POST' });
      qbLink = d.link || null;
      current = await api('/api/admin/invoices/' + editingId);
      renderQbBox(current);
      $('invQbMsg').className = d.warning ? 'msg err' : 'msg ok';
      $('invQbMsg').textContent =
        d.warning ||
        (d.qbo.updated ? 'Updated in QuickBooks.' : 'Created in QuickBooks.') +
          (d.qbo.customer.created ? ` Added ${d.qbo.customer.name} as a customer.` : '');
    } catch (e) {
      $('invQbMsg').className = 'msg err';
      $('invQbMsg').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function qbSend() {
    const to = (current && current.customer && current.customer.email) || '';
    if (!confirm(to ? `Email this invoice to ${to} from QuickBooks?` : 'Email this invoice from QuickBooks?'))
      return;
    const btn = $('invQbSend');
    btn.disabled = true;
    $('invQbMsg').className = 'msg';
    $('invQbMsg').textContent = 'Asking QuickBooks to send it…';
    try {
      const d = await api(`/api/admin/invoices/${editingId}/quickbooks/send`, { method: 'POST' });
      current = await api('/api/admin/invoices/' + editingId);
      $('invStatus').value = current.stored_status;
      renderQbBox(current);
      $('invQbMsg').className = 'msg ok';
      $('invQbMsg').textContent = `QuickBooks emailed it${d.sent_to ? ' to ' + d.sent_to : ''}.`;
    } catch (e) {
      $('invQbMsg').className = 'msg err';
      $('invQbMsg').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function renderPayments(inv) {
    const rows = inv.payments || [];
    $('invPayEmpty').style.display = rows.length ? 'none' : 'block';
    $('invPayBody').innerHTML = rows
      .map(
        (p, i) => `<tr>
          <td class="qb-dim">${fmtDate(p.date)}</td>
          <td>${esc(p.method || '—')}</td>
          <td class="qb-dim">${esc(p.note || '')}</td>
          <td>${money(p.amount)}</td>
          <td><button class="link-btn danger inv-pay-del" data-index="${i}" title="Remove">✕</button></td>
        </tr>`
      )
      .join('');
  }

  function payload() {
    return {
      customer: {
        name: $('icName').value.trim(),
        phone: $('icPhone').value.trim(),
        email: $('icEmail').value.trim(),
        address: $('icAddress').value.trim(),
      },
      items: readItems(),
      tax_rate: parseFloat($('invTax').value) || 0,
      notes: $('invNotes').value.trim(),
      issue_date: $('invIssue').value || null,
      due_date: $('invDue').value || null,
      status: $('invStatus').value,
    };
  }

  async function save() {
    $('invMsg').className = 'msg err';
    const body = payload();
    if (!body.customer.name) {
      $('invMsg').textContent = 'Enter who this invoice is for.';
      return;
    }
    try {
      const saved = editingId
        ? await api('/api/admin/invoices/' + editingId, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/admin/invoices', { method: 'POST', body: JSON.stringify(body) });
      editingId = saved.id;
      current = saved;
      $('invMsg').className = 'msg ok';
      $('invMsg').textContent = 'Saved.';
      $('invEditorTitle').textContent = 'Invoice ' + saved.number;
      $('invPayCard').style.display = '';
      $('invDelete').style.display = saved.payments.length ? 'none' : '';
      renderPayments(saved);
      // A brand new invoice can be sent as soon as it has been saved.
      renderQbBox(saved);
      compute();
      // Keep the list and the header tiles honest behind the editor.
      const d = await api('/api/admin/invoices');
      invoices = d.invoices || [];
      totals = d.totals || {};
      renderList();
    } catch (e) {
      $('invMsg').textContent = e.message;
    }
  }

  // ---- printable invoice ----
  function openPrint(inv) {
    const items = inv.items || [];
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
    const taxRate = Number(inv.tax_rate) || 0;
    const tax = (subtotal * taxRate) / 100;
    const total = subtotal + tax;
    const paid = Number(inv.paid) || 0;
    const balance = total - paid;
    const c = inv.customer || {};
    const contact = [c.phone, c.email].filter(Boolean).join(' &nbsp;•&nbsp; ');
    const settled = balance <= 0 && total > 0;

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>${esc(inv.number || 'Invoice')} — HEK Fencing</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 40px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #a97f43; padding-bottom: 18px; gap: 20px; }
  .brand .logo img { width: 54px; height: 54px; vertical-align: middle; border-radius: 8px; }
  .brand .logo .name { display: inline-block; vertical-align: middle; margin-left: 12px; }
  .brand .logo .name b { font-size: 26px; letter-spacing: 4px; color: #a97f43; display: block; }
  .brand .logo .name span { font-size: 12px; letter-spacing: 3px; color: #555; }
  .brand .cinfo { margin-top: 12px; color: #666; font-size: 11.5px; line-height: 1.7; }
  .doc { text-align: right; }
  .doc h1 { margin: 0; font-size: 30px; letter-spacing: 3px; color: #a97f43; }
  .doc .meta { color: #555; font-size: 13px; margin-top: 6px; line-height: 1.6; }
  .doc .due { font-weight: 700; color: #1a1a1a; }
  .to { margin: 28px 0 8px; }
  .to .lbl { text-transform: uppercase; font-size: 11px; letter-spacing: 1px; color: #999; margin-bottom: 4px; }
  .to .who { font-size: 18px; font-weight: 700; }
  .to .det { color: #555; font-size: 14px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 22px; font-size: 14px; }
  th { background: #f4f0e8; color: #6b5228; text-align: left; padding: 10px 12px; font-size: 12px; letter-spacing: .5px; text-transform: uppercase; }
  td { padding: 11px 12px; border-bottom: 1px solid #eee; }
  th.r, td.r { text-align: right; }
  .totals { width: 320px; margin-left: auto; margin-top: 18px; font-size: 14px; }
  .totals div { display: flex; justify-content: space-between; padding: 7px 12px; }
  .totals .sep { border-top: 1px solid #eee; margin-top: 4px; padding-top: 11px; }
  .totals .grand { border-top: 2px solid #a97f43; font-size: 19px; font-weight: 800; color: #a97f43; margin-top: 4px; padding-top: 12px; }
  .stamp { margin: 26px 0 0; text-align: right; }
  .stamp span { display: inline-block; border: 3px solid #2f9257; color: #2f9257; padding: 6px 20px; border-radius: 8px; font-size: 20px; font-weight: 800; letter-spacing: 4px; transform: rotate(-3deg); }
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
      <h1>INVOICE</h1>
      <div class="meta">
        ${inv.number ? '#' + esc(inv.number) + '<br />' : ''}
        Issued ${fmtDate(inv.issue_date || todayStr())}<br />
        ${inv.due_date ? `<span class="due">Due ${fmtDate(inv.due_date)}</span>` : ''}
      </div>
    </div>
  </div>

  <div class="to">
    <div class="lbl">Bill to</div>
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
    <div class="sep"><span>Total</span><span>${money(total)}</span></div>
    ${paid ? `<div><span>Paid to date</span><span>−${money(paid)}</span></div>` : ''}
    <div class="grand"><span>${settled ? 'Balance' : 'Amount due'}</span><span>${money(Math.max(0, balance))}</span></div>
  </div>

  ${settled ? '<div class="stamp"><span>PAID</span></div>' : ''}
  ${inv.notes ? `<div class="notes"><div class="lbl">Notes &amp; terms</div>${esc(inv.notes)}</div>` : ''}

  <div class="foot">
    ${esc(COMPANY.serviceArea)} &nbsp;•&nbsp; ${esc(COMPANY.website)} &nbsp;•&nbsp; Prices in CAD<br />
    Thank you for your business — HEK Fencing Inc.
  </div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };<\/script>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) {
      alert('Please allow pop-ups to print or save the invoice as a PDF.');
      return;
    }
    w.document.write(html);
    w.document.close();
  }

  // ---- quick-add buttons, built from the rate book ----
  async function loadQuickAdds() {
    try {
      const book = await api('/api/admin/ratebook');
      services = book.services || [];
    } catch (e) {
      services = [];
    }
    $('invQuick').innerHTML = services
      .map((s, i) => `<button type="button" class="chip" data-i="${i}">+ ${esc(s.label)}</button>`)
      .join('');
  }

  // ---- wiring ----
  function wire() {
    if (wired) return;
    wired = true;
    loadQuickAdds();

    $('invNew').addEventListener('click', () => newInvoice());
    $('invBack').addEventListener('click', () => load().catch((e) => alert(e.message)));
    $('invSearch').addEventListener('input', renderList);
    $('invFilter').addEventListener('change', renderList);

    $('invBody').addEventListener('click', (ev) => {
      const row = ev.target.closest('tr[data-id]');
      if (row) openInvoice(Number(row.dataset.id)).catch((e) => alert(e.message));
    });

    $('invQuick').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.chip[data-i]');
      if (!btn) return;
      const s = services[Number(btn.dataset.i)];
      if (s) addRow({ description: s.label + ' — supply & install', unit: s.unit, unit_price: s.price });
    });

    $('invAddRow').addEventListener('click', () => addRow());
    $('invItems').addEventListener('input', compute);
    $('invItems').addEventListener('click', (ev) => {
      const del = ev.target.closest('.i-del');
      if (del) {
        del.closest('tr').remove();
        compute();
      }
    });
    $('invTax').addEventListener('input', compute);
    $('invSave').addEventListener('click', () => save());
    $('invQbPush').addEventListener('click', () => qbPush());
    $('invQbSend').addEventListener('click', () => qbSend());
    $('invPrint').addEventListener('click', () => {
      // Print exactly what's on screen, saved or not.
      openPrint({
        ...payload(),
        number: current ? current.number : '',
        paid: current ? current.paid : 0,
      });
    });

    $('invDelete').addEventListener('click', async () => {
      if (editingId == null) return;
      if (!confirm('Delete this invoice? This cannot be undone.')) return;
      try {
        await api('/api/admin/invoices/' + editingId, { method: 'DELETE' });
        await load();
      } catch (e) {
        $('invMsg').className = 'msg err';
        $('invMsg').textContent = e.message;
      }
    });

    $('invPayAdd').addEventListener('click', async () => {
      if (editingId == null) {
        $('invPayMsg').className = 'msg err';
        $('invPayMsg').textContent = 'Save the invoice before recording a payment.';
        return;
      }
      const amount = parseFloat($('invPayAmount').value);
      if (!amount || amount <= 0) {
        $('invPayMsg').className = 'msg err';
        $('invPayMsg').textContent = 'Enter an amount.';
        return;
      }
      try {
        const saved = await api('/api/admin/invoices/' + editingId + '/payments', {
          method: 'POST',
          body: JSON.stringify({
            amount,
            date: $('invPayDate').value || todayStr(),
            method: $('invPayMethod').value,
            note: $('invPayNote').value.trim(),
          }),
        });
        current = saved;
        renderPayments(saved);
        compute();
        $('invPayAmount').value = '';
        $('invPayNote').value = '';
        $('invDelete').style.display = 'none';
        $('invPayMsg').className = 'msg ok';
        $('invPayMsg').textContent = `Recorded. Balance ${money(saved.balance)}.`;
        const d = await api('/api/admin/invoices');
        invoices = d.invoices || [];
        totals = d.totals || {};
        renderList();
      } catch (e) {
        $('invPayMsg').className = 'msg err';
        $('invPayMsg').textContent = e.message;
      }
    });

    $('invPayBody').addEventListener('click', async (ev) => {
      const btn = ev.target.closest('.inv-pay-del');
      if (!btn || editingId == null) return;
      if (!confirm('Remove this payment?')) return;
      try {
        const saved = await api(
          '/api/admin/invoices/' + editingId + '/payments/' + btn.dataset.index,
          { method: 'DELETE' }
        );
        current = saved;
        renderPayments(saved);
        compute();
        $('invDelete').style.display = saved.payments.length ? 'none' : '';
      } catch (e) {
        $('invPayMsg').className = 'msg err';
        $('invPayMsg').textContent = e.message;
      }
    });
  }

  // Called by the Quotes tab after converting a quote.
  async function openById(id) {
    wire();
    await openInvoice(id);
  }

  window.Invoices = { load, openById };
})();
