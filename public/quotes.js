// Quote builder for the admin dashboard and the employee portal. Lives in the
// "Quotes" tab. Uses the shared, auth-aware API helper exposed by admin.js or
// portal.js (window.HEKAdmin), the document helpers in paper.js, the takeoff
// engine in takeoff.js and the satellite map in fencemap.js.
//
// Three parts, top to bottom:
//   - the satellite estimator: find the property, trace the fence, drop the
//     gates — footage, posts, materials and labour are worked out as you draw,
//     and "Put on quote" turns them into priced lines;
//   - the quote itself, laid out as the customer will see it — letterhead,
//     customer, job, line items, totals, acceptance;
//   - a rail beside it: cost and margin, the customer's link (sent, viewed,
//     signed), the AI review, and converting to an invoice.
//
// Both pages use this one file, so the editor's markup lives here rather
// than being copied into each page.
(function () {
  const $ = (id) => document.getElementById(id);
  const A = window.HEKAdmin || {};
  const P = window.HEKPaper;
  const T = window.HEKTakeoff;
  // Looked up on every call, as the other modules do, so whatever the page's
  // helper does around a request (signing out on a 401, forgetting cached
  // copies after a change) always applies to this file's requests too.
  const api = (p, o) =>
    window.HEKAdmin && window.HEKAdmin.api ? window.HEKAdmin.api(p, o) : fetch(p, o).then((r) => r.json());
  const esc =
    A.esc ||
    ((s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
  const { money, fmtNum, fmtDate, dayOf, todayStr, addDays, autosize, autosizeAll } = P;

  let editingId = null; // null while building a brand-new quote
  let currentNumber = null;
  let current = null; // the quote as last loaded or saved — link, signature, review
  let layout = null; // the drawn fence, or null
  let cat = null; // the materials & labour catalog
  let catLoading = null;
  let fm = null; // the satellite map, made the first time the estimator opens
  let take = null; // the live takeoff of `layout`
  let estOpen = false;

  const escAttr = (s) => esc(s == null ? '' : s).replace(/"/g, '&quot;');
  const VALID_DAYS = 30;
  const fmtWhen = (iso) =>
    iso
      ? new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '';

  // Default terms dropped onto every new quote (fully editable).
  const DEFAULT_TERMS =
    'Free estimate. Prices in CAD; top-quality materials and professional ' +
    'installation included unless noted. A deposit may be required to ' +
    'schedule your installation.';

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

  // ---- the editor ----
  // Converting to an invoice is admin-only, so the button only exists on the
  // page that has an Invoices tab.
  const canInvoice = !!$('tab-invoices');
  $('qEditor').innerHTML = `
    <div class="q-shell">
    <div class="doc-bar">
      <button class="btn ghost sm" id="qBack" type="button" data-press="fast">← Quotes</button>
      <h2 id="qEditorTitle">New quote</h2>
      <div class="doc-bar-actions">
        <label for="qStatus">Status</label>
        <select id="qStatus">
          <option value="draft">Draft</option>
          <option value="sent">Sent</option>
          <option value="accepted">Accepted</option>
          <option value="declined">Declined</option>
        </select>
        <button class="btn ghost sm" id="qPrint" type="button">Download PDF</button>
        <button class="btn gold sm" id="qSave" type="button">Save quote</button>
      </div>
    </div>
    <div class="msg err" id="qMsg"></div>
    <div class="q-note-box" id="qLocked" hidden>
      <b>Accepted — locked.</b> The work, price and terms are what the customer agreed to. To change them,
      set the status back to <i>Sent</i>; they will then sign the new version.
    </div>
    <div class="q-note-box" id="qRequestNote" hidden></div>

    <div class="q-work">
    <div class="q-main">

    <section class="q-est card" id="qEst">
      <button type="button" class="q-est-toggle" id="qEstToggle" data-press="fast" aria-expanded="false" aria-controls="qEstBody">
        <span class="q-est-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"/><path d="M9 4v13M15 7v13"/></svg>
        </span>
        <span class="q-est-title"><b>Satellite estimator</b><small id="qEstSummary">Trace the fence on the property — footage, posts, gates and materials are worked out as you draw.</small></span>
        <span class="q-est-chev" aria-hidden="true">▾</span>
      </button>
      <div class="q-est-body" id="qEstBody" hidden>
        <div class="q-est-search">
          <input id="qeAddr" placeholder="Job site address, e.g. 285794 Airport Rd, Norwich ON" autocomplete="off" aria-label="Address to find on the map" />
          <button class="btn ghost sm" id="qeGo" type="button">Go</button>
          <div class="est-results" id="qeResults" style="display:none"></div>
        </div>
        <div class="q-est-grid">
          <div class="q-est-mapwrap">
            <div id="qeMap" class="q-est-map"></div>
            <div class="est-layers q-est-layers">
              <button type="button" data-layer="street">Map</button>
              <button type="button" data-layer="sat" class="active">Satellite</button>
            </div>
            <div class="fm-hint" id="qeHint"></div>
          </div>
          <div class="q-est-side">
            <div class="q-est-panel">
              <div class="q-est-panel-h">
                <h4 id="qeSpecTitle">Draw fence</h4>
                <button class="link-btn" id="qeDeselect" type="button" hidden>+ New run</button>
              </div>
              <label for="qeSys">Fence</label>
              <select id="qeSys"></select>
              <div class="q-est-two">
                <div><label for="qeH">Height</label><select id="qeH"></select></div>
                <label class="q-est-check"><input type="checkbox" id="qeTear" /> Remove old fence</label>
              </div>
              <button class="btn gold sm q-wide" id="qeDraw" type="button">+ Draw a run</button>
              <div class="q-est-gate">
                <select id="qeGateSize" aria-label="Gate size"></select>
                <button class="btn ghost sm" id="qeGate" type="button">+ Gate</button>
              </div>
              <div class="q-est-tools">
                <button class="link-btn" id="qeUndo" type="button">↶ Undo</button>
                <button class="link-btn" id="qeFit" type="button">Fit to fence</button>
                <button class="link-btn danger" id="qeClear" type="button">Clear all</button>
              </div>
            </div>
            <div class="q-est-panel q-est-runs-panel">
              <div class="q-est-panel-h"><h4>Runs</h4><span class="q-est-total" id="qeTotal"></span></div>
              <div id="qeRuns" class="q-est-runs"></div>
            </div>
          </div>
        </div>
        <div class="q-est-mat">
          <div class="q-est-mat-h">
            <h4>Materials &amp; labor</h4>
            <div class="q-est-mat-actions">
              <select id="qeMode" aria-label="How the fence goes on the quote">
                <option value="summary">On the quote: price per foot</option>
                <option value="itemized">On the quote: every material</option>
              </select>
              <button class="btn gold sm" id="qePut" type="button">Put on quote ↓</button>
              <button class="btn ghost sm" id="qeCat" type="button">Prices…</button>
            </div>
          </div>
          <div id="qeMat"></div>
          <p class="q-est-note" id="qeNote"></p>
        </div>
      </div>
    </section>

    <article class="paper" id="qPaper" aria-label="Quote">
      <header class="paper-head">
        <div>
          <div class="paper-logo"><img src="/logo.svg" alt="HEK Fencing Inc." /></div>
          <div class="paper-co">${P.companyHtml()}</div>
        </div>
        <div class="paper-title">
          <h3>Quote</h3>
          <dl class="paper-meta">
            <div><dt>Quote no.</dt><dd><span class="paper-static" id="qNumber"></span></dd></div>
            <div><dt><label for="qDate">Date</label></dt><dd><input type="date" class="pf" id="qDate" /></dd></div>
            <div><dt><label for="qValid">Valid until</label></dt><dd><input type="date" class="pf" id="qValid" /></dd></div>
          </dl>
        </div>
      </header>

      <section class="paper-parties">
        <div class="paper-party">
          <div class="paper-lbl">Prepared for</div>
          <input class="pf pf-strong" id="qcName" placeholder="Customer name (required)" aria-label="Customer name" />
          <textarea class="pf" id="qcAddress" rows="1" placeholder="Mailing address" aria-label="Customer address"></textarea>
          <input class="pf" id="qcPhone" placeholder="Phone" aria-label="Customer phone" />
          <input class="pf" id="qcEmail" type="email" placeholder="Email" aria-label="Customer email" />
        </div>
        <div class="paper-party">
          <div class="paper-lbl">Job</div>
          <input class="pf pf-strong" id="qProject" placeholder="What we're building, e.g. 6 ft wood privacy fence" aria-label="Project" />
          <textarea class="pf" id="qSite" rows="1" placeholder="Job site address, if it isn't the mailing address" aria-label="Job site address"></textarea>
        </div>
      </section>

      <div class="paper-quick">
        <div class="paper-lbl">Quick add</div>
        <div class="quick-adds" id="qQuick"></div>
      </div>

      <div class="paper-items-wrap">
        <table class="paper-items">
          <thead><tr>
            <th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit price</th><th class="r">Amount</th>
            <th><span class="sr-only">Remove</span></th>
          </tr></thead>
          <tbody id="qItems"></tbody>
        </table>
      </div>
      <button class="paper-add" id="qAddRow" type="button">+ Add line</button>

      <section class="paper-foot">
        <div class="paper-notes">
          <label class="paper-lbl" for="qNotes">Notes &amp; terms</label>
          <textarea class="pf" id="qNotes" rows="2" placeholder="e.g. 50% deposit due on acceptance. Balance on completion."></textarea>
        </div>
        <div class="paper-totals">
          <div class="pt-row"><span>Subtotal</span><span id="qSubtotal">$0.00</span></div>
          <div class="pt-row">
            <span>Tax <input class="pf pt-pct" id="qTax" inputmode="decimal" value="0" aria-label="Tax rate, percent" />%</span>
            <span id="qTaxAmt">$0.00</span>
          </div>
          <div class="pt-row pt-grand"><span>Total (CAD)</span><span id="qTotal">$0.00</span></div>
          <div class="pt-row">
            <span>Deposit <input class="pf pt-pct" id="qDeposit" inputmode="decimal" placeholder="0" aria-label="Deposit, percent of total" />%</span>
            <span class="pt-dim" id="qDepositNone">None</span>
          </div>
          <div class="pt-row pt-due" id="qDueRow" hidden><span>Deposit to book</span><span id="qDepositAmt">$0.00</span></div>
        </div>
      </section>

      <section class="paper-layout" id="qPaperLayout" hidden>
        <div class="paper-lbl">Fence layout</div>
        <div id="qPaperLayoutSvg"></div>
      </section>

      <section class="paper-accept">
        <div class="paper-lbl">Acceptance</div>
        <div id="qSigLines">
          <p>To go ahead, approve and sign online from the link we send you, or sign below and return a copy. Signing accepts the work and price in this quote.</p>
          <div class="paper-sig"><div>Customer signature</div><div>Date</div></div>
        </div>
        <div class="paper-signed" id="qSigned" hidden></div>
      </section>
    </article>
    </div>

    <aside class="q-rail" id="qRail" aria-label="Quote tools">
      <section class="q-card card">
        <h4>Summary</h4>
        <div class="q-sum-row"><span>Subtotal</span><b id="qrSub">$0.00</b></div>
        <div class="q-sum-row"><span>Tax</span><b id="qrTax">$0.00</b></div>
        <div class="q-sum-row q-sum-total"><span>Total</span><b id="qrTotal">$0.00</b></div>
        <div class="q-profit" id="qrProfit" hidden>
          <div class="q-sum-row"><span>Est. cost</span><b id="qrCost"></b></div>
          <div class="q-sum-row"><span>Profit</span><b id="qrProfitAmt"></b></div>
          <div class="q-margin" title="Margin on the subtotal, against your target">
            <div class="q-margin-bar"><i id="qrBar"></i><em id="qrTarget"></em></div>
            <span id="qrMargin"></span>
          </div>
          <p class="q-rail-note" id="qrCostNote"></p>
        </div>
      </section>

      <section class="q-card card">
        <h4>Customer page</h4>
        <ol class="q-timeline" id="qrTimeline"></ol>
        <p class="q-rail-note" id="qrTo"></p>
        <button class="btn gold sm q-wide" id="qrEmail" type="button">Email quote to customer</button>
        <div class="q-rail-two">
          <button class="btn ghost sm" id="qrText" type="button">Text link</button>
          <button class="btn ghost sm" id="qrCopy" type="button">Copy link</button>
        </div>
        <button class="btn ghost sm q-wide" id="qrPreview" type="button">Preview customer page ↗</button>
        <input class="q-link" id="qrLink" readonly hidden aria-label="Link to this quote" />
        <div class="q-warn" id="qrSignedWarn" hidden></div>
      </section>

      <section class="q-card card">
        <div class="q-card-h">
          <h4>AI review</h4>
          <button class="btn ghost sm" id="qrAnalyze" type="button">✦ Analyze with AI</button>
        </div>
        <div id="qrReview"></div>
      </section>

      ${canInvoice ? '<button class="btn gold sm q-wide" id="qToInvoice" type="button" style="display:none">Convert to invoice →</button>' : ''}
    </aside>
    </div>
    </div>`;

  // Catalog editor (admin edits prices; everyone else can look).
  const catModal = document.createElement('div');
  catModal.className = 'modal-back';
  catModal.id = 'qCatModal';
  catModal.innerHTML = `
    <div class="modal q-cat-modal" role="dialog" aria-modal="true" aria-labelledby="qcTitle">
      <div class="q-cat-head">
        <h3 id="qcTitle">Estimator prices</h3>
        <button class="link-btn" id="qcClose" type="button" aria-label="Close">✕</button>
      </div>
      <p class="q-rail-note" id="qcLead"></p>
      <div id="qcBody"></div>
      <div class="q-cat-foot">
        <button class="btn ghost sm" id="qcReset" type="button">Reset to defaults</button>
        <span class="msg" id="qcMsg"></span>
        <button class="btn gold sm" id="qcSave" type="button">Save prices</button>
      </div>
    </div>`;
  document.body.appendChild(catModal);

  // ---- line-item rows (the DOM is the source of truth, so typing never
  //      loses focus to a re-render) ----
  function addRow(item, before) {
    item = item || {};
    const val = (v) => (v != null && v !== '' ? escAttr(v) : '');
    const tr = document.createElement('tr');
    if (item.src === 'layout') tr.dataset.src = 'layout';
    tr.innerHTML =
      `<td><textarea class="pf i-desc" rows="1" placeholder="Description" aria-label="Description">${esc(item.description || '')}</textarea></td>` +
      `<td><input class="pf r i-qty" inputmode="decimal" value="${val(item.qty)}" placeholder="Qty" aria-label="Quantity" /></td>` +
      `<td><input class="pf i-unit" value="${val(item.unit)}" placeholder="ft / ea / hr" aria-label="Unit" /></td>` +
      `<td><input class="pf r i-price" inputmode="decimal" value="${val(item.unit_price)}" placeholder="0.00" aria-label="Unit price" /></td>` +
      `<td class="i-total">$0.00</td>` +
      `<td><button class="paper-del i-del" type="button" title="Remove line" aria-label="Remove line">✕</button></td>`;
    if (before) $('qItems').insertBefore(tr, before);
    else $('qItems').appendChild(tr);
    autosize(tr.querySelector('textarea'));
    computeTotals();
    return tr;
  }

  // A number as people type them: "1,200" is twelve hundred and "$45" is 45
  // (parseFloat reads 1 and nothing). Blank or unreadable counts as 0 here;
  // badAmount() is what stops a save over one that isn't blank.
  const num = (v) => {
    const n = T.parseAmount(v);
    return n == null ? 0 : n;
  };
  // The first quantity, price, tax or deposit box holding something that isn't
  // a number, or null.
  function badAmount() {
    const boxes = [...$('qItems').querySelectorAll('.i-qty, .i-price'), $('qTax'), $('qDeposit')];
    return boxes.find((b) => b && b.value.trim() !== '' && T.parseAmount(b.value) == null) || null;
  }

  function rowData() {
    return [...$('qItems').querySelectorAll('tr')].map((tr) => ({
      description: tr.querySelector('.i-desc').value.trim(),
      qty: num(tr.querySelector('.i-qty').value),
      unit: tr.querySelector('.i-unit').value.trim(),
      unit_price: num(tr.querySelector('.i-price').value),
      src: tr.dataset.src || '',
      tr,
    }));
  }

  // The same arithmetic as the server and the customer's page (totals.js).
  const totalsNow = () => P.totalsOf({ items: rowData(), tax_rate: num($('qTax').value) });

  function computeTotals() {
    rowData().forEach((r) => (r.tr.querySelector('.i-total').textContent = money(P.lineAmount(r))));
    const t = totalsNow();
    const depositPct = Math.min(100, Math.max(0, num($('qDeposit').value)));
    $('qSubtotal').textContent = money(t.subtotal);
    $('qTaxAmt').textContent = money(t.tax);
    $('qTotal').textContent = money(t.total);
    $('qDepositNone').style.display = depositPct ? 'none' : '';
    $('qDueRow').hidden = !depositPct;
    $('qDepositAmt').textContent = money(window.HEKTotals.deposit(t.total, depositPct));
    renderSummary(t);
  }

  function setNumber(number) {
    currentNumber = number || null;
    $('qNumber').textContent = currentNumber || 'Assigned on save';
    $('qNumber').classList.toggle('pending', !currentNumber);
    const name = $('qcName').value.trim();
    $('qEditorTitle').textContent = currentNumber
      ? currentNumber + (name ? ' — ' + name : '')
      : 'New quote';
  }

  // ---- the rail ----
  // Live from the drawing once the catalog is in; until then, what the server
  // worked out when the quote was last saved.
  function costNow() {
    if (take && take.groups.length) return take.totals.cost;
    if (layout && !cat && current && current.takeoff) return current.takeoff.cost;
    return null;
  }

  function renderSummary(t) {
    t = t || totalsNow();
    $('qrSub').textContent = money(t.subtotal);
    $('qrTax').textContent = money(t.tax);
    $('qrTotal').textContent = money(t.total);
    const cost = costNow();
    $('qrProfit').hidden = cost == null;
    if (cost != null) {
      const profit = t.subtotal - cost;
      const margin = t.subtotal > 0 ? (profit / t.subtotal) * 100 : 0;
      // 0 is a real target ("anything above cost"), so only a missing one falls back.
      const target = cat && cat.settings.target_margin_pct != null ? cat.settings.target_margin_pct : 30;
      $('qrCost').textContent = money(cost);
      $('qrProfitAmt').textContent = money(profit);
      $('qrProfitAmt').className = profit < 0 ? 'neg' : '';
      $('qrMargin').textContent = t.subtotal > 0 ? `${Math.round(margin)}% margin` : '—';
      const bar = $('qrBar');
      bar.style.width = Math.max(0, Math.min(100, margin)) + '%';
      bar.className = margin >= target ? 'ok' : margin >= target / 2 ? 'warn' : 'bad';
      $('qrTarget').style.left = Math.min(100, target) + '%';
      $('qrTarget').title = `Target ${target}%`;
      const manual = rowData().some((r) => r.src !== 'layout' && P.lineAmount(r) > 0);
      $('qrCostNote').textContent = manual
        ? 'Cost covers the drawn fence only — lines typed by hand count as all profit.'
        : `Target margin ${target}%.`;
    }
    renderSignedWarning(t);
  }

  function renderSignedWarning(t) {
    const q = current;
    const show = q && q.signed_total != null && q.status === 'accepted' && Math.abs((t || totalsNow()).total - q.signed_total) > 0.009;
    $('qrSignedWarn').hidden = !show;
    if (show)
      $('qrSignedWarn').textContent = `Changed since the customer signed — they agreed to ${money(q.signed_total)}. Send it again if the price has really changed.`;
  }

  const shareLink = (q) => (q && q.share_token ? `${location.origin}/quote?k=${encodeURIComponent(q.share_token)}` : '');

  function renderShare() {
    const q = current || {};
    const steps = [
      ['Created', q.created_at, ''],
      ['Sent', q.sent_at, ''],
      ['Viewed', q.viewed_at, q.view_count > 1 ? `${q.view_count} views` : ''],
    ];
    if (q.status === 'declined' && q.declined_at) steps.push(['Declined', q.declined_at, q.decline_reason || '', 'bad']);
    else if (q.signature && q.status === 'accepted')
      steps.push(['Signed', q.signature.at, q.signature_current === false ? `${q.signature.name} — on an earlier version` : q.signature.name]);
    // Marked accepted by hand — a paper copy came back, or a yes on the phone.
    else if (q.status === 'accepted' && q.accepted_at) steps.push(['Accepted', q.accepted_at, 'marked by the office']);
    else steps.push(['Signed', null, '']);
    $('qrTimeline').innerHTML = steps
      .map(
        ([label, at, extra, kind]) =>
          `<li class="${at ? 'done' : ''} ${kind || ''}"><b>${esc(label)}</b>${at ? `<span>${esc(fmtWhen(at))}</span>` : '<span>—</span>'}${extra ? `<em>${esc(extra)}</em>` : ''}</li>`
      )
      .join('');
    const email = $('qcEmail').value.trim();
    const phone = $('qcPhone').value.trim();
    $('qrTo').textContent = email
      ? `The link goes to ${email}. They can view, approve and sign from their phone.`
      : 'Add the customer’s email to send it — or text or copy the link.';
    $('qrEmail').disabled = !email;
    $('qrText').disabled = !phone;
    const link = shareLink(q);
    $('qrLink').hidden = !link;
    $('qrLink').value = link;
  }

  // Shown as agreed to only while the signature still stands for the quote as
  // it is (the server says: signature_current) and nothing on screen has
  // changed since it was loaded.
  const signatureStands = () =>
    !!(current && current.signature && current.status === 'accepted' && current.signature_current !== false && edits === savedAt);

  function renderSignature() {
    const s = current && current.signature;
    const signed = signatureStands();
    // Accepted: the terms are locked until it is reopened (the server refuses
    // changes to them too).
    $('qLocked').hidden = !(current && current.status === 'accepted');
    $('qSigned').hidden = !signed;
    $('qSigLines').hidden = signed;
    $('qSigned').innerHTML = signed
      ? `<img src="${escAttr(s.image)}" alt="Signature of ${escAttr(s.name)}" />
         <div>Approved and signed online by <b>${esc(s.name)}</b> on ${esc(fmtWhen(s.at))}${
           current.signed_total != null ? ` for ${money(current.signed_total)}` : ''
         }.</div>`
      : '';
  }

  // ---- AI review ----
  const VERDICTS = {
    looks_good: ['Looks good', 'ok'],
    review: ['Worth a second look', 'warn'],
    underpriced: ['Underpriced', 'bad'],
    overpriced: ['Overpriced', 'warn'],
  };
  let lastReview = null;

  function renderReview(r) {
    lastReview = r;
    const box = $('qrReview');
    if (!r) {
      box.innerHTML =
        '<p class="q-rail-note">Checks the price against your cost, margin target and rate book, catches anything missing from the drawing, and suggests add-ons.</p>';
      return;
    }
    const flags = [...(r.checks || []), ...((r.ai && r.ai.flags) || [])];
    const v = r.ai && VERDICTS[r.ai.verdict];
    box.innerHTML =
      (v ? `<div class="q-verdict v-${v[1]}"><b>${esc(v[0])}</b><span>${esc(r.ai.headline || '')}</span></div>` : '') +
      (flags.length
        ? `<ul class="q-flags">${flags
            .map((f) => `<li class="sev-${esc(f.severity)}"><b>${esc(f.title)}</b><span>${esc(f.detail || '')}</span></li>`)
            .join('')}</ul>`
        : '<p class="q-rail-note">No problems found.</p>') +
      (r.ai && r.ai.upsells && r.ai.upsells.length
        ? `<div class="q-upsells"><h5>Suggested add-ons</h5>${r.ai.upsells
            .map(
              (u, i) => `<div class="q-upsell"><div><b>${esc(u.title)}</b><span>${esc(u.detail)}</span></div>
                <button class="btn ghost sm" type="button" data-upsell="${i}">+ ${u.price > 0 ? money(u.price) : 'Add'}</button></div>`
            )
            .join('')}</div>`
        : '') +
      (r.ai_error ? `<p class="q-rail-note">${esc(r.ai_error)}</p>` : '') +
      (r.at ? `<p class="q-rail-stamp">Reviewed ${esc(fmtWhen(r.at))}</p>` : '');
  }

  // ---- view switching ----
  function showList() {
    $('qList').style.display = 'block';
    $('qEditor').style.display = 'none';
    if (fm) fm.cancel();
  }
  function showEditor() {
    $('qList').style.display = 'none';
    $('qEditor').style.display = 'block';
    $('qMsg').textContent = '';
    // Textareas can only measure themselves once they are on screen.
    autosizeAll($('qPaper'));
    if (fm && estOpen) setTimeout(() => fm.invalidate(), 30);
    Snappy.idle(warmQuietly);
  }

  // The estimator's map library and price catalog, fetched before anyone opens
  // it, so it opens with its map and prices already here. Each is fetched once
  // and kept; a failure here is said by openEstimator if it is still failing
  // when the estimator is actually opened.
  function warmEstimator() {
    Snappy.leaflet().catch(() => {});
    loadCatalog().catch(() => {});
  }
  // The same, from idle moments — but not on a data saver or 2G connection,
  // where nothing is fetched before it's needed.
  function warmQuietly() {
    const c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return;
    warmEstimator();
  }

  // ---- load / render the list ----
  // The list comes a page at a time, newest first, in the server's short row
  // shape. The first page is kept (in memory, and on this device for this
  // account) so the tab opens on it at once; the rest load as the end of the
  // list is scrolled toward.
  const LIST = '/api/admin/quotes?limit=50';
  // One quote in full. The same string everywhere it is read, so a hover's
  // prefetch, opening the quote and printing it all share one copy.
  const quotePath = (id) => '/api/admin/quotes/' + Number(id);

  function listNote(q) {
    if (q.status === 'accepted' && q.signature)
      return q.signature_current === false ? 'Changed since it was signed' : `Signed by ${q.signature.name}`;
    if (q.status === 'declined' && q.declined_at) return 'Declined online';
    if (q.viewed_at) return `Viewed ${fmtDate(q.last_viewed_at || q.viewed_at)}${q.view_count > 1 ? ` · ${q.view_count}×` : ''}`;
    if (q.sent_at) return `Sent ${fmtDate(q.sent_at)}`;
    if (q.expired) return 'Expired';
    return '';
  }

  // Quotes deleted from this list, or being deleted. Their rows are hidden
  // rather than taken out until the server agrees, so a refusal puts them back
  // exactly where they were — and an answer that left the server before the
  // delete reached it can't draw them again.
  const deleted = new Set();

  // A row opens its quote on the press itself (data-press="fast"); its PDF and
  // Delete buttons are their own presses (data-act).
  const rowHtml = (q) => `<tr class="clickable-row" data-id="${q.id}" data-press="fast" title="Click to open this quote"${
    deleted.has(q.id) ? ' style="display:none"' : ''
  }>
          <td>${esc(q.number)}</td>
          <td>${esc(q.customer.name || '—')}${q.project ? `<div class="qb-dim" style="font-size:12px">${esc(q.project)}</div>` : ''}</td>
          <td>${fmtDate(q.quote_date) || '—'}</td>
          <td>${money(q.total)}${q.margin_pct != null ? `<div class="qb-dim" style="font-size:12px">${Math.round(q.margin_pct)}% margin</div>` : ''}</td>
          <td><span class="badge status-${esc(q.status)}">${esc(q.status)}</span>${listNote(q) ? `<div class="qb-dim" style="font-size:12px">${esc(listNote(q))}</div>` : ''}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="link-btn" data-act="print" data-id="${q.id}">PDF</button>
            <button class="link-btn danger" data-act="del" data-id="${q.id}">Delete</button>
          </td></tr>`;
  const rowsOf = (id) => $('qBody').querySelectorAll(`tr[data-id="${Number(id)}"]`);

  let listLoad = 0; // which load() the list on screen belongs to
  let listPaint = 0; // which drawing of the list the rows on screen belong to
  let listNext = null; // where the next page starts; null when there is no more
  let stopPager = null;

  // Start the list over. The old drawing's pager is stopped, and a page still
  // on its way for it is dropped when it lands (listPaint has moved on), so
  // no row is ever added twice.
  function resetList(html) {
    if (stopPager) stopPager();
    stopPager = null;
    listPaint++;
    listNext = null;
    $('qBody').innerHTML = html;
  }

  // "No quotes yet" once nothing is left to show and nothing more to load.
  function emptyCheck() {
    const any = [...$('qBody').querySelectorAll('tr[data-id]')].some((tr) => tr.style.display !== 'none');
    $('qEmpty').style.display = any || listNext ? 'none' : 'block';
  }

  // The first page, then the rest a page at a time as they're scrolled toward.
  function paintList(page) {
    // A server from before paging answers with every quote in one array.
    const rows = Array.isArray(page) ? page : (page && page.quotes) || [];
    resetList(rows.map(rowHtml).join(''));
    listNext = (!Array.isArray(page) && page && page.next) || null;
    emptyCheck();
    if (listNext) {
      const paint = listPaint;
      stopPager = Snappy.endless($('qBody'), () => morePage(paint));
    }
  }

  async function morePage(paint) {
    const from = listNext;
    if (!from || paint !== listPaint) return false;
    const page = await api(LIST + '&before=' + encodeURIComponent(from));
    // Drawn again while this page was on its way: these rows belong to the old
    // list, and the new one asks for its own.
    if (paint !== listPaint) return false;
    listNext = page.next || null;
    $('qBody').insertAdjacentHTML('beforeend', (page.quotes || []).map(rowHtml).join(''));
    emptyCheck();
    return !!listNext;
  }

  // For when the first page is on its way and there's no kept copy to show.
  // styles.css holds skeleton rows back for a moment, so an answer that comes
  // quickly replaces them before they're ever seen.
  const LOADING_ROWS = '<tr class="skel-row"><td colspan="6"><span class="skel" style="width:60%"></span></td></tr>'.repeat(3);

  async function load() {
    const run = ++listLoad;
    showList();
    // Opening a quote's map next is likely: fetch what it needs while idle.
    Snappy.idle(warmQuietly);
    // The kept first page is drawn straight away (inside swr, before it
    // returns), then the server's answer if it differs. Either can arrive after
    // the tab has been opened again; only the latest load() draws.
    let painted = false;
    const answer = Snappy.swr(
      api,
      LIST,
      (page) => {
        if (run !== listLoad) return;
        painted = true;
        paintList(page);
      },
      { persist: true }
    );
    if (!painted) {
      // Nothing kept: rows left from an earlier visit may be out of date (a
      // save since, say), so they make way for the skeleton.
      resetList(LOADING_ROWS);
      $('qEmpty').style.display = 'none';
    }
    try {
      await answer;
    } catch (e) {
      // 401s are handled by the shared api() helper. Anything else, with no
      // kept copy on screen, is said where the list would be.
      if (run === listLoad && !painted)
        resetList(`<tr><td colspan="6" class="status-sub">Couldn’t load the quotes. ${esc(e.message)}</td></tr>`);
    }
  }

  // ---- new / edit ----
  //
  // Changes made in the editor that no load or save has covered yet. Leaving
  // the editor (the list, another tab, a quote from Pricing, closing the page)
  // with any asks first instead of quietly throwing them away.
  let edits = 0;
  let savedAt = 0;
  const markDirty = () => edits++;
  const markClean = () => (savedAt = edits);
  const editorOpen = () => $('qEditor').style.display !== 'none';
  function okToLeave() {
    if (!editorOpen() || edits === savedAt) return true;
    return confirm('This quote has changes that are not saved yet. Leave without saving them?');
  }

  // `gen` counts which quote the editor is showing. Anything that waits on the
  // server (a save, a share, the AI review, the slope check) notes it first and
  // drops its answer if the editor has moved on to another quote meanwhile —
  // otherwise a late reply about quote A would land on quote B.
  let gen = 0;
  // The status as last loaded or saved. Only a status someone actually changed
  // is sent, and it says what it is changing from: the customer may have
  // accepted or declined online since this editor was opened.
  let statusLoaded = 'draft';

  function resetForm() {
    gen++;
    markClean();
    ['qcName', 'qcPhone', 'qcEmail', 'qcAddress', 'qProject', 'qSite', 'qNotes', 'qDeposit'].forEach(
      (id) => ($(id).value = '')
    );
    $('qItems').innerHTML = '';
    $('qTax').value = '0';
    $('qStatus').value = 'draft';
    statusLoaded = 'draft';
    $('qDate').value = todayStr();
    $('qValid').value = addDays(todayStr(), VALID_DAYS);
    $('qMsg').textContent = '';
    current = null;
    setLayout(null);
    renderShare();
    renderSignature();
    renderReview(null);
  }

  function newQuote() {
    editingId = null;
    resetForm();
    setNumber(null);
    $('qNotes').value = DEFAULT_TERMS;
    // Nothing to bill for until the quote exists.
    if ($('qToInvoice')) $('qToInvoice').style.display = 'none';
    addRow(); // start with one blank line
    showEditor();
    // A new quote starts at the map: most of them begin with an address.
    openEstimator(true);
    $('qeAddr').value = '';
    $('qeAddr').focus();
  }

  function fill(q) {
    gen++;
    markClean();
    editingId = q.id;
    current = q;
    // The address search belongs to the quote it was typed for.
    $('qeAddr').value = '';
    $('qeResults').style.display = 'none';
    $('qeResults').innerHTML = '';
    // What the customer wrote on the web form, for the office only.
    $('qRequestNote').hidden = !q.request_notes;
    $('qRequestNote').innerHTML = q.request_notes
      ? `<b>What the customer wrote:</b> ${esc(q.request_notes)}`
      : '';
    $('qcName').value = q.customer.name || '';
    $('qcPhone').value = q.customer.phone || '';
    $('qcEmail').value = q.customer.email || '';
    $('qcAddress').value = q.customer.address || '';
    $('qProject').value = q.project || '';
    $('qSite').value = q.job_site || '';
    $('qDate').value = dayOf(q.quote_date) || todayStr();
    // Blank means no expiry — which is what a quote made before "valid until"
    // existed has. Inventing one from its old date would make it expire the
    // moment it is next saved.
    $('qValid').value = dayOf(q.valid_until) || '';
    $('qStatus').value = q.status || 'draft';
    statusLoaded = q.status || 'draft';
    $('qTax').value = q.tax_rate || 0;
    $('qDeposit').value = q.deposit_pct ? fmtNum(q.deposit_pct) : '';
    $('qNotes').value = q.notes || '';
    $('qItems').innerHTML = '';
    (q.items && q.items.length ? q.items : [{}]).forEach((it) => addRow(it));
    setNumber(q.number);
    if ($('qToInvoice')) $('qToInvoice').style.display = '';
    setLayout(q.layout || null);
    renderShare();
    renderSignature();
    renderReview(q.review || null);
    computeTotals();
  }

  // After a save or a share: take the server's view of the customer side
  // without touching anything typed on the sheet.
  // sentStatus: the status the save that answered sent. If the dropdown has
  // been changed since, that newer choice stays on screen (and goes with the
  // next save) instead of being reset to the server's.
  function applyServer(q, { sentStatus } = {}) {
    current = q;
    editingId = q.id;
    setNumber(q.number);
    if (sentStatus === undefined || $('qStatus').value === sentStatus) $('qStatus').value = q.status || 'draft';
    statusLoaded = q.status || 'draft';
    if ($('qToInvoice')) $('qToInvoice').style.display = '';
    renderShare();
    renderSignature();
    renderSummary();
  }

  // A copy of a quote fetched within this long — usually by a hover over its
  // row a moment ago — opens at once instead of waiting for the server. That
  // is no staler than a quote opened half a minute ago and left on screen.
  const KEPT_OPENS_MS = 30000;
  // One younger than this is as good as asking again; older ones are asked
  // for again behind the scenes (recheck).
  const KEPT_CURRENT_MS = 5000;
  const keptQuote = (id) =>
    Snappy.cache.fresh(quotePath(id), KEPT_OPENS_MS) ? Snappy.cache.peek(quotePath(id)) : undefined;

  function showQuote(q) {
    fill(q);
    showEditor();
    if (q.layout) openEstimator(false);
    else closeEstimator();
  }

  // Only the quote asked for last is opened: a slow reply for an earlier click
  // (or for one asked for before "+ New quote") is dropped.
  let opening = 0;
  async function editQuote(id) {
    const ticket = ++opening;
    const g = gen;
    const kept = keptQuote(id);
    if (kept) {
      // Taken now: from here on the editor works on this object (its layout).
      const keptJson = JSON.stringify(kept);
      showQuote(kept);
      if (!Snappy.cache.fresh(quotePath(id), KEPT_CURRENT_MS)) recheck(id, kept, keptJson);
      return;
    }
    try {
      // Joins the request a hover over the row already started, if there is one.
      const q = await Snappy.load(api, quotePath(id));
      if (ticket !== opening || g !== gen) return;
      showQuote(q);
    } catch (e) {
      if (ticket === opening) alert(e.message);
    }
  }

  // A quote opened from a kept copy is asked for again, and the server's answer
  // is put on screen only where that can't cost anything: nothing typed or
  // changed since it opened (edits), no save or send has answered since (its
  // answer is newer than this one), and the same quote is still open (gen).
  function recheck(id, shown, shownJson) {
    const ticket = opening;
    const g = gen;
    Snappy.load(api, quotePath(id))
      .then((q) => {
        if (ticket !== opening || g !== gen || current !== shown || edits !== savedAt || !editorOpen()) return;
        if (JSON.stringify(q) === shownJson) return; // the usual case: nothing has changed
        // Filling the sheet again would throw away a run half traced on the
        // map or an address being looked up; then only the customer's side
        // (sent, viewed, signed, status) catches up.
        if ((fm && fm.mode() !== 'idle') || $('qeAddr').value.trim()) applyServer(q);
        else fill(q);
      })
      .catch(() => {
        /* the copy on screen stands; a save will say if the quote has moved on */
      });
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
      project: $('qProject').value.trim(),
      job_site: $('qSite').value.trim(),
      quote_date: $('qDate').value || null,
      valid_until: $('qValid').value || null,
      items: rowData()
        .map((r) => ({
          description: r.description,
          qty: r.qty,
          unit: r.unit,
          unit_price: r.unit_price,
          ...(r.src ? { src: r.src } : {}),
        }))
        .filter((r) => r.description || r.qty || r.unit_price),
      tax_rate: num($('qTax').value),
      // A percentage of the total: the server and the printed copy hold it to
      // 0–100 as well, so "500" typed meaning dollars can't print 500%.
      deposit_pct: Math.min(100, Math.max(0, num($('qDeposit').value))),
      notes: $('qNotes').value.trim(),
      status: $('qStatus').value,
      layout: layout && layout.segments && layout.segments.length ? layout : null,
    };
  }

  function say(text, kind) {
    $('qMsg').className = 'msg ' + (kind || 'err');
    $('qMsg').textContent = text || '';
  }

  // Returns true once the quote is saved. Everything that needs the quote to
  // exist on the server — sending, previewing, the AI review — saves first, so
  // it always acts on what is on screen.
  //
  // Saves run one at a time. Two clicks close together (Save, then Copy link)
  // would otherwise both POST a brand-new quote and make two of it; queued,
  // the second one finds the quote already exists and updates it.
  let saveQueue = Promise.resolve();
  function save(opts) {
    // Noted now, not when its turn comes: if another quote is open by then,
    // this save is for one no longer on screen and is dropped.
    const g = gen;
    const run = saveQueue.then(() => (g === gen ? saveNow(opts) : false));
    saveQueue = run.catch(() => {});
    return run;
  }

  async function saveNow({ quiet } = {}) {
    const g = gen;
    const bad = badAmount();
    if (bad) {
      say(`"${bad.value}" isn't a number — fix the highlighted box and save again.`);
      bad.classList.add('q-cat-bad');
      bad.focus();
      bad.addEventListener('input', () => bad.classList.remove('q-cat-bad'), { once: true });
      return false;
    }
    // A run still being drawn goes in with the rest.
    if (fm && fm.mode() === 'draw') fm.finishRun();
    const covers = edits;
    const payload = collect();
    if (!payload.customer.name) {
      say('Customer name is required.');
      $('qcName').focus();
      return false;
    }
    const sentStatus = payload.status;
    if (payload.status === statusLoaded) delete payload.status;
    else payload.status_from = statusLoaded;
    const id = editingId;
    try {
      const q = editingId
        ? await api('/api/admin/quotes/' + editingId, { method: 'PATCH', body: JSON.stringify(payload) })
        : await api('/api/admin/quotes', { method: 'POST', body: JSON.stringify(payload) });
      if (g !== gen) return false; // the editor has moved on to another quote
      applyServer(q, { sentStatus });
      savedAt = covers; // anything typed while it was saving is still unsaved
      if (!quiet) say('Saved ✓', 'ok');
      return true;
    } catch (e) {
      // Refused — often because the customer has just answered ("Reopen it to
      // see their signature"). The reopened quote must be the server's, not a
      // copy kept from before, so that copy goes.
      if (id != null) Snappy.cache.drop(quotePath(id));
      if (g === gen) say(e.message);
      return false;
    }
  }

  // A "valid until" day that has already gone by.
  const expiredOnScreen = () => !!$('qValid').value && $('qValid').value < todayStr();

  // ---- sending to the customer ----
  async function share(sent) {
    if (sent && expiredOnScreen()) {
      say('This quote’s “Valid until” date has passed — set a new one before sending it.');
      $('qValid').focus();
      return null;
    }
    const g = gen;
    if (!(await save({ quiet: true })) || g !== gen) return null;
    try {
      const q = await api(`/api/admin/quotes/${editingId}/share`, { method: 'POST', body: JSON.stringify({ sent }) });
      if (g !== gen) return null;
      applyServer(q);
      return q;
    } catch (e) {
      if (g === gen) say(e.message);
      return null;
    }
  }

  function message(q) {
    const first = ($('qcName').value.trim().split(/\s+/)[0] || '').replace(/,$/, '');
    const t = totalsNow();
    return [
      `Hi${first ? ' ' + first : ''},`,
      '',
      `Here is your quote ${q.number} from HEK Fencing${$('qProject').value.trim() ? ' for ' + $('qProject').value.trim() : ''} — ${money(t.total)} including tax.`,
      '',
      `You can view it, approve it and sign it online here:`,
      shareLink(q),
      '',
      $('qValid').value ? `The price is good until ${fmtDate($('qValid').value)}.` : '',
      'Any questions, just reply or give us a call.',
      '',
      'Thank you,',
      P.COMPANY.name,
    ]
      .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
      .join('\n');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // No clipboard (plain http, an old browser): show the link to copy by hand.
      $('qrLink').hidden = false;
      $('qrLink').select();
      return false;
    }
  }

  // ---- the estimator ----
  function loadCatalog() {
    if (cat) return Promise.resolve(cat);
    if (!catLoading)
      catLoading = api('/api/admin/quotes/catalog')
        .then((c) => {
          cat = c;
          fillSpecControls();
          recompute();
          return c;
        })
        .catch((e) => {
          catLoading = null;
          throw e;
        });
    return catLoading;
  }

  const sysList = () =>
    cat ? Object.values(cat.systems).filter((s) => s.enabled || (selectedSeg() && selectedSeg().system === s.key)) : [];
  const selectedSeg = () => (fm && layout ? layout.segments.find((s) => s.id === fm.selected()) : null);

  function fillHeights(sysKey, value) {
    const sys = cat.systems[sysKey];
    const hs = [...new Set([...(sys ? sys.heights : []), Number(value) || (sys && sys.height) || 6])].sort((a, b) => a - b);
    $('qeH').innerHTML = hs.map((h) => `<option value="${h}">${fmtNum(h)} ft</option>`).join('');
    $('qeH').value = String(Number(value) || (sys && sys.height) || hs[0]);
  }

  // The panel's fence / height / tear-out describe the selected run when one
  // is selected, and the next run to be drawn otherwise.
  const nextSpec = { system: 'wood_privacy', height_ft: 6, tearout: false };
  function fillSpecControls() {
    if (!cat) return;
    const seg = selectedSeg();
    const spec = seg || nextSpec;
    $('qeSys').innerHTML = sysList()
      .map((s) => `<option value="${s.key}">${esc(s.label)}</option>`)
      .join('');
    if (!cat.systems[spec.system] || (!seg && !cat.systems[spec.system].enabled)) {
      const firstOn = sysList()[0];
      if (firstOn) {
        nextSpec.system = firstOn.key;
        nextSpec.height_ft = firstOn.height;
      }
    }
    $('qeSys').value = spec.system;
    fillHeights(spec.system, spec.height_ft);
    $('qeTear').checked = !!spec.tearout;
    $('qeSpecTitle').textContent = seg ? 'Selected run' : 'Draw fence';
    $('qeDeselect').hidden = !seg;
    // Rebuilt only when it's empty, so picking a run doesn't put the gate size
    // someone just chose back to the first one.
    if (!$('qeGateSize').options.length)
      $('qeGateSize').innerHTML = cat.gates
        .map((g, i) => `<option value="${i}">${esc(g.label)}</option>`)
        .join('');
  }

  function specChanged() {
    const spec = {
      system: $('qeSys').value,
      height_ft: Number($('qeH').value) || 6,
      tearout: $('qeTear').checked,
    };
    const seg = selectedSeg();
    if (seg) fm.updateSegment(seg.id, spec);
    else Object.assign(nextSpec, spec);
  }

  // The hint over the map: the map's own guidance while drawing, or why there
  // is no map yet.
  function estHint(text) {
    $('qeHint').textContent = text || '';
    $('qeHint').style.display = text ? 'block' : 'none';
  }

  // The map, made the first time it's needed. Null while Leaflet is still on
  // its way: it loads only when a map is about to be shown (Snappy.leaflet()),
  // and openEstimator waits for it before asking for the map.
  function ensureMap() {
    if (fm) return fm;
    if (!window.L) return null;
    fm = window.HEKFenceMap.create($('qeMap'), {
      editable: true,
      catalog: cat,
      onChange: (l) => {
        if (settingLayout) return; // being reset by setLayout, not edited
        markDirty();
        layout = l.segments.length ? l : null;
        recompute();
        queueTerrain();
      },
      onSelect: () => fillSpecControls(),
      onMode: (mode) => {
        $('qeDraw').textContent = mode === 'draw' ? '✓ Finish run' : '+ Draw a run';
        $('qeGate').textContent = mode === 'gate' ? 'Cancel' : '+ Gate';
      },
      onHint: estHint,
    });
    if (layout) fm.setLayout(layout);
    return fm;
  }

  // `fresh`: a quote with nothing drawn — go and find the property.
  function openEstimator(fresh) {
    estOpen = true;
    $('qEstBody').hidden = false;
    $('qEst').classList.add('open');
    $('qEstToggle').setAttribute('aria-expanded', 'true');
    const g = gen;
    // The prices and the map library, usually already here (warmEstimator).
    // If either can't load, it says so in its own place.
    Promise.all([
      loadCatalog().catch((e) => {
        $('qeMat').innerHTML = `<p class="q-est-note">Could not load the estimator prices: ${esc(e.message)}</p>`;
        throw e;
      }),
      Snappy.leaflet().catch((e) => {
        estHint('The map could not load. Check the connection, then close the estimator and open it again.');
        throw e;
      }),
    ])
      .then(() => {
        if (!estOpen) return; // closed again while they were on their way
        if (!fm) estHint(''); // an earlier failed try may have left its message
        ensureMap();
        fm.setCatalog(cat);
        // Once the panel has its size: a map made or resized while hidden
        // measures its box as empty.
        setTimeout(() => {
          fm.invalidate();
          if (layout && layout.segments.length) fm.fitToLayout();
          else if (fresh !== false && g === gen) findOnOpen();
        }, 40);
      })
      .catch(() => {
        /* each part above has already said what went wrong */
      });
  }
  function closeEstimator() {
    estOpen = false;
    $('qEstBody').hidden = true;
    $('qEst').classList.remove('open');
    $('qEstToggle').setAttribute('aria-expanded', 'false');
    if (fm) fm.cancel();
  }

  // Drop the map on the job before anyone has to type the address twice.
  function findOnOpen() {
    const addr = (layout && layout.address) || $('qSite').value.trim() || $('qcAddress').value.trim();
    if (!addr) return;
    $('qeAddr').value = addr.replace(/\n/g, ', ');
    searchAddress(true);
  }

  function setLayout(l) {
    layout = l && l.segments && l.segments.length ? l : null;
    // The map is being told what to show, not reporting an edit: anything it
    // says while being reset must not overwrite the layout just set.
    settingLayout = true;
    try {
      if (fm) fm.setLayout(layout || { segments: [], gates: [] }, { fit: !!layout });
    } finally {
      settingLayout = false;
    }
    terrainNote = '';
    // A drawing whose slope isn't fully known (traced by a customer on the
    // estimate page, or a check that didn't finish) gets checked again.
    lastTerrainKey = layout && terrainComplete() ? terrainKey(layout) : '';
    recompute();
    if (layout && !terrainComplete()) queueTerrain();
  }
  let settingLayout = false;

  function recompute() {
    take = cat && layout && layout.segments.length ? T.compute(layout, cat) : null;
    renderRuns();
    renderMaterials();
    renderEstSummary();
    renderPaperLayout();
    renderSummary();
  }

  function renderEstSummary() {
    const el = $('qEstSummary');
    if (!take) {
      el.textContent = layout
        ? 'Loading…'
        : 'Trace the fence on the property — footage, posts, gates and materials are worked out as you draw.';
      return;
    }
    const t = take.totals;
    el.textContent = `${t.fence_ft.toLocaleString()} ft · ${t.posts} posts · ${t.gates} gate${t.gates === 1 ? '' : 's'} · ${money(t.price)} at your markups`;
  }

  function renderRuns() {
    const box = $('qeRuns');
    if (!box) return;
    if (!layout || !cat) {
      box.innerHTML = '<p class="q-est-empty">Nothing drawn yet. Pick a fence, press <b>Draw a run</b>, and click the corners on the map.</p>';
      $('qeTotal').textContent = '';
      return;
    }
    const runs = take ? take.runs : [];
    const sel = fm && fm.selected();
    $('qeTotal').textContent = take ? `${take.totals.fence_ft.toLocaleString()} ft` : '';
    const S = cat.settings;
    box.innerHTML = layout.segments
      .map((seg, i) => {
        const r = runs.find((x) => x.id === seg.id) || {};
        const sys = cat.systems[seg.system] || {};
        const gates = layout.gates.filter((g) => g.seg === seg.id);
        const steep = r.max_grade != null && r.max_grade >= S.slope_grade_pct;
        return `<div class="q-run${seg.id === sel ? ' sel' : ''}" data-seg="${escAttr(seg.id)}">
          <button type="button" class="q-run-main" data-act="select">
            <i style="background:${escAttr(sys.color || '#999')}"></i>
            <span><b>Run ${i + 1} · ${esc(r.label || sys.label || '')}</b>
            <small>${Math.round(r.length_ft || 0)} ft${gates.length ? ` · ${gates.length} gate${gates.length > 1 ? 's' : ''}` : ''}${seg.tearout ? ' · tear-out' : ''}${
              steep ? ` · <em class="q-run-slope">slope ${Math.round(r.max_grade)}%</em>` : ''
            }</small></span>
          </button>
          <button type="button" class="link-btn danger" data-act="del" title="Delete this run" aria-label="Delete run ${i + 1}">✕</button>
          ${gates
            .map(
              (g) => `<div class="q-run-gate"><span>${esc(T.gateLabel(g))}</span>
                <button type="button" class="link-btn danger" data-act="del-gate" data-gate="${escAttr(g.id)}" aria-label="Remove gate">✕</button></div>`
            )
            .join('')}
        </div>`;
      })
      .join('');
  }

  function renderMaterials() {
    const box = $('qeMat');
    if (!box) return;
    if (!cat) return;
    if (!take) {
      box.innerHTML = '<p class="q-est-empty">The material list builds itself as you draw.</p>';
      $('qePut').disabled = true;
      $('qeNote').textContent = '';
      return;
    }
    $('qePut').disabled = false;
    const S = cat.settings;
    const t = take.totals;
    const row = (l) =>
      `<tr><td>${esc(l.label)}</td><td class="r">${fmtNum(l.qty)} <small>${esc(l.unit)}</small></td><td class="r">${money(l.unit_cost)}</td><td class="r">${money(l.cost)}</td></tr>`;
    box.innerHTML = `
      <div class="q-mat-wrap"><table class="q-mat">
        <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Unit cost</th><th class="r">Cost</th></tr></thead>
        <tbody>
          ${take.materials.map(row).join('')}
          <tr class="q-mat-sub"><td colspan="4">Labor</td></tr>
          ${take.labor.map(row).join('')}
        </tbody>
      </table></div>
      <div class="q-mat-totals">
        <div><span>Materials</span><b>${money(t.material_cost)}</b><small>+${fmtNum(S.material_markup_pct)}% → ${money(t.material_price)}</small></div>
        <div><span>Labor</span><b>${money(t.labor_cost)}</b><small>+${fmtNum(S.labor_markup_pct)}% → ${money(t.labor_price)}</small></div>
        <div><span>Your cost</span><b>${money(t.cost)}</b><small>${t.posts} posts · ${t.fence_ft.toLocaleString()} ft</small></div>
        <div class="hi"><span>Price before tax</span><b>${money(t.price)}</b><small>${money(t.per_ft)}/ft · ${Math.round(t.margin_pct)}% margin</small></div>
      </div>`;
    const steep = take.runs.filter((r) => r.max_grade != null && r.max_grade >= S.slope_grade_pct);
    const slopeNote = steep.length
      ? `Slope: ${steep.length} run${steep.length > 1 ? 's climb' : ' climbs'} ${Math.round(Math.max(...steep.map((r) => r.max_grade)))}% or more — ${fmtNum(S.slope_labor_pct)}% extra labor is included on that footage.`
      : '';
    // "Level" is only said when every leg was actually checked.
    $('qeNote').textContent = [
      terrainNote,
      slopeNote,
      !terrainNote && !slopeNote && terrainComplete() ? 'Slope checked — the ground is level enough to build straight.' : '',
      !terrainNote && layoutHasTerrain() && !terrainComplete() ? 'Slope not yet checked for every leg — those are priced as level.' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  const layoutHasTerrain = () => layout && layout.terrain && Object.keys(layout.terrain).length > 0;
  // Every leg of every run has a known grade.
  const terrainComplete = () =>
    !!layout &&
    layout.segments.every((s) => {
      const g = layout.terrain && Object.prototype.hasOwnProperty.call(layout.terrain, s.id) ? layout.terrain[s.id] : null;
      return Array.isArray(g) && g.length >= s.points.length - 1 && g.slice(0, s.points.length - 1).every((x) => x != null && Number.isFinite(Number(x)));
    });

  // The layout drawing on the sheet itself, as it will print.
  function renderPaperLayout() {
    const svg = cat && layout ? T.layoutSvg(layout, cat, { width: 760, height: 300 }) : '';
    $('qPaperLayout').hidden = !svg;
    $('qPaperLayoutSvg').innerHTML = svg ? svg + legendHtml() : '';
  }

  function legendHtml() {
    if (!take) return '';
    return `<div class="paper-legend">${take.groups
      .map((g) => {
        const sys = cat.systems[g.system] || {};
        const gates = g.gates.map((x) => `${x.count} × ${x.label}`).join(', ');
        return `<span><i style="background:${escAttr(sys.color || '#999')}"></i>${esc(g.label)} — ${g.fence_ft.toLocaleString()} ft${gates ? ` · ${esc(gates)}` : ''}</span>`;
      })
      .join('')}</div>`;
  }

  // ---- slope ----
  // Asked for once the drawing settles, and only when the geometry changed.
  let terrainTimer = null;
  let lastTerrainKey = '';
  let terrainNote = '';
  const terrainKey = (l) => JSON.stringify(l.segments.map((s) => [s.id, s.points]));
  function queueTerrain() {
    clearTimeout(terrainTimer);
    if (!layout) return;
    const g = gen;
    terrainTimer = setTimeout(async () => {
      if (!layout || g !== gen) return;
      const key = terrainKey(layout);
      if (key === lastTerrainKey) return;
      lastTerrainKey = key;
      try {
        const r = await api('/api/admin/quotes/terrain', {
          method: 'POST',
          body: JSON.stringify({ segments: layout.segments.map((s) => ({ id: s.id, points: s.points })) }),
        });
        // Another quote, or the same one redrawn meanwhile: this answer is stale.
        if (g !== gen || !layout || terrainKey(layout) !== key) return;
        terrainNote = r.note || '';
        if (fm) fm.setTerrain(r.terrain || {});
        else {
          layout.terrain = r.terrain || {};
          recompute();
        }
      } catch (e) {
        if (g === gen) terrainNote = '';
      }
    }, 1200);
  }

  // ---- address search ----
  async function searchAddress(auto) {
    const q = $('qeAddr').value.trim();
    if (q.length < 3) return;
    const g = gen;
    const box = $('qeResults');
    box.innerHTML = '<div class="est-result-note">Looking…</div>';
    box.style.display = 'block';
    try {
      const d = await api('/api/admin/quotes/geocode?q=' + encodeURIComponent(q));
      // Another quote is open now: this address was for the last one.
      if (g !== gen) return;
      const results = d.results || [];
      if (!results.length) {
        box.innerHTML = '<div class="est-result-note">Nothing found — try adding the town and province.</div>';
        return;
      }
      // Opening the map on a known address: just go there.
      if (auto) {
        box.style.display = 'none';
        return goToResult(results[0], true);
      }
      box.innerHTML =
        (results[0].approx
          ? '<div class="est-result-note">No exact match for the house number — here is the road. Find the property on the map.</div>'
          : '') + results.map((r, i) => `<button type="button" data-r="${i}">${esc(r.label)}</button>`).join('');
      box.dataset.results = JSON.stringify(results);
    } catch (e) {
      if (g === gen) box.innerHTML = '<div class="est-result-note">Could not search just now.</div>';
    }
  }

  function goToResult(r, quietly) {
    const g = gen;
    if (!r.approx) {
      if (layout) layout.address = r.label;
      // The job site is usually exactly what was just looked up.
      if (!quietly && !$('qSite').value.trim()) {
        $('qSite').value = r.label;
        autosize($('qSite'));
      }
    }
    // On a slow connection the map library can still be on its way.
    Snappy.leaflet()
      .then(() => {
        if (g !== gen || !ensureMap()) return; // another quote is open now
        // A road-only match is somewhere along a road: start wider.
        fm.goTo(r.lat, r.lng, r.approx ? 16 : 19);
        if (!r.approx) fm.setAddress(r.label);
      })
      .catch(() => {
        /* openEstimator has already said the map couldn't load */
      });
  }

  // ---- catalog editor ----
  const SETTING_LABELS = [
    ['material_markup_pct', 'Markup on materials', '%'],
    ['labor_markup_pct', 'Markup on labor', '%'],
    ['waste_pct', 'Waste allowance', '%'],
    ['target_margin_pct', 'Target margin', '%'],
    ['slope_grade_pct', 'Counts as sloped from', '% grade'],
    ['slope_labor_pct', 'Extra labor on slopes', '%'],
    ['tearout_cost', 'Tear-out cost', '$/ft'],
    ['delivery_cost', 'Delivery & setup', '$/job'],
  ];

  function openCatalog() {
    loadCatalog().then(() => {
      const ro = !cat.can_edit;
      const dis = ro ? 'disabled' : '';
      $('qcLead').innerHTML = ro
        ? 'What the estimator prices from. Only the office can change these.'
        : 'What things cost <b>you</b>. The markups turn cost into the price on the quote. Every new drawing is priced from these; quotes already saved keep their lines.';
      $('qcBody').innerHTML = `
        <h4>Markups &amp; rules</h4>
        <div class="q-cat-settings">${SETTING_LABELS.map(
          ([k, label, unit]) =>
            `<label>${esc(label)} <span>${esc(unit)}</span><input data-set="${k}" inputmode="decimal" value="${escAttr(cat.settings[k])}" ${dis} /></label>`
        ).join('')}</div>
        <h4>Fences</h4>
        <div class="q-mat-wrap"><table class="q-mat q-cat-table">
          <thead><tr><th>Fence</th><th>Offer</th><th class="r">Post spacing ft</th><th class="r">Set depth ft</th><th class="r">Concrete bags/post</th><th class="r">Labor $/ft</th><th class="r">Gate labor $/leaf</th></tr></thead>
          <tbody>${Object.values(cat.systems)
            .map(
              (s) => `<tr data-sys="${s.key}"><td><i class="q-swatch" style="background:${escAttr(s.color)}"></i>${esc(s.label)}</td>
                <td><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''} ${dis} aria-label="Offer ${escAttr(s.label)}" /></td>
                ${['spacing', 'depth', 'concrete', 'labor', 'gate_labor']
                  .map((f) => `<td class="r"><input data-f="${f}" inputmode="decimal" value="${escAttr(s[f])}" ${dis} /></td>`)
                  .join('')}</tr>`
            )
            .join('')}</tbody>
        </table></div>
        <h4>Materials <span class="q-rail-note">— your cost</span></h4>
        <div class="q-mat-wrap"><table class="q-mat q-cat-table">
          <thead><tr><th>Item</th><th class="r">Cost</th><th>Per</th></tr></thead>
          <tbody>${Object.entries(cat.materials)
            .map(
              ([k, m]) => `<tr data-mat="${k}"><td>${esc(m.label.replace('{len}', '…'))}</td>
                <td class="r"><input data-f="cost" inputmode="decimal" value="${escAttr(m.cost)}" ${dis} /></td>
                <td class="q-cat-per">${m.per === 'ft' ? 'ft of size' : esc(m.unit)}</td></tr>`
            )
            .join('')}</tbody>
        </table></div>`;
      $('qcSave').hidden = ro;
      $('qcReset').hidden = ro;
      $('qcMsg').textContent = '';
      catModal.classList.add('open');
    });
  }

  async function saveCatalog() {
    const patch = { settings: {}, systems: {}, materials: {} };
    // Every box must hold a number. "$9.50", "40%" and "1,200" are fine; an
    // empty box or a typo stops the save and says which one, instead of
    // quietly storing 0 — a post spacing of 0, or a 0% markup, would misprice
    // every quote after it.
    let bad = null;
    const read = (input) => {
      const n = T.parseAmount(input.value);
      if (n == null && !bad) bad = input;
      return n;
    };
    catModal.querySelectorAll('[data-set]').forEach((i) => (patch.settings[i.dataset.set] = read(i)));
    catModal.querySelectorAll('tr[data-sys]').forEach((tr) => {
      const s = {};
      tr.querySelectorAll('[data-f]').forEach((i) => (s[i.dataset.f] = i.type === 'checkbox' ? i.checked : read(i)));
      patch.systems[tr.dataset.sys] = s;
    });
    catModal.querySelectorAll('tr[data-mat]').forEach((tr) => {
      patch.materials[tr.dataset.mat] = { cost: read(tr.querySelector('[data-f="cost"]')) };
    });
    if (bad) {
      $('qcMsg').className = 'msg err';
      $('qcMsg').textContent = `"${bad.value || '(empty)'}" isn't a number — fix the highlighted box and save again.`;
      bad.classList.add('q-cat-bad');
      bad.focus();
      bad.addEventListener('input', () => bad.classList.remove('q-cat-bad'), { once: true });
      return;
    }
    $('qcMsg').className = 'msg';
    $('qcMsg').textContent = '';
    // The button is pressed and locked at once; "Saving…" and its spinner
    // only if the save takes long enough to notice.
    await Snappy.busy(
      $('qcSave'),
      async () => {
        try {
          cat = await api('/api/admin/quotes/catalog', { method: 'PATCH', body: JSON.stringify(patch) });
          afterCatalog();
          $('qcMsg').className = 'msg ok';
          $('qcMsg').textContent = 'Saved ✓';
          setTimeout(() => catModal.classList.remove('open'), 500);
        } catch (e) {
          $('qcMsg').className = 'msg err';
          $('qcMsg').textContent = e.message;
        }
      },
      { label: 'Saving…' }
    );
  }

  function afterCatalog() {
    if (fm) fm.setCatalog(cat);
    fillSpecControls();
    recompute();
  }

  // ---- events ----
  $('qNew').addEventListener('click', newQuote);
  $('qBack').addEventListener('click', () => okToLeave() && load());
  $('qAddRow').addEventListener('click', () => {
    markDirty();
    addRow().querySelector('.i-desc').focus();
  });
  // Anything typed or picked on the quote is a change. (Not the estimator's own
  // controls — an address search or the next run's fence type changes nothing
  // yet; an edit to the drawing is counted when the map reports it.)
  const editedOnSheet = (e) => {
    if (!e.target.closest('#qEst')) markDirty();
  };
  $('qEditor').addEventListener('input', editedOnSheet);
  $('qEditor').addEventListener('change', editedOnSheet);
  window.addEventListener('beforeunload', (e) => {
    if (editorOpen() && edits !== savedAt) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  // Pressed and locked at once; "Saving…" and a spinner only if the save takes
  // long enough to notice, so a quick one never flickers.
  $('qSave').addEventListener('click', () => Snappy.busy($('qSave'), () => save(), { label: 'Saving…' }));
  $('qPrint').addEventListener('click', () => {
    // Print exactly what's on screen, saved or not.
    P.openPrint({ number: currentNumber, ...collect(), ...printExtras() }, 'quote');
  });

  // What the printed quote carries beyond the sheet: the layout drawing and,
  // once it has one, the customer's signature.
  function printExtras() {
    const out = {};
    if (cat && layout) {
      out.layout_svg = T.layoutSvg(layout, cat, { width: 700, height: 300 });
      out.layout_legend = take
        ? take.groups.map((g) => ({ label: g.label, color: (cat.systems[g.system] || {}).color, fence_ft: g.fence_ft, gates: g.gates }))
        : [];
    }
    if (signatureStands()) out.signature = current.signature;
    return out;
  }

  // Everything typed on the sheet: grow textareas, keep the totals live.
  $('qPaper').addEventListener('input', (e) => {
    autosize(e.target);
    computeTotals();
  });
  $('qcName').addEventListener('input', () => setNumber(currentNumber));
  $('qcEmail').addEventListener('input', renderShare);
  $('qcPhone').addEventListener('input', renderShare);
  // A new date pushes "valid until" along with it rather than leaving it behind.
  $('qDate').addEventListener('change', () => {
    if ($('qDate').value && (!$('qValid').value || $('qValid').value < $('qDate').value))
      $('qValid').value = addDays($('qDate').value, VALID_DAYS);
  });

  // Bill for an accepted quote: copies the customer and pricing into a new
  // invoice rather than making anyone retype it, and marks the quote accepted.
  if ($('qToInvoice'))
    $('qToInvoice').addEventListener('click', () => {
      if (editingId == null) return;
      if (!confirm('Create an invoice from this quote?\n\nThe quote will be marked accepted.')) return;
      say('', '');
      // Locked from the press, so it can't bill twice; "Creating…" and a
      // spinner only if the wait is long enough to notice.
      Snappy.busy(
        $('qToInvoice'),
        async () => {
          try {
            // Save first, so the invoice gets what is on screen, not the last save.
            if (!(await save({ quiet: true }))) return;
            const inv = await api('/api/admin/quotes/' + editingId + '/invoice', { method: 'POST' });
            // A kept copy of the invoices list would be missing this one.
            Snappy.cache.drop('/api/admin/invoices');
            $('qStatus').value = 'accepted';
            say(`Invoice ${inv.number} created.`, 'ok');
            const tab = document.querySelector('.side-nav .tab[data-tab="invoices"]');
            if (tab && tab.style.display !== 'none') {
              tab.click();
              if (window.Invoices) window.Invoices.openById(inv.id).catch(() => {});
            }
          } catch (e) {
            say(e.message);
          }
        },
        { label: 'Creating…' }
      );
    });

  $('qItems').addEventListener('click', (e) => {
    const del = e.target.closest('.i-del');
    if (del) {
      del.closest('tr').remove();
      markDirty();
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
    // Fill the blank line a new quote starts with instead of leaving it empty.
    const blank = rowData().find((r) => !r.description && !r.qty && !r.unit_price);
    if (blank) blank.tr.remove();
    markDirty();
    addRow({ description: p.description, unit: p.unit, qty: 1, unit_price: '' }).querySelector('.i-price').focus();
  });

  // ---- estimator events ----
  $('qEstToggle').addEventListener('click', () => (estOpen ? closeEstimator() : openEstimator(!layout)));
  $('qeGo').addEventListener('click', () => searchAddress(false));
  $('qeAddr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchAddress(false);
    }
  });
  $('qeResults').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-r]');
    if (!btn) return;
    const r = JSON.parse($('qeResults').dataset.results || '[]')[Number(btn.dataset.r)];
    if (!r) return;
    $('qeResults').style.display = 'none';
    $('qeAddr').value = r.label;
    goToResult(r, false);
  });
  document.querySelector('.q-est-layers').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-layer]');
    if (!btn || !fm) return;
    document.querySelectorAll('.q-est-layers button').forEach((b) => b.classList.toggle('active', b === btn));
    fm.setBase(btn.dataset.layer);
  });
  $('qeSys').addEventListener('change', () => {
    const sys = cat.systems[$('qeSys').value];
    // A new fence type starts at its usual height unless that height suits it.
    const h = Number($('qeH').value);
    fillHeights(sys.key, sys.heights.includes(h) ? h : sys.height);
    specChanged();
  });
  $('qeH').addEventListener('change', specChanged);
  $('qeTear').addEventListener('change', specChanged);
  $('qeDeselect').addEventListener('click', () => fm && fm.select(null));
  // Until Leaflet is in there is no map to draw on; openEstimator makes it the
  // moment it arrives and clears this hint.
  const MAP_COMING = 'The map is still loading — one moment.';
  $('qeDraw').addEventListener('click', () => {
    if (!ensureMap()) return estHint(MAP_COMING);
    if (fm.mode() === 'draw') return fm.finishRun();
    // Drawing always starts a new run, with what the panel shows.
    const spec = { system: $('qeSys').value, height_ft: Number($('qeH').value) || 6, tearout: $('qeTear').checked };
    if (fm.selected()) fm.select(null);
    Object.assign(nextSpec, spec);
    fillSpecControls();
    fm.startRun({ ...nextSpec });
    $('qeMap').focus({ preventScroll: true });
  });
  $('qeGate').addEventListener('click', () => {
    if (!cat) return; // the gate sizes come with the catalog
    if (!ensureMap()) return estHint(MAP_COMING);
    if (fm.mode() === 'gate') return fm.cancel();
    const g = cat.gates[Number($('qeGateSize').value) || 0];
    fm.startGate(g);
  });
  $('qeUndo').addEventListener('click', () => fm && fm.undo());
  $('qeFit').addEventListener('click', () => fm && fm.fitToLayout());
  $('qeClear').addEventListener('click', () => {
    if (!fm || !layout) return;
    if (!confirm('Clear the whole drawing?')) return;
    fm.clear();
  });
  $('qeRuns').addEventListener('click', (e) => {
    const run = e.target.closest('[data-seg]');
    const act = e.target.closest('[data-act]');
    if (!run || !act || !fm) return;
    const id = run.dataset.seg;
    if (act.dataset.act === 'select') fm.select(fm.selected() === id ? null : id);
    else if (act.dataset.act === 'del') fm.removeSegment(id);
    else if (act.dataset.act === 'del-gate') fm.removeGate(act.dataset.gate);
  });

  // Turn the drawing into lines on the quote. Lines it made last time are
  // replaced; lines typed by hand stay where they are.
  $('qePut').addEventListener('click', () => {
    if (!take) return;
    const lines = T.quoteLines(take, cat, $('qeMode').value);
    const rows = rowData();
    rows.filter((r) => r.src === 'layout' || (!r.description && !r.qty && !r.unit_price)).forEach((r) => r.tr.remove());
    const firstManual = $('qItems').querySelector('tr');
    markDirty();
    lines.forEach((l) => addRow(l, firstManual));
    if (!$('qProject').value.trim())
      $('qProject').value = take.groups.map((g) => `${g.label} fence`).join(' + ');
    if (!$('qSite').value.trim() && layout && layout.address) {
      $('qSite').value = layout.address;
      autosize($('qSite'));
    }
    computeTotals();
    autosizeAll($('qPaper'));
    say(`${lines.length} line${lines.length === 1 ? '' : 's'} put on the quote. Save when it looks right.`, 'ok');
    $('qItems').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('qeCat').addEventListener('click', openCatalog);

  // ---- catalog modal events ----
  $('qcClose').addEventListener('click', () => catModal.classList.remove('open'));
  catModal.addEventListener('click', (e) => {
    if (e.target === catModal) catModal.classList.remove('open');
  });
  $('qcSave').addEventListener('click', saveCatalog);
  $('qcReset').addEventListener('click', () => {
    if (!confirm('Put every estimator price back to the starting defaults?')) return;
    Snappy.busy($('qcReset'), async () => {
      try {
        cat = await api('/api/admin/quotes/catalog/reset', { method: 'POST' });
        afterCatalog();
        catModal.classList.remove('open');
      } catch (e) {
        $('qcMsg').className = 'msg err';
        $('qcMsg').textContent = e.message;
      }
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (catModal.classList.contains('open')) catModal.classList.remove('open');
    else if (fm && fm.mode() !== 'idle') fm.cancel();
  });

  // ---- rail events ----
  // Saving and sending from the rail. The button is locked from the first
  // press, so a double click can't send twice, and shows a spinner only if the
  // wait is long enough to notice. renderShare() switches these buttons on and
  // off by what is typed, which can switch one back on mid-send, so a press on
  // a button that is still busy is ignored here as well.
  const sends = (btn, work) => () => (btn.getAttribute('aria-busy') === 'true' ? undefined : Snappy.busy(btn, work));
  $('qrEmail').addEventListener(
    'click',
    sends($('qrEmail'), async () => {
      const email = $('qcEmail').value.trim();
      if (!email) return;
      const q = await share(true);
      if (!q) return;
      const subject = `Your fence quote ${q.number} from ${P.COMPANY.name}`;
      location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message(q))}`;
      say('Your email app should open with the message ready to send. The quote is marked sent.', 'ok');
    })
  );
  $('qrText').addEventListener(
    'click',
    sends($('qrText'), async () => {
      const phone = $('qcPhone').value.replace(/[^\d+]/g, '');
      if (!phone) return;
      const q = await share(true);
      if (!q) return;
      const sep = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) ? '&' : '?';
      const text = `Hi from ${P.COMPANY.name} — here is your quote ${q.number} (${money(totalsNow().total)}). View, approve and sign it here: ${shareLink(q)}`;
      location.href = `sms:${phone}${sep}body=${encodeURIComponent(text)}`;
    })
  );
  $('qrCopy').addEventListener(
    'click',
    sends($('qrCopy'), async () => {
      const q = await share(true);
      if (!q) return;
      const ok = await copyText(shareLink(q));
      say(ok ? 'Link copied — paste it into an email or text. The quote is marked sent.' : 'Copy the link below.', 'ok');
    })
  );
  $('qrPreview').addEventListener(
    'click',
    sends($('qrPreview'), async () => {
      // Opened before the save so a pop-up blocker sees it as the click's own.
      // (Snappy.busy starts this straight away, still inside the click.)
      const w = window.open('', '_blank');
      const q = await share(false);
      if (!q) {
        if (w) w.close();
        return;
      }
      if (w) w.location = shareLink(q);
      else location.href = shareLink(q);
    })
  );
  $('qrAnalyze').addEventListener('click', () => {
    const btn = $('qrAnalyze');
    if (btn.disabled) return;
    // Busy from the first click — a review costs money, and a double click
    // shouldn't buy two. "Analyzing…" and the spinner follow if it's slow,
    // which a review always is.
    Snappy.busy(
      btn,
      async () => {
        const g = gen;
        const before = lastReview;
        try {
          if (!(await save({ quiet: true })) || g !== gen) return;
          // `wait`: held back for a moment, like any loading line.
          $('qrReview').innerHTML = '<p class="q-rail-note q-busy wait">Reading the quote…</p>';
          const r = await api(`/api/admin/quotes/${editingId}/analyze`, { method: 'POST' });
          if (g === gen) renderReview(r); // still the quote it was asked about
        } catch (e) {
          if (g === gen) {
            renderReview(before);
            say(e.message);
          }
        }
      },
      { label: 'Analyzing…' }
    );
  });
  $('qrReview').addEventListener('click', (e) => {
    const b = e.target.closest('[data-upsell]');
    if (!b || !lastReview || !lastReview.ai) return;
    const u = lastReview.ai.upsells[Number(b.dataset.upsell)];
    if (!u) return;
    markDirty();
    addRow({ description: u.title, qty: 1, unit: 'each', unit_price: u.price > 0 ? u.price : '' });
    b.disabled = true;
    b.textContent = 'Added ✓';
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
        // The copy a hover over the row has just fetched, or is fetching.
        const q = keptQuote(id) || (await Snappy.load(api, quotePath(id)));
        const extras = {};
        if (q.layout) {
          const c = await loadCatalog().catch(() => null);
          if (c) {
            extras.layout_svg = T.layoutSvg(q.layout, c, { width: 700, height: 300 });
            extras.layout_legend = T.layoutLegend(q.layout, c);
          }
        }
        const doc = { ...q, ...extras };
        // A quote signed and later reopened at other prices must not print as
        // agreed to: the signature goes only where it still stands.
        if (!(q.signature && q.status === 'accepted' && q.signature_current !== false)) delete doc.signature;
        P.openPrint(doc, 'quote');
      } else if (btn.dataset.act === 'del') {
        if (!confirm('Delete this quote?')) return;
        await deleteQuote(id);
      }
    } catch (err) {
      alert(err.message);
    }
  });

  // A hover, focus or touch on a row starts fetching that quote, so the press
  // that follows finds it here, or joins the request already on its way.
  Snappy.intent($('qBody'), 'tr[data-id]', (tr) => Snappy.prefetch(api, quotePath(tr.dataset.id)));

  // Deleting from the list: the row goes at once and the server is told
  // behind it. It refuses (409) for a quote that has been accepted, signed or
  // invoiced — the row then comes back where it was, and the caller says why.
  function deleteQuote(id) {
    let kept = null; // the row as it was in the kept first page, and its place there
    return Snappy.optimistic(
      () => {
        deleted.add(id);
        rowsOf(id).forEach((tr) => (tr.style.display = 'none'));
        // So the kept first page can't draw it again while this is decided.
        Snappy.cache.update(LIST, (page) => {
          const rows = page && page.quotes;
          const at = rows ? rows.findIndex((q) => q.id === id) : -1;
          if (at >= 0) kept = { at, row: rows.splice(at, 1)[0] };
          return page;
        });
        emptyCheck();
        return () => {
          deleted.delete(id);
          rowsOf(id).forEach((tr) => (tr.style.display = ''));
          if (kept)
            Snappy.cache.update(LIST, (page) => {
              const rows = page && page.quotes;
              if (rows && !rows.some((q) => q.id === id)) rows.splice(Math.min(kept.at, rows.length), 0, kept.row);
              return page;
            });
          emptyCheck();
        };
      },
      () => api(quotePath(id), { method: 'DELETE' })
    ).then(() => {
      // Gone for good. It stays in `deleted`, so a list answer that left the
      // server before the delete landed still won't show it.
      rowsOf(id).forEach((tr) => tr.remove());
    });
  }

  // Called by the Pricing tab: open a fresh quote pre-filled with the estimate.
  function activateQuotesTab() {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.section').forEach((x) => x.classList.remove('active'));
    const tab = document.querySelector('[data-tab="quotes"]');
    if (tab) tab.classList.add('active');
    if ($('tab-quotes')) $('tab-quotes').classList.add('active');
  }
  function prefill(items, opts) {
    // A quote with unsaved changes in the editor stays unless they say so.
    if (!okToLeave()) return false;
    activateQuotesTab();
    newQuote();
    closeEstimator();
    $('qItems').innerHTML = '';
    (items && items.length ? items : [{}]).forEach((it) => addRow(it));
    if (opts && opts.tax != null) $('qTax').value = opts.tax;
    computeTotals();
    autosizeAll($('qPaper'));
    // Brought over from Pricing: unsaved until saved.
    markDirty();
    return true;
  }

  // For the shell to call when someone shows interest in the Quotes tab, or
  // the page is idle: fetch the list's first page ahead, so the tab opens on
  // it. Safe to call any time. Nothing is asked for until someone is signed in
  // and the tab is theirs: before that the request would be refused, and a
  // refused request sends the page to sign-in.
  function prefetch() {
    const app = $('app');
    const tab = document.querySelector('.tab[data-tab="quotes"]');
    if (!app || !app.getClientRects().length || !tab || tab.style.display === 'none') return;
    Snappy.prefetch(api, LIST, { persist: true });
  }

  renderReview(null);
  // The tab bar calls load() whenever Quotes is clicked; with unsaved changes
  // in the editor that asks first, and "Cancel" leaves the editor as it was.
  window.Quotes = { load: () => (okToLeave() ? load() : Promise.resolve()), prefill, prefetch };
})();
