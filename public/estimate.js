// The public estimate maker at "/estimate".
//
// No login, no session. The customer picks services and quantities; the server
// prices them and files the request. Prices are never worked out here — the
// browser only says "this service, this much of it", so what is shown is always
// what the office would charge.
(function () {
  const $ = (id) => document.getElementById(id);

  let config = null; // { services, tax_rate, ... } once loaded
  let priceTimer = null;
  let priceSeq = 0; // numbers each pricing, so only the newest reply is used
  let pricing = null; // the newest pricing, settled once its reply is in
  let latest = null; // the server's pricing of the current lines, if it has one

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Priced by the running foot ("linear ft") — not "sq ft", which a traced
  // length has nothing to do with.
  const isLinearFoot = (unit) => /^(linear\s*)?(ft|foot|feet)\.?$/i.test(String(unit || '').trim());

  const money = (n) =>
    '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // A smooth scroll is motion too: someone who has asked their device for less
  // of it gets the plain jump.
  const scrollMotion = () =>
    window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...(opts || {}),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      data = null;
    }
    if (!res.ok) throw refusal(res.status, data);
    if (data === null) throw new Error('Something went wrong. Please try again.');
    return data;
  }

  // The error for a request the server said no to, in its own words where it
  // gave any — when it is turning requests away it says how long to wait. The
  // status goes with it, so a caller can tell "slow down" from "broken".
  function refusal(status, data) {
    const err = new Error(
      (data && data.error) ||
        (status === 429
          ? 'Too many requests — wait a moment and try again.'
          : 'Something went wrong. Please try again.')
    );
    err.status = status;
    return err;
  }

  // ---- lines ----
  function serviceOptions(selected) {
    return config.services
      .map(
        (s) =>
          `<option value="${esc(s.key)}"${s.key === selected ? ' selected' : ''}>${esc(s.label)}</option>`
      )
      .join('');
  }

  function addLine(serviceKey) {
    const row = document.createElement('div');
    row.className = 'est-line';
    const key = serviceKey || (config.services[0] && config.services[0].key) || '';
    row.innerHTML =
      `<div class="field est-svc">
         <label>What do you need?</label>
         <select class="est-service">${serviceOptions(key)}</select>
       </div>
       <div class="field est-qty">
         <label>How much? <span class="est-unit"></span></label>
         <input class="est-quantity" inputmode="decimal" placeholder="0" />
       </div>
       <button class="link-btn danger est-remove" title="Remove this line" aria-label="Remove this line">✕</button>`;
    $('estLines').appendChild(row);
    syncUnit(row);
    updateRemoveButtons();
  }

  // Show the unit next to the quantity box, so "how much" is never ambiguous.
  function syncUnit(row) {
    const key = row.querySelector('.est-service').value;
    const svc = config.services.find((s) => s.key === key);
    row.querySelector('.est-unit').textContent = svc ? '(' + svc.unit + ')' : '';
  }

  // Only offer to remove a line when more than one is on screen.
  function updateRemoveButtons() {
    const rows = [...document.querySelectorAll('.est-line')];
    rows.forEach((r) => {
      r.querySelector('.est-remove').style.visibility = rows.length > 1 ? 'visible' : 'hidden';
    });
  }

  function readLines() {
    return [...document.querySelectorAll('.est-line')]
      .map((r) => ({
        service: r.querySelector('.est-service').value,
        qty: parseFloat(r.querySelector('.est-quantity').value) || 0,
      }))
      .filter((l) => l.service && l.qty > 0);
  }

  // ---- pricing (always the server's answer) ----
  function queuePrice() {
    clearTimeout(priceTimer);
    priceTimer = setTimeout(price, 250);
  }

  // Price the lines now. Each pricing is numbered and only the newest one's
  // reply counts: replies can arrive out of order, and a slow one for an older
  // edit must not overwrite the total for a newer one.
  function price() {
    clearTimeout(priceTimer);
    priceTimer = null;
    pricing = askPrice(++priceSeq);
    return pricing;
  }

  async function askPrice(seq) {
    const items = readLines();
    if (!items.length) {
      latest = null;
      showTotals({ subtotal: 0, tax: 0, total: 0, tax_rate: config.tax_rate, below_minimum: false });
      priceNote('');
      syncRequest();
      return;
    }
    try {
      const priced = await api('/api/estimate/price', {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      if (seq !== priceSeq) return;
      latest = priced;
      showTotals(latest);
      priceNote('');
      syncRequest();
    } catch (e) {
      if (seq !== priceSeq) return;
      // Leave the last good figure on screen rather than flashing an error at
      // someone who is mid-typing — but it is no longer theirs to confirm. Being
      // turned away for asking too often is worth saying, though, or the button
      // greys out for no reason they can see.
      latest = null;
      priceNote(e.status === 429 ? e.message : '');
      syncRequest();
    }
  }

  // "Request a quote" is only for a total the server has given for the lines
  // on screen. While the button is busy waiting on that total (openModal) it
  // is left alone: Snappy.busy() hands it back exactly as it found it — enabled,
  // since it was just pressed — so this runs again the moment it lets go, and a
  // price that fell through meanwhile still leaves it greyed out.
  function syncRequest() {
    const btn = $('estRequest');
    if (btn.getAttribute('aria-busy') !== 'true') btn.disabled = !(latest && latest.items.length);
  }

  // Wait until the total is the server's answer for exactly the lines on
  // screen: price an edit still waiting on its timer, then sit out the reply —
  // and again if another edit lands meanwhile.
  async function settlePrice() {
    let p;
    do {
      if (priceTimer) price();
      p = pricing;
      await p;
    } while (p !== pricing || priceTimer);
  }

  function priceNote(text) {
    $('estPriceNote').textContent = text;
    $('estPriceNote').style.display = text ? 'block' : 'none';
  }

  function showTotals(t) {
    $('estSubtotal').textContent = money(t.subtotal);
    $('estTaxRate').textContent = t.tax_rate != null ? t.tax_rate : 0;
    $('estTax').textContent = money(t.tax);
    $('estTotal').textContent = money(t.total);
    $('estMinNote').style.display = t.below_minimum ? 'block' : 'none';
  }

  // ---- measuring on the map ----
  // The customer finds their property and clicks along where the fence goes.
  // Each click drops a corner; the running total is the ground distance along
  // those corners. Several separate stretches ("runs") add together.
  let map = null;
  let runs = [];        // [[ [lat,lng], ... ], ...] — a polyline per stretch
  let lines = [];       // the Leaflet polyline for each run
  let dots = [];        // corner markers, so a point can be seen and undone
  let layers = {};

  const M_TO_FT = 3.280839895;

  function metresBetween(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function totalMetres() {
    let m = 0;
    for (const run of runs) for (let i = 1; i < run.length; i++) m += metresBetween(run[i - 1], run[i]);
    return m;
  }

  // The map, once Leaflet is in. estimate.html only preloads the library, so it
  // never holds up the page; Snappy.leaflet() puts it to use, and by the time
  // anyone opens the map it has usually been warmed already (see the boot at
  // the bottom). Resolves to null if it can't load: the map's box says so, the
  // rest of the page carries on — a length can always be typed in — and the
  // next try (opening the map, Find, My location) asks again.
  let mapReady = null;
  function ensureMap() {
    if (!mapReady) {
      mapNote('Loading the map…', true);
      mapReady = Snappy.leaflet()
        .then(buildMap)
        .catch((e) => {
          console.error(e);
          mapReady = null;
          mapNote('The map could not load. Check your connection and try again — or type the length in yourself.');
          return null;
        });
    }
    return mapReady;
  }

  // A line in the map's own box, until there is a map in it. A wait is a
  // placeholder (.wait): seen only if Leaflet is slow to arrive.
  function mapNote(text, waiting) {
    $('estMap').innerHTML = `<p class="est-map-note${waiting ? ' wait' : ''}">${esc(text)}</p>`;
  }

  function buildMap() {
    $('estMap').textContent = ''; // the note goes; Leaflet builds its own panes in here
    map = L.map('estMap', { doubleClickZoom: false }).setView([42.93, -80.6], 13);
    // Satellite by default: a street map shows roads, not where a fence goes.
    layers.sat = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri' }
    );
    layers.street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    });
    layers.sat.addTo(map);

    map.on('click', (e) => addPoint([e.latlng.lat, e.latlng.lng]));
    return map;
  }

  function addPoint(pt) {
    if (!runs.length) runs.push([]);
    runs[runs.length - 1].push(pt);
    redraw();
  }

  function redraw() {
    lines.forEach((l) => map.removeLayer(l));
    dots.forEach((d) => map.removeLayer(d));
    lines = [];
    dots = [];
    runs.forEach((run) => {
      if (run.length > 1) {
        lines.push(L.polyline(run, { color: '#c3965a', weight: 4, opacity: 0.95 }).addTo(map));
      }
      run.forEach((p, i) => {
        const mk = L.circleMarker(p, {
          radius: 5, color: '#fff', weight: 2, fillColor: '#ac7d3f', fillOpacity: 1,
        }).addTo(map);
        // Each corner shows how far the fence has run to that point.
        let sofar = 0;
        for (let k = 1; k <= i; k++) sofar += metresBetween(run[k - 1], run[k]);
        if (i > 0) mk.bindTooltip(Math.round(sofar * M_TO_FT) + ' ft', { direction: 'top' });
        dots.push(mk);
      });
    });
    const m = totalMetres();
    const feet = Math.round(m * M_TO_FT);
    $('mapFeet').textContent = feet.toLocaleString('en-US');
    $('mapMetres').textContent = Math.round(m).toLocaleString('en-US') + ' m';
    $('mapUse').disabled = feet <= 0;
    // Nothing to stand up until there is at least one stretch of fence.
    const drawable = runs.some((r) => r.length >= 2);
    if ($('map3d')) $('map3d').disabled = !drawable;
    // With a fence drawn, the 3D view is one press away: start fetching it.
    if (drawable) warm3D();
    if (preview && $('est3d').style.display !== 'none') queue3D();
  }

  // Put the measured length into the estimate. It goes on the first line
  // measured by the foot — the fence itself — or starts one if there is none.
  function useLength() {
    const feet = Math.round(totalMetres() * M_TO_FT);
    if (feet <= 0) return;
    const perFoot = (s) => isLinearFoot(s.unit);
    let row = [...document.querySelectorAll('.est-line')].find((r) => {
      const svc = config.services.find((s) => s.key === r.querySelector('.est-service').value);
      return svc && perFoot(svc);
    });
    if (!row) {
      const svc = config.services.find(perFoot);
      if (!svc) {
        $('estMsg').textContent = '';
        alert('None of the services here are priced by the foot, so this length has nowhere to go.');
        return;
      }
      addLine(svc.key);
      row = document.querySelectorAll('.est-line')[document.querySelectorAll('.est-line').length - 1];
    }
    row.querySelector('.est-quantity').value = feet;
    syncUnit(row);
    queuePrice();
    row.scrollIntoView({ behavior: scrollMotion(), block: 'center' });
    row.querySelector('.est-quantity').focus();
  }

  // ---- where they are ----
  // Standing in the yard is the common case, so the map goes there on its own
  // the first time it opens. If the browser refuses — permission denied, no
  // GPS, or a plain http:// page, where browsers switch geolocation off — it
  // falls back to the search box without making a fuss about it.
  let locateTried = false;
  let hereMarker = null;

  function locate({ quiet } = {}) {
    const note = $('mapLocating');
    if (!navigator.geolocation) {
      if (!quiet) say('Your browser cannot share a location — search for the address instead.');
      return;
    }
    // Waiting, not news: a position the device already knows comes back at
    // once, and then this never shows.
    say('Finding you…', true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        const m = await ensureMap();
        if (!m) return say(''); // no map to put them on; its box says why
        m.setView([lat, lng], 19);
        if (hereMarker) m.removeLayer(hereMarker);
        // A soft dot rather than a pin: it marks where they are, and must not
        // be mistaken for a fence corner.
        hereMarker = L.circleMarker([lat, lng], {
          radius: 7, color: '#fff', weight: 2, fillColor: '#2f9257', fillOpacity: 0.9,
          interactive: false,
        }).addTo(m);
        say(
          accuracy > 100
            ? `Roughly here (within ${Math.round(accuracy)} m) — drag the map to your property.`
            : 'Here you are. Now click along where the fence goes.'
        );
        const hush = setTimeout(() => say(''), 6000);
        fillAddress(lat, lng).catch((e) => {
          // Turned away for asking too often: say so, and leave it up — a
          // search or a price would be turned away too.
          clearTimeout(hush);
          say(e.message);
        });
      },
      (err) => {
        if (quiet) return say('');
        say(
          err.code === 1
            ? 'Location permission was declined — search for the address instead.'
            : 'Could not work out where you are — search for the address instead.'
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );

    function say(text, waiting) {
      note.textContent = text;
      note.classList.toggle('wait', !!waiting);
      note.style.display = text ? 'block' : 'none';
    }
  }

  // Turn the located position into a street address, so the request the office
  // receives says where the job is rather than a pair of coordinates.
  let filling = false; // one lookup at a time: two quick presses ask once
  async function fillAddress(lat, lng) {
    if ($('mapSearch').value.trim() || filling) return; // never overwrite what they typed
    filling = true;
    try {
      const d = await api(`/api/estimate/reverse?lat=${lat}&lng=${lng}`);
      if (d.label && !$('mapSearch').value.trim()) $('mapSearch').value = d.label;
    } catch (e) {
      // The address is a nicety — the measurement is what matters — so only a
      // rate limit is passed on, being worth knowing about.
      if (e.status === 429) throw e;
    } finally {
      filling = false;
    }
  }

  $('mapLocate').addEventListener('click', () => locate({}));

  // ---- finding the property ----
  // Only when asked — Enter or the Find button. The lookup is OpenStreetMap's,
  // whose rules forbid searching as someone types. One search at a time: Find
  // is disabled while one is on its way (its spinner only if the wait is long
  // enough to notice), and Enter meanwhile is ignored — asking again would
  // only spend another of the visitor's lookups.
  function searchAddress() {
    const btn = $('mapSearchBtn');
    if (btn.getAttribute('aria-busy') === 'true') return;
    const q = $('mapSearch').value.trim();
    if (q.length < 3) return;
    return Snappy.busy(btn, () => findAddress(q));
  }

  async function findAddress(q) {
    const box = $('mapResults');
    // Whatever was listed before goes at once, so nothing stale can be picked
    // meanwhile; "Looking…" is a placeholder, seen only if the answer is slow.
    box.innerHTML = '<div class="est-result-note">Looking…</div>';
    box.classList.add('wait');
    box.style.display = 'block';
    try {
      const d = await api('/api/estimate/geocode?q=' + encodeURIComponent(q));
      const results = d.results || [];
      if (!results.length) {
        box.innerHTML = '<div class="est-result-note">Nothing found — try the town and province too.</div>';
        return;
      }
      // Picking a place only moves the map, so with a mouse it happens as the
      // button goes down (data-press="fast", snappy.js).
      box.innerHTML = results
        .map((r, i) => `<button type="button" data-r="${i}" data-press="fast">${esc(r.label)}</button>`)
        .join('');
      box.dataset.results = JSON.stringify(results);
    } catch (e) {
      // Say what went wrong rather than leave them rewording an address that
      // was fine — turned away for searching too often means wait.
      const why = e.status ? e.message : 'Could not search just now.';
      box.innerHTML = `<div class="est-result-note">${esc(why)}</div>`;
    } finally {
      box.classList.remove('wait'); // the answer itself shows at once
    }
  }

  $('mapResults').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-r]');
    if (!btn) return;
    const results = JSON.parse($('mapResults').dataset.results || '[]');
    const r = results[Number(btn.dataset.r)];
    if (!r) return;
    $('mapResults').style.display = 'none';
    $('mapSearch').value = r.label;
    // Close enough to see the yard and start clicking corners.
    ensureMap().then((m) => m && m.setView([r.lat, r.lng], 19));
  });

  $('mapToggle').addEventListener('click', () => {
    const panel = $('mapPanel');
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    $('mapHint').style.display = open ? 'none' : 'block';
    $('mapToggle').textContent = open ? 'Measure on a map' : 'Hide the map';
    if (open) return;
    // The panel is open already; the map fills it as soon as Leaflet is in.
    ensureMap().then((m) => {
      if (!m || panel.style.display === 'none') return; // shut again meanwhile
      // Leaflet needs telling once the container has a size.
      setTimeout(() => m.invalidateSize(), 50);
      // Go to them on first open. Quiet, because this is us asking rather than
      // them pressing the button — a refusal should not read as an error. Not
      // when the map couldn't load: there would be nothing to show them on.
      if (!locateTried) {
        locateTried = true;
        setTimeout(() => locate({ quiet: true }), 250);
      }
    });
  });

  $('mapSearchBtn').addEventListener('click', searchAddress);
  $('mapSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchAddress(); }
  });

  $('mapUndo').addEventListener('click', () => {
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].length) { runs[i].pop(); break; }
      runs.pop();
    }
    runs = runs.filter((r, i) => r.length || i === runs.length - 1);
    redraw();
  });
  $('mapNewRun').addEventListener('click', () => {
    if (runs.length && runs[runs.length - 1].length) runs.push([]);
  });
  $('mapClear').addEventListener('click', () => { runs = []; redraw(); });
  $('mapUse').addEventListener('click', useLength);

  document.querySelector('.est-layers').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-layer]');
    if (!btn || !map) return;
    document.querySelectorAll('.est-layers button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    Object.values(layers).forEach((l) => map.removeLayer(l));
    layers[btn.dataset.layer].addTo(map);
  });

  // What to send with the request, so the estimator sees where the fence goes.
  function measurement() {
    const usable = runs.filter((r) => r.length >= 2);
    if (!usable.length) return null;
    const m = totalMetres();
    return { runs: usable, metres: Math.round(m * 100) / 100, feet: Math.round(m * M_TO_FT) };
  }

  // ---- 3D preview ----
  //
  // The traced line, stood up as a fence on aerial imagery of the property.
  // The heavy lifting is in fence3d.js; this decides what to draw and keeps it
  // in step with what the customer has picked.
  let preview = null;
  let previewTimer = null;
  let open3DSeq = 0; // numbers each press, so only the newest sets the view up

  const drawableRuns = () => runs.filter((r) => r.length >= 2);

  // The viewer — three.js and fence3d.js — is the heaviest thing on the page
  // and only this step uses it, so estimate.html leaves it unfetched until
  // window.loadFence3D() asks. However often that is called there is one copy
  // on its way, and after a failure the next call tries again. Resolves to
  // { FencePreview, styleForService, styleList }.
  function load3D() {
    if (window.Fence3D) return Promise.resolve(window.Fence3D);
    return Promise.resolve().then(() => window.loadFence3D());
  }

  // Fetch the viewer while they are still tracing, so it is there by the time
  // they press "See it in 3D": once a fence is drawn — the step before — and
  // only when the device has nothing better to do. Not on Save-Data or a 2G
  // connection, where it is worth the download only to someone who asks for
  // it. A failure here says nothing; the press tries again and says why.
  let warmed3D = false;
  function warm3D() {
    if (warmed3D || window.Fence3D) return;
    const c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return;
    warmed3D = true;
    Snappy.idle(() => load3D().catch(() => {}));
  }

  // The words over the 3D picture. Progress is a placeholder (.wait): it fades
  // in only once the wait is long enough to notice, so a quick build never
  // flashes it. Anything else — a failure — shows at once. The stylesheet's
  // flex layout centres it, so showing it means clearing the inline display.
  function note3D(text, waiting) {
    const note = $('est3dNote');
    note.textContent = text || '';
    note.classList.toggle('wait', !!(text && waiting));
    note.style.display = text ? '' : 'none';
  }

  // Default the look to whatever fence they are actually pricing.
  function styleFromLines(F) {
    for (const row of document.querySelectorAll('.est-line')) {
      const key = row.querySelector('.est-service').value;
      const svc = config.services.find((s) => s.key === key);
      if (svc && isLinearFoot(svc.unit)) return F.styleForService(key);
    }
    return 'privacy';
  }

  function fillStyleOptions(F) {
    const sel = $('est3dStyle');
    if (!sel || sel.options.length) return;
    sel.innerHTML = F
      .styleList()
      .map((s) => `<option value="${s.key}">${esc(s.label)}</option>`)
      .join('');
  }

  // Rebuilding fetches imagery, so coalesce bursts of clicks into one build.
  function queue3D() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => build3D(), 250);
  }

  async function build3D() {
    if (!preview) return;
    const list = drawableRuns();
    if (!list.length) return;
    note3D('Building your fence…', true);
    try {
      const built = await preview.load({
        runs: list,
        styleKey: $('est3dStyle').value,
        heightFt: Number($('est3dHeight').value) || 6,
      });
      // Overtaken by a newer build (another corner, a new height) — the note
      // is that one's to clear.
      if (!built) return;
      note3D('');
      // The fence stands either way; if the aerial photo was turned away, say
      // why the ground under it is bare.
      $('est3dMsg').textContent = built.notice ? `Some of the aerial photo did not load. ${built.notice}` : '';
      $('est3dMsg').style.display = built.notice ? 'block' : 'none';
    } catch (e) {
      note3D('Could not build the 3D view.');
    }
    drawStreetView();
  }

  // The section opens the moment it is asked for, with a placeholder over the
  // picture until the viewer is in — and usually it already is (warm3D). If it
  // can't load, only this section says so: the map, the price and the request
  // all carry on without it.
  async function open3D() {
    const seq = ++open3DSeq;
    const box = $('est3d');
    box.style.display = 'block';
    if (!preview) note3D('Loading the 3D view…', true);
    box.scrollIntoView({ behavior: scrollMotion(), block: 'start' });
    let F;
    try {
      F = await load3D();
    } catch (e) {
      console.error(e);
      if (seq === open3DSeq) note3D('The 3D view could not load. Check your connection, then try again or reload the page.');
      return;
    }
    // Pressed again meanwhile (that press carries on from here), hidden again,
    // or the request sent: either way, nothing for this one to do.
    if (seq !== open3DSeq || box.style.display === 'none' || $('estMain').style.display === 'none') return;
    fillStyleOptions(F);
    $('est3dStyle').value = styleFromLines(F);
    if (!preview) {
      try {
        preview = new F.FencePreview($('est3dCanvas'));
      } catch (e) {
        // No WebGL: switched off, or a device too old for it.
        console.error(e);
        note3D('This browser cannot show the 3D view.');
        return;
      }
    }
    preview.resume(); // drawing again, if it was hidden
    build3D();
    if (config && config.street_view) loadStreetView();
  }

  // ---- from the road ----
  //
  // Google's photo of the property, with the fence drawn over it. The drawing
  // is a real projection — the camera's own position from Google, the bearing
  // and distance to each corner, and a pinhole camera — not a sketch. It still
  // assumes flat ground and a camera about 2.5 m up, which is why it is offered
  // as a rough preview rather than a picture of the finished job.
  const SV_CAM_HEIGHT = 2.5;
  const SV_FOV = 90;
  let panoAt = null;
  let svFor = null; // the spot whose photo is on screen, or on its way

  function bearingDeg(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const p1 = toRad(a[0]);
    const p2 = toRad(b[0]);
    const dl = toRad(b[1] - a[1]);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  const centroid = () => {
    const pts = drawableRuns().flat();
    if (!pts.length) return null;
    return [
      pts.reduce((s, p) => s + p[0], 0) / pts.length,
      pts.reduce((s, p) => s + p[1], 0) / pts.length,
    ];
  };

  async function loadStreetView() {
    const mid = centroid();
    if (!mid) return;
    const sv = $('estSv');
    sv.style.display = 'block';
    // Reopening the view on the same fence keeps the photo it already has (or
    // is already fetching) rather than asking again: every ask counts against
    // the visitor, and Google bills for the photo.
    const spot = mid.join(',');
    if (spot === svFor) return;
    svFor = spot;
    $('estSvMsg').textContent = 'Looking for a photo of your street…';
    try {
      const meta = await api(`/api/estimate/streetview/meta?lat=${mid[0]}&lng=${mid[1]}`);
      panoAt = [meta.lat, meta.lng];
      const heading = bearingDeg(panoAt, mid);
      // Fetched rather than set as the picture's src, so a refusal — turned away
      // for asking too often, say — comes back in words instead of leaving
      // "Looking for a photo" up for good.
      const res = await fetch(
        `/api/estimate/streetview?lat=${mid[0]}&lng=${mid[1]}&heading=${heading.toFixed(1)}&fov=${SV_FOV}`
      );
      if (!res.ok) throw refusal(res.status, await res.json().catch(() => null));
      const photo = URL.createObjectURL(await res.blob());
      $('estSvImg').onload = () => {
        URL.revokeObjectURL(photo); // decoded; the picture keeps its own copy
        $('estSvMsg').textContent = meta.date
          ? `Google's photo, taken ${meta.date}. Tick the box to see roughly where the fence lands.`
          : "Google's photo of your street.";
        drawStreetView();
      };
      $('estSvImg').onerror = () => {
        URL.revokeObjectURL(photo);
        panoAt = null;
        svFor = null; // worth another try next time
        $('estSvMsg').textContent = 'The photo of your street could not be shown.';
      };
      $('estSvImg').src = photo;
    } catch (e) {
      panoAt = null;
      // "No photo of this spot" stays true for this spot; anything else — a
      // dropped connection, being asked to wait — is worth another try.
      if (e.status !== 404) svFor = null;
      sv.style.display = 'block';
      $('estSvImg').removeAttribute('src');
      $('estSvMsg').textContent =
        e.message || 'Google has no road-level photo of this spot, so there is nothing to show.';
    }
  }

  function drawStreetView() {
    const cv = $('estSvCanvas');
    const img = $('estSvImg');
    if (!cv || !img || !panoAt || !img.naturalWidth) return;
    const w = (cv.width = img.clientWidth || img.naturalWidth);
    const h = (cv.height = img.clientHeight || img.naturalHeight);
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!$('estSvFence').checked) return;

    const mid = centroid();
    if (!mid) return;
    const heading = bearingDeg(panoAt, mid);
    const heightM = (Number($('est3dHeight').value) || 6) * 0.3048;
    const tanH = Math.tan((SV_FOV * Math.PI) / 360);
    const tanV = tanH * (h / w);

    // Where a point on the ground at (bearing, distance) lands in the picture.
    const project = (pt, up) => {
      const dist = metresBetween(panoAt, pt);
      if (dist < 1.5) return null;
      let a = bearingDeg(panoAt, pt) - heading;
      if (a > 180) a -= 360;
      if (a < -180) a += 360;
      if (Math.abs(a) > 70) return null; // outside the frame
      const x = w / 2 + (w / 2) * (Math.tan((a * Math.PI) / 180) / tanH);
      const elev = Math.atan((up - SV_CAM_HEIGHT) / dist);
      const y = h / 2 - (h / 2) * (Math.tan(elev) / tanV);
      return [x, y, dist];
    };

    ctx.lineJoin = 'round';
    for (const run of drawableRuns())
      for (let i = 1; i < run.length; i++) {
        const b0 = project(run[i - 1], 0);
        const b1 = project(run[i], 0);
        const t0 = project(run[i - 1], heightM);
        const t1 = project(run[i], heightM);
        if (!b0 || !b1 || !t0 || !t1) continue;
        // Nearer panels sit more solidly, which reads as depth.
        const near = Math.min(b0[2], b1[2]);
        ctx.fillStyle = `rgba(169,127,67,${Math.max(0.28, Math.min(0.6, 18 / near))})`;
        ctx.strokeStyle = 'rgba(255,246,230,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(b0[0], b0[1]);
        ctx.lineTo(b1[0], b1[1]);
        ctx.lineTo(t1[0], t1[1]);
        ctx.lineTo(t0[0], t0[1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
  }

  // ---- request ----
  async function openModal() {
    // An edit may still be waiting to be priced, or its price on the way back.
    // Let it land, so the figure they are asked to confirm is for the lines on
    // screen and not the ones before. The button is disabled meanwhile, so it
    // can't open the form twice, and spins only if that wait is long enough to
    // notice — usually the price is in already and nothing shows at all.
    await Snappy.busy($('estRequest'), settlePrice);
    if (!latest || !latest.items.length) return;
    $('estModalTotal').textContent = money(latest.total);
    $('estMsg').textContent = '';
    $('estModalBack').classList.add('open');
    $('estName').focus();
  }

  function closeModal() {
    $('estModalBack').classList.remove('open');
  }

  async function send() {
    $('estMsg').textContent = '';
    try {
      const filing = api('/api/estimate/request', {
        method: 'POST',
        body: JSON.stringify({
          customer: {
            name: $('estName').value,
            email: $('estEmail').value,
            phone: $('estPhone').value,
            address: $('estAddress').value,
          },
          notes: $('estNotes').value,
          items: readLines(),
          // Where they traced it, if they used the map.
          measurement: measurement(),
          // What they were looking at when they asked — the style and height
          // they settled on in the 3D view, so the estimator quotes the fence
          // the customer actually pictured.
          preview:
            preview && $('est3d').style.display !== 'none'
              ? { style: $('est3dStyle').value, height_ft: Number($('est3dHeight').value) || 6 }
              : null,
          site: $('mapSearch').value.trim(),
        }),
      });
      // Disabled the moment it is pressed, so a double press can't file the
      // request twice; "Sending…" and a spinner only if the server is slow
      // enough for the wait to be noticed.
      const r = await Snappy.busy($('estSend'), filing, { label: 'Sending…' });
      closeModal();
      $('estRef').textContent = r.reference;
      // The server priced the lines again as it filed them; that is the figure
      // the office has, so it is the one to show.
      if (r.total != null) {
        $('estDoneTotal').textContent = money(r.total);
        $('estDoneTotalLine').style.display = 'block';
      }
      $('estMain').style.display = 'none';
      $('estDone').style.display = 'block';
      // The 3D view went with the form, and there is no way back to it — let
      // it go rather than keep the GPU busy.
      clearTimeout(previewTimer);
      if (preview) {
        preview.destroy();
        preview = null;
      }
      window.scrollTo(0, 0);
    } catch (e) {
      $('estMsg').textContent = e.message;
    }
  }

  // ---- events ----
  $('estAdd').addEventListener('click', () => addLine());
  $('estLines').addEventListener('input', (e) => {
    if (e.target.closest('.est-quantity')) queuePrice();
  });
  $('estLines').addEventListener('change', (e) => {
    const sel = e.target.closest('.est-service');
    if (sel) {
      syncUnit(sel.closest('.est-line'));
      queuePrice();
    }
  });
  $('estLines').addEventListener('click', (e) => {
    const rm = e.target.closest('.est-remove');
    if (!rm) return;
    rm.closest('.est-line').remove();
    updateRemoveButtons();
    queuePrice();
  });
  // ---- 3D events ----
  if ($('map3d')) $('map3d').addEventListener('click', open3D);
  if ($('est3dHide'))
    $('est3dHide').addEventListener('click', () => {
      $('est3d').style.display = 'none';
      if (preview) preview.pause(); // out of sight, so stop drawing it
    });
  if ($('est3dStyle')) $('est3dStyle').addEventListener('change', build3D);
  if ($('est3dHeight')) $('est3dHeight').addEventListener('change', build3D);
  if ($('estSvFence')) $('estSvFence').addEventListener('change', drawStreetView);
  window.addEventListener('resize', drawStreetView);
  if ($('est3dSave'))
    $('est3dSave').addEventListener('click', () => {
      if (!preview) return;
      const a = document.createElement('a');
      a.href = preview.snapshot();
      a.download = 'my-fence.png';
      a.click();
    });

  $('estRequest').addEventListener('click', openModal);
  // Snappy.busy() takes aria-busy off as it lets go of the button; that is the
  // moment to put its state right again (syncRequest).
  new MutationObserver(syncRequest).observe($('estRequest'), { attributes: true, attributeFilter: ['aria-busy'] });
  $('estSend').addEventListener('click', send);
  $('estCancel').addEventListener('click', closeModal);
  $('estModalBack').addEventListener('click', (e) => {
    if (e.target === $('estModalBack')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // ---- boot ----
  api('/api/estimate/config')
    .then((c) => {
      $('estLoading').style.display = 'none';
      // Switched off by the admin, or no service has been made public yet —
      // either way there is nothing to price, so say so rather than show an
      // empty form.
      if (!c.enabled || !c.services || !c.services.length) {
        $('estOffline').style.display = 'block';
        return;
      }
      config = c;
      $('estHeadline').textContent = c.headline;
      $('estIntro').textContent = c.intro;
      $('estFootnote').textContent = c.footnote;
      // The disclaimer appears twice: on the page, and again on the request
      // form where they are about to send their details. Blank hides both.
      if (c.disclaimer) {
        $('estDisclaimerText').textContent = c.disclaimer;
        $('estDisclaimer').style.display = 'block';
        $('estModalDisclaimer').textContent = c.disclaimer;
        $('estModalDisclaimer').style.display = 'block';
      }
      $('estTaxRate').textContent = c.tax_rate;
      $('estMain').style.display = 'block';
      addLine();
      // The map library is downloaded already (estimate.html preloads it). Set
      // it up while the visitor reads, so "Measure on a map" opens on a map
      // rather than a wait. Nothing is asked of our server: the map's own tiles
      // load only once it is opened.
      Snappy.idle(() => Snappy.leaflet().catch(() => {}));
    })
    .catch((e) => {
      $('estLoading').style.display = 'none';
      $('estOffline').style.display = 'block';
      // Turned away for asking too often is not "closed" — say what the
      // server said instead.
      if (e.status === 429) {
        $('estOfflineTitle').textContent = 'Please try again shortly';
        $('estOfflineText').textContent = e.message;
      }
    });
})();
