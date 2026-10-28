// The customer's quote page at "/quote?k=<token>".
//
// No login: the long random token in the link is the whole of the access, and
// the server only ever returns what the customer is meant to see — never cost,
// margin or the office's notes to itself. From here the customer can read the
// quote, see where the fence goes on their own property, download it, and
// approve and sign it (or decline it) from their phone.
(function () {
  const $ = (id) => document.getElementById(id);
  const P = window.HEKPaper;
  const T = window.HEKTakeoff;
  const { money, fmtNum, fmtDate } = P;
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const token = new URLSearchParams(location.search).get('k') || '';
  const catalog = T.buildCatalog(); // only for each fence's colour on the map
  let quote = null;

  // A smooth scroll is motion too: someone who has asked their device for less
  // of it gets the plain jump.
  const scrollMotion = () =>
    window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

  async function api(path, opts) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...(opts || {}) });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok || !data) {
      const err = new Error((data && data.error) || 'Something went wrong. Please try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const C = P.COMPANY;
  const tel = (s) => 'tel:' + String(s).replace(/[^\d+]/g, '');
  function contactHtml() {
    return (
      C.phones.map((p) => `<a href="${esc(tel(p))}">📞 ${esc(p)}</a>`).join('') +
      C.emails.map((e) => `<a href="mailto:${esc(e)}">✉ ${esc(e)}</a>`).join('')
    );
  }

  // ---- render ----
  function render(q) {
    quote = q;
    document.title = `Quote ${q.number} — HEK Fencing`;
    $('qpTopMeta').innerHTML = `<span>Quote <b>${esc(q.number)}</b></span>${statusPill(q)}`;
    $('qpName').textContent = q.customer.name;
    $('qpAddr').textContent = q.customer.address || '';
    $('qpProject').textContent = q.project || 'Fence installation';
    $('qpSite').textContent = q.job_site && q.job_site !== q.customer.address ? q.job_site : '';
    $('qpTotal').textContent = money(q.total);
    $('qpTaxNote').textContent = q.tax ? `Includes ${money(q.tax)} tax (${fmtNum(q.tax_rate)}%)` : '';
    $('qpDeposit').hidden = !(q.deposit > 0);
    $('qpDeposit').innerHTML = q.deposit > 0 ? `Deposit to book: <b>${money(q.deposit)}</b> (${fmtNum(q.deposit_pct)}%)` : '';
    $('qpMeta').innerHTML = [
      ['Quote date', fmtDate(q.quote_date)],
      ['Valid until', fmtDate(q.valid_until)],
    ]
      .filter((m) => m[1])
      .map((m) => `<div><dt>${esc(m[0])}</dt><dd>${esc(m[1])}</dd></div>`)
      .join('');

    // Line items: a table on a wide screen, stacked on a phone (CSS).
    const items = (q.items || []).filter((it) => it.description || Number(it.qty) || Number(it.unit_price));
    $('qpItems').innerHTML = items.length
      ? `<table class="qp-table"><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>${items
          .map((it) => {
            const [head, ...rest] = String(it.description || '').split('\n');
            return `<tr>
              <td class="qp-desc"><b>${esc(head)}</b>${rest.length ? `<span>${esc(rest.join('\n'))}</span>` : ''}</td>
              <td class="r" data-l="Qty">${esc(fmtNum(it.qty))} ${esc(it.unit || '')}</td>
              <td class="r" data-l="Price">${money(it.unit_price)}</td>
              <td class="r qp-amt" data-l="Amount">${money(P.lineAmount(it))}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : '<p class="qp-dim">No line items.</p>';
    $('qpTotals').innerHTML = `
      <div><span>Subtotal</span><span>${money(q.subtotal)}</span></div>
      <div><span>Tax (${esc(fmtNum(q.tax_rate))}%)</span><span>${money(q.tax)}</span></div>
      <div class="qp-grand"><span>Total (CAD)</span><span>${money(q.total)}</span></div>
      ${q.deposit > 0 ? `<div class="qp-dep"><span>Deposit to book (${esc(fmtNum(q.deposit_pct))}%)</span><span>${money(q.deposit)}</span></div>` : ''}`;

    $('qpNotesCard').hidden = !q.notes;
    $('qpNotes').textContent = q.notes || '';

    // The plan is a picture of the job; a fault in drawing it must never keep
    // the quote itself — the price, the work, the way to sign — off screen.
    try {
      renderLayout(q);
    } catch (e) {
      console.error(e);
      $('qpLayoutCard').hidden = true;
    }
    renderState(q);

    $('qpFoot').innerHTML = `
      <div class="qp-contact">${contactHtml()}</div>
      <p>${esc(C.name)} · ${esc(C.serviceArea)} · ${esc(C.website)}<br />${C.locations.map(esc).join(' · ')}</p>`;
    $('qpLoading').hidden = true;
    $('qpMain').hidden = false;
  }

  function statusPill(q) {
    if (q.status === 'accepted') return '<span class="qp-pill ok">Accepted</span>';
    if (q.status === 'declined') return '<span class="qp-pill bad">Declined</span>';
    if (q.expired) return '<span class="qp-pill bad">Expired</span>';
    return '<span class="qp-pill">Awaiting approval</span>';
  }

  // The fence plan. Its satellite view needs Leaflet, and Leaflet is never
  // allowed to hold up the quote: the price, the work and the terms go on
  // screen the moment they arrive, and the map fills in once the library is
  // ready — usually at once, since quote.html preloads it. A quiet placeholder
  // keeps the card's place meanwhile, and if Leaflet can't load at all, the
  // drawing to scale stands in, as it always has.
  let map = null;
  let leaflet = null; // the one request for Leaflet, made with the first plan
  function renderLayout(q) {
    const has = q.layout && q.layout.segments && q.layout.segments.length;
    $('qpLayoutCard').hidden = !has;
    if (!has) return;
    $('qpLegend').innerHTML = (q.legend || [])
      .map((g) => {
        const gates = (g.gates || []).map((x) => `${x.count} × ${x.label}`).join(', ');
        return `<span><i style="background:${esc(g.color)}"></i>${esc(g.label)} — ${esc(Number(g.fence_ft).toLocaleString('en-US'))} ft${gates ? ` · ${esc(gates)}` : ''}</span>`;
      })
      .join('');
    if (!leaflet) {
      $('qpMap').innerHTML = '<p class="qp-map-note wait">Loading the map…</p>';
      leaflet = Promise.resolve().then(() => Snappy.leaflet());
    }
    leaflet.then(showMap).catch((e) => {
      console.error(e);
      showDrawing();
    });
  }

  // The satellite view, of the plan in the quote as it is now — a newer
  // render may have landed while Leaflet was on its way.
  function showMap() {
    if (!window.HEKFenceMap) throw new Error('The fence map is missing.');
    if (!map) {
      $('qpMap').textContent = ''; // the placeholder goes; Leaflet builds its own panes in here
      map = window.HEKFenceMap.create($('qpMap'), { editable: false, catalog, scrollWheelZoom: false, onHint: () => {} });
    }
    map.setLayout(quote.layout);
    setTimeout(() => {
      map.invalidate();
      map.fitToLayout();
    }, 50);
  }

  // The drawing to scale, for when there is no satellite view to be had.
  function showDrawing() {
    if (!quote || !quote.layout) return;
    $('qpMap').classList.add('qp-map-svg');
    $('qpMap').innerHTML = T.layoutSvg(quote.layout, catalog, { width: 760, height: 360 });
  }

  // A note at the top after a signature was refused because the quote changed.
  function showUpdated() {
    const b = $('qpBanner');
    b.hidden = false;
    b.className = 'qp-banner bad';
    b.innerHTML =
      '<b>This quote was just updated.</b> Please read it over again — the price or the work may have changed — then sign below.';
    // Agreeing again is their decision, made after reading the new version.
    $('qpAgree').checked = false;
  }

  function renderState(q) {
    const banner = $('qpBanner');
    // Signed — and the signature still stands for the quote as it is now.
    const signed = q.status === 'accepted' && q.signature && q.signature_current !== false;
    const open = !signed && !q.expired && q.status !== 'accepted';
    $('qpSignForm').hidden = !open;
    $('qpGoSign').hidden = !open;
    $('qpSigned').hidden = !signed;
    banner.hidden = false;
    banner.className = 'qp-banner';
    if (signed) {
      banner.classList.add('ok');
      banner.innerHTML = `<b>Thank you — your quote is approved.</b> We'll be in touch shortly to book your installation.`;
      $('qpSigned').innerHTML = `
        <h2>Approved &amp; signed</h2>
        <div class="qp-signed">
          <img src="${esc(q.signature.image)}" alt="Signature of ${esc(q.signature.name)}" />
          <p>Signed by <b>${esc(q.signature.name)}</b><br />${esc(new Date(q.signature.at).toLocaleString('en-CA', { dateStyle: 'long', timeStyle: 'short' }))}</p>
        </div>`;
      $('qpSign').hidden = false;
    } else if (q.status === 'accepted' && q.signature) {
      // Signed, but the quote has changed since (changed before locking
      // existed): don't show the old signature as agreeing to the new figures.
      banner.classList.add('bad');
      banner.innerHTML =
        '<b>This quote has changed since it was signed.</b> Please contact us before going ahead.';
      $('qpSign').hidden = true;
    } else if (q.status === 'accepted') {
      banner.classList.add('ok');
      banner.innerHTML = '<b>This quote has been accepted.</b> Thank you!';
      $('qpSign').hidden = true;
    } else if (q.expired) {
      banner.classList.add('bad');
      banner.innerHTML = `<b>This quote expired on ${esc(fmtDate(q.valid_until))}.</b> Prices change — get in touch and we'll send you an updated one.<div class="qp-contact">${contactHtml()}</div>`;
      $('qpSign').hidden = true;
    } else if (q.status === 'declined') {
      banner.classList.add('bad');
      banner.innerHTML = `<b>You declined this quote${q.declined_at ? ' on ' + esc(fmtDate(q.declined_at)) : ''}.</b> Changed your mind? You can still approve it below.`;
      $('qpSign').hidden = false;
      $('qpDeclineToggle').hidden = true;
    } else {
      banner.hidden = true;
      $('qpSign').hidden = false;
    }
    if (open) setTimeout(sizePad, 0);
  }

  // ---- signature pad ----
  const pad = $('qpPad');
  const ctx = pad.getContext('2d');
  let strokes = 0;
  let drawing = false;
  let last = null;

  // Match the canvas to its box (and the screen's pixel density). Resizing a
  // canvas wipes it, so only when the size really changed — and anything
  // already signed is copied across, stretched to the new box, so turning the
  // phone mid-signature doesn't lose it or leave the pen drawing off-target.
  function sizePad() {
    const r = pad.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (pad.width === w && pad.height === h) return;
    let copy = null;
    if (strokes && pad.width && pad.height) {
      copy = document.createElement('canvas');
      copy.width = pad.width;
      copy.height = pad.height;
      copy.getContext('2d').drawImage(pad, 0, 0);
    }
    pad.width = w;
    pad.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (copy) ctx.drawImage(copy, 0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1b2a4a';
    if (!copy) strokes = 0;
  }
  const at = (e) => {
    const r = pad.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    drawing = true;
    last = at(e);
    ctx.beginPath();
    ctx.arc(last[0], last[1], 1.1, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = at(e);
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    // Midpoint smoothing keeps fast strokes from looking like a polygon.
    const mid = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2];
    ctx.quadraticCurveTo(last[0], last[1], mid[0], mid[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    last = p;
  });
  const end = () => {
    if (drawing) strokes++;
    drawing = false;
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  $('qpPadClear').addEventListener('click', () => {
    ctx.clearRect(0, 0, pad.width, pad.height);
    strokes = 0;
  });
  window.addEventListener('resize', sizePad);

  // A small, white-backed PNG — the stored copy, not the screen-sized one.
  function signatureImage() {
    const w = Math.min(600, pad.width);
    const h = Math.round((pad.height / pad.width) * w);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const o = out.getContext('2d');
    o.fillStyle = '#fff';
    o.fillRect(0, 0, w, h);
    o.drawImage(pad, 0, 0, w, h);
    return out.toDataURL('image/png');
  }

  function say(text) {
    $('qpSignMsg').textContent = text || '';
  }

  $('qpAccept').addEventListener('click', async () => {
    say('');
    const name = $('qpSignName').value.trim();
    if (name.length < 2) {
      $('qpSignName').focus();
      return say('Please type your full name.');
    }
    if (!strokes) return say('Please sign in the box.');
    if (!$('qpAgree').checked) return say('Please tick the box to accept the quote.');
    // Signing is a legal act, so nothing on screen claims it until the server
    // has it. The button is disabled the moment it is pressed, so it can't be
    // sent twice; "Signing…" and a spinner show only if the wait is long enough
    // to notice — and last until the outcome, an updated quote included, is on
    // screen.
    await Snappy.busy(
      $('qpAccept'),
      async () => {
        try {
          const q = await api(`/api/public/quote/${encodeURIComponent(token)}/accept`, {
            method: 'POST',
            // Which version of the quote is on screen, so the signature is for
            // exactly what they read.
            body: JSON.stringify({ name, signature: signatureImage(), agree: true, version: quote && quote.version }),
          });
          render(q);
          window.scrollTo({ top: 0, behavior: scrollMotion() });
        } catch (e) {
          if (e.status === 409 && /updated/i.test(e.message)) {
            // The office changed it while they were reading: show the new version
            // and ask them to look it over before signing.
            try {
              render(await api(`/api/public/quote/${encodeURIComponent(token)}`));
            } catch (err) {
              /* keep what is on screen */
            }
            window.scrollTo({ top: 0, behavior: scrollMotion() });
            showUpdated();
          }
          say(e.message);
        }
      },
      { label: 'Signing…' }
    );
  });

  $('qpDeclineToggle').addEventListener('click', () => {
    $('qpDecline').hidden = !$('qpDecline').hidden;
    if (!$('qpDecline').hidden) $('qpReason').focus();
  });
  // Declining waits for the server just as signing does, and can't be sent
  // twice either; its spinner too shows only if the wait is long enough to see.
  $('qpDeclineBtn').addEventListener('click', () =>
    Snappy.busy($('qpDeclineBtn'), async () => {
      try {
        const q = await api(`/api/public/quote/${encodeURIComponent(token)}/decline`, {
          method: 'POST',
          body: JSON.stringify({ reason: $('qpReason').value }),
        });
        $('qpDecline').hidden = true;
        render(q);
        window.scrollTo({ top: 0, behavior: scrollMotion() });
      } catch (e) {
        say(e.message);
      }
    })
  );

  // The same printed quote the office sends, with the drawing and signature.
  $('qpPdf').addEventListener('click', () => {
    if (!quote) return;
    const doc = { ...quote, customer: { ...quote.customer } };
    if (quote.layout) {
      doc.layout_svg = T.layoutSvg(quote.layout, catalog, { width: 700, height: 300 });
      doc.layout_legend = quote.legend;
    }
    if (!(quote.status === 'accepted' && quote.signature && quote.signature_current !== false)) delete doc.signature;
    P.openPrint(doc, 'quote');
  });

  // ---- boot ----
  if (!token) {
    $('qpLoading').hidden = true;
    $('qpMissing').hidden = false;
    $('qpContact1').innerHTML = contactHtml();
    return;
  }
  api(`/api/public/quote/${encodeURIComponent(token)}`)
    .then(render)
    .catch((e) => {
      $('qpLoading').hidden = true;
      $('qpMissing').hidden = false;
      if (e.status !== 404) $('qpMissingMsg').textContent = e.message;
      $('qpContact1').innerHTML = contactHtml();
    });
})();
