// The public estimate maker at "/estimate".
//
// A customer prices their own fence from the same rate book the office uses,
// then presses "Request a quote". That files a request the admin reviews in the
// dashboard; approving one is what turns it into a real quote. Nothing here
// ever creates a quote on its own, and nothing here can be reached with a
// login — the page is deliberately open to the public.
//
// The admin owns everything on it except the layout: which services appear,
// what they are called, what they cost, the tax rate, the blurb at the top,
// and whether the page is switched on at all.

'use strict';

const { store } = require('./db');
const secrets = require('./secrets');
const { getRateBook, serviceMap, round2 } = require('./ratebook');

const SETTINGS_ID = 'estimate';

const DEFAULTS = {
  enabled: false, // off until the admin turns it on, so rates never leak by surprise
  headline: 'Get an instant fence estimate',
  intro:
    'Pick what you need and how much of it. The price below is an estimate — ' +
    'we confirm it once we have seen the site.',
  footnote:
    'This is an estimate, not a final price. Ground conditions, access and ' +
    'materials can change it.',
  // Shown as a callout on the page and again on the request form, and copied
  // onto every request as it stood at the time — so a request always carries
  // the wording that customer actually saw, even after this is reworded.
  disclaimer:
    'Prices shown are an estimate based on the information given and do not ' +
    'form a contract or a binding offer. A firm price is issued only after a ' +
    'site visit. Rock, slopes, obstructions, fence removal, permits and ' +
    'material availability can all change the final cost.',
  min_charge: 0, // a job below this is quoted at this instead
};

const cleanText = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

async function getSettings() {
  const doc = await store.settings.findOne({ _id: SETTINGS_ID });
  return {
    ...DEFAULTS,
    ...(doc || {}),
    _id: undefined,
    // The stored key never leaves the server, not even as ciphertext — the
    // dashboard only needs to know whether one is set.
    google_key_enc: undefined,
    has_google_key: !!(doc && doc.google_key_enc) || !!process.env.GOOGLE_MAPS_API_KEY,
  };
}

async function saveSettings(body) {
  const set = {};
  if (body.enabled != null) set.enabled = !!body.enabled;
  if (body.headline != null) set.headline = cleanText(body.headline, 120);
  if (body.intro != null) set.intro = cleanText(body.intro, 600);
  if (body.footnote != null) set.footnote = cleanText(body.footnote, 600);
  if (body.disclaimer != null) set.disclaimer = cleanText(body.disclaimer, 2000);
  if (body.min_charge != null) {
    const n = Number(body.min_charge);
    if (!Number.isFinite(n) || n < 0) {
      const err = new Error('Minimum charge must be 0 or more.');
      err.status = 400;
      throw err;
    }
    set.min_charge = round2(n);
  }
  // Google Maps key, used server-side only for the Street View photo of the
  // property. Encrypted like any other stored credential, and never sent to the
  // browser — the page asks this server for the picture instead.
  if (body.google_api_key) {
    const v = String(body.google_api_key).trim();
    if (v.length < 20) {
      const err = new Error("That doesn't look like a Google Maps API key.");
      err.status = 400;
      throw err;
    }
    try {
      set.google_key_enc = secrets.encrypt('google', v);
    } catch (e) {
      e.status = 400;
      throw e;
    }
  }
  if (body.clear_google_api_key) set.google_key_enc = null;

  if (Object.keys(set).length) {
    set.updated_at = new Date();
    await store.settings.updateOne({ _id: SETTINGS_ID }, { $set: set }, { upsert: true });
  }
  return getSettings();
}

// The Google Maps key in use, or null. Falls back to the environment so a
// deployment already configured that way keeps working.
async function googleKey() {
  const doc = await store.settings.findOne({ _id: SETTINGS_ID });
  const stored = doc && doc.google_key_enc ? secrets.decrypt('google', doc.google_key_enc) : null;
  return stored || process.env.GOOGLE_MAPS_API_KEY || null;
}

// What the public page is allowed to see: the switched-on services only, and
// no internal fields. If the page is off, it gets nothing but `enabled: false`.
async function publicConfig() {
  const settings = await getSettings();
  if (!settings.enabled) return { enabled: false };
  const book = await getRateBook();
  return {
    enabled: true,
    headline: settings.headline,
    intro: settings.intro,
    footnote: settings.footnote,
    disclaimer: settings.disclaimer,
    tax_rate: book.tax_rate,
    // Whether the "from the road" photo is available. The key itself stays on
    // the server; the page only learns whether to offer the panel at all.
    street_view: !!(await googleKey()),
    services: book.services
      .filter((s) => s.public)
      .map((s) => ({ key: s.key, label: s.label, unit: s.unit, price: s.price })),
  };
}

