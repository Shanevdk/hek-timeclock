// The rate book — what HEK charges for each service.
//
// This used to live in the browser's localStorage, which meant it was tied to
// one device and invisible to the server. The inbox agent has to price a
// drafted estimate against the same numbers the office would have used by
// hand, so the rate book moved here: one list, stored in the database, read by
// both the Pricing calculator and the agent.

'use strict';

const { store } = require('./db');

const SETTINGS_ID = 'ratebook';

// Starting rates in CAD. These are only defaults — the admin edits them in the
// Pricing tab and the edited values are what everything else reads.
//
// `install` marks the services that are quoted as supply-and-install, so that
// phrase lands on the fence lines and not on "Remove & haul away old fence".
const SERVICES = [
  { key: 'board', label: 'Board farm fence', unit: 'linear ft', price: 32, install: true },
  { key: 'woven', label: 'Woven wire farm fence', unit: 'linear ft', price: 14, install: true },
  { key: 'tensile', label: 'High tensile wire fence', unit: 'linear ft', price: 9, install: true },
  { key: 'ranch', label: 'Vinyl ranch fence', unit: 'linear ft', price: 28, install: true },
  { key: 'flex', label: 'Flex fence', unit: 'linear ft', price: 12, install: true },
  { key: 'wood', label: 'Wood privacy fence', unit: 'linear ft', price: 45, install: true },
  { key: 'vinylp', label: 'Vinyl privacy fence', unit: 'linear ft', price: 55, install: true },
  { key: 'steel', label: 'Corrugated steel privacy fence', unit: 'linear ft', price: 60, install: true },
  { key: 'hybrid', label: 'Hybrid privacy fence', unit: 'linear ft', price: 50, install: true },
  { key: 'clblack', label: 'Chain-link, black — 9ga+', unit: 'linear ft', price: 28, install: true },
  { key: 'clgalv', label: 'Chain-link, galvanized — 9ga+', unit: 'linear ft', price: 22, install: true },
  { key: 'ornam', label: 'Ornamental wrought-iron fence', unit: 'linear ft', price: 65, install: true },
  { key: 'gate', label: 'Gate', unit: 'each', price: 350, install: true },
  { key: 'postpound', label: 'Post pounding', unit: 'each', price: 35, install: false },
  { key: 'posthole', label: 'Post hole drilling', unit: 'each', price: 45, install: false },
  { key: 'repair', label: 'Fence repair', unit: 'hour', price: 85, install: false },
  { key: 'tearout', label: 'Remove & haul away old fence', unit: 'linear ft', price: 6, install: false },
  { key: 'labor', label: 'Labor', unit: 'hour', price: 65, install: false },
];

const SERVICE_KEYS = new Set(SERVICES.map((s) => s.key));
const byKey = Object.fromEntries(SERVICES.map((s) => [s.key, s]));

// The admin owns this list, not just the prices on it: a built-in service can
// be renamed, re-united or hidden, and brand new services can be added. The
// built-ins above stay as the seed, and edits are layered over them, so a
// service added to the code later still appears for everyone.
//
//   overrides  { key: { label, unit, install, public } }  edits to a built-in
//   custom     [ { key, label, unit, price, install, public } ]  admin's own
//   hidden     [ key ]  built-ins switched off
//
// `public` decides whether a service is offered on the customer-facing
// estimate page. Everything shows in the office by default; nothing is public
// until the admin says so, so turning the page on never leaks a rate by
// surprise.
const CUSTOM_PREFIX = 'x_';
const UNITS = ['linear ft', 'each', 'hour', 'sq ft', 'day'];

const cleanText = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const cleanUnit = (v, fallback) => {
  const u = cleanText(v, 20);
  return u || fallback || 'each';
};

// Default tax rate applied to a new quote or invoice (percent). Ontario HST.
const DEFAULT_TAX_RATE = 13;

const round2 = (n) => Math.round(n * 100) / 100;

// The rate book as it currently stands: the service list with any edited
// prices applied. `seeded` is true the first time it is read, which lets the
// browser offer to push up rates a user had already saved on their device.
async function getRateBook() {
  let doc = await store.settings.findOne({ _id: SETTINGS_ID });
  let seeded = false;
  if (!doc) {
    const rates = Object.fromEntries(SERVICES.map((s) => [s.key, s.price]));
    await store.settings.updateOne(
      { _id: SETTINGS_ID },
      { $setOnInsert: { rates, tax_rate: DEFAULT_TAX_RATE, created_at: new Date() } },
      { upsert: true }
    );
    doc = await store.settings.findOne({ _id: SETTINGS_ID });
    seeded = true;
  }
  const rates = (doc && doc.rates) || {};
  const overrides = (doc && doc.overrides) || {};
  const hidden = new Set((doc && doc.hidden) || []);
  const custom = Array.isArray(doc && doc.custom) ? doc.custom : [];

  // Built from SERVICES, not from the stored doc, so a service added to the
  // list above appears immediately at its default price instead of vanishing.
  const builtIns = SERVICES.filter((s) => !hidden.has(s.key)).map((s) => {
    const o = overrides[s.key] || {};
    return {
      ...s,
      label: o.label || s.label,
      unit: o.unit || s.unit,
      install: o.install != null ? !!o.install : s.install,
      price: Number.isFinite(rates[s.key]) ? rates[s.key] : s.price,
      public: !!o.public,
      custom: false,
    };
  });
  const added = custom.map((s) => ({
    key: s.key,
    label: s.label,
    unit: s.unit,
    install: !!s.install,
    price: Number.isFinite(rates[s.key]) ? rates[s.key] : Number(s.price) || 0,
    public: !!s.public,
    custom: true,
  }));

  return {
    seeded,
    tax_rate: doc && doc.tax_rate != null ? doc.tax_rate : DEFAULT_TAX_RATE,
    units: UNITS,
    services: [...builtIns, ...added],
  };
}

