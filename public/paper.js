// Shared by the Quotes and Invoices tabs: the company details, the formatting
// helpers, and the printable customer document. Both editors are laid out as
// the document itself, so what the office types is what the customer gets —
// this file is the one place that decides what that document looks like.
//
// Loaded before quotes.js and invoices.js; exposes window.HEKPaper.
(function () {
  // HEK Fencing Inc. — company details (from hekfencing.ca). Edit here if any
  // of it changes; it prints on every quote and invoice.
  const COMPANY = {
    name: 'HEK Fencing Inc.',
    serviceArea: 'Serving South-Western Ontario',
    website: 'hekfencing.ca',
    locations: ['225439 Otterville Rd, Otterville, ON', '285794 Airport Rd, Norwich, ON'],
    phones: ['Henry (519) 983-0304', 'Barend (226) 228-1136'],
    emails: ['henry@hekfencing.com', 'barend@hekfencing.com'],
  };

  // Payment terms an invoice can carry, and how many days each gives.
  const TERMS = [
    ['receipt', 'Due on receipt', 0],
    ['net7', 'Net 7', 7],
    ['net15', 'Net 15', 15],
    ['net30', 'Net 30', 30],
    ['net45', 'Net 45', 45],
    ['net60', 'Net 60', 60],
    ['custom', 'Custom', null],
  ];
  const termDays = (key) => {
    const t = TERMS.find((x) => x[0] === key);
    return t ? t[2] : null;
  };
  const termLabel = (key) => {
    const t = TERMS.find((x) => x[0] === key);
    return t && key !== 'custom' ? t[1] : '';
  };

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) =>
    (Number(n) < 0 ? '−$' : '$') +
    Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Trim trailing zeros from a quantity (2.00 -> "2", 1.50 -> "1.5").
  const fmtNum = (n) => String(Math.round((Number(n) || 0) * 100) / 100);
  const localDay = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  // Dates travel as ISO strings. A picked date ("2026-10-10") is stored as
  // midnight UTC, and its day is the one written in the string — moving it
  // through the local timezone would print the day before in Ontario. Anything
  // with a real time of day (an old quote stamped "now", a payment sync) is a
  // moment, and its day is the local one.
  const dayOf = (iso) => {
    if (!iso) return '';
    const s = String(iso);
    if (s.length === 10 || /T00:00:00(\.000)?Z$/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    return isNaN(d) ? '' : localDay(d);
  };
  const fmtDate = (iso) => {
    const d = dayOf(iso);
    if (!d) return '';
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const todayStr = () => localDay(new Date());
  const addDays = (day, n) => {
    const [y, m, d] = (day || todayStr()).split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return new Date(dt - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };

  // Grow a textarea to fit what is in it, so the editor reads like the page.
  function autosize(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }
  function autosizeAll(root) {
    if (root) root.querySelectorAll('textarea').forEach(autosize);
  }

  // The company block for the editor's letterhead.
  function companyHtml() {
    return [COMPANY.locations, COMPANY.phones, COMPANY.emails]
      .map((group) => `<div>${group.map(esc).join(' &nbsp;·&nbsp; ')}</div>`)
      .join('');
  }

  // The one way totals are worked out — the same code the server runs
  // (totals.js) — so the printed copy agrees with the customer's page to the
  // cent.
  const T = window.HEKTotals;
  const totalsOf = (doc) => T.totalsOf(doc.items || [], doc.tax_rate);
  const lineAmount = (it) => T.lineAmount(it);

  // ---- the customer document ----
  // kind: 'quote' | 'invoice'. Opens in its own window and prints, which is
  // also how it becomes a PDF ("Save as PDF" in the print dialog).
  function documentHtml(doc, kind) {
    const isQuote = kind === 'quote';
    const t = totalsOf(doc);
    const c = doc.customer || {};
    const paid = isQuote ? 0 : Number(doc.paid) || 0;
    const balance = Math.round((t.total - paid) * 100) / 100;
    const settled = !isQuote && t.total > 0 && balance <= 0;
    // Held to 0–100, as the editor and the server hold it: a figure typed as
    // dollars must not print as a 500% deposit.
    const depositPct = isQuote ? Math.min(100, Math.max(0, Number(doc.deposit_pct) || 0)) : 0;
    const deposit = T.deposit(t.total, depositPct);

    const meta = isQuote
      ? [
          ['Quote no.', doc.number],
          ['Date', fmtDate(doc.quote_date || todayStr())],
          ['Valid until', fmtDate(doc.valid_until)],
        ]
      : [
          ['Invoice no.', doc.number],
          ['Issued', fmtDate(doc.issue_date || todayStr())],
          ['Terms', termLabel(doc.terms)],
          ['Due', fmtDate(doc.due_date)],
          ['PO no.', doc.po],
          ['Quote', doc.quote_number],
        ];

    const rows = (doc.items || [])
      .filter((it) => it.description || Number(it.qty) || Number(it.unit_price))
      .map((it) => {
        const line = lineAmount(it);
        return `<tr>
          <td class="desc">${esc(it.description || '')}</td>
          <td class="r">${fmtNum(it.qty)}</td>
          <td>${esc(it.unit || '')}</td>
          <td class="r">${money(it.unit_price)}</td>
          <td class="r">${money(line)}</td></tr>`;
      })
      .join('');

    const billLines = [c.address, [c.phone, c.email].filter(Boolean).join('  ·  ')].filter(Boolean);
    const jobLines = [doc.job_site].filter(Boolean);
    const hasJob = doc.project || doc.job_site;

    return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>${esc(doc.number || (isQuote ? 'Quote' : 'Invoice'))} — HEK Fencing</title>
<style>
  @page { size: letter; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #22201c; margin: 0; padding: 36px; font-size: 13.5px; line-height: 1.45; }
  .sheet { max-width: 800px; margin: 0 auto; position: relative; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding-bottom: 20px; border-bottom: 3px solid #ac7d3f; }
  .logo img { display: block; width: 120px; height: auto; }
  .co { margin-top: 12px; color: #6f685f; font-size: 11.5px; line-height: 1.7; }
  .doc { text-align: right; }
  .doc h1 { margin: 0 0 10px; font-size: 30px; letter-spacing: 4px; color: #ac7d3f; line-height: 1; }
  .meta { border-collapse: collapse; margin-left: auto; }
  .meta td { padding: 2px 0 2px 16px; font-size: 12.5px; white-space: nowrap; }
  .meta td:first-child { color: #6f685f; text-align: right; }
  .meta td:last-child { font-weight: 600; text-align: right; }
  .parties { display: flex; gap: 32px; margin: 26px 0 6px; }
  .parties > div { flex: 1; min-width: 0; }
  .lbl { text-transform: uppercase; font-size: 10.5px; letter-spacing: 1.2px; color: #8a8278; font-weight: 600; margin-bottom: 5px; }
  .who { font-size: 17px; font-weight: 700; }
  .det { color: #555; white-space: pre-line; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 22px; }
  .items th { background: #f4f0e8; color: #6b5228; text-align: left; padding: 9px 10px; font-size: 11px; letter-spacing: .6px; text-transform: uppercase; }
  .items td { padding: 10px; border-bottom: 1px solid #ece7de; vertical-align: top; }
  .items .desc { white-space: pre-line; }
  .items th.r, .items td.r { text-align: right; white-space: nowrap; }
  .items tr { break-inside: avoid; }
  .foot { display: flex; gap: 36px; align-items: flex-start; margin-top: 18px; break-inside: avoid; }
  .notes { flex: 1; min-width: 0; color: #444; white-space: pre-wrap; font-size: 12.5px; }
  .totals { position: relative; width: 300px; flex: none; }
  .totals > div:not(.stamp) { display: flex; justify-content: space-between; padding: 6px 10px; }
  .totals div span:first-child { color: #6f685f; }
  .totals .grand { border-top: 2px solid #22201c; margin-top: 4px; padding-top: 10px; font-size: 16px; font-weight: 700; }
  .totals .grand span:first-child { color: #22201c; }
  .totals .due { background: #ac7d3f; color: #fff; border-radius: 6px; margin-top: 8px; padding: 10px 12px; font-size: 16px; font-weight: 700; }
  .totals .due span:first-child { color: #fff; }
  .accept { margin-top: 36px; padding-top: 16px; border-top: 1px solid #ece7de; break-inside: avoid; }
  .accept p { margin: 0 0 34px; color: #555; font-size: 12.5px; }
  .sig { display: flex; gap: 32px; }
  .sig div { flex: 2; border-top: 1px solid #22201c; padding-top: 5px; font-size: 11.5px; color: #6f685f; }
  .sig div:last-child { flex: 1; }
  .stamp { width: max-content; margin: 4px 10px 14px auto; transform: rotate(-6deg); border: 3px solid #2f9257; color: #2f9257; padding: 4px 18px; border-radius: 8px; font-size: 26px; font-weight: 800; letter-spacing: 5px; opacity: .8; }
  .layout { margin-top: 26px; break-inside: avoid; }
  .layout svg { width: 100%; height: auto; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 8px; font-size: 12px; color: #555; }
  .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; border: 1px solid rgba(0,0,0,.25); }
  .signed { display: flex; align-items: flex-end; gap: 24px; }
  .signed img { height: 70px; max-width: 280px; object-fit: contain; border-bottom: 1px solid #22201c; }
  .signed div { font-size: 12.5px; color: #555; }
  .end { margin-top: 40px; text-align: center; color: #8a8278; font-size: 11.5px; }
  .bar { text-align: center; margin-bottom: 24px; }
  .bar button { background: #ac7d3f; color: #fff; border: none; padding: 10px 22px; border-radius: 8px; font-size: 15px; cursor: pointer; }
  @media print { body { padding: 0; } .noprint { display: none; } }
</style></head><body>
  <div class="bar noprint"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="sheet">
    <div class="head">
      <div>
        <div class="logo"><img src="/logo.svg" alt="HEK Fencing Inc." /></div>
        <div class="co">${companyHtml()}</div>
      </div>
      <div class="doc">
        <h1>${isQuote ? 'QUOTE' : 'INVOICE'}</h1>
        <table class="meta">${meta
          .filter((m) => m[1])
          .map((m) => `<tr><td>${esc(m[0])}</td><td>${esc(m[1])}</td></tr>`)
          .join('')}</table>
      </div>
    </div>

    <div class="parties">
      <div>
        <div class="lbl">${isQuote ? 'Prepared for' : 'Bill to'}</div>
        <div class="who">${esc(c.name || '')}</div>
        ${billLines.map((l) => `<div class="det">${esc(l)}</div>`).join('')}
      </div>
      ${
        hasJob
          ? `<div>
        <div class="lbl">Job</div>
        ${doc.project ? `<div class="who">${esc(doc.project)}</div>` : ''}
        ${jobLines.map((l) => `<div class="det">${esc(l)}</div>`).join('')}
      </div>`
          : ''
      }
    </div>

    <table class="items">
      <thead><tr><th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="color:#999">No line items.</td></tr>'}</tbody>
    </table>

    <div class="foot">
      <div class="notes">${doc.notes ? `<div class="lbl">Notes &amp; terms</div>${esc(doc.notes)}` : ''}</div>
      <div class="totals">
        ${settled ? '<div class="stamp">PAID</div>' : ''}
        <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
        <div><span>Tax (${fmtNum(t.taxRate)}%)</span><span>${money(t.tax)}</span></div>
        <div class="grand"><span>Total (CAD)</span><span>${money(t.total)}</span></div>
        ${
          isQuote
            ? deposit > 0
              ? `<div class="due"><span>Deposit to book (${fmtNum(depositPct)}%)</span><span>${money(deposit)}</span></div>`
              : ''
            : `${paid ? `<div><span>Paid to date</span><span>−${money(paid)}</span></div>` : ''}
               <div class="due"><span>${balance < 0 ? 'Credit' : settled ? 'Balance' : 'Balance due'}</span><span>${money(Math.abs(balance))}</span></div>`
        }
      </div>
    </div>

    ${
      isQuote && doc.layout_svg
        ? `<div class="layout">
      <div class="lbl">Fence layout</div>
      ${doc.layout_svg}
      <div class="legend">${(doc.layout_legend || [])
        .map(
          (g) =>
            `<span><i style="background:${esc(g.color || '#999')}"></i>${esc(g.label)} — ${esc(Number(g.fence_ft || 0).toLocaleString('en-US'))} ft${
              (g.gates || []).length ? ' · ' + esc(g.gates.map((x) => `${x.count} × ${x.label}`).join(', ')) : ''
            }</span>`
        )
        .join('')}</div>
    </div>`
        : ''
    }

    ${
      isQuote
        ? // Only an accepted quote carries its signature, and only while the
          // signature still stands for what the quote says (the server's
          // signature_current): one changed after signing must not print as
          // agreed to.
          doc.signature && doc.signature.image && doc.status === 'accepted' && doc.signature_current !== false
          ? `<div class="accept">
      <div class="lbl">Acceptance</div>
      <div class="signed">
        <img src="${esc(doc.signature.image)}" alt="" />
        <div>Approved and signed online by <b>${esc(doc.signature.name)}</b><br />${esc(
          new Date(doc.signature.at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })
        )}</div>
      </div>
    </div>`
          : `<div class="accept">
      <div class="lbl">Acceptance</div>
      <p>To go ahead, approve and sign online from the link we send you, or sign below and return a copy. Signing accepts the work and price in this quote.</p>
      <div class="sig"><div>Customer signature</div><div>Date</div></div>
    </div>`
        : ''
    }

    <div class="end">
      ${esc(COMPANY.serviceArea)} &nbsp;·&nbsp; ${esc(COMPANY.website)} &nbsp;·&nbsp; Prices in CAD<br />
      ${isQuote ? 'Thank you for the opportunity to earn your business' : 'Thank you for your business'} — ${esc(COMPANY.name)}
    </div>
  </div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };<\/script>
</body></html>`;
  }

  function openPrint(doc, kind) {
    const w = window.open('', '_blank');
    if (!w) {
      alert(`Please allow pop-ups to print or save the ${kind} as a PDF.`);
      return;
    }
    w.document.write(documentHtml(doc, kind));
    w.document.close();
  }

  window.HEKPaper = {
    COMPANY,
    TERMS,
    termDays,
    termLabel,
    money,
    fmtNum,
    fmtDate,
    dayOf,
    todayStr,
    addDays,
    autosize,
    autosizeAll,
    companyHtml,
    totalsOf,
    lineAmount,
    documentHtml,
    openPrint,
  };
})();
