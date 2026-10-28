// The satellite fence map: trace the fence on the customer's property, drop
// gates onto it, and see every leg's length as you go.
//
// Used two ways:
//   - editable, inside the quote editor (quotes.js drives it);
//   - read-only, on the customer's quote page, to show them where it goes.
//
// The layout it produces is plain data — runs of [lat, lng] points, each
// with a fence system and height, and gates as a position along one leg of a
// run — which takeoff.js turns into materials. Needs Leaflet (window.L).
// No page loads Leaflet up front any more: callers wait for Snappy.leaflet()
// before calling create(), which stays synchronous.
//
// Exposes window.HEKFenceMap.create(container, options).
(function () {
  const FT_PER_M = 3.280839895;
  const SNAP_PX = 12;

  const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const STREET_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function metres(a, b) {
    const R = 6371000;
    const r = (d) => (d * Math.PI) / 180;
    const dLat = r(b[0] - a[0]);
    const dLng = r(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const feet = (a, b) => metres(a, b) * FT_PER_M;
  const ftLabel = (ft) => `${Math.round(ft)}'`;

  // Pale fences (vinyl, flex) vanish on a sunlit lawn, so every run is drawn
  // over a dark casing.
  const casing = '#14110d';

  function create(container, opts) {
    // Leaflet arrives only when a map is about to be shown. A caller that didn't
    // wait for it gets this, rather than a bare "L is not defined".
    if (!window.L || !window.L.map)
      throw new Error('The map could not load (Leaflet is missing). Wait for Snappy.leaflet() before HEKFenceMap.create().');
    const o = opts || {};
    const editable = !!o.editable;
    let catalog = o.catalog || null;
    let layout = { segments: [], gates: [], terrain: {}, center: null, zoom: 19, address: '' };
    let mode = 'idle'; // idle | draw | gate
    let drawing = null; // the run being traced
    let pendingGate = null; // { width, double } while placing a gate
    let selected = null;
    let history = []; // undo stack of serialized layouts

    const map = L.map(container, {
      doubleClickZoom: false,
      zoomControl: true,
      scrollWheelZoom: o.scrollWheelZoom !== false,
      attributionControl: true,
    }).setView(o.center || [42.99, -80.6], o.zoom || 13);

    const layers = {
      sat: L.tileLayer(SAT_URL, { maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri' }),
      street: L.tileLayer(STREET_URL, { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' }),
    };
    layers.sat.addTo(map);
    let base = 'sat';

    const drawn = L.layerGroup().addTo(map);
    const handles = L.layerGroup().addTo(map);
    const guide = L.layerGroup().addTo(map);

    const sysOf = (key) => (catalog && catalog.systems && catalog.systems[key]) || { label: key, color: '#d08a3c' };

    // ---- state helpers ----
    // Slopes ride along: they belong to the legs, so undoing a change brings
    // back the legs' grades with them.
    const snapshot = () => JSON.stringify({ segments: layout.segments, gates: layout.gates, terrain: layout.terrain });
    function remember() {
      history.push(snapshot());
      if (history.length > 80) history.shift();
    }
    function changed() {
      layout.center = [map.getCenter().lat, map.getCenter().lng];
      layout.zoom = map.getZoom();
      redraw();
      if (o.onChange) o.onChange(getLayout());
    }

    // ---- drawing ----
    function legsOf(seg) {
      const out = [];
      for (let i = 1; i < seg.points.length; i++) out.push([seg.points[i - 1], seg.points[i]]);
      return out;
    }

    // keepHandles: mid-drag, the handle being dragged must survive the redraw,
    // so only the lines, labels and gates are rebuilt.
    function redraw(keepHandles) {
      drawn.clearLayers();
      if (!keepHandles) handles.clearLayers();
      const showLengths = map.getZoom() >= 18;
      const all = drawing ? [...layout.segments, drawing] : layout.segments;
      for (const seg of all) {
        if (seg.points.length < 1) continue;
        const sys = sysOf(seg.system);
        const isSel = selected === seg.id || seg === drawing;
        if (seg.points.length >= 2) {
          L.polyline(seg.points, {
            color: casing, weight: isSel ? 9 : 7, opacity: 0.75, lineCap: 'round', lineJoin: 'round',
            dashArray: seg.tearout ? '2 8' : null, interactive: false,
          }).addTo(drawn);
          const line = L.polyline(seg.points, {
            color: sys.color, weight: isSel ? 5 : 4, opacity: 1, lineCap: 'round', lineJoin: 'round',
            bubblingMouseEvents: false,
          }).addTo(drawn);
          if (editable && seg !== drawing)
            line.on('click', (e) => {
              if (mode === 'gate') return placeGate(e.latlng);
              if (mode === 'draw') return addPoint(e.latlng);
              select(seg.id);
            });
          if (showLengths || seg === drawing)
            legsOf(seg).forEach(([a, b]) => {
              const ft = feet(a, b);
              if (ft < 4) return;
              L.tooltip({ permanent: true, direction: 'center', className: 'fm-len', interactive: false })
                .setLatLng([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
                .setContent(ftLabel(ft))
                .addTo(drawn);
            });
        }
        // Corner dots on everything; draggable handles on the selected run.
        seg.points.forEach((p, i) => {
          if (editable && isSel && seg !== drawing) {
            if (keepHandles) return;
            const h = L.marker(p, {
              draggable: true,
              icon: L.divIcon({ className: 'fm-handle', iconSize: [14, 14] }),
              title: 'Drag to move · right-click to remove',
              keyboard: false,
            }).addTo(handles);
            h.on('dragstart', remember);
            h.on('drag', (e) => {
              seg.points[i] = [e.latlng.lat, e.latlng.lng];
              redrawLight();
            });
            h.on('dragend', () => {
              // Snap a dropped corner onto another run's corner, so runs join.
              const cur = seg.points[i];
              seg.points[i] = snap(L.latLng(cur[0], cur[1]), cur);
              // Dropped onto its own neighbour, the leg between them would have
              // no length — and the slope check and the takeoff both count by
              // leg, so a phantom one shifts everything after it. The two
              // corners become one instead (gates follow, as for a removal).
              const p = seg.points[i];
              const same = (q) => !!q && q[0] === p[0] && q[1] === p[1];
              if (seg.points.length > 2 && (same(seg.points[i - 1]) || same(seg.points[i + 1]))) removeCorner(seg, i);
              changed();
            });
            h.on('contextmenu', (e) => {
              L.DomEvent.preventDefault(e.originalEvent || e);
              if (seg.points.length <= 2) return;
              remember();
              removeCorner(seg, i);
              changed();
            });
          } else {
            L.circleMarker(p, {
              radius: seg === drawing && i === 0 ? 6 : 3.5, color: '#fff', weight: 2,
              fillColor: sys.color, fillOpacity: 1, interactive: false,
            }).addTo(drawn);
          }
        });
      }
      // Gates: an opening in the line with a post at each side.
      for (const g of layout.gates) {
        const seg = layout.segments.find((s) => s.id === g.seg);
        const leg = seg && legsOf(seg)[g.leg];
        if (!leg) continue;
        const lenFt = feet(leg[0], leg[1]) || 1;
        const half = Math.min(g.width / 2, lenFt / 2) / lenFt;
        const t = Math.min(1 - half, Math.max(half, g.t));
        const at = (tt) => [leg[0][0] + (leg[1][0] - leg[0][0]) * tt, leg[0][1] + (leg[1][1] - leg[0][1]) * tt];
        const a = at(t - half);
        const b = at(t + half);
        L.polyline([a, b], { color: '#fff', weight: 7, opacity: 1, interactive: false }).addTo(drawn);
        L.polyline([a, b], { color: '#2f9257', weight: 4, dashArray: '5 4', interactive: false }).addTo(drawn);
        [a, b].forEach((p) =>
          L.circleMarker(p, { radius: 4, color: '#fff', weight: 2, fillColor: '#2f9257', fillOpacity: 1, interactive: false }).addTo(drawn)
        );
        L.tooltip({ permanent: true, direction: 'top', offset: [0, -6], className: 'fm-gate', interactive: false })
          .setLatLng(at(t))
          .setContent(`Gate ${g.width}'`)
          .addTo(drawn);
      }
    }

    // While a handle is being dragged, only the lines need to move — once a
    // frame at most.
    let lightTimer = null;
    function redrawLight() {
      if (lightTimer) return;
      lightTimer = requestAnimationFrame(() => {
        lightTimer = null;
        redraw(true);
      });
    }

    // Nearest existing corner within a few pixels, so runs join cleanly.
    function snap(latlng, exclude) {
      const pt = map.latLngToContainerPoint(latlng);
      let best = null;
      let bestD = SNAP_PX;
      for (const seg of layout.segments)
        for (const p of seg.points) {
          const d = map.latLngToContainerPoint(p).distanceTo(pt);
          if (d < bestD && p !== exclude) {
            bestD = d;
            best = p;
          }
        }
      return best ? [best[0], best[1]] : [latlng.lat, latlng.lng];
    }

    // A second click on the same spot, quickly, ends the run. Leaflet's own
    // dblclick doesn't arrive reliably here: the first click redraws the run,
    // which can pull the element under the pointer out of the page between
    // the two clicks.
    let lastClick = null;
    function addPoint(latlng) {
      if (!drawing) return;
      const pts = drawing.points;
      const px = map.latLngToContainerPoint(latlng);
      const now = Date.now();
      const repeat = lastClick && now - lastClick.t < 450 && px.distanceTo(lastClick.px) < 8;
      lastClick = { t: now, px };
      if (repeat) {
        lastClick = null;
        return finishRun();
      }
      // Back on the first corner: the run closes into a loop.
      if (pts.length >= 3) {
        const first = map.latLngToContainerPoint(pts[0]);
        if (first.distanceTo(map.latLngToContainerPoint(latlng)) < SNAP_PX) {
          pts.push([pts[0][0], pts[0][1]]);
          return finishRun();
        }
      }
      pts.push(snap(latlng));
      redraw();
      say(pts.length === 1 ? 'Click the next corner. Double-click, or press Finish, to end the run.' : runSoFar());
    }

    function runSoFar() {
      const pts = drawing.points;
      let ft = 0;
      for (let i = 1; i < pts.length; i++) ft += feet(pts[i - 1], pts[i]);
      return `${Math.round(ft)} ft so far — keep clicking corners; double-click or Finish to end.`;
    }

    function startRun(spec) {
      cancel();
      mode = 'draw';
      selected = null;
      drawing = {
        id: uid('s'),
        system: spec.system,
        height_ft: spec.height_ft,
        tearout: !!spec.tearout,
        points: [],
      };
      container.classList.add('fm-drawing');
      say('Click on the map where the fence starts.');
      redraw();
      notifyMode();
    }

    function finishRun() {
      if (!drawing) return;
      const run = drawing;
      drawing = null;
      mode = 'idle';
      guide.clearLayers();
      container.classList.remove('fm-drawing');
      // Drop doubled points left by a double-click.
      run.points = run.points.filter((p, i, a) => i === 0 || metres(a[i - 1], p) > 0.15);
      if (run.points.length >= 2) {
        remember();
        layout.segments.push(run);
        selected = run.id;
        say('');
        changed();
        if (o.onSelect) o.onSelect(run.id);
      } else {
        say('');
        redraw();
      }
      notifyMode();
    }

    function startGate(spec) {
      cancel();
      if (!layout.segments.length) return say('Draw the fence first, then drop the gate on it.');
      mode = 'gate';
      pendingGate = { width: spec.width, double: !!spec.double };
      container.classList.add('fm-gating');
      say(`Click on the fence where the ${spec.width} ft gate goes.`);
      notifyMode();
    }

    // Put a gate on the leg nearest the click.
    function placeGate(latlng) {
      const pt = map.latLngToContainerPoint(latlng);
      let best = null;
      for (const seg of layout.segments)
        legsOf(seg).forEach(([a, b], li) => {
          const pa = map.latLngToContainerPoint(a);
          const pb = map.latLngToContainerPoint(b);
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          const len2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((pt.x - pa.x) * dx + (pt.y - pa.y) * dy) / len2));
          const d = Math.hypot(pa.x + dx * t - pt.x, pa.y + dy * t - pt.y);
          if (!best || d < best.d) best = { seg, li, t, d };
        });
      if (!best || best.d > 24) return say('That missed the fence — click right on the line.');
      const lenFt = feet(...legsOf(best.seg)[best.li]);
      if (lenFt < pendingGate.width + 0.5)
        return say(`That stretch is only ${Math.round(lenFt)} ft — too short for a ${pendingGate.width} ft gate.`);
      remember();
      layout.gates.push({ id: uid('g'), seg: best.seg.id, leg: best.li, t: best.t, width: pendingGate.width, double: pendingGate.double });
      const placed = pendingGate;
      cancel();
      say(`${placed.width} ft gate added.`);
      setTimeout(() => say(''), 2500);
      changed();
    }

    function cancel() {
      if (drawing) finishRun();
      mode = 'idle';
      pendingGate = null;
      guide.clearLayers();
      container.classList.remove('fm-drawing', 'fm-gating');
      notifyMode();
    }

    // Gates sit on a leg by index; if a corner is removed, gates past the end
    // of the run go too rather than landing somewhere arbitrary.
    // Take corner i out of a run. Gates are held by leg number, so every gate
    // has to follow its stretch: the two legs either side of the corner become
    // one (a gate on either keeps its place along it), the legs after it each
    // move down one, and a gate on a leg that is gone at the end of the run
    // goes with it. Slopes are per leg too, and are re-checked for the merged one.
    function removeCorner(seg, i) {
      const pts = seg.points;
      const legLen = (k) => feet(pts[k], pts[k + 1]);
      const n = pts.length - 1; // legs before
      const before = i > 0 && i < n ? legLen(i - 1) : 0;
      const after = i > 0 && i < n ? legLen(i) : 0;
      const kept = [];
      for (const g of layout.gates) {
        if (g.seg !== seg.id) {
          kept.push(g);
          continue;
        }
        if (i === 0) {
          // The first leg goes; the rest shift down.
          if (g.leg === 0) continue;
          kept.push({ ...g, leg: g.leg - 1 });
        } else if (i === n) {
          // The last leg goes.
          if (g.leg === n - 1) continue;
          kept.push(g);
        } else if (g.leg < i - 1) {
          kept.push(g);
        } else if (g.leg === i - 1 || g.leg === i) {
          // Onto the merged leg, at the same distance from its start.
          const along = g.leg === i - 1 ? g.t * before : before + g.t * after;
          kept.push({ ...g, leg: i - 1, t: before + after > 0 ? along / (before + after) : 0.5 });
        } else {
          kept.push({ ...g, leg: g.leg - 1 });
        }
      }
      layout.gates = kept;
      const grades = layout.terrain && Array.isArray(layout.terrain[seg.id]) ? layout.terrain[seg.id].slice() : null;
      if (grades) {
        if (i === 0) grades.splice(0, 1);
        else if (i === n) grades.splice(n - 1, 1);
        else grades.splice(i - 1, 2, null);
        layout.terrain[seg.id] = grades;
      }
      pts.splice(i, 1);
    }

    // ---- events ----
    if (editable) {
      map.on('click', (e) => {
        if (mode === 'draw') addPoint(e.latlng);
        else if (mode === 'gate') placeGate(e.latlng);
        else if (selected) select(null);
      });
      map.on('dblclick', (e) => {
        if (mode === 'draw') {
          L.DomEvent.stop(e);
          finishRun();
        }
      });
      // The dashed line from the last corner to the pointer, with its length.
      // A mouse reports far more moves than the screen can show, so only the
      // latest one is drawn, once a frame, and by moving the same line and
      // label rather than building new ones on every move.
      let guideLine = null;
      let guideLabel = null;
      let guideAt = null;
      let guideFrame = 0;
      const drawGuide = () => {
        guideFrame = 0;
        if (mode !== 'draw' || !drawing || !drawing.points.length || !guideAt) {
          guide.clearLayers(); // e.g. every corner undone: nothing to draw from
          return;
        }
        const last = drawing.points[drawing.points.length - 1];
        const to = snap(guideAt);
        if (!guideLine) {
          guideLine = L.polyline([last, to], { color: '#fff', weight: 2, dashArray: '6 6', interactive: false });
          guideLabel = L.tooltip({ permanent: true, direction: 'right', offset: [12, 0], className: 'fm-len fm-live', interactive: false });
        }
        guideLine.setLatLngs([last, to]);
        guideLabel.setLatLng(to).setContent(ftLabel(feet(last, to)));
        // Finishing or cancelling a run empties the group; put them back.
        if (!guide.hasLayer(guideLine)) guide.addLayer(guideLine);
        if (!guide.hasLayer(guideLabel)) guide.addLayer(guideLabel);
      };
      map.on('mousemove', (e) => {
        // Outside drawing there is nothing to follow the pointer: finishing,
        // cancelling and starting a gate all clear the guide already.
        if (mode !== 'draw' || !drawing) return;
        guideAt = e.latlng;
        if (!guideFrame) guideFrame = requestAnimationFrame(drawGuide);
      });
      map.on('zoomend', () => redraw());
      container.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') cancel();
        if (e.key === 'Enter' && mode === 'draw') finishRun();
      });
      container.tabIndex = 0;
    } else {
      map.on('zoomend', () => redraw());
    }

    let sayEl = null;
    function say(text) {
      if (o.onHint) return o.onHint(text);
      if (!sayEl) {
        sayEl = document.createElement('div');
        sayEl.className = 'fm-hint';
        container.appendChild(sayEl);
      }
      sayEl.textContent = text || '';
      sayEl.style.display = text ? 'block' : 'none';
    }
    const notifyMode = () => o.onMode && o.onMode(mode);

    // ---- public ----
    function getLayout() {
      return {
        v: 1,
        address: layout.address || '',
        center: layout.center,
        zoom: layout.zoom,
        segments: layout.segments.map((s) => ({ ...s, points: s.points.map((p) => [p[0], p[1]]) })),
        gates: layout.gates.map((g) => ({ ...g })),
        terrain: { ...(layout.terrain || {}) },
      };
    }

    // Put the map back to idle without keeping anything half drawn. Used when
    // the editor loads a different quote: committing the old run there would
    // report it as an edit and carry one customer's fence onto the next.
    function discardDraft() {
      drawing = null;
      mode = 'idle';
      pendingGate = null;
      guide.clearLayers();
      container.classList.remove('fm-drawing', 'fm-gating');
      say('');
      notifyMode();
    }

    function setLayout(next, { fit } = {}) {
      discardDraft();
      const n = next || {};
      layout = {
        address: n.address || '',
        center: n.center || null,
        zoom: n.zoom || 19,
        segments: (n.segments || []).map((s) => ({ ...s, points: (s.points || []).map((p) => [p[0], p[1]]) })),
        gates: (n.gates || []).map((g) => ({ ...g })),
        terrain: { ...(n.terrain || {}) },
      };
      history = [];
      selected = null;
      if (fit !== false) fitToLayout();
      redraw();
    }

    function fitToLayout() {
      const pts = layout.segments.flatMap((s) => s.points);
      if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 20 });
      else if (layout.center) map.setView(layout.center, layout.zoom || 19);
    }

    function select(id) {
      selected = id;
      redraw();
      if (o.onSelect) o.onSelect(id);
    }

    function updateSegment(id, patch) {
      const seg = layout.segments.find((s) => s.id === id);
      if (!seg) return;
      remember();
      Object.assign(seg, patch);
      changed();
    }

    function removeSegment(id) {
      remember();
      layout.segments = layout.segments.filter((s) => s.id !== id);
      layout.gates = layout.gates.filter((g) => g.seg !== id);
      delete layout.terrain[id];
      if (selected === id) selected = null;
      changed();
    }

    function removeGate(id) {
      remember();
      layout.gates = layout.gates.filter((g) => g.id !== id);
      changed();
    }

    function undo() {
      if (mode === 'draw' && drawing && drawing.points.length) {
        drawing.points.pop();
        redraw();
        return;
      }
      const prev = history.pop();
      if (!prev) return;
      const p = JSON.parse(prev);
      layout.segments = p.segments;
      layout.gates = p.gates;
      layout.terrain = p.terrain || {};
      if (selected && !layout.segments.some((s) => s.id === selected)) selected = null;
      changed();
    }

    function clear() {
      cancel();
      if (!layout.segments.length) return;
      remember();
      layout.segments = [];
      layout.gates = [];
      layout.terrain = {};
      selected = null;
      changed();
    }

    function setTerrain(terrain) {
      layout.terrain = { ...(terrain || {}) };
      if (o.onChange) o.onChange(getLayout());
    }

    function setBase(name) {
      if (!layers[name] || name === base) return;
      map.removeLayer(layers[base]);
      layers[name].addTo(map);
      layers[name].bringToBack();
      base = name;
    }

    return {
      map,
      getLayout,
      setLayout,
      setCatalog(c) {
        catalog = c;
        redraw();
      },
      setAddress(a) {
        layout.address = a || '';
      },
      startRun,
      finishRun,
      startGate,
      cancel,
      undo,
      clear,
      select,
      selected: () => selected,
      mode: () => mode,
      updateSegment,
      removeSegment,
      removeGate,
      setTerrain,
      setBase,
      fitToLayout,
      goTo(lat, lng, zoom) {
        map.setView([lat, lng], zoom || 19);
      },
      invalidate() {
        map.invalidateSize();
      },
      escape: esc,
    };
  }

  window.HEKFenceMap = { create };
})();
