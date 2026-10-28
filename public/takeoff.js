// The fence takeoff: turns a drawn layout — runs traced on the satellite map,
// gates dropped onto them — into posts, rails, pickets, panels, fabric,
// concrete and labour, priced from the catalog.
//
// One file, three users:
//   - the quote editor, live, as the fence is drawn;
//   - the server, which recomputes the cost on every save, so a quote's margin
//     is never just a number a browser claimed;
//   - the printed quote and the customer page, which draw the layout diagram.
//
// Loaded as a plain <script> (window.HEKTakeoff) and require()d by Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HEKTakeoff = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FT_PER_M = 3.280839895;
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Own keys only: "toString" or "__proto__" must never pass for a fence
  // system or a material just because every object inherits one.
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  // A number someone typed, or null. Blank is null — never 0 — so clearing a
  // box can't silently save a zero; "$9.50", "40%" and "1,200" are understood.
  const parseAmount = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const s = v.replace(/[$,%\s]/g, '');
    if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
    return Number(s);
  };
  // Run ids end up as object keys; ones that mean something to JavaScript
  // itself are refused outright.
  const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
  // "linear ft" and the like — not "sq ft".
  const isLinearFoot = (unit) => /^(linear\s*)?(ft|foot|feet)\.?$/i.test(String(unit || '').trim());

  // ---------------------------------------------------------------------------
  // Default catalog. Starting prices in CAD — the office sets its own in the
  // catalog editor, and those edits are what every quote is priced from.
  //
  // A material's cost is either per piece (`per: 'each'`) or per foot of the
  // size the recipe asks for (`per: 'ft'`) — a 4x4 post priced by the foot
  // comes out right at 8, 10 or 12 ft, and a chain-link roll priced per foot
  // of height comes out right at 4 or 6 ft. `{len}` in a label is that size.
  // `coated` marks the parts a black (vinyl-coated) chain-link system pays
  // more for.
  // ---------------------------------------------------------------------------
  const MATERIALS = {
    // Wood
    pt_post_4x4: { label: '4x4x{len} pressure-treated post', unit: 'ea', cost: 2.4, per: 'ft' },
    pt_post_6x6: { label: '6x6x{len} pressure-treated gate post', unit: 'ea', cost: 5.2, per: 'ft' },
    pt_rail_2x4: { label: '2x4x8 pressure-treated rail', unit: 'ea', cost: 7.5, per: 'each' },
    picket_1x6: { label: '1x6x{len} dog-ear picket', unit: 'ea', cost: 0.75, per: 'ft' },
    fasteners: { label: 'Fence screws & rail brackets (per section)', unit: 'set', cost: 6, per: 'each' },
    wood_gate: { label: '{len} ft wood gate — frame, boards & bracing', unit: 'ea', cost: 32, per: 'ft' },
    gate_hw_wood: { label: 'Gate hinges & latch, heavy duty', unit: 'set', cost: 45, per: 'each' },
    // Vinyl
    vinyl_post: { label: '5x5 vinyl post, {len} ft', unit: 'ea', cost: 4.5, per: 'ft' },
    vinyl_cap: { label: 'Vinyl post cap', unit: 'ea', cost: 6, per: 'each' },
    vinyl_panel: { label: 'Vinyl privacy panel, {len} ft tall', unit: 'ea', cost: 18, per: 'ft' },
    ranch_rail: { label: 'Vinyl ranch rail, 8 ft', unit: 'ea', cost: 20, per: 'each' },
    post_insert: { label: 'Aluminum post stiffener (gate post)', unit: 'ea', cost: 45, per: 'each' },
    vinyl_gate: { label: '{len} ft vinyl gate', unit: 'ea', cost: 90, per: 'ft' },
    gate_hw_vinyl: { label: 'Self-closing hinges & latch', unit: 'set', cost: 85, per: 'each' },
    // Chain-link
    cl_term_post: { label: '2-3/8" terminal post, {len} ft', unit: 'ea', cost: 4.2, per: 'ft', coated: true },
    cl_line_post: { label: '1-7/8" line post, {len} ft', unit: 'ea', cost: 3, per: 'ft', coated: true },
    cl_top_rail: { label: '1-5/8" top rail, 21 ft', unit: 'ea', cost: 38, per: 'each', coated: true },
    cl_fabric: { label: '9 ga chain-link fabric, {len} ft × 50 ft roll', unit: 'roll', cost: 22, per: 'ft', coated: true },
    cl_tension_wire: { label: 'Bottom tension wire', unit: 'ft', cost: 0.2, per: 'each', coated: true },
    cl_tension_bar: { label: 'Tension bar, {len} ft', unit: 'ea', cost: 1.6, per: 'ft', coated: true },
    cl_tension_band: { label: 'Tension band', unit: 'ea', cost: 1.6, per: 'each', coated: true },
    cl_brace_band: { label: 'Brace band', unit: 'ea', cost: 1.8, per: 'each', coated: true },
    cl_rail_end: { label: 'Rail end cup', unit: 'ea', cost: 3.2, per: 'each', coated: true },
    cl_bolt: { label: 'Carriage bolt & nut', unit: 'ea', cost: 0.45, per: 'each' },
    cl_loop_cap: { label: 'Line post loop cap', unit: 'ea', cost: 2.6, per: 'each', coated: true },
    cl_dome_cap: { label: 'Terminal post dome cap', unit: 'ea', cost: 3.5, per: 'each', coated: true },
    cl_ties: { label: 'Aluminum fence ties, bag of 100', unit: 'bag', cost: 14, per: 'each' },
    cl_gate: { label: '{len} ft chain-link gate frame with fabric', unit: 'ea', cost: 45, per: 'ft', coated: true },
    gate_hw_cl: { label: 'Gate hinges & fork latch', unit: 'set', cost: 38, per: 'each', coated: true },
    // Ornamental
    orn_post: { label: '2" aluminum post, {len} ft', unit: 'ea', cost: 7, per: 'ft' },
    orn_cap: { label: 'Ornamental post cap', unit: 'ea', cost: 5, per: 'each' },
    orn_panel: { label: 'Ornamental aluminum panel, {len} ft tall', unit: 'ea', cost: 32, per: 'ft' },
    orn_bracket: { label: 'Panel mounting bracket', unit: 'ea', cost: 3.5, per: 'each' },
    orn_gate: { label: '{len} ft ornamental aluminum gate', unit: 'ea', cost: 120, per: 'ft' },
    gate_hw_orn: { label: 'Self-closing hinges & magnetic latch', unit: 'set', cost: 95, per: 'each' },
    // Steel
    steel_post: { label: '2-3/8" galvanized steel post, {len} ft', unit: 'ea', cost: 5.5, per: 'ft' },
    steel_sheet: { label: 'Corrugated steel sheet, 26" × {len} ft', unit: 'ea', cost: 5.5, per: 'ft' },
    steel_trim: { label: 'Steel top trim cap, 10 ft', unit: 'ea', cost: 22, per: 'each' },
    steel_screws: { label: 'Steel-to-wood screws, box of 250', unit: 'box', cost: 40, per: 'each' },
    steel_gate: { label: '{len} ft steel-clad gate', unit: 'ea', cost: 60, per: 'ft' },
    // Farm
    farm_post: { label: '4–5" round treated post, {len} ft', unit: 'ea', cost: 3.5, per: 'ft' },
    farm_anchor: { label: '6–7" round treated anchor post, {len} ft', unit: 'ea', cost: 4.8, per: 'ft' },
    brace_rail: { label: '4" × 8 ft brace rail', unit: 'ea', cost: 16, per: 'each' },
    brace_wire: { label: '9 ga brace wire (one brace)', unit: 'ea', cost: 6, per: 'each' },
    farm_board: { label: '2x6x16 pressure-treated board', unit: 'ea', cost: 22, per: 'each' },
    farm_nails: { label: 'Ring-shank fence nails, 5 lb box', unit: 'box', cost: 28, per: 'each' },
    woven_roll: { label: 'Woven wire (page wire), {len} ft × 330 ft roll', unit: 'roll', cost: 95, per: 'ft' },
    staples: { label: 'Fence staples, 5 kg box', unit: 'box', cost: 38, per: 'each' },
    ht_wire: { label: '12.5 ga high-tensile wire, 4000 ft roll', unit: 'roll', cost: 185, per: 'each' },
    ht_strainer: { label: 'In-line wire strainer', unit: 'ea', cost: 5.5, per: 'each' },
    flex_rail: { label: 'Flex rail, 660 ft roll', unit: 'roll', cost: 520, per: 'each' },
    flex_bracket: { label: 'Flex rail post bracket', unit: 'ea', cost: 3.2, per: 'each' },
    flex_tensioner: { label: 'Flex rail tensioner', unit: 'ea', cost: 18, per: 'each' },
    farm_gate: { label: '{len} ft tube-steel farm gate', unit: 'ea', cost: 28, per: 'ft' },
    gate_hw_farm: { label: 'Gate hinge pins & chain latch', unit: 'set', cost: 35, per: 'each' },
    // Shared
    concrete: { label: 'Concrete mix, 30 kg bag', unit: 'bag', cost: 9.5, per: 'each' },
    drop_rod: { label: 'Drop rod (double gate)', unit: 'ea', cost: 30, per: 'each' },
  };

  // The fence systems the estimator can draw. Each one names its recipe below,
  // the rate-book service it corresponds to (so a quote can be checked against
  // the per-foot rate the office already publishes), its post spacing and
  // setting depth, and what labour costs — the crew's cost, before markup.
  const SYSTEMS = {
    wood_privacy: {
      label: 'Wood privacy', ratebook: 'wood', color: '#d08a3c',
      heights: [4, 5, 6, 7, 8], height: 6, spacing: 8, depth: 4, concrete: 2, labor: 12, gate_labor: 100,
    },
    vinyl_privacy: {
      label: 'Vinyl privacy', ratebook: 'vinylp', color: '#f2efe6',
      heights: [4, 5, 6], height: 6, spacing: 6, depth: 3, concrete: 2.5, labor: 11, gate_labor: 90,
    },
    chainlink_galv: {
      label: 'Chain-link, galvanized', ratebook: 'clgalv', color: '#9fb4c4', recipe: 'chainlink',
      heights: [3, 4, 5, 6, 8, 10], height: 4, spacing: 10, depth: 3.5, concrete: 1.5, labor: 6, gate_labor: 80,
    },
    chainlink_black: {
      label: 'Chain-link, black', ratebook: 'clblack', color: '#3d4148', recipe: 'chainlink',
      finish: 'black', cost_factor: 1.35,
      heights: [3, 4, 5, 6, 8, 10], height: 4, spacing: 10, depth: 3.5, concrete: 1.5, labor: 6, gate_labor: 80,
    },
    ornamental: {
      label: 'Ornamental aluminum', ratebook: 'ornam', color: '#111111',
      heights: [3, 4, 5, 6], height: 4, spacing: 6, depth: 3, concrete: 2, labor: 10, gate_labor: 90,
    },
    steel_privacy: {
      label: 'Corrugated steel privacy', ratebook: 'steel', color: '#8c9aa3',
      heights: [5, 6, 7, 8], height: 6, spacing: 8, depth: 4, concrete: 2, labor: 12, gate_labor: 110,
    },
    vinyl_ranch: {
      label: 'Vinyl ranch rail', ratebook: 'ranch', color: '#e9e4d6',
      heights: [3, 4, 5], height: 4, spacing: 8, depth: 3, concrete: 2, labor: 6, gate_labor: 80,
    },
    board_farm: {
      label: 'Board farm fence', ratebook: 'board', color: '#b8743a',
      heights: [4, 5], height: 4, spacing: 8, depth: 3, concrete: 0, labor: 10, gate_labor: 60,
    },
    woven_wire: {
      label: 'Woven wire farm fence', ratebook: 'woven', color: '#8fbf5a',
      heights: [3, 4, 5], height: 4, spacing: 16, depth: 3, concrete: 0, labor: 3, gate_labor: 60,
    },
    high_tensile: {
      label: 'High tensile wire', ratebook: 'tensile', color: '#e6d36a',
      heights: [3, 4, 5, 6], height: 4, spacing: 25, depth: 3, concrete: 0, labor: 2, gate_labor: 60,
    },
    flex: {
      label: 'Flex fence', ratebook: 'flex', color: '#f4f4f4',
      heights: [4, 5], height: 4, spacing: 12, depth: 3, concrete: 0, labor: 4, gate_labor: 60,
    },
  };

  // Gate sizes offered when dropping a gate on the map. Double gates are two
  // leaves, each half the opening.
  const GATES = [
    { width: 4, double: false, label: '4 ft walk gate' },
    { width: 5, double: false, label: '5 ft walk gate' },
    { width: 6, double: false, label: '6 ft walk gate' },
    { width: 8, double: true, label: '8 ft double gate' },
    { width: 10, double: true, label: '10 ft double drive gate' },
    { width: 12, double: true, label: '12 ft double drive gate' },
    { width: 14, double: true, label: '14 ft double drive gate' },
    { width: 16, double: true, label: '16 ft double drive gate' },
  ];

  const SETTINGS = {
    material_markup_pct: 35, // on material cost
    labor_markup_pct: 50, // on labour cost
    waste_pct: 5, // added to boards, pickets, fabric, wire
    target_margin_pct: 30, // the AI review flags a quote below this
    slope_grade_pct: 10, // a run steeper than this is "on a slope"
    slope_labor_pct: 20, // extra labour on sloped footage (stepping / racking)
    tearout_cost: 4, // per ft, labour cost to remove & haul away old fence
    delivery_cost: 0, // per job (delivery, setup)
  };

  // What the office may change. Anything else in a saved override is ignored,
  // so a stale tab can never write junk into the catalog.
  const SETTING_LIMITS = {
    material_markup_pct: [0, 500],
    labor_markup_pct: [0, 500],
    waste_pct: [0, 50],
    target_margin_pct: [0, 90],
    slope_grade_pct: [1, 100],
    slope_labor_pct: [0, 300],
    tearout_cost: [0, 1000],
    delivery_cost: [0, 100000],
  };
  const SYSTEM_LIMITS = {
    spacing: [2, 60],
    depth: [0, 8],
    concrete: [0, 10],
    labor: [0, 1000],
    gate_labor: [0, 10000],
  };

  // The full catalog: defaults with the office's saved overrides on top.
  function buildCatalog(overrides) {
    const o = overrides || {};
    const own = (obj, k) => (obj && has(obj, k) ? obj[k] : undefined);
    const settings = { ...SETTINGS };
    for (const k of Object.keys(SETTING_LIMITS)) {
      const v = parseAmount(own(o.settings, k));
      if (v != null) settings[k] = clamp(v, ...SETTING_LIMITS[k]);
    }
    const materials = {};
    for (const [k, m] of Object.entries(MATERIALS)) {
      const v = parseAmount(own(own(o.materials, k), 'cost'));
      materials[k] = { ...m, cost: v != null ? clamp(round2(v), 0, 100000) : m.cost };
    }
    const systems = {};
    for (const [k, s] of Object.entries(SYSTEMS)) {
      const so = own(o.systems, k) || {};
      const sys = { ...s, key: k, enabled: own(so, 'enabled') !== false };
      for (const f of Object.keys(SYSTEM_LIMITS)) {
        const v = parseAmount(own(so, f));
        if (v != null) sys[f] = clamp(v, ...SYSTEM_LIMITS[f]);
      }
      systems[k] = sys;
    }
    return { settings, materials, systems, gates: GATES };
  }

  // Validate an edit from the catalog editor and fold it into what is stored.
  // Only known keys, only real numbers: a blank or unreadable value leaves the
  // stored one as it was.
  function cleanOverrides(patch, current) {
    const cur = current || {};
    const out = {
      settings: { ...(cur.settings || {}) },
      materials: { ...(cur.materials || {}) },
      systems: { ...(cur.systems || {}) },
    };
    const p = patch || {};
    const entries = (obj) => (obj && typeof obj === 'object' ? Object.entries(obj) : []);
    for (const [k, v] of entries(p.settings)) {
      const n = parseAmount(v);
      if (!has(SETTING_LIMITS, k) || n == null) continue;
      out.settings[k] = clamp(n, ...SETTING_LIMITS[k]);
    }
    for (const [k, v] of entries(p.materials)) {
      const n = parseAmount(v && v.cost);
      if (!has(MATERIALS, k) || n == null) continue;
      out.materials[k] = { cost: clamp(round2(n), 0, 100000) };
    }
    for (const [k, v] of entries(p.systems)) {
      if (!has(SYSTEMS, k) || !v || typeof v !== 'object') continue;
      const next = { ...(has(out.systems, k) ? out.systems[k] : {}) };
      for (const f of Object.keys(SYSTEM_LIMITS)) {
        const n = parseAmount(v[f]);
        if (n != null) next[f] = clamp(n, ...SYSTEM_LIMITS[f]);
      }
      if (v.enabled != null) next.enabled = !!v.enabled;
      out.systems[k] = next;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Geometry. Over one property the earth is flat to within centimetres, so
  // points go into a local plane in feet around the layout's centre.
  // ---------------------------------------------------------------------------
  const M_PER_DEG_LAT = 111132.954;
  function projector(points) {
    const lat0 = points.length ? points.reduce((s, p) => s + p[0], 0) / points.length : 0;
    const lng0 = points.length ? points.reduce((s, p) => s + p[1], 0) / points.length : 0;
    const mPerLng = 111319.488 * Math.cos((lat0 * Math.PI) / 180);
    return ([lat, lng]) => [(lng - lng0) * mPerLng * FT_PER_M, (lat - lat0) * M_PER_DEG_LAT * FT_PER_M];
  }
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  const allPoints = (layout) => ((layout && layout.segments) || []).flatMap((s) => s.points || []);

  // A run's legs in feet. A run whose last click lands back on its first is a
  // closed loop (a yard all the way round), so it has no free ends.
  function segmentGeometry(seg, toFt) {
    let pts = (seg.points || []).map(toFt);
    let closed = false;
    if (pts.length >= 4 && dist(pts[0], pts[pts.length - 1]) < 3) {
      pts = pts.slice(0, -1);
      closed = true;
    }
    const legs = [];
    for (let i = 0; i < pts.length - 1; i++) legs.push({ a: pts[i], b: pts[i + 1], len: dist(pts[i], pts[i + 1]) });
    if (closed) legs.push({ a: pts[pts.length - 1], b: pts[0], len: dist(pts[pts.length - 1], pts[0]) });
    return { pts, legs, closed };
  }

  // How sharply the line turns at a vertex, in degrees. Under ~12° it is a
  // wobble in someone's clicking, carried by an ordinary line post.
  function deflection(prev, at, next) {
    const a1 = Math.atan2(at[1] - prev[1], at[0] - prev[0]);
    const a2 = Math.atan2(next[1] - at[1], next[0] - at[0]);
    let d = Math.abs(a2 - a1) * (180 / Math.PI);
    if (d > 180) d = 360 - d;
    return d;
  }

  const gateKey = (g) => `${num(g.width, 4)}${g.double ? 'd' : 's'}`;
  const gateLabel = (g) => {
    const known = GATES.find((x) => x.width === num(g.width, 0) && x.double === !!g.double);
    return known ? known.label : `${num(g.width, 4)} ft ${g.double ? 'double' : 'walk'} gate`;
  };

  // Count what one run needs: footage, sections, posts by kind, gates.
  function measureSegment(seg, gates, toFt, spacing) {
    const { pts, legs, closed } = segmentGeometry(seg, toFt);
    const out = {
      length_ft: 0, fence_ft: 0, bays: 0, line: 0, ends: 0, corners: 0, gate_posts: 0,
      // Vertex posts a gate post stands in for (see the end of this function).
      held_terminal: 0, held_line: 0,
      legs: legs.map((l) => l.len), gates: [], endpoints: [],
    };
    if (!legs.length) return out;
    // Vertex posts: free ends, corners, and slight bends (line posts).
    const n = pts.length;
    const vertexHeld = new Array(n).fill(0); // gate posts standing on the vertex
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) out.ends++;
      else {
        const prev = pts[(i - 1 + n) % n];
        const next = pts[(i + 1) % n];
        if (deflection(prev, pts[i], next) >= 12) out.corners++;
        else out.line++;
      }
    }
    if (!closed) out.endpoints = [pts[0], pts[n - 1]];

    legs.forEach((leg, li) => {
      out.length_ft += leg.len;
      // Gates on this leg, as openings along it.
      const on = gates
        .filter((g) => g.leg === li)
        .map((g) => {
          const w = clamp(num(g.width, 4), 2, Math.max(2, leg.len));
          const c = clamp(num(g.t, 0.5), 0, 1) * leg.len;
          return { g, w, from: clamp(c - w / 2, 0, leg.len - w), to: 0 };
        })
        .sort((x, y) => x.from - y.from);
      on.forEach((o) => (o.to = o.from + o.w));
      // The fence between the openings.
      let cursor = 0;
      const subs = [];
      on.forEach((o) => {
        subs.push({ from: cursor, to: Math.max(cursor, o.from) });
        cursor = Math.max(cursor, o.to);
        out.gates.push(o.g);
        out.gate_posts += 2;
      });
      subs.push({ from: cursor, to: leg.len });
      subs.forEach((s, si) => {
        const len = Math.max(0, s.to - s.from);
        if (len < 1) {
          // No fence here: a gate's post stands on the corner, or two gates
          // share one post between them.
          if (!on.length) return;
          if (si === 0) vertexHeld[li]++;
          else if (si === subs.length - 1) vertexHeld[(li + 1) % n]++;
          else out.gate_posts--;
          return;
        }
        out.fence_ft += len;
        const bays = Math.ceil(len / spacing);
        out.bays += bays;
        out.line += bays - 1;
      });
    });
    // A gate post standing on a vertex IS that vertex's post. It is priced as
    // the gate post it is — the heavier post a hung gate needs — and the
    // vertex's own ordinary post (end, corner or bend) comes off the post
    // count. The vertex still counts as an end or a corner for the bracing and
    // fabric hardware it takes. Two gates meeting on one vertex share its post.
    vertexHeld.forEach((count, i) => {
      if (!count) return;
      const free = !closed && (i === 0 || i === n - 1);
      if (free || deflection(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]) >= 12) out.held_terminal++;
      else out.held_line++;
      out.gate_posts -= count - 1;
    });
    return out;
  }

  // Stock lengths posts and boards come in.
  const stock = (ft) => {
    for (const s of [6, 8, 10, 12, 14, 16]) if (ft <= s + 0.01) return s;
    return Math.ceil(ft / 2) * 2;
  };

  // ---------------------------------------------------------------------------
  // Recipes: what one group (one system at one height) needs. `m` is the
  // group's measurements; `add(material, qty, part, opts)` records a line,
  // where part is 'fence' or 'gate' (opts.gate names which gate size), so the
  // summary view can price the fence by the foot and each gate as one item.
  // ---------------------------------------------------------------------------
  function gateMaterials(add, m, sys, { gateMat, hwMat, postMat, postLen, insert }) {
    for (const g of m.gate_list) {
      const leaves = g.double ? 2 : 1;
      const leafW = Math.round((g.width / leaves) * 10) / 10;
      const o = { gate: g.key };
      add(gateMat, leaves * g.count, 'gate', { ...o, len: leafW });
      add(hwMat, leaves * g.count, 'gate', o);
      if (g.double) add('drop_rod', g.count, 'gate', o);
      if (postMat) add(postMat, g.posts, 'gate', { ...o, len: postLen });
      if (insert) add(insert, g.posts, 'gate', o);
      if (sys.concrete) add('concrete', Math.ceil(g.posts * sys.concrete), 'gate', o);
    }
  }

  const RECIPES = {
    wood_privacy(m, sys, add, w) {
      const H = m.height;
      const rails = H > 6 ? 4 : H >= 5 ? 3 : 2;
      const posts = m.term_posts + m.line_posts;
      add('pt_post_4x4', posts, 'fence', { len: stock(H + sys.depth) });
      add('pt_rail_2x4', m.bays * rails * Math.ceil(sys.spacing / 8), 'fence');
      add('picket_1x6', Math.ceil(((m.fence_ft * 12) / 5.5) * w), 'fence', { len: H });
      add('concrete', Math.ceil(posts * sys.concrete), 'fence');
      add('fasteners', m.bays, 'fence');
      gateMaterials(add, m, sys, { gateMat: 'wood_gate', hwMat: 'gate_hw_wood', postMat: 'pt_post_6x6', postLen: stock(H + sys.depth) });
      return `PT 4x4 posts every ${sys.spacing} ft set in concrete, ${rails} rails, 1x6 dog-ear pickets`;
    },
    vinyl_privacy(m, sys, add) {
      const H = m.height;
      const posts = m.term_posts + m.line_posts;
      add('vinyl_post', posts, 'fence', { len: stock(H + sys.depth) });
      add('vinyl_cap', posts, 'fence');
      add('vinyl_panel', m.bays, 'fence', { len: H });
      add('concrete', Math.ceil(posts * sys.concrete), 'fence');
      gateMaterials(add, m, sys, { gateMat: 'vinyl_gate', hwMat: 'gate_hw_vinyl', postMat: 'vinyl_post', postLen: stock(H + sys.depth), insert: 'post_insert' });
      for (const g of m.gate_list) add('vinyl_cap', g.posts, 'gate', { gate: g.key });
      return `5x5 vinyl posts set in concrete, ${sys.spacing} ft privacy panels with caps`;
    },
    chainlink(m, sys, add, w) {
      const H = m.height;
      const len = stock(H + sys.depth);
      // Every free end, corner side and gate post is where fabric is stretched
      // and tied off: each one takes a tension bar, bands and a rail end.
      const sides = m.ends + 2 * m.corners;
      add('cl_term_post', m.term_posts, 'fence', { len });
      add('cl_line_post', m.line_posts, 'fence', { len: stock(H + sys.depth - 0.5) });
      add('cl_top_rail', Math.ceil((m.fence_ft / 20) * w), 'fence');
      add('cl_fabric', Math.ceil((m.fence_ft * w) / 50), 'fence', { len: H });
      add('cl_tension_wire', Math.ceil(m.fence_ft * w), 'fence');
      const bands = Math.max(1, Math.round(H) - 1);
      add('cl_tension_bar', sides, 'fence', { len: H });
      add('cl_tension_band', sides * bands, 'fence');
      add('cl_brace_band', sides, 'fence');
      add('cl_rail_end', sides, 'fence');
      add('cl_bolt', sides * (bands + 1), 'fence');
      add('cl_loop_cap', m.line_posts, 'fence');
      add('cl_dome_cap', m.term_posts, 'fence');
      add('cl_ties', Math.ceil((m.line * Math.ceil(H) + m.fence_ft / 2) / 100), 'fence');
      add('concrete', Math.ceil((m.term_posts + m.line_posts) * sys.concrete), 'fence');
      gateMaterials(add, m, sys, { gateMat: 'cl_gate', hwMat: 'gate_hw_cl', postMat: 'cl_term_post', postLen: len });
      for (const g of m.gate_list) {
        const o = { gate: g.key };
        add('cl_tension_bar', g.hw_posts, 'gate', { ...o, len: H });
        add('cl_tension_band', g.hw_posts * bands, 'gate', o);
        add('cl_brace_band', g.hw_posts, 'gate', o);
        add('cl_rail_end', g.hw_posts, 'gate', o);
        add('cl_bolt', g.hw_posts * (bands + 1), 'gate', o);
        add('cl_dome_cap', g.posts, 'gate', o);
      }
      return `9 ga ${sys.finish === 'black' ? 'black vinyl-coated' : 'galvanized'} fabric, top rail and bottom tension wire, posts every ${sys.spacing} ft set in concrete`;
    },
    ornamental(m, sys, add) {
      const H = m.height;
      const posts = m.term_posts + m.line_posts;
      add('orn_post', posts, 'fence', { len: stock(H + sys.depth) });
      add('orn_cap', posts, 'fence');
      add('orn_panel', m.bays, 'fence', { len: H });
      add('orn_bracket', m.bays * (H >= 5 ? 6 : 4), 'fence');
      add('concrete', Math.ceil(posts * sys.concrete), 'fence');
      gateMaterials(add, m, sys, { gateMat: 'orn_gate', hwMat: 'gate_hw_orn', postMat: 'orn_post', postLen: stock(H + sys.depth) });
      for (const g of m.gate_list) add('orn_cap', g.posts, 'gate', { gate: g.key });
      return `Aluminum posts set in concrete, ${sys.spacing} ft ornamental panels`;
    },
    steel_privacy(m, sys, add, w) {
      const H = m.height;
      const rails = H >= 6 ? 3 : 2;
      const posts = m.term_posts + m.line_posts;
      const sheets = Math.ceil((m.fence_ft / (26 / 12)) * w);
      add('steel_post', posts, 'fence', { len: stock(H + sys.depth) });
      add('pt_rail_2x4', m.bays * rails * Math.ceil(sys.spacing / 8), 'fence');
      add('steel_sheet', sheets, 'fence', { len: H });
      add('steel_trim', Math.ceil((m.fence_ft * w) / 10), 'fence');
      add('steel_screws', Math.ceil((sheets * 12) / 250), 'fence');
      add('concrete', Math.ceil(posts * sys.concrete), 'fence');
      gateMaterials(add, m, sys, { gateMat: 'steel_gate', hwMat: 'gate_hw_wood', postMat: 'steel_post', postLen: stock(H + sys.depth) });
      return `Galvanized steel posts set in concrete, ${rails} wood rails, corrugated steel sheets with top trim`;
    },
    vinyl_ranch(m, sys, add) {
      const H = m.height;
      const rails = H >= 5 ? 4 : H >= 4 ? 3 : 2;
      const posts = m.term_posts + m.line_posts;
      add('vinyl_post', posts, 'fence', { len: stock(H + sys.depth) });
      add('vinyl_cap', posts, 'fence');
      add('ranch_rail', m.bays * rails * Math.ceil(sys.spacing / 8), 'fence');
      add('concrete', Math.ceil(posts * sys.concrete), 'fence');
      gateMaterials(add, m, sys, { gateMat: 'vinyl_gate', hwMat: 'gate_hw_vinyl', postMat: 'vinyl_post', postLen: stock(H + sys.depth), insert: 'post_insert' });
      return `5x5 vinyl posts every ${sys.spacing} ft, ${rails}-rail ranch style`;
    },
    board_farm(m, sys, add, w) {
      const H = m.height;
      const boards = H > 4.5 ? 4 : 3;
      const count = Math.ceil((m.fence_ft / 16) * boards * w);
      add('farm_post', m.term_posts + m.line_posts, 'fence', { len: stock(H + sys.depth) });
      add('farm_board', count, 'fence');
      add('farm_nails', Math.max(1, Math.ceil((count * 9) / 400)), 'fence');
      gateMaterials(add, m, sys, { gateMat: 'farm_gate', hwMat: 'gate_hw_farm', postMat: 'farm_anchor', postLen: stock(H + sys.depth + 1) });
      return `Round treated posts every ${sys.spacing} ft, ${boards} boards, posts driven`;
    },
    woven_wire(m, sys, add, w) {
      const H = m.height;
      // Every end and corner side is braced: an H-brace is a second post, a
      // rail between them and a twisted brace wire.
      const braces = m.ends + 2 * m.corners;
      const posts = m.term_posts + m.line_posts + braces;
      add('farm_anchor', m.term_posts, 'fence', { len: stock(H + sys.depth + 1) });
      add('farm_post', m.line_posts + braces, 'fence', { len: stock(H + sys.depth) });
      add('brace_rail', braces, 'fence');
      add('brace_wire', braces, 'fence');
      add('woven_roll', Math.ceil((m.fence_ft * w) / 330), 'fence', { len: H });
      add('staples', Math.max(1, Math.ceil((posts * 10) / 700)), 'fence');
      gateMaterials(add, m, sys, { gateMat: 'farm_gate', hwMat: 'gate_hw_farm', postMat: 'farm_anchor', postLen: stock(H + sys.depth + 1) });
      return `Woven wire on treated posts every ${sys.spacing} ft, H-braced at every end and corner`;
    },
    high_tensile(m, sys, add, w) {
      const H = m.height;
      const strands = Math.max(3, Math.round(H * 1.25));
      const braces = m.ends + 2 * m.corners;
      add('farm_anchor', m.term_posts, 'fence', { len: stock(H + sys.depth + 1) });
      add('farm_post', m.line_posts + braces, 'fence', { len: stock(H + sys.depth) });
      add('brace_rail', braces, 'fence');
      add('brace_wire', braces, 'fence');
      add('ht_wire', Math.ceil((m.fence_ft * strands * w) / 4000), 'fence');
      add('ht_strainer', Math.ceil(braces / 2) * strands, 'fence');
      add('staples', Math.max(1, Math.ceil((m.line * strands) / 700)), 'fence');
      gateMaterials(add, m, sys, { gateMat: 'farm_gate', hwMat: 'gate_hw_farm', postMat: 'farm_anchor', postLen: stock(H + sys.depth + 1) });
      return `${strands} strands of 12.5 ga high-tensile wire, posts every ${sys.spacing} ft, braced ends and corners`;
    },
    flex(m, sys, add, w) {
      const H = m.height;
      const rails = H >= 5 ? 4 : 3;
      const braces = m.ends + 2 * m.corners;
      add('farm_anchor', m.term_posts, 'fence', { len: stock(H + sys.depth + 1) });
      add('farm_post', m.line_posts + braces, 'fence', { len: stock(H + sys.depth) });
      add('brace_rail', braces, 'fence');
      add('brace_wire', braces, 'fence');
      add('flex_rail', Math.ceil((m.fence_ft * rails * w) / 660), 'fence');
      add('flex_bracket', (m.line + m.terminals) * rails, 'fence');
      add('flex_tensioner', Math.ceil(braces / 2) * rails, 'fence');
      gateMaterials(add, m, sys, { gateMat: 'farm_gate', hwMat: 'gate_hw_farm', postMat: 'farm_anchor', postLen: stock(H + sys.depth + 1) });
      return `${rails} flex rails on treated posts every ${sys.spacing} ft`;
    },
  };

  const fmtLen = (v) => String(Math.round(v * 10) / 10);
  const groupLabel = (sys, H) => `${fmtLen(H)} ft ${sys.label.charAt(0).toLowerCase()}${sys.label.slice(1)}`;

  // ---------------------------------------------------------------------------
  // The takeoff itself.
  // ---------------------------------------------------------------------------
  function compute(layout, catalog) {
    const cat = catalog || buildCatalog();
    const S = cat.settings;
    const segs = ((layout && layout.segments) || []).filter((s) => (s.points || []).length >= 2);
    const gatesAll = (layout && layout.gates) || [];
    const terrain = (layout && layout.terrain) || {};
    const toFt = projector(allPoints(layout));
    const w = 1 + S.waste_pct / 100;
    const mm = 1 + S.material_markup_pct / 100;
    const lm = 1 + S.labor_markup_pct / 100;

    // One group per system and height: a 6 ft and a 4 ft run of the same
    // fence take different posts and pickets.
    const groups = new Map();
    const runs = [];
    for (const seg of segs) {
      const sys = (has(cat.systems, seg.system) && cat.systems[seg.system]) || cat.systems.wood_privacy;
      const H = clamp(num(seg.height_ft, sys.height), 1, 16);
      const key = `${sys.key}|${H}`;
      const gates = gatesAll.filter((g) => g.seg === seg.id);
      const ms = measureSegment(seg, gates, toFt, sys.spacing);
      // Footage on a slope steeper than the threshold costs more to build:
      // sections are stepped or racked, and every post is set by hand. A leg
      // whose slope is unknown (null) is priced as level, and counted, so the
      // editor can say the check isn't complete.
      const raw = has(terrain, seg.id) && Array.isArray(terrain[seg.id]) ? terrain[seg.id] : [];
      const known = [];
      let slopeFt = 0;
      let unchecked = 0;
      ms.legs.forEach((len, i) => {
        const g = raw[i] == null ? null : Number(raw[i]);
        if (g == null || !Number.isFinite(g)) return void unchecked++;
        known.push(Math.abs(g));
        if (Math.abs(g) >= S.slope_grade_pct) slopeFt += len;
      });
      runs.push({
        id: seg.id, system: sys.key, label: groupLabel(sys, H), length_ft: ms.length_ft,
        fence_ft: ms.fence_ft, gates: gates.length, slope_ft: slopeFt, tearout: !!seg.tearout,
        max_grade: known.length ? Math.max(...known) : null,
        slope_unchecked: unchecked,
      });
      if (!groups.has(key))
        groups.set(key, {
          key, sys, height: H, fence_ft: 0, length_ft: 0, bays: 0, line: 0, ends: 0, corners: 0,
          gate_posts: 0, terminals: 0, held_terminal: 0, held_line: 0,
          gate_list: [], endpoints: [], tearout_ft: 0, slope_ft: 0, runs: 0,
        });
      const g = groups.get(key);
      g.runs++;
      g.fence_ft += ms.fence_ft;
      g.length_ft += ms.length_ft;
      g.bays += ms.bays;
      g.line += ms.line;
      g.ends += ms.ends;
      g.corners += ms.corners;
      g.gate_posts += ms.gate_posts;
      g.held_terminal += ms.held_terminal;
      g.held_line += ms.held_line;
      g.endpoints.push(...ms.endpoints);
      g.slope_ft += slopeFt;
      if (seg.tearout) g.tearout_ft += ms.length_ft;
      for (const gt of ms.gates) {
        const k = gateKey(gt);
        let e = g.gate_list.find((x) => x.key === k);
        if (!e) g.gate_list.push((e = { key: k, width: num(gt.width, 4), double: !!gt.double, count: 0, posts: 0 }));
        e.count++;
      }
    }

    const out = { groups: [], runs, materials: [], labor: [], totals: null };
    const matIndex = new Map();
    for (const g of groups.values()) {
      // Two runs of the same fence that meet end to end share the post there:
      // two free ends become one corner.
      const ends = g.endpoints;
      const merged = new Array(ends.length).fill(false);
      for (let i = 0; i < ends.length; i++)
        for (let j = i + 1; j < ends.length; j++)
          if (!merged[i] && !merged[j] && dist(ends[i], ends[j]) < 2) {
            merged[j] = true;
            g.ends -= 2;
            g.corners += 1;
          }
      g.terminals = g.ends + g.corners;
      // The posts the fence itself needs, after the ones gate posts stand in
      // for. (terminals and line still count every end, corner and bend: the
      // bracing and fabric hardware goes by those.)
      g.term_posts = Math.max(0, g.terminals - g.held_terminal);
      g.line_posts = Math.max(0, g.line - g.held_line);
      // Gate posts are shared out to the gate sizes that need them. hw_posts
      // leaves out the ones standing on a fence end or corner, whose fabric and
      // bracing hardware is already counted with the fence.
      const totalGates = g.gate_list.reduce((s, x) => s + x.count, 0);
      const share = (total, field) => {
        let left = total;
        g.gate_list.forEach((x, i) => {
          x[field] = i === g.gate_list.length - 1 ? left : Math.round((total * x.count) / totalGates);
          left -= x[field];
        });
      };
      share(g.gate_posts, 'posts');
      share(Math.max(0, g.gate_posts - g.held_terminal - g.held_line), 'hw_posts');

      const lines = [];
      const add = (mat, qty, part, opts) => {
        const m = cat.materials[mat];
        qty = Math.max(0, Math.ceil(qty - 1e-9));
        if (!m || !qty) return;
        const len = opts && opts.len != null ? opts.len : null;
        let unitCost = m.per === 'ft' && len != null ? m.cost * len : m.cost;
        let label = m.label.replace('{len}', len != null ? fmtLen(len) : '').replace(/\s+/g, ' ');
        if (g.sys.finish && m.coated) {
          unitCost *= g.sys.cost_factor || 1;
          label += `, ${g.sys.finish}`;
        }
        unitCost = round2(unitCost);
        lines.push({ key: mat, label, unit: m.unit, qty, unit_cost: unitCost, cost: round2(qty * unitCost), part, gate: (opts && opts.gate) || null });
      };
      const recipe = RECIPES[g.sys.recipe || g.sys.key] || RECIPES.wood_privacy;
      const m = { ...g, height: g.height };
      const spec = recipe(m, g.sys, add, w);

      const fenceLabor = round2(g.fence_ft * g.sys.labor);
      const slopeLabor = round2(g.slope_ft * g.sys.labor * (S.slope_labor_pct / 100));
      const leaves = g.gate_list.reduce((s, x) => s + x.count * (x.double ? 2 : 1), 0);
      const gateLabor = round2(leaves * g.sys.gate_labor);
      const tearLabor = round2(g.tearout_ft * S.tearout_cost);
      const label = groupLabel(g.sys, g.height);
      const labor = [];
      if (fenceLabor) labor.push({ key: 'install', label: `Installation labor — ${label}`, qty: Math.round(g.fence_ft), unit: 'linear ft', unit_cost: g.sys.labor, cost: fenceLabor, part: 'fence' });
      if (slopeLabor) labor.push({ key: 'slope', label: `Sloped ground — stepped / racked sections, ${label}`, qty: Math.round(g.slope_ft), unit: 'linear ft', unit_cost: round2(g.sys.labor * (S.slope_labor_pct / 100)), cost: slopeLabor, part: 'fence' });
      for (const x of g.gate_list) {
        const l = x.count * (x.double ? 2 : 1) * g.sys.gate_labor;
        labor.push({ key: 'gate', label: `Gate installation — ${gateLabel(x)}`, qty: x.count, unit: 'each', unit_cost: round2(l / x.count), cost: round2(l), part: 'gate', gate: x.key });
      }
      if (tearLabor) labor.push({ key: 'tearout', label: 'Remove & haul away old fence', qty: Math.round(g.tearout_ft), unit: 'linear ft', unit_cost: S.tearout_cost, cost: tearLabor, part: 'tearout' });

      const materialCost = round2(lines.reduce((s, l) => s + l.cost, 0));
      const laborCost = round2(labor.reduce((s, l) => s + l.cost, 0));
      const priceOf = (part, gate) =>
        round2(
          lines.filter((l) => l.part === part && (!gate || l.gate === gate)).reduce((s, l) => s + l.cost * mm, 0) +
            labor.filter((l) => l.part === part && (!gate || l.gate === gate)).reduce((s, l) => s + l.cost * lm, 0)
        );
      const group = {
        key: g.key, system: g.sys.key, label, spec, height: g.height, runs: g.runs, ratebook: g.sys.ratebook,
        fence_ft: Math.round(g.fence_ft), length_ft: Math.round(g.length_ft), slope_ft: Math.round(g.slope_ft),
        tearout_ft: Math.round(g.tearout_ft),
        posts: g.term_posts + g.line_posts + Math.max(0, g.gate_posts), sections: g.bays,
        gates: g.gate_list.map((x) => ({ key: x.key, width: x.width, double: x.double, count: x.count, label: gateLabel(x), price: priceOf('gate', x.key) })),
        materials: lines, labor,
        material_cost: materialCost, labor_cost: laborCost, cost: round2(materialCost + laborCost),
        fence_price: priceOf('fence'), tearout_price: priceOf('tearout'),
        price: round2(materialCost * mm + laborCost * lm),
      };
      out.groups.push(group);
      for (const l of lines) {
        const k = l.label + '|' + l.unit_cost;
        const e = matIndex.get(k);
        if (e) {
          e.qty += l.qty;
          e.cost = round2(e.cost + l.cost);
        } else {
          const copy = { key: l.key, label: l.label, unit: l.unit, qty: l.qty, unit_cost: l.unit_cost, cost: l.cost };
          matIndex.set(k, copy);
          out.materials.push(copy);
        }
      }
      out.labor.push(...labor);
    }

    if (out.groups.length && S.delivery_cost > 0)
      out.labor.push({ key: 'delivery', label: 'Delivery & job setup', qty: 1, unit: 'job', unit_cost: S.delivery_cost, cost: S.delivery_cost, part: 'job' });

    const materialCost = round2(out.materials.reduce((s, l) => s + l.cost, 0));
    const laborCost = round2(out.labor.reduce((s, l) => s + l.cost, 0));
    const price = round2(materialCost * mm + laborCost * lm);
    const cost = round2(materialCost + laborCost);
    const fenceFt = out.groups.reduce((s, g) => s + g.fence_ft, 0);
    out.totals = {
      fence_ft: fenceFt,
      length_ft: out.groups.reduce((s, g) => s + g.length_ft, 0),
      gates: out.groups.reduce((s, g) => s + g.gates.reduce((n, x) => n + x.count, 0), 0),
      posts: out.groups.reduce((s, g) => s + g.posts, 0),
      material_cost: materialCost,
      labor_cost: laborCost,
      cost,
      material_price: round2(materialCost * mm),
      labor_price: round2(laborCost * lm),
      price,
      margin_pct: price > 0 ? round2(((price - cost) / price) * 100) : 0,
      per_ft: fenceFt > 0 ? round2(price / fenceFt) : 0,
    };
    return out;
  }

  // ---------------------------------------------------------------------------
  // Quote lines from a takeoff.
  //   itemized — every material at its marked-up price, then the labour;
  //   summary  — one line per fence at a price per foot, one per gate size.
  // Every line is tagged src:'layout' so redrawing replaces them without
  // touching anything the office typed in by hand.
  // ---------------------------------------------------------------------------
  function quoteLines(t, catalog, mode) {
    const S = (catalog || buildCatalog()).settings;
    const mm = 1 + S.material_markup_pct / 100;
    const lm = 1 + S.labor_markup_pct / 100;
    const lines = [];
    const push = (description, qty, unit, unitPrice) => {
      if (!qty) return;
      lines.push({ description, qty: Math.round(qty * 100) / 100, unit, unit_price: round2(unitPrice), src: 'layout' });
    };
    if (mode === 'itemized') {
      for (const m of t.materials) push(m.label, m.qty, m.unit, m.unit_cost * mm);
      for (const l of t.labor) push(l.label, l.qty, l.unit, (l.cost / (l.qty || 1)) * lm);
      return lines;
    }
    for (const g of t.groups) {
      if (g.fence_ft > 0)
        push(`${g.label} fence — supply & install\n${g.spec}`, g.fence_ft, 'linear ft', g.fence_price / g.fence_ft);
      for (const x of g.gates) push(`${x.label}, ${g.label} — supply & install`, x.count, 'each', x.price / x.count);
      if (g.tearout_ft > 0) push('Remove & haul away old fence', g.tearout_ft, 'linear ft', g.tearout_price / g.tearout_ft);
    }
    for (const l of t.labor.filter((x) => x.part === 'job')) push(l.label, l.qty, l.unit, l.unit_cost * lm);
    return lines;
  }

  // ---------------------------------------------------------------------------
  // The layout as a drawing: the runs to scale, each leg's length, the gates,
  // and north. Used on the printed quote and the customer page, where a
  // satellite map can't be printed reliably.
  // ---------------------------------------------------------------------------
  const escXml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function layoutSvg(layout, catalog, opts) {
    const o = opts || {};
    const W = o.width || 640;
    const H = o.height || 340;
    const cat = catalog || buildCatalog();
    const segs = ((layout && layout.segments) || []).filter((s) => (s.points || []).length >= 2);
    if (!segs.length) return '';
    const toFt = projector(allPoints(layout));
    const proj = segs.map((s) => ({ seg: s, pts: s.points.map(toFt) }));
    const xs = proj.flatMap((p) => p.pts.map((q) => q[0]));
    const ys = proj.flatMap((p) => p.pts.map((q) => q[1]));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 46;
    const scale = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY), 8);
    const offX = (W - (maxX - minX) * scale) / 2;
    const offY = (H - (maxY - minY) * scale) / 2;
    const P = ([x, y]) => [offX + (x - minX) * scale, H - (offY + (y - minY) * scale)];
    const ink = '#22201c';
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Fence layout drawing" style="max-width:${W}px;display:block;font-family:Arial,sans-serif">`;
    svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="#fbf8f2" stroke="#e6dfd2"/>`;
    // A light grid gives the drawing a sense of scale.
    const stepFt = [5, 10, 20, 25, 50, 100, 200, 500].find((s) => s * scale >= 28) || 1000;
    svg += `<g stroke="#ece5d8" stroke-width="1">`;
    for (let x = offX % (stepFt * scale); x < W; x += stepFt * scale) svg += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}"/>`;
    for (let y = offY % (stepFt * scale); y < H; y += stepFt * scale) svg += `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}"/>`;
    svg += `</g>`;
    const labels = [];
    for (const { seg, pts } of proj) {
      const sys = (has(cat.systems, seg.system) && cat.systems[seg.system]) || cat.systems.wood_privacy;
      const color = sys.color === '#f2efe6' || sys.color === '#f4f4f4' || sys.color === '#e9e4d6' ? '#b9b2a4' : sys.color;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${P(p)[0].toFixed(1)},${P(p)[1].toFixed(1)}`).join(' ');
      svg += `<path d="${d}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
      for (const p of pts) {
        const [x, y] = P(p);
        svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="#fff" stroke="${ink}" stroke-width="1.5"/>`;
      }
      for (let i = 1; i < pts.length; i++) {
        const len = dist(pts[i - 1], pts[i]);
        if (len < 3) continue;
        const a = P(pts[i - 1]), b = P(pts[i]);
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const nx = -(b[1] - a[1]), ny = b[0] - a[0];
        const nl = Math.hypot(nx, ny) || 1;
        labels.push({ x: mx + (nx / nl) * 13, y: my + (ny / nl) * 13, text: `${Math.round(len)}'` });
      }
      // Gates: a white gap in the line with a tick at each post.
      const legs = [];
      for (let i = 0; i < pts.length - 1; i++) legs.push([pts[i], pts[i + 1]]);
      for (const g of ((layout && layout.gates) || []).filter((x) => x.seg === seg.id)) {
        const leg = legs[g.leg];
        if (!leg) continue;
        const len = dist(leg[0], leg[1]) || 1;
        const half = Math.min(num(g.width, 4) / 2, len / 2) / len;
        const t = clamp(num(g.t, 0.5), half, 1 - half);
        const at = (tt) => P([leg[0][0] + (leg[1][0] - leg[0][0]) * tt, leg[0][1] + (leg[1][1] - leg[0][1]) * tt]);
        const a = at(t - half), b = at(t + half), c = at(t);
        svg += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="#fbf8f2" stroke-width="7"/>`;
        svg += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="#2f9257" stroke-width="2.5" stroke-dasharray="4 3"/>`;
        svg += `<circle cx="${a[0].toFixed(1)}" cy="${a[1].toFixed(1)}" r="3.5" fill="#2f9257"/><circle cx="${b[0].toFixed(1)}" cy="${b[1].toFixed(1)}" r="3.5" fill="#2f9257"/>`;
        labels.push({ x: c[0], y: c[1] - 10, text: `Gate ${fmtLen(num(g.width, 4))}'`, gate: true });
      }
    }
    for (const l of labels)
      svg += `<text x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="700" fill="${l.gate ? '#2f9257' : ink}" stroke="#fbf8f2" stroke-width="3" paint-order="stroke">${escXml(l.text)}</text>`;
    // North arrow and scale bar.
    svg += `<g transform="translate(${W - 26},28)"><path d="M0,-14 L6,4 L0,0 L-6,4 Z" fill="${ink}"/><text x="0" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="${ink}">N</text></g>`;
    const bar = stepFt * scale;
    svg += `<g transform="translate(14,${H - 16})"><line x1="0" y1="0" x2="${bar.toFixed(1)}" y2="0" stroke="${ink}" stroke-width="2"/><line x1="0" y1="-4" x2="0" y2="4" stroke="${ink}" stroke-width="2"/><line x1="${bar.toFixed(1)}" y1="-4" x2="${bar.toFixed(1)}" y2="4" stroke="${ink}" stroke-width="2"/><text x="${(bar / 2).toFixed(1)}" y="-7" text-anchor="middle" font-size="10" fill="${ink}">${stepFt} ft</text></g>`;
    svg += `</svg>`;
    return svg;
  }

  // The legend for a drawn layout: each fence and its footage.
  function layoutLegend(layout, catalog) {
    const t = compute(layout, catalog);
    return t.groups.map((g) => {
      const systems = (catalog || buildCatalog()).systems;
      const sys = has(systems, g.system) ? systems[g.system] : null;
      return { label: g.label, color: sys ? sys.color : '#999', fence_ft: g.fence_ft, gates: g.gates };
    });
  }

  // Validate a layout coming in from a browser. Bounded so one request can't
  // store something enormous.
  function cleanLayout(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const okPt = (p) =>
      Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])) &&
      Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
    const pt = (p) => [Math.round(Number(p[0]) * 1e7) / 1e7, Math.round(Number(p[1]) * 1e7) / 1e7];
    // Two clicks within ~15 cm of each other (a double click on the public
    // estimate page) are one corner, not a zero-length leg with a post of its
    // own. Dropping one shifts the legs after it, so each run keeps a map from
    // its old leg numbers to the new, and its gates and slopes follow it.
    const near = (a, b) =>
      Math.abs(a[0] - b[0]) < 1.5e-6 && Math.abs(a[1] - b[1]) * Math.cos((a[0] * Math.PI) / 180) < 1.5e-6;
    const legMaps = Object.create(null);
    const ids = new Set();
    const segments = (Array.isArray(raw.segments) ? raw.segments : [])
      .slice(0, 60)
      .map((s) => {
        const id = String((s && s.id) || '').replace(/[^\w-]/g, '').slice(0, 24);
        if (!id || ids.has(id) || RESERVED.has(id)) return null;
        const pts = (Array.isArray(s.points) ? s.points : []).filter(okPt).slice(0, 300).map(pt);
        if (!pts.length) return null;
        const points = [pts[0]];
        const legMap = [];
        for (let i = 1; i < pts.length; i++) {
          if (near(pts[i], points[points.length - 1])) legMap.push(-1);
          else {
            points.push(pts[i]);
            legMap.push(points.length - 2);
          }
        }
        if (points.length < 2) return null;
        ids.add(id);
        legMaps[id] = legMap;
        return {
          id,
          system: has(SYSTEMS, s.system) ? s.system : 'wood_privacy',
          height_ft: clamp(num(s.height_ft, 6), 1, 16),
          tearout: !!s.tearout,
          points,
        };
      })
      .filter(Boolean);
    if (!segments.length) return null;
    const gates = (Array.isArray(raw.gates) ? raw.gates : [])
      .slice(0, 80)
      .map((g) => {
        if (!g || typeof g.seg !== 'string' || !ids.has(g.seg)) return null;
        const leg = legMaps[g.seg][clamp(Math.floor(num(g.leg, 0)), 0, 300)];
        if (leg == null || leg < 0) return null; // its stretch no longer exists
        return {
          id: String(g.id || '').replace(/[^\w-]/g, '').slice(0, 24) || 'g' + Math.random().toString(36).slice(2, 8),
          seg: g.seg,
          leg,
          t: clamp(num(g.t, 0.5), 0, 1),
          width: clamp(num(g.width, 4), 2, 40),
          double: !!g.double,
        };
      })
      .filter(Boolean);
    // Slope per leg: a grade, or null where it hasn't been checked.
    const terrain = {};
    if (raw.terrain && typeof raw.terrain === 'object')
      for (const s of segments) {
        const src = has(raw.terrain, s.id) && Array.isArray(raw.terrain[s.id]) ? raw.terrain[s.id] : null;
        if (!src) continue;
        const out = new Array(s.points.length - 1).fill(null);
        legMaps[s.id].forEach((n, r) => {
          const g = src[r];
          if (n >= 0 && g != null && Number.isFinite(Number(g))) out[n] = Math.round(Number(g) * 10) / 10;
        });
        terrain[s.id] = out;
      }
    const center = okPt(raw.center) ? pt(raw.center) : null;
    return {
      v: 1,
      address: String(raw.address || '').trim().slice(0, 300),
      center,
      zoom: clamp(Math.round(num(raw.zoom, 19)), 3, 22),
      segments,
      gates,
      terrain,
    };
  }

  return {
    MATERIALS,
    SYSTEMS,
    GATES,
    SETTINGS,
    buildCatalog,
    cleanOverrides,
    cleanLayout,
    compute,
    quoteLines,
    layoutSvg,
    layoutLegend,
    gateLabel,
    projector,
    isLinearFoot,
    parseAmount,
  };
});
