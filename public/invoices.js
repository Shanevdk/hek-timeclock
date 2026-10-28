// Invoices — the money-owed side of the Quotes tab.
//
// An invoice differs from a quote in the two things that matter to the books:
// it has a due date and it tracks what has actually been paid. "Paid" and
// "overdue" are never stored — the server works them out from the payments and
// the due date, so the badge next to an invoice can't disagree with the numbers
// underneath it.
//
// Like the quote editor, the invoice is edited on a sheet laid out as the
// invoice itself (see paper.js); payments and QuickBooks sit underneath it.
//
// Relies on window.HEKAdmin ({ api, esc }) from admin.js, loaded first.
(function () {
  const H = () => window.HEKAdmin || {};
  const api = (...a) => H().api(...a);
  const esc = (s) => (H().esc ? H().esc(s) : String(s));
  const $ = (id) => document.getElementById(id);
  const P = window.HEKPaper;
  const { money, fmtNum, fmtDate, dayOf, todayStr, addDays, termDays, autosize, autosizeAll } = P;

  let invoices = [];
  let totals = {};
  let editingId = null;
  let current = null; // the invoice being edited, as the server last returned it
  let qbLink = null; // deep link into QuickBooks for the invoice being edited
  let shipment = null; // the job this invoice put on the Schedule board, if any
  let services = []; // rate book, for quick-add buttons
  let wired = false;
  // Which invoice is on screen: bumped whenever another is opened or started,
  // or the list is gone back to. Anything that waits on the server notes it
  // first and drops its reply if it changed — a late answer about one invoice
  // must not land on the next.
  let seq = 0;
  let saving = null; // the save in flight, so a second click joins it

  // The list, and one invoice, spelled the same way everywhere in this file:
  // kept copies are filed under the exact path, so the hover that fetches an
  // invoice and the click that opens it have to ask for the same string.
  const LIST = '/api/admin/invoices';
  const one = (id) => '/api/admin/invoices/' + id;
  // How old a kept invoice may be and still open without asking again: long
  // enough for one fetched on hover to serve the click that follows, short
  // enough that nobody starts editing a copy someone else has since changed.
  const FRESH_MS = 30000;
  // After any change to an invoice, its kept copy is out of date. Forgotten
  // here, so reopening it asks again — editing the copy from before a save
  // and saving that would quietly undo the first save.
  const changed = (id) => {
    if (id != null) Snappy.cache.drop(one(id));
  };
  // Answers about the list can land out of order — a slow read that set off
  // before a change can arrive after it. Each read is numbered as it starts;
  // one older than what the screen already shows (a newer read, or a change
  // made here) is dropped rather than painted over it.
  let asked = 0;
  let shown = 0;

  const escAttr = (s) => esc(s == null ? '' : s).replace(/"/g, '&quot;');
  // The due date and terms print in the header now, so these don't repeat them.
  const DEFAULT_TERMS = 'Prices in CAD. Cheques payable to HEK Fencing Inc. Thank you for your business.';

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

  // ---- the editor (one sheet, laid out like the printed invoice) ----
  $('invEditor').innerHTML = `
    <div class="doc-bar">
      <!-- Going back only shows the list, so a mouse does it on the way down
           (data-press, snappy.js). -->
      <button class="btn ghost sm" id="invBack" type="button" data-press="fast">← Invoices</button>
      <h2 id="invEditorTitle">New invoice</h2>
      <div class="doc-bar-actions">
        <label for="invStatus">Status</label>
        <select id="invStatus">
          <option value="draft">Draft</option>
          <option value="sent">Sent</option>
          <option value="void">Void</option>
        </select>
        <button class="btn ghost sm" id="invShip" type="button" hidden>Create shipment</button>
        <button class="btn ghost sm" id="invPrint" type="button">Print / PDF</button>
        <button class="btn gold sm" id="invSave" type="button">Save invoice</button>
      </div>
    </div>
    <p class="doc-note" id="invDerived"></p>
    <p class="doc-note" id="invShipNote"></p>
    <div class="msg err" id="invMsg"></div>

    <article class="paper" id="invPaper" aria-label="Invoice">
      <header class="paper-head">
        <div>
          <div class="paper-logo"><img src="/logo.svg" alt="HEK Fencing Inc." /></div>
          <div class="paper-co">${P.companyHtml()}</div>
        </div>
        <div class="paper-title">
          <h3>Invoice</h3>
          <dl class="paper-meta">
            <div><dt>Invoice no.</dt><dd><span class="paper-static" id="invNumber"></span></dd></div>
            <div><dt><label for="invIssue">Issued</label></dt><dd><input type="date" class="pf" id="invIssue" /></dd></div>
            <div><dt><label for="invTerms">Terms</label></dt><dd>
              <select class="pf" id="invTerms">${P.TERMS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
            </dd></div>
            <div><dt><label for="invDue">Due</label></dt><dd><input type="date" class="pf" id="invDue" /></dd></div>
            <div><dt><label for="invPo">PO no.</label></dt><dd><input class="pf" id="invPo" placeholder="Optional" /></dd></div>
            <div id="invQuoteRow" hidden><dt>Quote</dt><dd><span class="paper-static" id="invQuoteRef"></span></dd></div>
          </dl>
        </div>
      </header>

      <section class="paper-parties">
        <div class="paper-party">
          <div class="paper-lbl">Bill to</div>
          <input class="pf pf-strong" id="icName" placeholder="Customer name (required)" aria-label="Customer name" />
          <textarea class="pf" id="icAddress" rows="1" placeholder="Billing address" aria-label="Billing address"></textarea>
          <input class="pf" id="icPhone" placeholder="Phone" aria-label="Customer phone" />
          <input class="pf" id="icEmail" type="email" placeholder="Email (QuickBooks sends it here)" aria-label="Customer email" />
        </div>
        <div class="paper-party">
          <div class="paper-lbl">Job</div>
          <input class="pf pf-strong" id="invProject" placeholder="What we built, e.g. 6 ft wood privacy fence" aria-label="Project" />
          <textarea class="pf" id="invSite" rows="1" placeholder="Job site address, if it isn't the billing address" aria-label="Job site address"></textarea>
        </div>
      </section>

      <div class="paper-quick">
        <div class="paper-lbl">Quick add from the rate book</div>
        <div class="quick-adds" id="invQuick"></div>
      </div>

      <div class="paper-items-wrap">
        <table class="paper-items">
          <thead><tr>
            <th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit price</th><th class="r">Amount</th>
            <th><span class="sr-only">Remove</span></th>
          </tr></thead>
          <tbody id="invItems"></tbody>
        </table>
      </div>
      <button class="paper-add" id="invAddRow" type="button">+ Add line</button>

      <section class="paper-foot">
        <div class="paper-notes">
          <label class="paper-lbl" for="invNotes">Notes &amp; terms</label>
          <textarea class="pf" id="invNotes" rows="2" placeholder="e.g. Cheques payable to HEK Fencing Inc."></textarea>
        </div>
        <div class="paper-totals">
          <div class="paper-stamp" id="invStamp" hidden>PAID</div>
          <div class="pt-row"><span>Subtotal</span><span id="invSubtotal">$0.00</span></div>
          <div class="pt-row">
            <span>Tax <input class="pf pt-pct" id="invTax" inputmode="decimal" value="0" aria-label="Tax rate, percent" />%</span>
            <span id="invTaxAmt">$0.00</span>
          </div>
          <div class="pt-row pt-grand"><span>Total (CAD)</span><span id="invTotal">$0.00</span></div>
          <div class="pt-row"><span>Paid to date</span><span id="invPaid">$0.00</span></div>
          <div class="pt-row pt-due"><span id="invBalanceLbl">Balance due</span><span id="invBalance">$0.00</span></div>
        </div>
      </section>
    </article>

    <div class="doc-after">
      <!-- Payments -->
      <div class="card" id="invPayCard">
        <h3 style="margin-top:0">Payments</h3>
        <table>
          <thead><tr><th>Date</th><th>Method</th><th>Note</th><th>Amount</th><th></th></tr></thead>
          <tbody id="invPayBody"></tbody>
        </table>
        <p class="status-sub" id="invPayEmpty" style="display:none">Nothing received yet.</p>
        <div class="row" style="margin-top:12px">
          <div class="field" style="flex:1 1 120px"><label for="invPayAmount">Amount</label><input id="invPayAmount" inputmode="decimal" placeholder="0.00" /></div>
          <div class="field" style="flex:1 1 140px"><label for="invPayDate">Date</label><input type="date" id="invPayDate" /></div>
          <div class="field" style="flex:1 1 140px"><label for="invPayMethod">Method</label>
            <select id="invPayMethod">
              <option value="">—</option><option>Cheque</option><option>E-transfer</option>
              <option>Cash</option><option>Credit card</option><option>Bank transfer</option>
            </select></div>
          <div class="field" style="flex:2 1 180px"><label for="invPayNote">Note</label><input id="invPayNote" placeholder="e.g. cheque #204" /></div>
          <button class="btn ghost sm" id="invPayRest" type="button">Fill balance</button>
          <button class="btn gold sm" id="invPayAdd" type="button">Record payment</button>
        </div>
        <div class="msg" id="invPayMsg"></div>
      </div>

      <!-- Sending goes through QuickBooks: it holds the customer, the
           branding and the payment link, so this app never emails one. -->
      <div class="card qb-send" id="invQbBox" style="display:none;margin-top:16px">
        <div class="qb-send-head">
          <h3 style="margin:0">Send with QuickBooks</h3>
          <span class="qb-send-state" id="invQbState"></span>
        </div>
        <p class="status-sub" style="text-align:left;margin:6px 0 12px" id="invQbHint"></p>
        <div class="row">
          <button class="btn ghost sm" id="invQbPush" type="button">Send to QuickBooks</button>
          <button class="btn gold sm" id="invQbSend" type="button" disabled>Email it to the customer</button>
          <a class="btn ghost sm" id="invQbOpen" target="_blank" rel="noopener" style="display:none">Open in QuickBooks</a>
        </div>
        <div class="msg" id="invQbMsg"></div>
      </div>

      <div class="row" style="justify-content:flex-start;margin-top:12px">
        <button class="link-btn danger" id="invDelete" type="button" style="display:none">Delete this invoice</button>
      </div>
    </div>`;

  function show(view) {
    $('invList').style.display = view === 'list' ? 'block' : 'none';
    $('invEditor').style.display = view === 'editor' ? 'block' : 'none';
    // Textareas can only measure themselves once they are on screen.
    if (view === 'editor') autosizeAll($('invPaper'));
  }

  // ---- list ----
  // Opens on the last copy kept on this device — numbers, names and totals,
  // nothing more — then on the server's answer if that differs.
  function load() {
    wire();
    // Back on the list: an invoice still on its way must not open over it.
    const s = ++seq;
    const n = ++asked;
    let painted = false;
    const done = Snappy.swr(
      api,
      LIST,
      (d, fresh) => {
        painted = true;
        if (n < shown) return;
        shown = n;
        take(d);
        renderList(fresh);
        // Unless an invoice has been opened, or a new one started, since.
        if (s === seq) show('list');
      },
      { persist: true }
    );
    if (!painted) {
      // Nothing kept yet. Rows already drawn stay until the answer replaces
      // them; an empty table says it's loading, but only once the wait is long
      // enough to notice (styles.css, .wait).
      if (!$('invBody').children.length) {
        $('invEmpty').style.display = 'none';
        $('invBody').innerHTML = '<tr class="wait"><td colspan="7" class="qb-dim">Loading invoices…</td></tr>';
      }
      show('list');
    }
    return done;
  }

  function take(d) {
    invoices = d.invoices || [];
    totals = d.totals || {};
  }

  // A row's HTML, worked out once per invoice and reused while the search box
  // is typed in, so filtering a few thousand invoices costs next to nothing.
  const rowHtml = new WeakMap();
  function rowFor(i) {
    let html = rowHtml.get(i);
    if (!html) {
      // Opening an invoice only shows it, so a mouse opens it on the way down
      // (data-press, snappy.js).
      html = `<tr class="clickable-row" data-id="${i.id}" data-press="fast" title="Open this invoice">
          <td>${esc(i.number)}</td>
          <td>${esc((i.customer && i.customer.name) || '')}${i.project ? `<div class="qb-dim" style="font-size:12px">${esc(i.project)}</div>` : ''}</td>
          <td class="qb-dim">${fmtDate(i.issue_date) || '—'}</td>
          <td class="qb-dim">${fmtDate(i.due_date) || '—'}</td>
          <td>${money(i.total)}</td>
          <td>${i.balance > 0 ? '<strong>' + money(i.balance) + '</strong>' : money(i.balance)}</td>
          <td>${badge(i.status)}</td>
        </tr>`;
      rowHtml.set(i, html);
    }
    return html;
  }

  // `keep`: the same list, refreshed — draw at least as many rows as are
  // already there, so the page doesn't shrink under someone scrolled down it.
  // A new search or filter starts again from the top.
  function renderList(keep) {
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
        ((i.customer && i.customer.name) || '').toLowerCase().includes(needle) ||
        (i.project || '').toLowerCase().includes(needle)
      );
    });

    $('invEmpty').style.display = rows.length ? 'none' : 'block';
    const body = $('invBody');
    const drawn = keep ? body.querySelectorAll('tr[data-id]').length : 0;
    // A screenful now and the rest as it is scrolled toward: thousands of
    // rows parsed in one go would freeze a phone.
    Snappy.chunks(body, rows.map(rowFor), { first: Math.max(60, drawn) });
  }

  // The header tiles less one invoice, added up the way the server does it:
  // a voided invoice never counted, and only money still owed is outstanding.
  function without(t, inv) {
    if (inv.status === 'void') return t;
    const owed = Math.max(0, Number(inv.balance) || 0);
    const cents = (n) => Math.round(n * 100) / 100;
    return {
      ...t,
      outstanding: cents((t.outstanding || 0) - owed),
      overdue: cents((t.overdue || 0) - (inv.status === 'overdue' ? owed : 0)),
      paid: cents((t.paid || 0) - (Number(inv.paid) || 0)),
      count: Math.max(0, (t.count || 0) - 1),
    };
  }

  // Takes an invoice off the list — on screen and in the kept copy — and goes
  // back to the list. Returns what puts it back.
  function takeOut(id) {
    const was = { invoices, totals };
    const gone = invoices.find((i) => i.id === id);
    invoices = invoices.filter((i) => i.id !== id);
    if (gone) totals = without(totals, gone);
    shown = ++asked; // newer than any read of the list already on its way
    const left = totals;
    Snappy.cache.update(LIST, (d) => ({ ...d, invoices: (d.invoices || []).filter((i) => i.id !== id), totals: left }));
    Snappy.cache.drop(one(id));
    // Its editor is closing: a late answer about it must land nowhere.
    seq++;
    editingId = null;
    current = null;
    renderList(true);
    show('list');
    return () => {
      invoices = was.invoices;
      totals = was.totals;
      shown = ++asked;
      Snappy.cache.update(LIST, (d) => ({ ...d, ...was }));
      renderList(true);
    };
  }

  // ---- line items (the DOM is the source of truth while typing) ----
  function addRow(item) {
    item = item || {};
    const val = (v) => (v != null && v !== '' ? escAttr(v) : '');
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><textarea class="pf i-desc" rows="1" placeholder="Description" aria-label="Description">${esc(item.description || '')}</textarea></td>` +
      `<td><input class="pf r i-qty" inputmode="decimal" value="${val(item.qty)}" placeholder="Qty" aria-label="Quantity" /></td>` +
      `<td><input class="pf i-unit" value="${val(item.unit)}" placeholder="ft / ea / hr" aria-label="Unit" /></td>` +
      `<td><input class="pf r i-price" inputmode="decimal" value="${val(item.unit_price)}" placeholder="0.00" aria-label="Unit price" /></td>` +
      `<td class="i-total">$0.00</td>` +
      `<td><button class="paper-del i-del" type="button" title="Remove line" aria-label="Remove line">✕</button></td>`;
    $('invItems').appendChild(tr);
    autosize(tr.querySelector('textarea'));
    compute();
    return tr;
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
    const items = [...$('invItems').querySelectorAll('tr')].map((tr) => {
      const it = {
        qty: parseFloat(tr.querySelector('.i-qty').value) || 0,
        unit_price: parseFloat(tr.querySelector('.i-price').value) || 0,
      };
      tr.querySelector('.i-total').textContent = money(P.lineAmount(it));
      return it;
    });
    // The same arithmetic as the server (totals.js), so "Fill balance" records
    // exactly what the server thinks is owed and the invoice really settles.
    const { subtotal, tax, total } = P.totalsOf({ items, tax_rate: parseFloat($('invTax').value) || 0 });
    const paid = current ? current.paid : 0;
    const balance = Math.round((total - paid) * 100) / 100;
    const settled = !!current && total > 0 && balance <= 0 && $('invStatus').value !== 'void';
    $('invSubtotal').textContent = money(subtotal);
    $('invTaxAmt').textContent = money(tax);
    $('invTotal').textContent = money(total);
    $('invPaid').textContent = paid ? '−' + money(paid) : money(0);
    // Paid more than is owed: say so, rather than showing a balance of $0.
    $('invBalanceLbl').textContent = balance < 0 ? 'Credit' : settled ? 'Balance' : 'Balance due';
    $('invBalance').textContent = money(Math.abs(balance));
    $('invStamp').hidden = !settled;
    $('invPayRest').style.display = current && balance > 0 ? '' : 'none';
    return { total, balance };
  }

  // The due date follows the issue date and the terms, until someone picks a
  // due date by hand — then the terms say "Custom" rather than something untrue.
  function syncDue() {
    const days = termDays($('invTerms').value);
    if (days != null) $('invDue').value = addDays($('invIssue').value || todayStr(), days);
  }
  function termsFromDates(issue, due) {
    if (!issue || !due) return 'custom';
    const match = P.TERMS.find(([, , d]) => d != null && addDays(issue, d) === due);
    return match ? match[0] : 'custom';
  }

  function setTitle(number) {
    $('invNumber').textContent = number || 'Assigned on save';
    $('invNumber').classList.toggle('pending', !number);
    const name = $('icName').value.trim();
    $('invEditorTitle').textContent = number ? 'Invoice ' + number + (name ? ' — ' + name : '') : 'New invoice';
  }

  function setQuoteRef(inv) {
    const ref = inv && (inv.quote_number || (inv.quote_id ? '#' + inv.quote_id : ''));
    $('invQuoteRow').hidden = !ref;
    $('invQuoteRef').textContent = ref || '';
  }

  // ---- editor ----
  function newInvoice(prefill) {
    editingId = null;
    current = null;
    const p = prefill || {};
    const c = p.customer || {};
    $('icName').value = c.name || '';
    $('icPhone').value = c.phone || '';
    $('icEmail').value = c.email || '';
    $('icAddress').value = c.address || '';
    $('invProject').value = p.project || '';
    $('invSite').value = p.job_site || '';
    $('invPo').value = '';
    $('invIssue').value = todayStr();
    $('invTerms').value = 'net30';
    syncDue();
    $('invStatus').value = 'draft';
    $('invTax').value = p.tax_rate != null ? p.tax_rate : 13;
    $('invNotes').value = DEFAULT_TERMS;
    $('invItems').innerHTML = '';
    (p.items && p.items.length ? p.items : [{}]).forEach(addRow);
    setTitle(null);
    setQuoteRef(null);
    $('invDerived').textContent = '';
    $('invMsg').textContent = '';
    $('invDelete').style.display = 'none';
    $('invPayCard').style.display = 'none';
    // Nothing to send until it has been saved and has a number.
    qbLink = null;
    seq++;
    $('invQbBox').style.display = 'none';
    shipment = null;
    renderShip();
    compute();
    show('editor');
    $('icName').focus();
  }

  async function openInvoice(id) {
    const s = ++seq;
    const path = one(id);
    // Fetched a moment ago — on hover, or as the press landed — it opens at
    // once, or joins the fetch still on its way. An older copy is asked for
    // again rather than edited stale.
    const inv = Snappy.cache.fresh(path, FRESH_MS) ? Snappy.cache.peek(path) : await Snappy.load(api, path);
    if (s !== seq) return; // another invoice was opened while this one loaded
    editingId = id;
    // The deep link belongs to whichever invoice was pushed last; this one's
    // comes back when it is pushed, or is worked out by renderQbBox.
    qbLink = null;
    current = inv;
    const c = inv.customer || {};
    $('icName').value = c.name || '';
    $('icPhone').value = c.phone || '';
    $('icEmail').value = c.email || '';
    $('icAddress').value = c.address || '';
    $('invProject').value = inv.project || '';
    $('invSite').value = inv.job_site || '';
    $('invPo').value = inv.po || '';
    $('invIssue').value = dayOf(inv.issue_date);
    $('invDue').value = dayOf(inv.due_date);
    // Invoices from before terms existed: name the terms their dates describe.
    $('invTerms').value = inv.terms && inv.terms !== 'net30'
      ? inv.terms
      : termsFromDates($('invIssue').value, $('invDue').value);
    $('invStatus').value = inv.stored_status;
    $('invTax').value = inv.tax_rate;
    $('invNotes').value = inv.notes || '';
    $('invItems').innerHTML = '';
    (inv.items && inv.items.length ? inv.items : [{}]).forEach(addRow);
    setTitle(inv.number);
    setQuoteRef(inv);
    renderDerived(inv);

    $('invDelete').style.display = deletable(inv) ? '' : 'none';
    $('invPayCard').style.display = '';
    $('invPayDate').value = todayStr();
    renderPayments(inv);
    renderQbBox(inv);
    shipment = inv.shipment || null;
    renderShip();
    $('invMsg').textContent = '';
    compute();
    show('editor');
  }

  // ---- shipment (to the Schedule board) ----
  // One click puts the job in "To be scheduled" with the address, the customer,
  // what's going and the load list. Once it exists the button opens it there.
  const scheduleTab = () => {
    const tab = document.querySelector('.side-nav .tab[data-tab="schedule"]');
    return tab && tab.style.display !== 'none' ? tab : null;
  };

  function renderShip() {
    const btn = $('invShip');
    const note = $('invShipNote');
    // Needs a saved invoice, and a board to hand it to.
    const can = editingId != null && !!scheduleTab();
    btn.hidden = !can;
    if (!can || !shipment) {
      btn.textContent = 'Create shipment';
      note.innerHTML = '';
      return;
    }
    btn.textContent = 'Open shipment ↗';
    const when = shipment.date
      ? `booked for ${esc(fmtDate(shipment.date))}${shipment.end_date ? ' – ' + esc(fmtDate(shipment.end_date)) : ''}`
      : 'waiting in <b>To be scheduled</b>';
    note.innerHTML = `${esc(shipment.job_type)} #${shipment.id} is on the Schedule board, ${when}.
      <button class="link-btn" id="invShipAgain" type="button">+ Another shipment</button>`;
  }

  let shipping = false;
  async function createShipment(again) {
    // One at a time: a double click must not put the job on the board twice.
    if (shipping) return;
    shipping = true;
    const forInvoice = editingId;
    try {
      // It writes to the board, so it waits for the server: the button is
      // busy at once and shows a spinner only if that takes a moment.
      await Snappy.busy($('invShip'), async () => {
        // Saved first, so the shipment carries what is on screen.
        if (!(await save())) return;
        // Said only once the wait is long enough to need saying (.wait).
        $('invMsg').className = 'msg wait';
        $('invMsg').textContent = 'Putting it on the schedule…';
        const invId = editingId;
        const r = await api(`/api/admin/invoices/${invId}/shipment`, {
          method: 'POST',
          body: JSON.stringify({ again: !!again }),
        });
        // The invoice now points at its job, and the board's kept copy
        // doesn't have that job yet.
        changed(invId);
        Snappy.cache.drop('/api/admin/schedules');
        if (editingId !== forInvoice && forInvoice != null) return; // another invoice is open now
        shipment = r.shipment;
        renderShip();
        $('invMsg').className = 'msg ok';
        $('invMsg').textContent = `Shipment #${r.id} is in “To be scheduled” on the Schedule board.`;
      });
    } catch (e) {
      $('invMsg').className = 'msg err';
      $('invMsg').textContent = e.message;
    } finally {
      shipping = false;
    }
  }

  function openShipment() {
    const tab = scheduleTab();
    if (!tab || !shipment || !window.Schedule || !window.Schedule.openJob) return;
    tab.click();
    window.Schedule.openJob(shipment.id).catch((e) => alert(e.message));
  }

  // The stored status is what you set; this line explains what the invoice
  // actually is right now, and why.
  function renderDerived(inv) {
    const bits = [];
    if (inv.status !== inv.stored_status) bits.push(`Currently <strong>${esc(inv.status)}</strong>.`);
    if (inv.status === 'overdue') bits.push(`It was due ${fmtDate(inv.due_date)}.`);
    $('invDerived').innerHTML = bits.join(' ');
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

  // Both of these write to the company's books or email a customer, so
  // neither shows anything as done before QuickBooks says so. The button is
  // busy at once (a spinner only if the wait is noticeable), the line saying
  // what's happening appears only if it takes a moment (.wait), and the
  // answer is painted only if the same invoice is still the one open.
  async function qbPush() {
    const s = seq;
    const id = editingId;
    $('invQbMsg').className = 'msg wait';
    $('invQbMsg').textContent = 'Sending to QuickBooks…';
    try {
      const { d, inv } = await Snappy.busy($('invQbPush'), async () => {
        const d = await api(`/api/admin/invoices/${id}/quickbooks`, { method: 'POST' });
        changed(id);
        return { d, inv: await api(one(id)) };
      });
      if (s !== seq) return; // another invoice is on screen now
      qbLink = d.link || null;
      current = inv;
      renderQbBox(current);
      $('invQbMsg').className = d.warning ? 'msg err' : 'msg ok';
      $('invQbMsg').textContent =
        d.warning ||
        (d.qbo.updated ? 'Updated in QuickBooks.' : 'Created in QuickBooks.') +
          (d.qbo.customer.created ? ` Added ${d.qbo.customer.name} as a customer.` : '');
      // The list learns it is in QuickBooks now, which decides how it can go.
      refreshList().catch(() => {});
    } catch (e) {
      if (s !== seq) return;
      $('invQbMsg').className = 'msg err';
      $('invQbMsg').textContent = e.message;
    }
  }

  async function qbSend() {
    const to = (current && current.customer && current.customer.email) || '';
    if (!confirm(to ? `Email this invoice to ${to} from QuickBooks?` : 'Email this invoice from QuickBooks?'))
      return;
    const s = seq;
    const id = editingId;
    $('invQbMsg').className = 'msg wait';
    $('invQbMsg').textContent = 'Asking QuickBooks to send it…';
    try {
      const { d, inv } = await Snappy.busy($('invQbSend'), async () => {
        const d = await api(`/api/admin/invoices/${id}/quickbooks/send`, { method: 'POST' });
        changed(id);
        return { d, inv: await api(one(id)) };
      });
      if (s !== seq) return; // another invoice is on screen now
      current = inv;
      $('invStatus').value = current.stored_status;
      renderQbBox(current);
      $('invQbMsg').className = 'msg ok';
      $('invQbMsg').textContent = `QuickBooks emailed it${d.sent_to ? ' to ' + d.sent_to : ''}.`;
      // Emailing it marks a draft as sent; the list's badge says so too.
      refreshList().catch(() => {});
    } catch (e) {
      if (s !== seq) return;
      $('invQbMsg').className = 'msg err';
      $('invQbMsg').textContent = e.message;
    }
  }

  function renderPayments(inv) {
    const rows = inv.payments || [];
    $('invPayEmpty').style.display = rows.length ? 'none' : 'block';
    $('invPayBody').innerHTML = rows
      .map(
        (p) => `<tr>
          <td class="qb-dim">${fmtDate(p.date) || '—'}</td>
          <td>${esc(p.method || '—')}</td>
          <td class="qb-dim">${esc(p.note || '')}</td>
          <td>${money(p.amount)}</td>
          <td><button class="link-btn danger inv-pay-del" data-id="${escAttr(p.id || '')}" title="Remove">✕</button></td>
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
      project: $('invProject').value.trim(),
      job_site: $('invSite').value.trim(),
      po: $('invPo').value.trim(),
      terms: $('invTerms').value,
      items: readItems(),
      tax_rate: parseFloat($('invTax').value) || 0,
      notes: $('invNotes').value.trim(),
      issue_date: $('invIssue').value || null,
      due_date: $('invDue').value || null,
      status: $('invStatus').value,
    };
  }

  // The list as it stands after a change made here. Always asked for afresh:
  // the kept copy, or a read that set off before the change, would be older.
  async function refreshList() {
    const n = ++asked;
    const d = await api(LIST);
    if (n < shown) return;
    shown = n;
    Snappy.cache.put(LIST, d, true);
    take(d);
    renderList(true);
  }

  async function save() {
    $('invMsg').className = 'msg err';
    const body = payload();
    if (!body.customer.name) {
      $('invMsg').textContent = 'Enter who this invoice is for.';
      $('icName').focus();
      return false;
    }
    // One save at a time: a double click on a new invoice would otherwise
    // POST twice and make two invoices.
    if (saving) return saving;
    const s = seq;
    const run = (async () => {
      const saved = editingId
        ? await api('/api/admin/invoices/' + editingId, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/admin/invoices', { method: 'POST', body: JSON.stringify(body) });
      changed(saved.id);
      // Saved — but if another invoice is on screen now, this reply is not
      // about it and must not be painted over it. The list behind still
      // catches up.
      if (s !== seq) {
        refreshList().catch(() => {});
        return true;
      }
      editingId = saved.id;
      current = saved;
      $('invMsg').className = saved.warning ? 'msg err' : 'msg ok';
      // e.g. voided here but QuickBooks couldn't void its copy.
      $('invMsg').textContent = saved.warning || 'Saved.';
      setTitle(saved.number);
      renderDerived(saved);
      $('invPayCard').style.display = '';
      if (!$('invPayDate').value) $('invPayDate').value = todayStr();
      $('invDelete').style.display = deletable(saved) ? '' : 'none';
      renderPayments(saved);
      // A brand new invoice can be sent as soon as it has been saved.
      renderQbBox(saved);
      renderShip();
      compute();
      // Keep the list and the header tiles honest behind the editor — in the
      // background: the save is done, and a slow list mustn't hold the button
      // or turn a good save into an error.
      refreshList().catch(() => {});
      return true;
    })();
    saving = run
      .catch((e) => {
        if (s === seq) $('invMsg').textContent = e.message;
        return false;
      })
      .finally(() => {
        saving = null;
      });
    return saving;
  }

  // Delete is offered only where the server allows it: no payments recorded,
  // and not yet in QuickBooks (that one is voided instead).
  const deletable = (inv) => !(inv.payments || []).length && !(inv.qbo && inv.qbo.id);

  // ---- quick-add buttons, built from the rate book ----
  async function loadQuickAdds() {
    try {
      // Through the shared loader, so it joins the same request when another
      // tab (Estimate requests, Pricing) is already asking for the rate book.
      const book = await Snappy.load(api, '/api/admin/ratebook');
      services = book.services || [];
    } catch (e) {
      services = [];
    }
    $('invQuick').innerHTML = services
      .map((s, i) => `<button type="button" class="chip" data-i="${i}">+ ${esc(s.label)}</button>`)
      .join('');
    $('invQuick').parentElement.style.display = services.length ? '' : 'none';
  }

  // ---- wiring ----
  function wire() {
    if (wired) return;
    wired = true;
    loadQuickAdds();

    $('invNew').addEventListener('click', () => newInvoice());
    $('invBack').addEventListener('click', () => load().catch((e) => alert(e.message)));
    // A new search starts the list again from its first screenful.
    $('invSearch').addEventListener('input', () => renderList());
    $('invFilter').addEventListener('change', () => renderList());

    $('invBody').addEventListener('click', (ev) => {
      const row = ev.target.closest('tr[data-id]');
      if (row) openInvoice(Number(row.dataset.id)).catch((e) => alert(e.message));
    });
    // A mouse resting on a row, or a finger landing on it, starts fetching that
    // invoice; the click that follows finds it on its way, or already here.
    Snappy.intent($('invBody'), 'tr[data-id]', (tr) => Snappy.prefetch(api, one(tr.dataset.id)));

    $('invQuick').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.chip[data-i]');
      if (!btn) return;
      const s = services[Number(btn.dataset.i)];
      if (!s) return;
      // Fill the blank line a new invoice starts with instead of leaving it empty.
      const blank = [...$('invItems').querySelectorAll('tr')].find(
        (tr) => !tr.querySelector('.i-desc').value.trim() && !tr.querySelector('.i-price').value.trim()
      );
      if (blank) blank.remove();
      addRow({ description: s.label + ' — supply & install', unit: s.unit, unit_price: s.price })
        .querySelector('.i-qty')
        .focus();
    });

    // Everything typed on the sheet: grow textareas, keep the totals live.
    $('invPaper').addEventListener('input', (ev) => {
      autosize(ev.target);
      compute();
    });
    $('icName').addEventListener('input', () => setTitle(current ? current.number : null));
    $('invTerms').addEventListener('change', syncDue);
    $('invIssue').addEventListener('change', syncDue);
    $('invDue').addEventListener('change', () => {
      $('invTerms').value = termsFromDates($('invIssue').value, $('invDue').value);
    });
    $('invStatus').addEventListener('change', compute);

    $('invAddRow').addEventListener('click', () => addRow().querySelector('.i-desc').focus());
    $('invItems').addEventListener('click', (ev) => {
      const del = ev.target.closest('.i-del');
      if (del) {
        del.closest('tr').remove();
        compute();
      }
    });
    // Busy at once, so a second press can't start a second save; the spinner
    // shows only if the server takes a moment.
    $('invSave').addEventListener('click', () => Snappy.busy($('invSave'), save));
    $('invShip').addEventListener('click', () => (shipment ? openShipment() : createShipment(false)));
    $('invShipNote').addEventListener('click', (ev) => {
      if (!ev.target.closest('#invShipAgain')) return;
      // Split deliveries are real, but a second one should never be an accident.
      if (confirm('Put another shipment for this invoice on the schedule?')) createShipment(true);
    });
    $('invQbPush').addEventListener('click', () => qbPush());
    $('invQbSend').addEventListener('click', () => qbSend());
    $('invPrint').addEventListener('click', () => {
      // Print exactly what's on screen, saved or not.
      P.openPrint(
        {
          ...payload(),
          number: current ? current.number : '',
          paid: current ? current.paid : 0,
          quote_number: current ? current.quote_number : null,
        },
        'invoice'
      );
    });

    $('invDelete').addEventListener('click', async () => {
      if (editingId == null) return;
      if (!confirm('Delete this invoice? This cannot be undone.')) return;
      const id = editingId;
      const row = invoices.find((i) => i.id === id);
      // Gone from the list at once only where the server is sure to agree: no
      // payments and not in QuickBooks — by the editor's copy, which knows the
      // payments, and by the list's, which knows QuickBooks. Anything else
      // waits for the server's answer, which may well be "void it instead".
      const sure =
        !!current &&
        current.id === id &&
        deletable(current) &&
        !(row && ((row.qbo && row.qbo.id) || row.paid));
      if (!sure) {
        try {
          await Snappy.busy($('invDelete'), () => api(one(id), { method: 'DELETE' }));
          changed(id);
          Snappy.cache.drop('/api/admin/quotes');
          await load();
        } catch (e) {
          $('invMsg').className = 'msg err';
          $('invMsg').textContent = e.message;
        }
        return;
      }
      try {
        await Snappy.optimistic(
          () => takeOut(id),
          () => api(one(id), { method: 'DELETE' })
        );
      } catch (e) {
        // It's back on the list where it was; say why it's still there.
        alert(e.message);
        refreshList().catch(() => {});
        return;
      }
      // Its quote can be invoiced again, which the Quotes list shows.
      Snappy.cache.drop('/api/admin/quotes');
      refreshList().catch(() => {});
    });

    // Most payments settle the invoice, so offer the balance rather than
    // making anyone work it out.
    $('invPayRest').addEventListener('click', () => {
      const { balance } = compute();
      if (balance > 0) $('invPayAmount').value = balance.toFixed(2);
      $('invPayAmount').focus();
    });

    $('invPayAdd').addEventListener('click', async () => {
      if (editingId == null) {
        $('invPayMsg').className = 'msg err';
        $('invPayMsg').textContent = 'Save the invoice before recording a payment.';
        return;
      }
      // "$1,200" is twelve hundred dollars, not one (as parseFloat reads it).
      const amount = window.HEKTakeoff ? window.HEKTakeoff.parseAmount($('invPayAmount').value) : parseFloat($('invPayAmount').value);
      if (!amount || amount <= 0) {
        $('invPayMsg').className = 'msg err';
        $('invPayMsg').textContent = 'Enter an amount.';
        return;
      }
      // One recording at a time: a double click must not take the money twice.
      // Busy (disabled) the moment it's pressed; money is shown as received
      // only once the server has recorded it, never ahead of it.
      const btn = $('invPayAdd');
      if (btn.disabled) return;
      const s = seq;
      const id = editingId;
      try {
        const saved = await Snappy.busy(btn, () =>
          api('/api/admin/invoices/' + id + '/payments', {
            method: 'POST',
            body: JSON.stringify({
              amount,
              date: $('invPayDate').value || todayStr(),
              method: $('invPayMethod').value,
              note: $('invPayNote').value.trim(),
            }),
          })
        );
        // Recorded whatever is on screen now, so the kept copy is forgotten
        // and the list behind catches up either way.
        changed(id);
        refreshList().catch(() => {});
        if (s !== seq) return; // recorded — but another invoice is on screen now
        current = saved;
        renderPayments(saved);
        renderDerived(saved);
        compute();
        $('invPayAmount').value = '';
        $('invPayNote').value = '';
        $('invDelete').style.display = 'none';
        $('invPayMsg').className = 'msg ok';
        $('invPayMsg').textContent = `Recorded. Balance ${money(saved.balance)}.`;
      } catch (e) {
        if (s === seq) {
          $('invPayMsg').className = 'msg err';
          $('invPayMsg').textContent = e.message;
        }
      }
    });

    $('invPayBody').addEventListener('click', async (ev) => {
      const btn = ev.target.closest('.inv-pay-del');
      if (!btn || editingId == null || btn.disabled) return;
      if (!confirm('Remove this payment?')) return;
      // By the payment's own id: its row number may have changed since this
      // list was drawn. Busy (disabled) while in flight so a second click
      // can't remove a second payment — and, being money, the row goes only
      // once the server has taken it off.
      const s = seq;
      const id = editingId;
      try {
        const saved = await Snappy.busy(btn, () =>
          api('/api/admin/invoices/' + id + '/payments/' + encodeURIComponent(btn.dataset.id), {
            method: 'DELETE',
          })
        );
        // The balance and status changed: forget the kept copy, and let the
        // list behind catch up.
        changed(id);
        refreshList().catch(() => {});
        if (s !== seq) return;
        current = saved;
        renderPayments(saved);
        renderDerived(saved);
        compute();
        $('invDelete').style.display = deletable(saved) ? '' : 'none';
      } catch (e) {
        if (s === seq) {
          $('invPayMsg').className = 'msg err';
          $('invPayMsg').textContent = e.message;
        }
      }
    });
  }

  // Called by the Quotes tab after converting a quote.
  async function openById(id) {
    wire();
    await openInvoice(id);
  }

  // Signed in, and allowed this tab: before sign-in the answer would only be
  // "please sign in", and a feature switched off isn't worth asking about.
  function canOpen() {
    const app = $('app');
    const tab = document.querySelector('.side-nav .tab[data-tab="invoices"]');
    return !!app && app.style.display !== 'none' && !!tab && tab.style.display !== 'none';
  }

  // Warms the list for someone on their way to it — the shell calls this when
  // the Invoices tab is hovered, focused or touched, and when the page is idle.
  // The same path, and the same copy kept on this device, that load() paints.
  function prefetch() {
    if (!canOpen()) return;
    Snappy.prefetch(api, LIST, { persist: true });
  }

  window.Invoices = { load, openById, prefetch };
})();
