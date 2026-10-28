// The materials & labour catalog the quote estimator prices from: what each
// material costs HEK, what the crew costs per foot of each fence, and the
// markups on top.
//
// The defaults and every recipe live in public/takeoff.js, which the browser
// runs as well — the editor prices a fence live as it is drawn, and the server
// recomputes the same takeoff on save. Only the office's edits are stored
// here, layered over those defaults, so a material added to the code later
// still shows up at its default price.

'use strict';

const { store } = require('./db');
const takeoff = require('./public/takeoff');

const SETTINGS_ID = 'takeoff';

async function getOverrides() {
  const doc = await store.settings.findOne({ _id: SETTINGS_ID });
  return (doc && doc.overrides) || {};
}

// Read on every quote save and every customer page view, and it changes only
// when someone edits prices — so it is kept for a little while. An edit made
// here replaces it at once; one made on another server instance shows up
// within CACHE_MS.
const CACHE_MS = 30000;
let cached = null;
async function getCatalog() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.catalog;
  const catalog = takeoff.buildCatalog(await getOverrides());
  cached = { catalog, at: Date.now() };
  return catalog;
}
const remember = (catalog) => {
  cached = { catalog, at: Date.now() };
  return catalog;
};

// Unknown keys, blanks and out-of-range numbers are dropped by cleanOverrides,
// so neither a stale tab nor an emptied box can write junk into the catalog.
async function saveCatalog(patch) {
  const next = takeoff.cleanOverrides(patch, await getOverrides());
  await store.settings.updateOne(
    { _id: SETTINGS_ID },
    { $set: { overrides: next, updated_at: new Date() } },
    { upsert: true }
  );
  return remember(takeoff.buildCatalog(next));
}

// Put every price back to the starting defaults.
async function resetCatalog() {
  await store.settings.updateOne(
    { _id: SETTINGS_ID },
    { $set: { overrides: {}, updated_at: new Date() } },
    { upsert: true }
  );
  return remember(takeoff.buildCatalog({}));
}

module.exports = { getCatalog, saveCatalog, resetCatalog };