// Every service currently in the book, keyed for lookup — built-ins as edited
// by the admin, plus their own additions. Used to price a quote request against
// the same numbers the office sees.
async function serviceMap() {
  const book = await getRateBook();
  return Object.fromEntries(book.services.map((s) => [s.key, s]));
}

// Add a service, or edit/remove one. Built-ins are never deleted from the code;
// removing one records it as hidden so it can be brought back.
async function editService(action, body) {
  const doc = (await store.settings.findOne({ _id: SETTINGS_ID })) || {};
  const overrides = { ...(doc.overrides || {}) };
  const hidden = new Set(doc.hidden || []);
  const custom = Array.isArray(doc.custom) ? [...doc.custom] : [];
  const rates = { ...(doc.rates || {}) };
  const key = cleanText(body && body.key, 40);

  const fail = (msg) => {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  };

  if (action === 'add') {
    const label = cleanText(body.label, 120);
    if (!label) fail('Give the service a name.');
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) fail('Enter a price of 0 or more.');
    // A key of its own so renaming never collides with a built-in.
    const newKey = CUSTOM_PREFIX + Date.now().toString(36);
    custom.push({
      key: newKey,
      label,
      unit: cleanUnit(body.unit, 'linear ft'),
      price: round2(price),
      install: !!body.install,
      public: !!body.public,
    });
    rates[newKey] = round2(price);
  } else if (action === 'update') {
    const idx = custom.findIndex((s) => s.key === key);
    if (idx < 0 && !SERVICE_KEYS.has(key)) fail('That service no longer exists.');
    const patch = {};
    if (body.label != null) {
      const label = cleanText(body.label, 120);
      if (!label) fail('The name cannot be empty.');
      patch.label = label;
    }
    if (body.unit != null) patch.unit = cleanUnit(body.unit);
    if (body.install != null) patch.install = !!body.install;
    if (body.public != null) patch.public = !!body.public;
    if (body.price != null) {
      const price = Number(body.price);
      if (!Number.isFinite(price) || price < 0) fail('Enter a price of 0 or more.');
      rates[key] = round2(price);
    }
    if (idx >= 0) custom[idx] = { ...custom[idx], ...patch };
    else overrides[key] = { ...(overrides[key] || {}), ...patch };
  } else if (action === 'remove') {
    const idx = custom.findIndex((s) => s.key === key);
    if (idx >= 0) custom.splice(idx, 1);
    else if (SERVICE_KEYS.has(key)) hidden.add(key);
    else fail('That service no longer exists.');
  } else if (action === 'restore') {
    hidden.delete(key);
  } else {
    fail('Unknown action.');
  }

  await store.settings.updateOne(
    { _id: SETTINGS_ID },
    { $set: { overrides, hidden: [...hidden], custom, rates, updated_at: new Date() } },
    { upsert: true }
  );
  return getRateBook();
}

// The built-in services the admin has switched off, so the UI can offer them back.
async function hiddenServices() {
  const doc = await store.settings.findOne({ _id: SETTINGS_ID });
  const hidden = new Set((doc && doc.hidden) || []);
  return SERVICES.filter((s) => hidden.has(s.key)).map((s) => ({ key: s.key, label: s.label }));
}

// Save edited prices. Unknown keys are ignored rather than stored, so a stale
// browser tab can't write junk into the book.
async function saveRateBook({ rates, tax_rate: taxRate }) {
  const set = {};
  if (rates && typeof rates === 'object') {
    const current = await getRateBook();
    const next = Object.fromEntries(current.services.map((s) => [s.key, s.price]));
    // Any key the book currently holds, so the admin's own services can be
    // repriced here too — but nothing unknown gets written.
    const known = new Set(current.services.map((s) => s.key));
    for (const [key, value] of Object.entries(rates)) {
      if (!known.has(key)) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) continue;
      next[key] = round2(n);
    }
    set.rates = next;
  }
  if (taxRate != null) {
    const n = Number(taxRate);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      const err = new Error('Tax rate must be between 0 and 100.');
      err.status = 400;
      throw err;
    }
    set.tax_rate = round2(n);
  }
  if (Object.keys(set).length) {
    set.updated_at = new Date();
    await store.settings.updateOne({ _id: SETTINGS_ID }, { $set: set }, { upsert: true });
  }
  return getRateBook();
}

// A one-line description of a service, the way it reads on a customer's quote.
const serviceLabel = (key) => {
  const s = byKey[key];
  if (!s) return key;
  return s.install ? `${s.label} — supply & install` : s.label;
};

module.exports = {
  SERVICES,
  SERVICE_KEYS,
  DEFAULT_TAX_RATE,
  UNITS,
  byKey,
  getRateBook,
  saveRateBook,
  serviceLabel,
  serviceMap,
  editService,
  hiddenServices,
  round2,
};