// Price a request on the server against the live rate book. What the browser
// sent for prices is ignored entirely — only the picked service and quantity
// are taken from it, so a tampered page cannot talk us into a cheaper job.
async function priceItems(rawItems) {
  const services = await serviceMap();
  const book = await getRateBook();
  const settings = await getSettings();
  const items = [];
  for (const raw of Array.isArray(rawItems) ? rawItems.slice(0, 40) : []) {
    const svc = services[cleanText(raw && raw.service, 40)];
    if (!svc || !svc.public) continue; // unknown or not offered publicly
    const qty = Number(raw && raw.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const cappedQty = round2(Math.min(qty, 1000000));
    items.push({
      service: svc.key,
      description: svc.install ? `${svc.label} — supply & install` : svc.label,
      unit: svc.unit,
      qty: cappedQty,
      unit_price: svc.price,
      line_total: round2(cappedQty * svc.price),
    });
  }
  let subtotal = round2(items.reduce((t, i) => t + i.line_total, 0));
  const minCharge = Number(settings.min_charge) || 0;
  const belowMinimum = subtotal > 0 && minCharge > 0 && subtotal < minCharge;
  if (belowMinimum) subtotal = round2(minCharge);
  const taxRate = Number(book.tax_rate) || 0;
  const tax = round2((subtotal * taxRate) / 100);
  return {
    items,
    subtotal,
    tax_rate: taxRate,
    tax,
    total: round2(subtotal + tax),
    below_minimum: belowMinimum,
  };
}

// What they traced on the map, kept with the request so the estimator can see
// where the fence actually goes rather than just a number. Re-measured here
// from the points: the browser's total is a convenience, not evidence.
function cleanMeasurement(m) {
  if (!m || !Array.isArray(m.runs)) return null;
  const runs = m.runs
    .slice(0, 20)
    .map((run) =>
      (Array.isArray(run) ? run : [])
        .slice(0, 200)
        .map((p) => [Number(p && p[0]), Number(p && p[1])])
        .filter(
          ([a, b]) =>
            Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180
        )
    )
    .filter((run) => run.length >= 2);
  if (!runs.length) return null;

  let metres = 0;
  for (const run of runs)
    for (let i = 1; i < run.length; i++) metres += haversineM(run[i - 1], run[i]);
  return {
    runs,
    metres: round2(metres),
    feet: Math.round(metres * 3.280839895),
  };
}

// What the customer had on screen in the 3D view when they sent the request.
const PREVIEW_STYLES = ['privacy', 'picket', 'board', 'chainlink', 'wire'];
function cleanPreview(p) {
  if (!p || !PREVIEW_STYLES.includes(p.style)) return null;
  const h = Number(p.height_ft);
  return {
    style: p.style,
    height_ft: Number.isFinite(h) && h > 0 && h <= 12 ? Math.round(h * 10) / 10 : null,
  };
}

// Distance between two [lat, lng] points, in metres.
function haversineM([aLat, aLng], [bLat, bLng]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const cleanCustomer = (c) => ({
  name: cleanText(c && c.name, 120),
  email: cleanText(c && c.email, 160),
  phone: cleanText(c && c.phone, 40),
  address: cleanText(c && c.address, 200),
});

// File a quote request. Returns the stored doc.
async function createRequest(body, meta) {
  const settings = await getSettings();
  if (!settings.enabled) {
    const err = new Error('The estimate page is not available right now.');
    err.status = 403;
    throw err;
  }
  const customer = cleanCustomer(body && body.customer);
  if (!customer.name) {
    const err = new Error('Please enter your name.');
    err.status = 400;
    throw err;
  }
  if (!customer.email && !customer.phone) {
    const err = new Error('Please leave an email address or a phone number so we can reach you.');
    err.status = 400;
    throw err;
  }
  const priced = await priceItems(body && body.items);
  if (!priced.items.length) {
    const err = new Error('Please choose at least one thing to be quoted for.');
    err.status = 400;
    throw err;
  }
  const doc = {
    _id: await store.nextId('estimate_requests'),
    customer,
    notes: cleanText(body && body.notes, 2000),
    // The disclaimer as it read when they submitted, not a pointer to the
    // current one — rewording it later must not rewrite history.
    disclaimer: settings.disclaimer || '',
    // Where they traced the fence, if they used the map.
    measurement: cleanMeasurement(body && body.measurement),
    // The style and height they settled on in the 3D view. Worth keeping: it is
    // the fence the customer actually pictured, which the line items alone
    // don't say.
    preview: cleanPreview(body && body.preview),
    site: cleanText(body && body.site, 200),
    ...priced,
    status: 'new',
    quote_id: null,
    created_at: new Date(),
    // Kept for spam triage only — never shown to the customer.
    source: { ip: cleanText(meta && meta.ip, 60), agent: cleanText(meta && meta.agent, 200) },
  };
  await store.estimateRequests.insertOne(doc);
  return doc;
}

const requestView = (r) => ({
  id: r._id,
  customer: r.customer,
  notes: r.notes || '',
  disclaimer: r.disclaimer || '',
  measurement: r.measurement || null,
  preview: r.preview || null,
  site: r.site || '',
  items: r.items || [],
  subtotal: r.subtotal,
  tax_rate: r.tax_rate,
  tax: r.tax,
  total: r.total,
  below_minimum: !!r.below_minimum,
  status: r.status,
  quote_id: r.quote_id || null,
  created_at: r.created_at,
});

async function listRequests() {
  const rows = await store.estimateRequests
    .find({}, { sort: { created_at: -1 } })
    .limit(500)
    .toArray();
  return rows.map(requestView);
}

async function countNew() {
  return store.estimateRequests.countDocuments({ status: 'new' });
}

module.exports = {
  DEFAULTS,
  getSettings,
  saveSettings,
  googleKey,
  publicConfig,
  priceItems,
  createRequest,
  listRequests,
  countNew,
  requestView,
};
