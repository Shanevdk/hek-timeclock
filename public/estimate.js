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
  let latest = null; // the server's last pricing of the current lines

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  const money = (n) =>
    '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
    if (data === null) throw new Error('Something went wrong. Please try again.');
    return data;
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

  async function price() {
    const items = readLines();
    if (!items.length) {
      latest = null;
      showTotals({ subtotal: 0, tax: 0, total: 0, tax_rate: config.tax_rate, below_minimum: false });
      $('estRequest').disabled = true;
      return;
    }
    try {
      latest = await api('/api/estimate/price', {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      showTotals(latest);
      $('estRequest').disabled = !latest.items.length;
    } catch (e) {
      // Leave the last good figure on screen rather than flashing an error at
      // someone who is mid-typing.
      $('estRequest').disabled = true;
    }
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
  let searchTimer = null;

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

  function ensureMap() {
    if (map) return map;
    if (!window.L) return null;
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
        lines.push(L.polyline(run, { color: '#c89b5c', weight: 4, opacity: 0.95 }).addTo(map));
      }
      run.forEach((p, i) => {
        const mk = L.circleMarker(p, {
          radius: 5, color: '#fff', weight: 2, fillColor: '#a97f43', fillOpacity: 1,
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
    if (preview && $('est3d').style.display !== 'none') queue3D();
  }

  // Put the measured length into the estimate. It goes on the first line
  // measured by the foot — the fence itself — or starts one if there is none.
  function useLength() {
    const feet = Math.round(totalMetres() * M_TO_FT);
    if (feet <= 0) return;
    const perFoot = (s) => /ft|foot|feet/i.test(s.unit);
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
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    say('Finding you…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        ensureMap();
        map.setView([lat, lng], 19);
        if (hereMarker) map.removeLayer(hereMarker);
        // A soft dot rather than a pin: it marks where they are, and must not
        // be mistaken for a fence corner.
        hereMarker = L.circleMarker([lat, lng], {
          radius: 7, color: '#fff', weight: 2, fillColor: '#2f9257', fillOpacity: 0.9,
          interactive: false,
        }).addTo(map);
        say(
          accuracy > 100
            ? `Roughly here (within ${Math.round(accuracy)} m) — drag the map to your property.`
            : 'Here you are. Now click along where the fence goes.'
        );
        setTimeout(() => say(''), 6000);
        fillAddress(lat, lng);
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

    function say(text) {
      note.textContent = text;
      note.style.display = text ? 'block' : 'none';
    }
  }

  // Turn the located position into a street address, so the request the office
  // receives says where the job is rather than a pair of coordinates.
  async function fillAddress(lat, lng) {
    if ($('mapSearch').value.trim()) return; // never overwrite what they typed
    try {
      const d = await api(`/api/estimate/reverse?lat=${lat}&lng=${lng}`);
      if (d.label) $('mapSearch').value = d.label;
    } catch (e) {
      /* the address is a nicety — the measurement is what matters */
    }
  }

  $('mapLocate').addEventListener('click', () => locate({}));

  // ---- finding the property ----
  async function searchAddress() {
    const q = $('mapSearch').value.trim();
    if (q.length < 3) return;
    const box = $('mapResults');
    box.innerHTML = '<div class="est-result-note">Looking…</div>';
    box.style.display = 'block';
    try {
      const d = await api('/api/estimate/geocode?q=' + encodeURIComponent(q));
      const results = d.results || [];
      if (!results.length) {
        box.innerHTML = '<div class="est-result-note">Nothing found — try the town and province too.</div>';
        return;
      }
      box.innerHTML = results
        .map((r, i) => `<button type="button" data-r="${i}">${esc(r.label)}</button>`)
        .join('');
      box.dataset.results = JSON.stringify(results);
    } catch (e) {
      box.innerHTML = '<div class="est-result-note">Could not search just now.</div>';
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
    ensureMap();
    // Close enough to see the yard and start clicking corners.
    map.setView([r.lat, r.lng], 19);
  });

  $('mapToggle').addEventListener('click', () => {
    const panel = $('mapPanel');
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    $('mapHint').style.display = open ? 'none' : 'block';
    $('mapToggle').textContent = open ? 'Measure on a map' : 'Hide the map';
    if (!open) {
      ensureMap();
      // Leaflet needs telling once the container has a size.
      setTimeout(() => map && map.invalidateSize(), 50);
      // Go to them on first open. Quiet, because this is us asking rather than
      // them pressing the button — a refusal should not read as an error.
      if (!locateTried) {
        locateTried = true;
        setTimeout(() => locate({ quiet: true }), 250);
      }
    }
  });

  $('mapSearchBtn').addEventListener('click', searchAddress);
  $('mapSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchAddress(); }
  });
  $('mapSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    if ($('mapSearch').value.trim().length >= 4) searchTimer = setTimeout(searchAddress, 600);
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

  const drawableRuns = () => runs.filter((r) => r.length >= 2);

  // Default the look to whatever fence they are actually pricing.
  function styleFromLines() {
    if (!window.Fence3D) return 'privacy';
    for (const row of document.querySelectorAll('.est-line')) {
      const key = row.querySelector('.est-service').value;
      const svc = config.services.find((s) => s.key === key);
      if (svc && /ft|foot|feet/i.test(svc.unit)) return window.Fence3D.styleForService(key);
    }
    return 'privacy';
  }

  function fillStyleOptions() {
    const sel = $('est3dStyle');
    if (!sel || sel.options.length || !window.Fence3D) return;
    sel.innerHTML = window.Fence3D
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
    $('est3dNote').style.display = 'block';
    $('est3dNote').textContent = 'Building your fence…';
    try {
      await preview.load({
        runs: list,
        styleKey: $('est3dStyle').value,
        heightFt: Number($('est3dHeight').value) || 6,
      });
      $('est3dNote').style.display = 'none';
    } catch (e) {
      $('est3dNote').textContent = 'Could not build the 3D view.';
    }
    drawStreetView();
  }

  function open3D() {
    if (!window.Fence3D) return;
    fillStyleOptions();
    $('est3d').style.display = 'block';
    $('est3dStyle').value = styleFromLines();
    if (!preview) preview = new window.Fence3D.FencePreview($('est3dCanvas'));
    build3D();
    if (config && config.street_view) loadStreetView();
    $('est3d').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    $('estSvMsg').textContent = 'Looking for a photo of your street…';
    try {
      const meta = await api(`/api/estimate/streetview/meta?lat=${mid[0]}&lng=${mid[1]}`);
      panoAt = [meta.lat, meta.lng];
      const heading = bearingDeg(panoAt, mid);
      $('estSvImg').onload = () => {
        $('estSvMsg').textContent = meta.date
          ? `Google's photo, taken ${meta.date}. Tick the box to see roughly where the fence lands.`
          : "Google's photo of your street.";
        drawStreetView();
      };
      $('estSvImg').src =
        `/api/estimate/streetview?lat=${mid[0]}&lng=${mid[1]}&heading=${heading.toFixed(1)}&fov=${SV_FOV}`;
    } catch (e) {
      panoAt = null;
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
  function openModal() {
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
    const btn = $('estSend');
    btn.disabled = true;
    try {
      const r = await api('/api/estimate/request', {
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
      closeModal();
      $('estRef').textContent = r.reference;
      $('estMain').style.display = 'none';
      $('estDone').style.display = 'block';
      window.scrollTo(0, 0);
    } catch (e) {
      $('estMsg').textContent = e.message;
    } finally {
      btn.disabled = false;
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
    })
    .catch(() => {
      $('estLoading').style.display = 'none';
      $('estOffline').style.display = 'block';
    });
})();
