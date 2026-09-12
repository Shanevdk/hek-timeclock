// HEK Fencing Inc. timeclock server.
// - Employee: personal login (email + password) at "/" — an employee portal
//             where they clock in / out and always see their own hours, plus
//             any extra features the admin has granted them (permissions).
// - Admin:    dashboard at ADMIN_PATH protected by an email + password. The
//             admin can also sign in from "/" and is redirected to ADMIN_PATH.
//
// All data lives in a cloud MongoDB database (see db.js / DATABASE_URL).

// Load a local .env file if one exists (so `node server.js` picks up your
// settings). On a cloud host you set real environment variables instead, and
// this simply does nothing.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — using real environment variables */
}

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const { connect, store } = require('./db');
const qbo = require('./quickbooks');
const rateBook = require('./ratebook');
const inbox = require('./inbox');
const estimates = require('./estimates');
const metrics = require('./metrics');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@hekfencing.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
// A built-in "dev" account: a limited admin that can use everything in the
// dashboard EXCEPT the clock-in features. Seeded into the database on first run.
const DEV_EMAIL = (process.env.DEV_EMAIL || 'dev@hek-fencing.com').toLowerCase();
const DEV_PASSWORD = process.env.DEV_PASSWORD || 'golfcart';
const SESSION_SECRET =
  process.env.SESSION_SECRET || 'hek-timeclock-dev-secret-please-change';
// The admin dashboard is its own page served at this path. Admins reach it by
// signing in on the main page ("/"), which redirects here — they never type it.
// Override with the ADMIN_PATH env var.
const ADMIN_PATH = process.env.ADMIN_PATH || '/admin';
// Timezone used to decide when "today" starts, so a missed clock-out from a
// previous day is detected correctly. Set it to your region.
const TIMEZONE = process.env.TIMEZONE || 'America/New_York';

// Local calendar day (YYYY-MM-DD) for a timestamp, in the configured timezone.
function localDay(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(d));
}

if (ADMIN_PASSWORD === 'changeme') {
  console.warn(
    '\n[WARN] ADMIN_PASSWORD is not set — using default "changeme". ' +
      'Set the ADMIN_PASSWORD env var before going live.\n'
  );
}

// When running as a Netlify function, requests arrive under a
// "/.netlify/functions/<name>" prefix. Strip it so the Express routes below see
// clean paths like "/api/status". Harmless when running as a normal server.
app.use((req, res, next) => {
  req.url = req.url.replace(/^\/\.netlify\/functions\/[^/?]+/, '');
  if (!req.url.startsWith('/')) req.url = '/' + req.url;
  next();
});

// Raised from the 100kb default so task file attachments (sent as base64 JSON,
// capped at 4 MB each server-side ≈ 5.4 MB encoded) fit in the request body.
// Kept under Netlify Functions' ~6 MB request payload limit for production.
app.use(express.json({ limit: '6mb' }));
app.use(
  cookieSession({
    name: 'hek_sess',
    secret: SESSION_SECRET,
    maxAge: 12 * 60 * 60 * 1000, // 12h
    httpOnly: true,
    sameSite: 'lax',
  })
);

// Count every request for the dev dashboard. This runs on 'finish', i.e. after
// the response has been sent, so measuring never slows anybody down, and a
// failure to record is swallowed — statistics must not break the app.
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const path = req.path || '';
    // Static assets are noise on a usage chart: a page view already implies
    // its stylesheet and scripts.
    if (/.(css|js|png|jpe?g|svg|ico|webmanifest|map|woff2?)$/i.test(path)) return;
    const who =
      req.session && req.session.role === 'dev'
        ? 'dev'
        : req.session && req.session.admin
          ? 'admin'
          : req.session && req.session.employeeId
            ? 'employee'
            : 'public';
    metrics
      .record({
        path,
        status: res.statusCode,
        ms,
        ip: clientIp(req),
        agent: req.headers['user-agent'],
        timezone: TIMEZONE,
        isPage: !path.startsWith('/api/'),
        who,
      })
      .catch(() => {});
  });
  next();
});

// The "dev" account is a limited admin: it can use the dashboard's non-clock-in
// features (quotes, pricing, scheduling, employees) but not the timeclock data,
// nor the admin's own login settings. Enforced here in one place.
const DEV_BLOCKED = [
  '/api/admin/active',
  '/api/admin/timesheet',
  '/api/admin/export.csv',
  '/api/admin/credentials',
  '/api/cron/quickbooks-sync',
  '/api/cron/inbox-scan',
];
// Path prefixes the dev account may not touch. These are the client's own
// business: payroll reads pay rates and writes to their books, invoices are
// money owed them, and the inbox agent reads their email. The dev may switch
// any of these features on or off, but never operate them.
const DEV_BLOCKED_PREFIXES = [
  '/api/admin/punches',
  '/api/admin/quickbooks',
  '/api/quickbooks',
  '/api/admin/invoices',
  '/api/admin/inbox',
];
app.use((req, res, next) => {
  if (req.session && req.session.role === 'dev') {
    if (DEV_BLOCKED.includes(req.path) || DEV_BLOCKED_PREFIXES.some((p) => req.path.startsWith(p))) {
      return res.status(403).json({ error: 'Not available for the dev account.' });
    }
  }
  next();
});

// ---------------------------------------------------------------------------
// Feature entitlements — the dev account decides which paid features the client
// (the real admin) may use. Turning one off removes it for everyone in the org
// EXCEPT the dev, who controls it. Stored in settings doc _id:'entitlements'.
// ---------------------------------------------------------------------------

// The single source of truth for client-toggleable features. Add a feature
// here (plus a FEATURE_MATCH entry for its endpoints, and a sidebar tab whose
// data-tab equals the key) and it automatically shows up in the dev's "Client
// access" panel and hides its tab for the client when switched off.
const ADMIN_FEATURES = [
  { key: 'quotes', label: 'Quotes / estimates' },
  { key: 'schedule', label: 'Scheduling' },
  { key: 'pricing', label: 'Pricing calculator' },
  { key: 'map', label: 'Clock-in map' },
  { key: 'tasks', label: 'My Tasks' },
  { key: 'messages', label: 'Message board' },
  // adminOnly: the client can switch it on or off, but it is never something to
  // hand an employee — it reads everyone's pay rate and writes to the books.
  { key: 'quickbooks', label: 'QuickBooks payroll sync', adminOnly: true },
  // Billing and the mailbox are office functions: one is money owed, the other
  // reads the company's email. Neither is something to grant a field employee.
  { key: 'invoices', label: 'Invoices', adminOnly: true },
  { key: 'inbox', label: 'AI inbox — drafts quotes from email', adminOnly: true },
  // The public estimate page and the requests it files. adminOnly: it decides
  // what the outside world is shown and quoted, which is the office's call.
  { key: 'estimate', label: 'Public estimate page', adminOnly: true },
];
// Which request paths belong to each feature (used to block them when disabled).
const FEATURE_MATCH = {
  quotes: (p) => p.startsWith('/api/admin/quotes'),
  schedule: (p) =>
    p.startsWith('/api/admin/schedules') ||
    p === '/api/admin/geocode' ||
    p.startsWith('/api/my/schedules'),
  pricing: () => false, // client-only calculator; no endpoints to guard
  map: (p) =>
    p.startsWith('/api/admin/locations') ||
    p.startsWith('/api/my/locations') ||
    p.startsWith('/api/admin/map') ||
    p === '/api/admin/shop',
  tasks: (p) => p.startsWith('/api/admin/tasks') || p.startsWith('/api/my/tasks'),
  messages: (p) => p.startsWith('/api/admin/bulletins') || p.startsWith('/api/my/bulletins'),
  quickbooks: (p) =>
    p.startsWith('/api/admin/quickbooks') ||
    p.startsWith('/api/quickbooks') ||
    p === '/api/cron/quickbooks-sync',
  invoices: (p) => p.startsWith('/api/admin/invoices'),
  inbox: (p) => p.startsWith('/api/admin/inbox') || p === '/api/cron/inbox-scan',
  // Both sides of the estimate page: the admin's queue and the public endpoints
  // the page itself calls, so switching the feature off closes it to the world.
  estimate: (p) => p.startsWith('/api/admin/estimate') || p.startsWith('/api/estimate'),
};

let _entitlements = null; // cached; reloaded on write and on cold start
function normalizeEntitlements(f) {
  f = f || {};
  const out = {};
  for (const feat of ADMIN_FEATURES) out[feat.key] = f[feat.key] !== false; // default ON
  return out;
}
async function getEntitlements() {
  if (_entitlements) return _entitlements;
  const doc = await store.settings.findOne({ _id: 'entitlements' });
  _entitlements = normalizeEntitlements(doc && doc.features);
  return _entitlements;
}
async function setEntitlements(patch) {
  const next = { ...(await getEntitlements()) };
  for (const feat of ADMIN_FEATURES) if (patch[feat.key] != null) next[feat.key] = !!patch[feat.key];
  await store.settings.updateOne({ _id: 'entitlements' }, { $set: { features: next } }, { upsert: true });
  _entitlements = next;
  return next;
}

// Block a disabled feature's endpoints for everyone except the dev.
app.use(async (req, res, next) => {
  try {
    if (req.session && req.session.role === 'dev') return next();
    if (!req.path.startsWith('/api/')) return next();
    let feat = null;
    for (const f of ADMIN_FEATURES) {
      if (FEATURE_MATCH[f.key] && FEATURE_MATCH[f.key](req.path)) {
        feat = f.key;
        break;
      }
    }
    if (feat) {
      const ent = await getEntitlements();
      if (!ent[feat])
        return res.status(403).json({ error: 'This feature is turned off. Contact your provider.' });
    }
  } catch (e) {
    /* fail open — a lookup error shouldn't take the whole app down */
  }
  next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const iso = (v) => (v == null ? null : new Date(v).toISOString());

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'Not authorized' });
}

// Only the dev account may manage which features the client can use.
function requireDev(req, res, next) {
  if (req.session && req.session.admin && req.session.role === 'dev') return next();
  if (req.session && req.session.admin) return res.status(403).json({ error: 'Not authorized' });
  return res.status(401).json({ error: 'Not authorized' });
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// The features an admin can grant an employee, derived from ADMIN_FEATURES so
// every feature the admin has is grantable and a newly added feature shows up
// in the picker automatically. Hours, messages, their own schedule and time-off
// are baseline — every employee gets those, so they are not permissions.
//
// "admin" is special: an employee with it signs straight into the full admin
// dashboard instead of the employee portal (see the login handlers).
const PERMISSION_NOTES = {
  admin: 'Full dashboard access — everything below, plus employees, timesheets and payroll export.',
  quotes: 'Build and send customer quotes from the portal.',
  schedule: 'Baseline: everyone already sees their own jobs. Grants nothing extra in the portal yet.',
  pricing: 'Use the rate-book calculator to price a job.',
  map: 'See their own clock-in locations on a map.',
  tasks: 'See the tasks assigned to them, move them along and comment.',
  messages: 'Baseline: everyone already reads the message board. Grants nothing extra in the portal yet.',
};
const GRANTABLE_PERMISSIONS = [
  { key: 'admin', label: 'Admin (full dashboard access)', note: PERMISSION_NOTES.admin },
  ...ADMIN_FEATURES.filter((f) => !f.adminOnly).map((f) => ({
    key: f.key,
    label: f.label,
    note: PERMISSION_NOTES[f.key] || '',
  })),
];
const ALL_PERMISSIONS = GRANTABLE_PERMISSIONS.map((p) => p.key);
// Permission keys that are backed by a switchable feature. ("admin" is not — it
// is always available to the client.)
const FEATURE_KEYS = new Set(ADMIN_FEATURES.map((f) => f.key));
function cleanPermissions(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((p) => ALL_PERMISSIONS.includes(p)))];
}

// Password hashing with Node's built-in scrypt (no extra dependency needed).
// Stored as a hex salt + hex hash on the employee document.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { password_salt: salt, password_hash: hash };
}
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(test, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Admin credentials — stored in MongoDB (settings doc _id:'admin'), hashed with
// the same scrypt used for employees. Seeded once from the ADMIN_EMAIL /
// ADMIN_PASSWORD env vars so existing deployments keep working; after that the
// admin can change them from the dashboard and the env vars are no longer used.
// ---------------------------------------------------------------------------

// Load the admin credential doc, creating it from the env vars on first run.
async function getAdminRecord() {
  let doc = await store.settings.findOne({ _id: 'admin' });
  if (!doc) {
    // Upsert with $setOnInsert so two concurrent first-boots can't double-insert.
    await store.settings.updateOne(
      { _id: 'admin' },
      { $setOnInsert: { email: ADMIN_EMAIL, ...hashPassword(ADMIN_PASSWORD), created_at: new Date() } },
      { upsert: true }
    );
    doc = await store.settings.findOne({ _id: 'admin' });
  }
  return doc;
}

// True when email + password match the stored admin credentials.
async function checkAdmin(email, password) {
  const admin = await getAdminRecord();
  const emailOk = (email || '').trim().toLowerCase() === (admin.email || '').toLowerCase();
  return emailOk && verifyPassword(password, admin.password_salt, admin.password_hash);
}

// The "dev" account lives in the same settings collection (doc _id:'dev'),
// seeded from DEV_EMAIL / DEV_PASSWORD on first run.
async function getDevRecord() {
  let doc = await store.settings.findOne({ _id: 'dev' });
  if (!doc) {
    await store.settings.updateOne(
      { _id: 'dev' },
      { $setOnInsert: { email: DEV_EMAIL, ...hashPassword(DEV_PASSWORD), created_at: new Date() } },
      { upsert: true }
    );
    doc = await store.settings.findOne({ _id: 'dev' });
  }
  return doc;
}
async function checkDev(email, password) {
  const dev = await getDevRecord();
  const emailOk = (email || '').trim().toLowerCase() === (dev.email || '').toLowerCase();
  return emailOk && verifyPassword(password, dev.password_salt, dev.password_hash);
}

// Salaried staff are paid the same however long the day runs, so they have no
// clock. Anyone whose pay type is not set still clocks in — a blank field means
// "not decided yet", and nobody should silently lose the clock by omission.
function clockAllowed(emp) {
  return (emp.pay_type || '') !== 'Salary';
}

// Shape an employee document for the current session (never leaks the hash).
// can_clock is a plain yes/no — the pay rate itself stays admin-only.
//
// Permissions are filtered through the org's entitlements: a feature the dev
// has not granted this client is invisible to the employee, even if the admin
// granted it while the feature was still on. The grant stays on their record,
// so switching the feature back on restores it.
function selfView(emp, ent) {
  const granted = emp.permissions || [];
  return {
    id: emp._id,
    name: emp.name,
    email: emp.email || null,
    permissions: ent
      ? granted.filter((p) => !FEATURE_KEYS.has(p) || ent[p] !== false)
      : granted,
    can_clock: clockAllowed(emp),
  };
}

// Require a signed-in employee; attaches the fresh employee doc as req.employee.
function requireEmployee(req, res, next) {
  if (!req.session || !req.session.employeeId)
    return res.status(401).json({ error: 'Please sign in.' });
  store.employees
    .findOne({ _id: req.session.employeeId, active: true })
    .then((emp) => {
      if (!emp) {
        req.session = null;
        return res.status(401).json({ error: 'Please sign in.' });
      }
      req.employee = emp;
      next();
    })
    .catch((err) => {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    });
}

// Allow admins, or employees who have been granted a specific permission.
function requirePermission(perm) {
  return (req, res, next) => {
    if (req.session && req.session.admin) return next();
    if (!req.session || !req.session.employeeId)
      return res.status(401).json({ error: 'Please sign in.' });
    store.employees
      .findOne({ _id: req.session.employeeId, active: true })
      .then((emp) => {
        if (!emp || !(emp.permissions || []).includes(perm)) {
          req.session = emp ? req.session : null;
          return res.status(403).json({ error: 'Not permitted.' });
        }
        req.employee = emp;
        next();
      })
      .catch((err) => {
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
      });
  };
}
const requireQuotes = requirePermission('quotes');

// Employee-scoped feature access for the /api/my routes. Unlike
// requirePermission, this always loads the employee record — every "my" route
// needs to know whose data to return, so a bare admin session (which has no
// employee record behind it) gets a clean 401 rather than crashing on a missing
// req.employee. The "admin" permission satisfies any feature check.
function requireMyFeature(perm) {
  return (req, res, next) =>
    requireEmployee(req, res, () => {
      const held = req.employee.permissions || [];
      if (!held.includes(perm) && !held.includes('admin'))
        return res.status(403).json({ error: 'Not permitted.' });
      next();
    });
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    // Keep it for the dev dashboard as well as the log — a log line on a
    // serverless host is gone the moment you look away.
    metrics
      .recordError({
        path: req.path,
        method: req.method,
        status: 500,
        message: err && err.message,
        stack: err && err.stack,
        who: req.session && req.session.admin ? 'admin' : req.session && req.session.employeeId ? 'employee' : 'anonymous',
        timezone: TIMEZONE,
      })
      .catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: 'Server error.' });
  });

// ---------------------------------------------------------------------------
// The shop — where jobs are measured from.
//
// OpenStreetMap has no entry for the street number, only the road, so the
// default below is Otterville Rd in N0J 1R0 rather than the building itself.
// The admin can drag the pin onto the exact spot; that is stored and used from
// then on. Distances are straight-line, not driving distance (see distanceKm).
// ---------------------------------------------------------------------------

const SHOP_DEFAULT = {
  address: '225439 Otterville Rd, Otterville, ON N0J 1R0',
  lat: 42.9340705,
  lng: -80.5536229,
  exact: false, // true once someone has placed the pin themselves
};

async function getShop() {
  const doc = await store.settings.findOne({ _id: 'shop' });
  if (!doc) return { ...SHOP_DEFAULT };
  return {
    address: doc.address || SHOP_DEFAULT.address,
    lat: Number.isFinite(doc.lat) ? doc.lat : SHOP_DEFAULT.lat,
    lng: Number.isFinite(doc.lng) ? doc.lng : SHOP_DEFAULT.lng,
    exact: !!doc.exact,
  };
}

async function saveShop(body) {
  const set = {};
  if (body.address != null) set.address = String(body.address).trim().slice(0, 200);
  if (body.lat != null || body.lng != null) {
    const { lat, lng } = cleanLatLng(body.lat, body.lng);
    if (lat == null || lng == null) {
      const err = new Error('That is not a valid position on the map.');
      err.status = 400;
      throw err;
    }
    set.lat = lat;
    set.lng = lng;
    // Placing the pin by hand is what makes it exact, so distances can say so.
    set.exact = true;
  }
  if (Object.keys(set).length) {
    set.updated_at = new Date();
    await store.settings.updateOne({ _id: 'shop' }, { $set: set }, { upsert: true });
  }
  return getShop();
}

// Straight-line distance in kilometres (haversine). This is "as the crow
// flies", not driving distance — the road route is always longer, and working
// that out would mean calling a routing service on every job. Labelled as such
// wherever it is shown so nobody mistakes it for a trip odometer.
function distanceKm(aLat, aLng, bLat, bLng) {
  if (![aLat, aLng, bLat, bLng].every((n) => Number.isFinite(n))) return null;
  const R = 6371; // mean earth radius, km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10;
}

async function getOpenPunch(employeeId) {
  return store.punches.findOne(
    { employee_id: employeeId, clock_out: null },
    { sort: { clock_in: -1 } }
  );
}

// ---- Shop/load time, lunch and manual kilometres -------------------------
// Three things the crew enters by hand at clock-out:
//   shop_hours  time spent loading up at the shop, ADDED to the shift
//   lunch_hours the unpaid break, SUBTRACTED from it
//   km_manual   kilometres driven, typed in rather than worked out from GPS —
//               the computed figure was never reliable (location turned off,
//               an address the geocoder didn't know), so the odometer wins.
// The first two are picked from quarter-hour steps; anything else is rounded
// onto the nearest quarter so the stored value always matches an option.
const MAX_SHOP_HOURS = 8;
const MAX_LUNCH_HOURS = 4;

function quarterHours(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.round(n * 4) / 4);
}

// Typed-in kilometres. null means "not entered" — distinct from a real 0.
function manualKm(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(100000, Math.round(n * 10) / 10);
}

// Paid hours for a punch: the clock-in→clock-out span, plus shop/load time,
// minus lunch. Never negative, and null while the punch is still open.
function paidHours(row) {
  if (!row.clock_out) return null;
  const raw = (new Date(row.clock_out) - new Date(row.clock_in)) / 3600000;
  const net = raw + (Number(row.shop_hours) || 0) - (Number(row.lunch_hours) || 0);
  return Math.max(0, net);
}

// ---- Jobs worked (scheduled jobs tagged onto a punch) ---------------------
// At clock-out the employee ticks off which of their scheduled jobs they were
// on that day. `day` is a local YYYY-MM-DD, which is exactly how schedule dates
// are stored, so they compare directly.
//
// Undated jobs are included too: a job with no date is ongoing work rather than
// work fixed to one day, so it stays on offer every day. ({ date: null } also
// matches docs where the field is missing.) scheduleSort puts them last.
async function jobsOnDay(employeeId, day) {
  const docs = await store.schedules
    .find({
      employee_ids: employeeId,
      ...(day
        ? {
            $or: [
              { date: day },
              // A multi-day job is on offer every day of its run, not just the
              // day it started — otherwise a crew on a three-day install could
              // only tag the job on day one.
              { date: { $lte: day }, end_date: { $gte: day } },
              { date: null },
            ],
          }
        : { date: null }),
    })
    .toArray();
  return docs.sort(scheduleSort);
}

// Resolve submitted job ids against what was actually on that employee's
// schedule that day, then snapshot the address/description onto the punch —
// the timesheet must still read correctly if the schedule is later edited or
// deleted. Unknown ids are dropped rather than rejected: a stale modal should
// not block someone from clocking out.
async function pickJobs(employeeId, day, rawIds) {
  if (!Array.isArray(rawIds) || !rawIds.length) return [];
  const ids = new Set(
    rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50)
  );
  if (!ids.size) return [];
  const jobs = await jobsOnDay(employeeId, day);
  return jobs
    .filter((d) => ids.has(d._id))
    .map((d) => {
      // The position is snapshotted alongside the address for the same reason:
      // the mileage on a past timesheet must not move because someone later
      // edited or deleted the job.
      const { lat, lng } = cleanLatLng(d.lat, d.lng);
      return {
        id: d._id,
        address: d.address,
        description: d.description || null,
        lat,
        lng,
      };
    });
}

// ---- Mileage -------------------------------------------------------------
// How far the crew travelled, worked out from the jobs tagged onto a punch and
// the shop's position. Reimbursement is normally paid on the return trip, so
// that is the default; an office that chains jobs without coming back can turn
// it off and get one-way figures instead.

async function getMileageSettings() {
  const doc = await store.settings.findOne({ _id: 'mileage' });
  return { round_trip: !doc || doc.round_trip !== false };
}

async function saveMileageSettings(body) {
  const set = {};
  if (body.round_trip != null) set.round_trip = !!body.round_trip;
  if (Object.keys(set).length) {
    set.updated_at = new Date();
    await store.settings.updateOne({ _id: 'mileage' }, { $set: set }, { upsert: true });
  }
  return getMileageSettings();
}

// Fill in each row's job distances and the row total. Punches recorded before
// positions were snapshotted fall back to looking the job up by id, so old
// timesheets still get mileage as long as the job still exists.
//
// A hand-entered figure always wins: `km_manual` is what the driver read off
// the odometer, and the straight-line calculation is only a fallback for
// entries recorded before manual entry existed.
async function attachMileage(rows) {
  const needsLookup = new Set();
  for (const r of rows)
    for (const j of r.jobs || [])
      if (j && j.id != null && (j.lat == null || j.lng == null)) needsLookup.add(Number(j.id));

  let byId = {};
  if (needsLookup.size) {
    const docs = await store.schedules.find({ _id: { $in: [...needsLookup] } }).toArray();
    byId = Object.fromEntries(docs.map((d) => [d._id, d]));
  }

  const shop = await getShop();
  const { round_trip: roundTrip } = await getMileageSettings();
  const legs = roundTrip ? 2 : 1;

  for (const r of rows) {
    let total = 0;
    let known = false;
    r.jobs = (r.jobs || []).map((j) => {
      let { lat, lng } = cleanLatLng(j.lat, j.lng);
      if (lat == null && byId[j.id]) ({ lat, lng } = cleanLatLng(byId[j.id].lat, byId[j.id].lng));
      const oneWay = lat == null ? null : distanceKm(shop.lat, shop.lng, lat, lng);
      if (oneWay != null) {
        total += oneWay * legs;
        known = true;
      }
      return { ...j, km: oneWay == null ? null : Math.round(oneWay * legs * 10) / 10 };
    });
    // null, not 0, when nothing could be worked out — "no distance known" and
    // "travelled nothing" are different answers.
    const computed = known ? Math.round(total * 10) / 10 : null;
    r.km = r.km_manual != null ? r.km_manual : computed;
    r.km_computed = computed;
  }
  return rows;
}

// One-line label for a snapshotted job, used in the CSV export and elsewhere
// a job list has to collapse to text.
function jobLabel(j) {
  return j.description ? `${j.address} (${j.description})` : j.address;
}

// Attach employee names to a set of punch docs (app-side join).
async function withNames(punches) {
  const ids = [...new Set(punches.map((p) => p.employee_id))];
  const emps = await store.employees.find({ _id: { $in: ids } }).toArray();
  const nameById = Object.fromEntries(emps.map((e) => [e._id, e.name]));
  return punches.map((p) => ({ ...p, name: nameById[p.employee_id] || '(deleted)' }));
}

// ---------------------------------------------------------------------------
// Rate limiting — after RL_LIMIT failed attempts from one IP within RL_WINDOW,
// further attempts are blocked until the window passes. Stored in MongoDB so it
// works across serverless invocations. Only *failed* attempts count, so a whole
// crew signing in from one office IP with correct passwords is never locked out.
// ---------------------------------------------------------------------------

const RL_LIMIT = 10;
const RL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function clientIp(req) {
  return (
    req.headers['x-nf-client-connection-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.ip ||
    'unknown'
  );
}

async function isBlocked(key) {
  const doc = await store.rateLimits.findOne({ _id: key });
  if (!doc || !doc.windowStart) return 0;
  const elapsed = Date.now() - new Date(doc.windowStart).getTime();
  if (elapsed > RL_WINDOW_MS) return 0;
  return doc.count >= RL_LIMIT ? RL_WINDOW_MS - elapsed : 0;
}

async function recordFail(key) {
  await store.rateLimits.updateOne(
    { _id: key },
    [
      {
        $set: {
          windowStart: {
            $cond: [
              {
                $gt: [
                  { $subtract: ['$$NOW', { $ifNull: ['$windowStart', new Date(0)] }] },
                  RL_WINDOW_MS,
                ],
              },
              '$$NOW',
              { $ifNull: ['$windowStart', '$$NOW'] },
            ],
          },
        },
      },
      {
        $set: {
          count: {
            $cond: [
              { $eq: ['$windowStart', '$$NOW'] },
              1,
              { $add: [{ $ifNull: ['$count', 0] }, 1] },
            ],
          },
        },
      },
    ],
    { upsert: true }
  );
}

const clearFails = (key) => store.rateLimits.deleteOne({ _id: key });

// Middleware factory: blocks a request if the IP is over the limit for `scope`.
const limiter = (scope) => async (req, res, next) => {
  const key = `${scope}:${clientIp(req)}`;
  req._rlKey = key;
  try {
    const waitMs = await isBlocked(key);
    if (waitMs > 0) {
      const mins = Math.ceil(waitMs / 60000);
      return res
        .status(429)
        .json({ error: `Too many attempts. Please wait ${mins} minute${mins > 1 ? 's' : ''}.` });
    }
  } catch (err) {
    console.error('rate-limit check failed (allowing request):', err.message);
  }
  next();
};

const adminLimiter = limiter('admin');
const loginLimiter = limiter('login');

// ---------------------------------------------------------------------------
// Employee / unified auth (used by the login page at "/")
// ---------------------------------------------------------------------------

// One login form for everyone. Admin credentials sign in as admin (and the
// client redirects to the dashboard); everyone else signs in as an employee.
app.post(
  '/api/login',
  loginLimiter,
  wrap(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';
    if (!email || !password)
      return res.status(400).json({ error: 'Enter your email and password.' });

    // Admin?
    if (await checkAdmin(email, password)) {
      await clearFails(req._rlKey);
      req.session.admin = true;
      req.session.role = 'admin';
      req.session.employeeId = null;
      return res.json({ role: 'admin', redirect: ADMIN_PATH });
    }

    // Dev — a limited admin (everything in the dashboard except clock-in).
    if (await checkDev(email, password)) {
      await clearFails(req._rlKey);
      req.session.admin = true;
      req.session.role = 'dev';
      req.session.employeeId = null;
      return res.json({ role: 'admin', redirect: ADMIN_PATH });
    }

    // Employee?
    const emp = await store.employees.findOne({ email });
    if (!emp || !emp.active || !verifyPassword(password, emp.password_salt, emp.password_hash)) {
      await recordFail(req._rlKey);
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    await clearFails(req._rlKey);
    // An employee granted the "admin" role signs into the full dashboard.
    if ((emp.permissions || []).includes('admin')) {
      req.session.admin = true;
      req.session.role = 'admin';
      req.session.employeeId = emp._id;
      return res.json({ role: 'admin', redirect: ADMIN_PATH });
    }
    req.session.admin = false;
    req.session.role = null;
    req.session.employeeId = emp._id;
    res.json({ role: 'employee', ...selfView(emp, await getEntitlements()) });
  })
);

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});


// Who am I? Used by the portal (and by the shared login page) to restore state.
app.get(
  '/api/me',
  wrap(async (req, res) => {
    if (req.session && req.session.admin) return res.json({ role: 'admin', redirect: ADMIN_PATH });
    if (req.session && req.session.employeeId) {
      const emp = await store.employees.findOne({ _id: req.session.employeeId, active: true });
      if (emp)
        return res.json({ role: 'employee', ...selfView(emp, await getEntitlements()) });
    }
    res.json({ role: null });
  })
);

// An employee's own timesheet — always available to a signed-in employee.
app.get(
  '/api/my/timesheet',
  requireEmployee,
  wrap(async (req, res) => {
    const rows = await timesheetRows({
      employeeId: req.employee._id,
      from: req.query.from,
      to: req.query.to,
    });
    let total = 0;
    let totalKm = 0;
    const entries = rows.map((r) => {
      const hours = hoursOf(r);
      if (hours) total += hours;
      if (r.km) totalKm += r.km;
      return { ...r, clock_in: iso(r.clock_in), clock_out: iso(r.clock_out), hours };
    });
    res.json({
      entries,
      totalHours: Math.round(total * 100) / 100,
      totalKm: Math.round(totalKm * 10) / 10,
    });
  })
);

// The jobs assigned to the signed-in employee — always available, no permission
// needed. Sorted soonest-first so the next job is at the top.
// ---------------------------------------------------------------------------
// Employee self-service clock — the portal "Clock In / Clock Out" button. This
// is the only way to punch in: every signed-in employee can use it, and no PIN
// is needed (they are already signed in).
// ---------------------------------------------------------------------------

app.get(
  '/api/my/clock-status',
  requireEmployee,
  wrap(async (req, res) => {
    const open = await getOpenPunch(req.employee._id);
    // A still-open punch that started on an earlier day = a missed clock-out.
    let missed = null;
    if (open && localDay(open.clock_in) < localDay(new Date()))
      missed = { punchId: open._id, clockIn: iso(open.clock_in), day: localDay(open.clock_in) };
    // The day the clock-out will be recorded against — the day the open punch
    // started, or today if they are about to clock in. The server owns this so
    // the browser's own timezone can't disagree about which day it is.
    const day = open ? localDay(open.clock_in) : localDay(new Date());
    res.json({
      canClock: clockAllowed(req.employee),
      clockedIn: !!open,
      since: open ? iso(open.clock_in) : null,
      missed,
      day,
      jobs: (await jobsOnDay(req.employee._id, day)).map(publicScheduleView),
    });
  })
);

app.post(
  '/api/my/clock-in',
  requireEmployee,
  wrap(async (req, res) => {
    // Only clocking IN is blocked for salaried staff. Clock-out and missed
    // clock-outs stay open to everyone, so a punch started before someone moved
    // onto salary can still be closed instead of hanging open forever.
    if (!clockAllowed(req.employee))
      return res.status(403).json({ error: 'Salaried employees do not clock in.' });
    const open = await getOpenPunch(req.employee._id);
    if (open) {
      if (localDay(open.clock_in) < localDay(new Date()))
        return res.status(409).json({ error: 'You have a missed clock-out to resolve first.' });
      return res.status(409).json({ error: 'You are already clocked in.' });
    }
    const now = new Date();
    const remarks = String(req.body?.remarks || '').trim().slice(0, 1000) || null;
    const { lat, lng } = cleanLatLng(req.body?.lat, req.body?.lng);
    await store.punches.insertOne({
      _id: await store.nextId('punches'),
      employee_id: req.employee._id,
      clock_in: now,
      clock_out: null,
      work_done: null,
      jobs: [],
      missed_reason: null,
      note: remarks,
      shop_hours: 0,
      lunch_hours: 0,
      km_manual: null,
      edited: false,
      clock_in_lat: lat,
      clock_in_lng: lng,
    });
    res.json({ clockedIn: true, since: iso(now) });
  })
);

app.post(
  '/api/my/clock-out',
  requireEmployee,
  wrap(async (req, res) => {
    const open = await getOpenPunch(req.employee._id);
    if (!open) return res.status(409).json({ error: 'You are not clocked in.' });
    if (localDay(open.clock_in) < localDay(new Date()))
      return res.status(409).json({ error: 'You have a missed clock-out to resolve first.' });
    // What they worked on is required — it is the only record of the day's work.
    const workDone = String(req.body?.remarks || '').trim().slice(0, 2000);
    if (!workDone)
      return res.status(400).json({ error: 'Please enter what you worked on today.' });
    const jobs = await pickJobs(req.employee._id, localDay(open.clock_in), req.body?.jobIds);
    const shopHours = quarterHours(req.body?.shopHours, MAX_SHOP_HOURS);
    const lunchHours = quarterHours(req.body?.lunchHours, MAX_LUNCH_HOURS);
    const km = manualKm(req.body?.km);
    // Anything they typed under "additional notes" joins whatever they said on
    // the way in, so neither remark is lost.
    const extra = String(req.body?.notes || '').trim().slice(0, 1000);
    const note = [open.note, extra].filter(Boolean).join('\n') || null;
    const now = new Date();

    // They may finish the punch at an earlier time than "now" — e.g. they left
    // the site at 4pm and only remembered to clock out at 6. It must still be
    // after they clocked in, not in the future, and on the same day, since an
    // earlier day would have to go through the missed-clock-out flow instead.
    let out = now;
    let backdated = false;
    if (req.body?.clockOut) {
      out = new Date(req.body.clockOut);
      if (isNaN(out)) return res.status(400).json({ error: 'Invalid finish time.' });
      if (out.getTime() > now.getTime() + 60000)
        return res.status(400).json({ error: "Finish time can't be in the future." });
      if (out < new Date(open.clock_in))
        return res.status(400).json({ error: 'Finish time must be after your clock-in.' });
      if (localDay(out) !== localDay(open.clock_in))
        return res.status(400).json({ error: 'Finish time must be on the same day you clocked in.' });
      // Within a minute of now is just the default value coming back — not a
      // deliberate correction, so don't flag the punch for it.
      backdated = now.getTime() - out.getTime() > 60000;
    }

    // A lunch longer than the shift itself would pay them for negative time.
    if (
      lunchHours > 0 &&
      paidHours({ clock_in: open.clock_in, clock_out: out, shop_hours: shopHours, lunch_hours: lunchHours }) <= 0
    )
      return res.status(400).json({ error: "Your lunch break is longer than the time you were on the clock." });

    await store.punches.updateOne(
      { _id: open._id },
      {
        $set: {
          clock_out: out,
          work_done: workDone,
          jobs,
          shop_hours: shopHours,
          lunch_hours: lunchHours,
          km_manual: km,
          note,
          ...(backdated ? { edited: true } : {}),
        },
      }
    );
    res.json({ clockedIn: false, since: iso(open.clock_in), until: iso(out) });
  })
);

// Resolve a missed clock-out from a previous day: the employee supplies the time
// they actually finished, what they did, and why they forgot to clock out.
app.post(
  '/api/my/resolve-missed',
  requireEmployee,
  wrap(async (req, res) => {
    const { punchId, clockOut, workDone, reason } = req.body || {};
    const p = await store.punches.findOne({
      _id: Number(punchId),
      employee_id: req.employee._id,
      clock_out: null,
    });
    if (!p) return res.status(404).json({ error: 'Nothing to resolve.' });

    const work = String(workDone || '').trim().slice(0, 2000);
    const why = String(reason || '').trim().slice(0, 1000);
    if (!clockOut) return res.status(400).json({ error: 'Enter the time you finished.' });
    if (!work) return res.status(400).json({ error: 'Enter what you worked on that day.' });
    if (!why) return res.status(400).json({ error: 'Enter why you did not clock out.' });

    const co = new Date(clockOut);
    if (isNaN(co)) return res.status(400).json({ error: 'Invalid finish time.' });
    if (co.getTime() > Date.now() + 60000)
      return res.status(400).json({ error: "Finish time can't be in the future." });
    if (co < new Date(p.clock_in))
      return res.status(400).json({ error: 'Finish time must be after your clock-in.' });

    const jobs = await pickJobs(req.employee._id, localDay(p.clock_in), req.body?.jobIds);
    const shopHours = quarterHours(req.body?.shopHours, MAX_SHOP_HOURS);
    const lunchHours = quarterHours(req.body?.lunchHours, MAX_LUNCH_HOURS);
    const km = manualKm(req.body?.km);
    const extra = String(req.body?.notes || '').trim().slice(0, 1000);
    const note = [p.note, extra].filter(Boolean).join('\n') || null;
    if (
      lunchHours > 0 &&
      paidHours({ clock_in: p.clock_in, clock_out: co, shop_hours: shopHours, lunch_hours: lunchHours }) <= 0
    )
      return res.status(400).json({ error: "Your lunch break is longer than the time you were on the clock." });

    await store.punches.updateOne(
      { _id: p._id },
      {
        $set: {
          clock_out: co,
          work_done: work,
          jobs,
          missed_reason: why,
          shop_hours: shopHours,
          lunch_hours: lunchHours,
          km_manual: km,
          note,
          edited: true,
        },
      }
    );
    res.json({ ok: true });
  })
);

app.get(
  '/api/my/schedules',
  requireEmployee,
  wrap(async (req, res) => {
    const docs = await store.schedules.find({ employee_ids: req.employee._id }).toArray();
    res.json({ jobs: docs.map(publicScheduleView).sort(scheduleSort) });
  })
);

// One job the crew member is on — the job page they land on from their
// schedule. Same view as the list, so it carries the address, the driver
// notes and the job's files.
app.get(
  '/api/my/schedules/:id',
  requireEmployee,
  wrap(async (req, res) => {
    const doc = await store.schedules.findOne({
      _id: Number(req.params.id),
      employee_ids: req.employee._id,
    });
    if (!doc) return res.status(404).json({ error: 'Job not found.' });
    res.json(publicScheduleView(doc));
  })
);

// A file off one of their own jobs. The job has to be theirs, and the file has
// to be on that job — an id alone opens nothing.
app.get(
  '/api/my/schedules/:id/files/:fileId',
  requireEmployee,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const job = await store.schedules.findOne({ _id: id, employee_ids: req.employee._id });
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    const blob = await store.jobFiles.findOne({ _id: req.params.fileId, job_id: id });
    if (!blob) return res.status(404).json({ error: 'File not found.' });
    sendJobFile(res, blob);
  })
);

// ---------------------------------------------------------------------------
// Employee-side feature endpoints (unlocked by a granted permission)
// ---------------------------------------------------------------------------

// Their own clock-in pins, for the portal map. Deliberately scoped to the
// signed-in employee: the admin map shows the whole crew, but one employee has
// no business seeing where everyone else clocked in.
app.get(
  '/api/my/locations',
  requireMyFeature('map'),
  wrap(async (req, res) => {
    const q = { employee_id: req.employee._id, clock_in_lat: { $ne: null } };
    const { from, to } = req.query;
    if (from || to) {
      q.clock_in = {};
      if (from) q.clock_in.$gte = new Date(from + 'T00:00:00');
      if (to) q.clock_in.$lte = new Date(to + 'T23:59:59.999');
    }
    const rows = await store.punches.find(q, { sort: { clock_in: -1 } }).toArray();
    res.json(
      rows.map((p) => ({
        id: p._id,
        name: req.employee.name,
        clock_in: iso(p.clock_in),
        lat: p.clock_in_lat,
        lng: p.clock_in_lng,
      }))
    );
  })
);

// Tasks assigned to them. Read-only apart from moving a card between columns
// and commenting — creating, assigning, deleting and re-pricing stay with the
// admin, so a granted employee can work their queue but not reshape the board.
app.get(
  '/api/my/tasks',
  requireMyFeature('tasks'),
  wrap(async (req, res) => {
    const rows = await store.tasks
      .find({ assignee_id: req.employee._id }, { sort: { order: 1, _id: 1 } })
      .toArray();
    const nameById = { [req.employee._id]: req.employee.name };
    res.json({ tasks: rows.map((t) => taskView(t, nameById)) });
  })
);

app.patch(
  '/api/my/tasks/:id',
  requireMyFeature('tasks'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await store.tasks.findOne({ _id: id, assignee_id: req.employee._id });
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    const status = req.body?.status;
    if (!TASK_STATUSES.includes(status))
      return res.status(400).json({ error: 'Unknown status.' });
    if (status === t.status) return res.json({ ok: true });
    const history = (t.history || []).concat({
      id: (t.history || []).length + 1,
      text: `Moved to ${status.replace('_', ' ')} by ${req.employee.name}`,
      at: new Date(),
    });
    await store.tasks.updateOne(
      { _id: id },
      { $set: { status, completed: status === 'done', history, updated_at: new Date() } }
    );
    res.json({ ok: true });
  })
);

app.post(
  '/api/my/tasks/:id/comment',
  requireMyFeature('tasks'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await store.tasks.findOne({ _id: id, assignee_id: req.employee._id });
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Write a comment first.' });
    const comment = {
      id: (t.comments || []).length + 1,
      author: req.employee.name,
      text: text.slice(0, 2000),
      at: new Date(),
    };
    await store.tasks.updateOne(
      { _id: id },
      { $push: { comments: comment }, $set: { updated_at: new Date() } }
    );
    res.json({ comment: { ...comment, at: iso(comment.at) } });
  })
);

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------

app.post(
  '/api/admin/login',
  adminLimiter,
  wrap(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const { password } = req.body || {};
    if (await checkAdmin(email, password)) {
      await clearFails(req._rlKey);
      req.session.admin = true;
      req.session.role = 'admin';
      req.session.email = email;
      return res.json({ ok: true, email, role: 'admin' });
    }
    if (await checkDev(email, password)) {
      await clearFails(req._rlKey);
      req.session.admin = true;
      req.session.role = 'dev';
      req.session.email = email;
      return res.json({ ok: true, email, role: 'dev' });
    }
    // An employee granted the "admin" role may also sign in on the admin form.
    const emp = await store.employees.findOne({ email });
    if (
      emp &&
      emp.active &&
      verifyPassword(password, emp.password_salt, emp.password_hash) &&
      (emp.permissions || []).includes('admin')
    ) {
      await clearFails(req._rlKey);
      req.session.admin = true;
      req.session.role = 'admin';
      req.session.employeeId = emp._id;
      req.session.email = email;
      return res.json({ ok: true, email, role: 'admin' });
    }
    await recordFail(req._rlKey);
    res.status(401).json({ error: 'Wrong email or password.' });
  })
);

app.post('/api/admin/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get(
  '/api/admin/me',
  wrap(async (req, res) => {
    const admin = !!(req.session && req.session.admin);
    const role = admin ? (req.session.role === 'dev' ? 'dev' : 'admin') : null;
    let email = null;
    let features = null;
    if (admin) {
      try {
        if (req.session.employeeId) {
          // An employee granted the "admin" role — show their own identity.
          const emp = await store.employees.findOne({ _id: req.session.employeeId });
          email = emp ? emp.email || emp.name : null;
        } else {
          email = (role === 'dev' ? await getDevRecord() : await getAdminRecord()).email;
        }
      } catch (e) {
        /* fall back to no email if the settings doc can't be read */
      }
      try {
        features = await getEntitlements();
      } catch (e) {
        /* fall back to no feature info */
      }
    }
    res.json({ admin, role, email, features });
  })
);

// ---------------------------------------------------------------------------
// Dev: manage which features the client (real admin) can use.
// ---------------------------------------------------------------------------

const featureList = (ent) =>
  ADMIN_FEATURES.map((f) => ({ key: f.key, label: f.label, enabled: ent[f.key] }));

app.get(
  '/api/dev/features',
  requireDev,
  wrap(async (req, res) => {
    res.json({ features: featureList(await getEntitlements()) });
  })
);

app.patch(
  '/api/dev/features',
  requireDev,
  wrap(async (req, res) => {
    const next = await setEntitlements(req.body || {});
    res.json({ features: featureList(next) });
  })
);

// ---------------------------------------------------------------------------
// Dev: app health. Usage, errors and what the app actually holds.
//
// Dev-only on purpose: it reports on the client's install rather than being
// part of it, and the error list carries stack traces.
// ---------------------------------------------------------------------------

app.get(
  '/api/dev/stats',
  requireDev,
  wrap(async (req, res) => {
    res.json(await metrics.report({ days: Number(req.query.days) || 30, timezone: TIMEZONE }));
  })
);

// Clear the error list once they have been dealt with, so "0 errors" can mean
// something. The daily counts stay — the history is the point of them.
app.delete(
  '/api/dev/stats/errors',
  requireDev,
  wrap(async (req, res) => {
    const r = await store.appErrors.deleteMany({});
    res.json({ ok: true, cleared: r.deletedCount });
  })
);

// Change the login of whoever is signed in — only ever their own account, never
// anyone else's. An employee granted the "admin" role edits their own employee
// record; the built-in admin and dev accounts edit their own settings doc.
app.patch(
  '/api/admin/credentials',
  requireAdmin,
  wrap(async (req, res) => {
    let email = null;
    if (req.body?.email != null) {
      email = String(req.body.email).trim().toLowerCase();
      if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    }
    let password = null;
    if (req.body?.password) {
      password = String(req.body.password);
      if (password.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (!email && !password)
      return res.status(400).json({ error: 'Enter a new email or password.' });

    const set = { updated_at: new Date() };
    if (password) Object.assign(set, hashPassword(password));

    // An employee who signs into the dashboard via the "admin" role: this is
    // their employee record, so changing it here must not touch the built-in
    // admin account (which is how the whole company gets in).
    if (req.session.employeeId) {
      const id = req.session.employeeId;
      if (email) {
        if (await store.employees.findOne({ email, _id: { $ne: id } }))
          return res.status(409).json({ error: 'That email is already in use.' });
        // Taking the built-in admin's address would shadow that login.
        const taken = await Promise.all([getAdminRecord(), getDevRecord()]);
        if (taken.some((d) => d && (d.email || '').toLowerCase() === email))
          return res.status(409).json({ error: 'That email is already in use.' });
        set.email = email;
      }
      await store.employees.updateOne({ _id: id }, { $set: set });
      const emp = await store.employees.findOne({ _id: id });
      return res.json({ ok: true, email: emp.email || emp.name });
    }

    // The built-in admin account, stored in the settings collection. (The dev
    // account never gets here — DEV_BLOCKED refuses this path outright.)
    await getAdminRecord(); // ensure the doc exists before updating
    if (email) {
      if (await store.employees.findOne({ email }))
        return res.status(409).json({ error: 'That email is already in use.' });
      set.email = email;
    }
    await store.settings.updateOne({ _id: 'admin' }, { $set: set });
    const updated = await getAdminRecord();
    if (set.email) req.session.email = updated.email;
    res.json({ ok: true, email: updated.email });
  })
);

// ---------------------------------------------------------------------------
// Admin: employees
// ---------------------------------------------------------------------------

// Extra profile fields on an employee record (shown in the rich editor). Stored
// as trimmed strings; the UI decides how to present them.
const PROFILE_FIELDS = [
  'first_name', 'last_name', 'initials', 'phone',
  'address1', 'address2', 'city', 'province', 'postal', 'country',
  'birth_date', 'employment_type', 'vacation_weeks', 'job_title',
  'start_date', 'termination_date', 'pay_type', 'pay_rate',
];
function pickProfile(body) {
  const out = {};
  for (const f of PROFILE_FIELDS) if (body && body[f] != null) out[f] = String(body[f]).trim();
  return out;
}

// How an employee is paid. pay_rate means dollars per hour when pay_type is
// "Hourly" and dollars per year when it is "Salary"; both are admin-only (they
// are never part of selfView, so they never reach the employee portal).
const PAY_TYPES = ['', 'Hourly', 'Salary'];
// Validate + tidy the pay fields on a $set object, in place. Returns an error
// message for the client, or null when everything is fine.
function checkPay(set) {
  if (set.pay_type != null && !PAY_TYPES.includes(set.pay_type))
    return 'Pay type must be Hourly or Salary.';
  if (set.pay_rate != null) {
    const raw = set.pay_rate.replace(/[$,\s]/g, '');
    if (!raw) {
      set.pay_rate = '';
      return null;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0)
      return 'Enter the pay as a number, e.g. 28.50.';
    set.pay_rate = String(Math.round(n * 100) / 100);
  }
  return null;
}
// Shape an employee for the admin UI (never leaks the password hash).
function employeeView(e) {
  const v = {
    id: e._id,
    name: e.name,
    email: e.email || null,
    permissions: e.permissions || [],
    hasPassword: !!e.password_hash,
    active: e.active,
    created_at: e.created_at,
  };
  for (const f of PROFILE_FIELDS) v[f] = e[f] || '';
  v.reports_to = e.reports_to || null; // the id of the employee they report to
  // Which QuickBooks employee this person is, for the payroll sync. Set from
  // the QuickBooks tab, not the profile editor, so it can be picked from the
  // real list instead of typed from memory.
  v.qbo_employee_id = e.qbo_employee_id || '';
  return v;
}

app.get(
  '/api/admin/employees',
  requireAdmin,
  wrap(async (req, res) => {
    const rows = await store.employees.find({}, { sort: { name: 1 } }).toArray();
    res.json(rows.map(employeeView));
  })
);

// Also tell the admin UI which permission keys exist, so it can render the
// right checkboxes without hard-coding the list in two places. A feature the
// dev has not granted this client is switched off completely: it is not offered
// here, its tab is hidden, its endpoints are refused, and it disappears from the
// employee portal (see selfView). Anything already granted stays on the employee
// record, so turning the feature back on restores it untouched.
app.get(
  '/api/admin/permissions',
  requireAdmin,
  wrap(async (req, res) => {
    const ent = await getEntitlements();
    const permissions = GRANTABLE_PERMISSIONS.filter(
      (p) => !FEATURE_KEYS.has(p.key) || ent[p.key] !== false
    );
    res.json({ permissions });
  })
);

app.post(
  '/api/admin/employees',
  requireAdmin,
  wrap(async (req, res) => {
    const first = (req.body?.first_name || '').trim();
    const last = (req.body?.last_name || '').trim();
    let name = (req.body?.name || '').trim();
    if (!name) name = [first, last].filter(Boolean).join(' ').trim();
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';
    const permissions = cleanPermissions(req.body?.permissions);
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (email && !validEmail(email))
      return res.status(400).json({ error: 'Enter a valid email address.' });

    if (email && (await store.employees.findOne({ email })))
      return res.status(409).json({ error: 'That email is already in use.' });

    const profile = pickProfile(req.body);
    const payError = checkPay(profile);
    if (payError) return res.status(400).json({ error: payError });

    const _id = await store.nextId('employees');
    // reports_to: the id of another employee (their manager).
    let reportsTo = null;
    if (req.body?.reports_to) {
      reportsTo = Number(req.body.reports_to);
      if (!Number.isInteger(reportsTo) || reportsTo === _id || !(await store.employees.findOne({ _id: reportsTo })))
        return res.status(400).json({ error: 'Invalid "reports to" selection.' });
    }
    const doc = {
      _id,
      name,
      email: email || null,
      permissions,
      active: true,
      created_at: new Date(),
      reports_to: reportsTo,
      ...profile,
    };
    if (email && password) Object.assign(doc, hashPassword(password));
    await store.employees.insertOne(doc);
    res.json(employeeView(doc));
  })
);

app.patch(
  '/api/admin/employees/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const emp = await store.employees.findOne({ _id: id });
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });

    let name = req.body?.name != null ? String(req.body.name).trim() : emp.name;
    // If first/last name were edited, recompute the display name from them.
    if (req.body?.first_name != null || req.body?.last_name != null) {
      const first = req.body?.first_name != null ? String(req.body.first_name).trim() : emp.first_name || '';
      const last = req.body?.last_name != null ? String(req.body.last_name).trim() : emp.last_name || '';
      const combined = [first, last].filter(Boolean).join(' ').trim();
      if (!req.body?.name && combined) name = combined;
    }
    const active =
      req.body?.active != null ? !!req.body.active && req.body.active !== 0 : emp.active;

    if (!name) return res.status(400).json({ error: 'Name is required.' });

    const set = { name, active, ...pickProfile(req.body) };
    const payError = checkPay(set);
    if (payError) return res.status(400).json({ error: payError });

    // Email: allow setting/changing, or clearing with an empty string.
    if (req.body?.email != null) {
      const email = String(req.body.email).trim().toLowerCase();
      if (email && !validEmail(email))
        return res.status(400).json({ error: 'Enter a valid email address.' });
      if (email && (await store.employees.findOne({ email, _id: { $ne: id } })))
        return res.status(409).json({ error: 'That email is already in use.' });
      set.email = email || null;
    }

    // Permissions: replace the whole list when provided.
    if (req.body?.permissions != null) set.permissions = cleanPermissions(req.body.permissions);

    // Reports to: another employee (their manager). "" clears it; can't be self.
    if (req.body?.reports_to != null) {
      if (req.body.reports_to === '' || req.body.reports_to === 0) {
        set.reports_to = null;
      } else {
        const rt = Number(req.body.reports_to);
        if (!Number.isInteger(rt) || rt === id)
          return res.status(400).json({ error: "An employee can't report to themselves." });
        if (!(await store.employees.findOne({ _id: rt })))
          return res.status(400).json({ error: 'Unknown manager.' });
        set.reports_to = rt;
      }
    }

    // Password: only when a non-empty new value is supplied.
    if (req.body?.password) Object.assign(set, hashPassword(req.body.password));

    await store.employees.updateOne({ _id: id }, { $set: set });
    const updated = await store.employees.findOne({ _id: id });
    res.json(employeeView(updated));
  })
);

app.delete(
  '/api/admin/employees/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await store.employees.deleteOne({ _id: id });
    await store.punches.deleteMany({ employee_id: id }); // cascade their time entries
    await store.schedules.updateMany({}, { $pull: { employee_ids: id } }); // unassign jobs
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Scheduling (jobs) — an address + description assigned to one or more
// employees. Employees see their own jobs in the portal and tap to navigate.
// ---------------------------------------------------------------------------

const cleanDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
const cleanTime = (s) => (/^\d{2}:\d{2}$/.test(s || '') ? s : null);

// ---- Multi-day jobs ------------------------------------------------------
// A job runs from `date` to `end_date` inclusive. `end_date` is null for the
// ordinary one-day job, which is every job booked before this existed — so the
// absent field and "finishes the day it starts" mean the same thing, and the
// single-day path needs no migration.
//
// Normalised on the way in so the stored pair is always sane: no start means no
// range at all, and an end that isn't genuinely later than the start collapses
// back to a single day.
function cleanRange(date, endDate) {
  const start = cleanDate(date);
  const end = cleanDate(endDate);
  if (!start || !end || end <= start) return { date: start, end_date: null };
  return { date: start, end_date: end };
}

// Whole days a job covers. Used to keep a run the same length when it is
// dragged to a different start day.
const DAY_MS = 86400000;
function daySpan(date, endDate) {
  if (!date || !endDate) return 0;
  return Math.round((new Date(endDate + 'T00:00') - new Date(date + 'T00:00')) / DAY_MS);
}
function addDaysStr(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

// Moving a job to a new start day takes its whole run along: a three-day job
// dropped on Thursday finishes on Saturday, it doesn't shrink to Thursday.
function shiftedEnd(doc, newDate) {
  const span = daySpan(doc.date, doc.end_date);
  if (!span || !newDate) return null;
  return addDaysStr(newDate, span);
}

// What kind of visit this is. Anything unrecognised falls back to a delivery,
// which is the common case.
const JOB_TYPES = ['Delivery', 'Install', 'Service', 'Pickup'];
const cleanJobType = (s) => (JOB_TYPES.includes(s) ? s : 'Delivery');
const cleanNote = (s, max = 2000) => String(s == null ? '' : s).trim().slice(0, max) || null;

// Keep a lat/lng pair only if it's a real, in-range coordinate; else drop both.
function cleanLatLng(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (
    Number.isFinite(a) && Number.isFinite(b) &&
    a >= -90 && a <= 90 && b >= -180 && b <= 180 && !(a === 0 && b === 0)
  )
    return { lat: a, lng: b };
  return { lat: null, lng: null };
}

// Narrow a list of ids down to employees that actually exist.
async function cleanEmployeeIds(list) {
  const ids = Array.isArray(list)
    ? [...new Set(list.map(Number).filter((n) => Number.isInteger(n)))]
    : [];
  if (!ids.length) return [];
  const found = await store.employees.find({ _id: { $in: ids } }).toArray();
  return found.map((e) => e._id);
}

// Fields safe to send to an employee (no internal assignment list).
function publicScheduleView(d) {
  return {
    id: d._id,
    address: d.address,
    description: d.description || null,
    date: d.date || null,
    // Last day of a multi-day job; null when it starts and finishes the same day.
    end_date: d.end_date || null,
    time: d.time || null,
    due_date: d.due_date || null,
    job_type: d.job_type || 'Delivery',
    // The crew's own notes travel with the job. Internal notes deliberately do
    // not — that is the whole point of having two boxes.
    notes_driver: d.notes_driver || null,
    confirmed: !!d.confirmed,
    lat: d.lat ?? null,
    lng: d.lng ?? null,
    // The job's own filing cabinet. Metadata only — the blobs are fetched one
    // at a time from the file route.
    folders: [...(d.folders || [])].sort(),
    files: (d.files || []).map((f) => ({ ...f, at: iso(f.at) })),
  };
}

// Soonest-first: undated jobs sort to the bottom (both date and time are
// zero-padded strings, so plain string comparison orders them correctly).
function scheduleSort(a, b) {
  const ad = a.date || '9999-99-99';
  const bd = b.date || '9999-99-99';
  if (ad !== bd) return ad < bd ? -1 : 1;
  const at = a.time || '99:99';
  const bt = b.time || '99:99';
  return at < bt ? -1 : at > bt ? 1 : 0;
}

// Address autocomplete, proxied to OpenStreetMap's free Nominatim geocoder so we
// can set a proper User-Agent (their usage policy) and keep it server-side.
app.get(
  '/api/admin/geocode',
  requireAdmin,
  wrap(async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 3) return res.json({ results: [] });
    try {
      const url =
        'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' +
        encodeURIComponent(q);
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'HEK-Timeclock/1.0 (job scheduling address lookup)',
          'Accept-Language': 'en',
        },
      });
      if (!r.ok) return res.json({ results: [] });
      const data = await r.json();
      const results = (Array.isArray(data) ? data : [])
        .map((d) => ({ label: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }))
        .filter((x) => x.label && Number.isFinite(x.lat) && Number.isFinite(x.lng));
      res.json({ results });
    } catch (err) {
      console.error('geocode failed:', err.message);
      res.json({ results: [] });
    }
  })
);

app.get(
  '/api/admin/schedules',
  requireAdmin,
  wrap(async (req, res) => {
    const docs = await store.schedules.find({}).toArray();
    const emps = await store.employees.find({}).toArray();
    const nameById = Object.fromEntries(emps.map((e) => [e._id, e.name]));
    const jobs = docs
      .map((d) => ({
        ...publicScheduleView(d),
        // Admin-only, so the internal note is added back on top of the view the
        // employee portal gets.
        notes_internal: d.notes_internal || null,
        employee_ids: d.employee_ids || [],
        employees: (d.employee_ids || []).map((id) => nameById[id] || '(removed)'),
      }))
      .sort(scheduleSort);
    res.json({ jobs });
  })
);

app.post(
  '/api/admin/schedules',
  requireAdmin,
  wrap(async (req, res) => {
    const address = (req.body?.address || '').trim();
    if (!address) return res.status(400).json({ error: 'An address is required.' });
    const { lat, lng } = cleanLatLng(req.body?.lat, req.body?.lng);
    const _id = await store.nextId('schedules');
    await store.schedules.insertOne({
      _id,
      address,
      description: (req.body?.description || '').trim() || null,
      // A job can run over several days: `date` is the first, `end_date` the
      // last (null when it's a single day).
      ...cleanRange(req.body?.date, req.body?.end_date),
      time: cleanTime(req.body?.time),
      // When the customer needs it by — independent of the day it's booked on,
      // which is what makes a late booking visible.
      due_date: cleanDate(req.body?.due_date),
      job_type: cleanJobType(req.body?.job_type),
      // Notes for the crew go out with the job; internal notes never do.
      notes_driver: cleanNote(req.body?.notes_driver),
      notes_internal: cleanNote(req.body?.notes_internal),
      confirmed: !!req.body?.confirmed,
      lat,
      lng,
      employee_ids: await cleanEmployeeIds(req.body?.employee_ids),
      created_at: new Date(),
      updated_at: new Date(),
    });
    res.json({ id: _id });
  })
);

// Bulk edit — planning a week means putting the same date (and usually the
// same crew) on a stack of jobs at once, so the board can send one request for
// a whole selection. Registered before "/:id" so "bulk" isn't read as a job id.
app.patch(
  '/api/admin/schedules/bulk',
  requireAdmin,
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map(Number).filter((n) => Number.isInteger(n)))]
      : [];
    if (!ids.length) return res.status(400).json({ error: 'No jobs selected.' });

    // Only the fields a bulk edit can sensibly share — address and the notes
    // belong to one job each, so they're deliberately not here.
    const set = { updated_at: new Date() };
    // A bulk range always starts from a start date — an end day on its own has
    // nothing to anchor to, and must never be read as "clear the dates".
    if (req.body?.date != null)
      Object.assign(set, cleanRange(req.body.date, req.body?.end_date));
    if (req.body?.time != null) set.time = cleanTime(req.body.time);
    if (req.body?.due_date != null) set.due_date = cleanDate(req.body.due_date);
    if (req.body?.job_type != null) set.job_type = cleanJobType(req.body.job_type);
    if (req.body?.confirmed != null) set.confirmed = !!req.body.confirmed;

    const update = { $set: set };
    if (req.body?.employee_ids != null) {
      const crew = await cleanEmployeeIds(req.body.employee_ids);
      const mode = String(req.body?.crew_mode || 'replace');
      // add/remove leave the rest of each crew alone — the usual case when the
      // selected jobs already have different people on them.
      if (mode === 'add' && crew.length) update.$addToSet = { employee_ids: { $each: crew } };
      else if (mode === 'remove' && crew.length) update.$pullAll = { employee_ids: crew };
      else if (mode === 'replace') set.employee_ids = crew;
    }

    // A new start day slides each multi-day run along by its own length, which
    // one updateMany can't express — so those are written individually and the
    // single-day jobs still go in one shot. Sending an explicit end_date means
    // the whole selection was given the same run, so no shifting is needed.
    let ranged = [];
    if (req.body?.date != null && req.body?.end_date == null) {
      ranged = (await store.schedules.find({ _id: { $in: ids } }).toArray()).filter(
        (d) => d.end_date
      );
      for (const d of ranged) {
        const moved = cleanRange(set.date, shiftedEnd(d, set.date));
        await store.schedules.updateOne(
          { _id: d._id },
          { ...update, $set: { ...set, ...moved } }
        );
      }
    }

    const rest = ids.filter((id) => !ranged.some((d) => d._id === id));
    const r = rest.length
      ? await store.schedules.updateMany({ _id: { $in: rest } }, update)
      : { modifiedCount: 0 };
    res.json({ ok: true, updated: (r.modifiedCount ?? rest.length) + ranged.length });
  })
);

app.patch(
  '/api/admin/schedules/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const doc = await store.schedules.findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: 'Job not found.' });

    const set = { updated_at: new Date() };
    if (req.body?.address != null) {
      const address = String(req.body.address).trim();
      if (!address) return res.status(400).json({ error: 'An address is required.' });
      set.address = address;
    }
    if (req.body?.description != null)
      set.description = String(req.body.description).trim() || null;
    // Start and end move together. When only the start is sent — dragging a
    // card to another day — the run keeps its length and slides with it; when
    // the form sends both, they're taken as given.
    if (req.body?.date != null || req.body?.end_date != null) {
      const start = req.body?.date != null ? cleanDate(req.body.date) : doc.date || null;
      const end =
        req.body?.end_date != null
          ? cleanDate(req.body.end_date)
          : shiftedEnd(doc, start);
      Object.assign(set, cleanRange(start, end));
    }
    if (req.body?.time != null) set.time = cleanTime(req.body.time);
    if (req.body?.due_date != null) set.due_date = cleanDate(req.body.due_date);
    if (req.body?.job_type != null) set.job_type = cleanJobType(req.body.job_type);
    if (req.body?.notes_driver != null) set.notes_driver = cleanNote(req.body.notes_driver);
    if (req.body?.notes_internal != null) set.notes_internal = cleanNote(req.body.notes_internal);
    if (req.body?.confirmed != null) set.confirmed = !!req.body.confirmed;
    if (req.body?.lat !== undefined || req.body?.lng !== undefined) {
      const { lat, lng } = cleanLatLng(req.body?.lat, req.body?.lng);
      set.lat = lat;
      set.lng = lng;
    }
    if (req.body?.employee_ids != null)
      set.employee_ids = await cleanEmployeeIds(req.body.employee_ids);

    await store.schedules.updateOne({ _id: id }, { $set: set });
    res.json({ ok: true });
  })
);

app.delete(
  '/api/admin/schedules/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await store.schedules.deleteOne({ _id: id });
    await store.jobFiles.deleteMany({ job_id: id }); // don't leave orphan blobs
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Job files — every scheduled job has its own filing cabinet: folders (kept on
// the job document, so an empty one sticks around) and files (the blob in
// job_files, lightweight metadata mirrored onto the job so listing a job never
// loads file data). The crew sees the same shelf in the portal, read-only.
// ---------------------------------------------------------------------------

const JOB_FILE_MAX = 4 * 1024 * 1024; // 4 MB per file — same cap as task attachments

// A folder path such as "Permits/Approved". At most five levels, each trimmed
// of the characters that make a name awkward to show; "" is the job's root.
function cleanFolder(s) {
  return String(s == null ? '' : s)
    .split('/')
    .map((p) =>
      p
        .trim()
        .replace(/[\:*?"<>|]/g, '')
        .replace(/^\.+|\.+$/g, '')
        .trim()
        .slice(0, 60)
    )
    .filter(Boolean)
    .slice(0, 5)
    .join('/');
}

// A folder path and every folder above it: "a/b/c" -> ["a", "a/b", "a/b/c"].
const ancestors = (path) => path.split('/').map((_, i, all) => all.slice(0, i + 1).join('/'));

// Matches a folder and everything nested under it — deleting a folder takes
// its subfolders with it, the way a file manager does.
const underFolder = (path) => (p) => p === path || p.startsWith(path + '/');

// Load the job or answer 404. Returns null once the response has been sent.
async function jobOr404(req, res) {
  const doc = await store.schedules.findOne({ _id: Number(req.params.id) });
  if (!doc) {
    res.status(404).json({ error: 'Job not found.' });
    return null;
  }
  return doc;
}

// Stream one stored file back to the browser.
function sendJobFile(res, blob) {
  const raw = blob.data;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw && raw.buffer ? raw.buffer : raw);
  res.setHeader('Content-Type', blob.content_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${safeName(blob.filename)}"`);
  res.send(buf);
}

app.post(
  '/api/admin/schedules/:id/folders',
  requireAdmin,
  wrap(async (req, res) => {
    const job = await jobOr404(req, res);
    if (!job) return;
    const path = cleanFolder(req.body?.path);
    if (!path) return res.status(400).json({ error: 'Give the folder a name.' });
    if ((job.folders || []).includes(path))
      return res.status(400).json({ error: 'That folder already exists.' });
    await store.schedules.updateOne(
      { _id: job._id },
      { $addToSet: { folders: { $each: ancestors(path) } }, $set: { updated_at: new Date() } }
    );
    res.json({ path });
  })
);

app.delete(
  '/api/admin/schedules/:id/folders',
  requireAdmin,
  wrap(async (req, res) => {
    const job = await jobOr404(req, res);
    if (!job) return;
    const path = cleanFolder(req.query.path);
    if (!path) return res.status(400).json({ error: 'No folder given.' });
    const hit = underFolder(path);
    const doomed = (job.files || []).filter((f) => hit(f.folder || ''));
    if (doomed.length) await store.jobFiles.deleteMany({ _id: { $in: doomed.map((f) => f.id) } });
    await store.schedules.updateOne(
      { _id: job._id },
      {
        $set: {
          folders: (job.folders || []).filter((p) => !hit(p)),
          files: (job.files || []).filter((f) => !hit(f.folder || '')),
          updated_at: new Date(),
        },
      }
    );
    res.json({ ok: true, removed: doomed.length });
  })
);

app.post(
  '/api/admin/schedules/:id/files',
  requireAdmin,
  wrap(async (req, res) => {
    const job = await jobOr404(req, res);
    if (!job) return;
    const { filename, content_type, data } = req.body || {};
    if (!data || typeof data !== 'string')
      return res.status(400).json({ error: 'No file data received.' });
    let buf;
    try {
      buf = Buffer.from(data, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Could not read that file.' });
    }
    if (!buf.length) return res.status(400).json({ error: 'That file is empty.' });
    if (buf.length > JOB_FILE_MAX)
      return res.status(400).json({ error: 'File is too large (max 4 MB).' });

    const fileId = crypto.randomUUID();
    const meta = {
      id: fileId,
      filename: safeName(filename),
      folder: cleanFolder(req.body?.folder),
      content_type: String(content_type || 'application/octet-stream').slice(0, 120),
      size: buf.length,
      uploaded_by: actorName(req),
      at: new Date(),
    };
    await store.jobFiles.insertOne({
      _id: fileId,
      job_id: job._id,
      filename: meta.filename,
      content_type: meta.content_type,
      data: buf,
    });
    // Dropping a file into a folder that was never created explicitly (a
    // drag-and-drop of a whole folder does this) files the folder too.
    const update = { $push: { files: meta }, $set: { updated_at: new Date() } };
    // Filing into "Permits/Approved" registers "Permits" as well, so the folder
    // you walk through on the way exists in its own right.
    if (meta.folder) update.$addToSet = { folders: { $each: ancestors(meta.folder) } };
    await store.schedules.updateOne({ _id: job._id }, update);
    res.json({ ...meta, at: iso(meta.at) });
  })
);

app.get(
  '/api/admin/schedules/:id/files/:fileId',
  requireAdmin,
  wrap(async (req, res) => {
    const blob = await store.jobFiles.findOne({
      _id: req.params.fileId,
      job_id: Number(req.params.id),
    });
    if (!blob) return res.status(404).json({ error: 'File not found.' });
    sendJobFile(res, blob);
  })
);

// Rename a file, or move it to another folder.
app.patch(
  '/api/admin/schedules/:id/files/:fileId',
  requireAdmin,
  wrap(async (req, res) => {
    const job = await jobOr404(req, res);
    if (!job) return;
    const file = (job.files || []).find((f) => f.id === req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found.' });

    const set = { updated_at: new Date() };
    if (req.body?.filename != null) {
      const name = safeName(req.body.filename).trim();
      if (!name) return res.status(400).json({ error: 'Give the file a name.' });
      set['files.$[f].filename'] = name;
    }
    if (req.body?.folder != null) set['files.$[f].folder'] = cleanFolder(req.body.folder);
    await store.schedules.updateOne({ _id: job._id }, { $set: set }, {
      arrayFilters: [{ 'f.id': file.id }],
    });
    if (set['files.$[f].filename'])
      await store.jobFiles.updateOne(
        { _id: file.id },
        { $set: { filename: set['files.$[f].filename'] } }
      );
    res.json({ ok: true });
  })
);

app.delete(
  '/api/admin/schedules/:id/files/:fileId',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const fileId = req.params.fileId;
    await store.jobFiles.deleteOne({ _id: fileId, job_id: id });
    await store.schedules.updateOne(
      { _id: id },
      { $pull: { files: { id: fileId } }, $set: { updated_at: new Date() } }
    );
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Admin: live "who's on the clock"
// ---------------------------------------------------------------------------

app.get(
  '/api/admin/active',
  requireAdmin,
  wrap(async (req, res) => {
    const open = await store.punches
      .find({ clock_out: null }, { sort: { clock_in: 1 } })
      .toArray();
    const named = await withNames(open);
    res.json(
      named.map((p) => ({
        punch_id: p._id,
        clock_in: iso(p.clock_in),
        employee_id: p.employee_id,
        name: p.name,
      }))
    );
  })
);

// ---------------------------------------------------------------------------
// Admin: clock-in locations (map) — every punch that captured a GPS fix, with
// the employee's name and clock-in time. Filtered by an optional date range.
// ---------------------------------------------------------------------------

app.get(
  '/api/admin/locations',
  requireAdmin,
  wrap(async (req, res) => {
    const q = { clock_in_lat: { $ne: null } };
    const { from, to } = req.query;
    if (from || to) {
      q.clock_in = {};
      if (from) q.clock_in.$gte = new Date(from + 'T00:00:00');
      if (to) q.clock_in.$lte = new Date(to + 'T23:59:59.999');
    }
    const rows = await store.punches.find(q, { sort: { clock_in: -1 } }).toArray();
    const named = await withNames(rows);
    res.json(
      named.map((p) => ({
        id: p._id,
        name: p.name,
        clock_in: iso(p.clock_in),
        lat: p.clock_in_lat,
        lng: p.clock_in_lng,
      }))
    );
  })
);

// The shop and the scheduled jobs, each with how far it is from the shop. Only
// jobs whose address was matched to a position can be mapped — one typed in by
// hand without picking a suggestion has no coordinates, and is counted rather
// than silently dropped.
app.get(
  '/api/admin/map',
  requireAdmin,
  wrap(async (req, res) => {
    const shop = await getShop();
    const { from, to } = req.query;
    const q = {};
    if (from || to) {
      // Undated jobs are ongoing work rather than work fixed to a day, so they
      // stay on the map whatever range is chosen.
      q.$or = [
        { date: null },
        { date: { ...(from ? { $gte: String(from) } : {}), ...(to ? { $lte: String(to) } : {}) } },
      ];
    }
    const docs = (await store.schedules.find(q).toArray()).sort(scheduleSort);
    const employees = await store.employees.find({}).toArray();
    const nameById = Object.fromEntries(employees.map((e) => [e._id, e.name]));

    const jobs = [];
    let unmapped = 0;
    for (const d of docs) {
      // cleanLatLng rather than Number(): Number(null) is 0, which is finite,
      // and would put an ungeocoded job in the Gulf of Guinea.
      const { lat, lng } = cleanLatLng(d.lat, d.lng);
      if (lat == null || lng == null) {
        unmapped++;
        continue;
      }
      jobs.push({
        id: d._id,
        address: d.address,
        description: d.description || null,
        date: d.date || null,
        time: d.time || null,
        lat,
        lng,
        crew: (d.employee_ids || []).map((id) => nameById[id]).filter(Boolean),
        km: distanceKm(shop.lat, shop.lng, lat, lng),
      });
    }
    res.json({ shop, jobs, unmapped });
  })
);

app.get(
  '/api/admin/shop',
  requireAdmin,
  wrap(async (req, res) => {
    res.json({ shop: await getShop(), default: SHOP_DEFAULT });
  })
);

app.patch(
  '/api/admin/shop',
  requireAdmin,
  wrap(async (req, res) => {
    try {
      res.json({ shop: await saveShop(req.body || {}) });
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      throw err;
    }
  })
);

// ---------------------------------------------------------------------------
// Admin: timesheets
// ---------------------------------------------------------------------------

// from/to are inclusive dates (YYYY-MM-DD). Returns entries ordered newest-first,
// each with the employee's name attached.
async function timesheetRows({ employeeId, from, to }) {
  const q = {};
  if (employeeId) q.employee_id = Number(employeeId);
  if (from || to) {
    q.clock_in = {};
    if (from) q.clock_in.$gte = new Date(from + 'T00:00:00');
    if (to) q.clock_in.$lte = new Date(to + 'T23:59:59.999');
  }
  const rows = await store.punches.find(q, { sort: { clock_in: -1 } }).toArray();
  const named = await withNames(rows);
  return attachMileage(
    named.map((r) => ({
      id: r._id,
      employee_id: r.employee_id,
      name: r.name,
      clock_in: r.clock_in,
      clock_out: r.clock_out,
      work_done: r.work_done,
      jobs: r.jobs || [],
      missed_reason: r.missed_reason,
      note: r.note,
      shop_hours: Number(r.shop_hours) || 0,
      lunch_hours: Number(r.lunch_hours) || 0,
      km_manual: r.km_manual ?? null,
      edited: r.edited,
      clock_in_lat: r.clock_in_lat ?? null,
      clock_in_lng: r.clock_in_lng ?? null,
    }))
  );
}

function hoursOf(row) {
  const h = paidHours(row);
  return h == null ? null : Math.round(h * 100) / 100;
}

app.get(
  '/api/admin/timesheet',
  requireAdmin,
  wrap(async (req, res) => {
    const rows = await timesheetRows({
      employeeId: req.query.employee_id,
      from: req.query.from,
      to: req.query.to,
    });
    let total = 0;
    let totalKm = 0;
    const entries = rows.map((r) => {
      const hours = hoursOf(r);
      if (hours) total += hours;
      if (r.km) totalKm += r.km;
      return { ...r, clock_in: iso(r.clock_in), clock_out: iso(r.clock_out), hours };
    });
    res.json({
      entries,
      totalHours: Math.round(total * 100) / 100,
      totalKm: Math.round(totalKm * 10) / 10,
      mileage: await getMileageSettings(),
    });
  })
);

// Whether mileage counts the return trip. Deliberately its own endpoint rather
// than part of the map: the timesheet has to keep working when the map feature
// is switched off.
app.get(
  '/api/admin/mileage',
  requireAdmin,
  wrap(async (req, res) => {
    res.json({ mileage: await getMileageSettings(), shop: await getShop() });
  })
);

app.patch(
  '/api/admin/mileage',
  requireAdmin,
  wrap(async (req, res) => {
    res.json({ mileage: await saveMileageSettings(req.body || {}) });
  })
);

// ---------------------------------------------------------------------------
// Admin: create / edit / delete punches
// ---------------------------------------------------------------------------

app.post(
  '/api/admin/punches',
  requireAdmin,
  wrap(async (req, res) => {
    const employeeId = Number(req.body?.employee_id);
    const { clock_in, clock_out, note, work_done } = req.body || {};
    const emp = await store.employees.findOne({ _id: employeeId });
    if (!emp) return res.status(400).json({ error: 'Unknown employee.' });
    if (!clock_in) return res.status(400).json({ error: 'Clock-in time is required.' });

    const ci = new Date(clock_in);
    const co = clock_out ? new Date(clock_out) : null;
    if (isNaN(ci)) return res.status(400).json({ error: 'Invalid clock-in time.' });
    if (co && isNaN(co)) return res.status(400).json({ error: 'Invalid clock-out time.' });
    if (co && co < ci)
      return res.status(400).json({ error: 'Clock-out must be after clock-in.' });

    const _id = await store.nextId('punches');
    await store.punches.insertOne({
      _id,
      employee_id: employeeId,
      clock_in: ci,
      clock_out: co,
      work_done: work_done || null,
      missed_reason: null,
      note: note || null,
      shop_hours: quarterHours(req.body?.shop_hours, MAX_SHOP_HOURS),
      lunch_hours: quarterHours(req.body?.lunch_hours, MAX_LUNCH_HOURS),
      km_manual: manualKm(req.body?.km_manual),
      edited: true,
    });
    res.json({ id: _id });
  })
);

app.patch(
  '/api/admin/punches/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const p = await store.punches.findOne({ _id: id });
    if (!p) return res.status(404).json({ error: 'Entry not found.' });

    const ci = req.body?.clock_in ? new Date(req.body.clock_in) : new Date(p.clock_in);
    let co;
    if (req.body?.clock_out === '' || req.body?.clock_out === null) {
      co = null; // explicitly reopen the entry
    } else if (req.body?.clock_out) {
      co = new Date(req.body.clock_out);
    } else {
      co = p.clock_out ? new Date(p.clock_out) : null;
    }

    if (isNaN(ci)) return res.status(400).json({ error: 'Invalid clock-in time.' });
    if (co && isNaN(co)) return res.status(400).json({ error: 'Invalid clock-out time.' });
    if (co && co < ci)
      return res.status(400).json({ error: 'Clock-out must be after clock-in.' });

    const note = req.body?.note != null ? req.body.note : p.note;
    const workDone = req.body?.work_done != null ? req.body.work_done : p.work_done;
    const missedReason =
      req.body?.missed_reason != null ? req.body.missed_reason : p.missed_reason;
    const shopHours =
      req.body?.shop_hours != null
        ? quarterHours(req.body.shop_hours, MAX_SHOP_HOURS)
        : Number(p.shop_hours) || 0;
    const lunchHours =
      req.body?.lunch_hours != null
        ? quarterHours(req.body.lunch_hours, MAX_LUNCH_HOURS)
        : Number(p.lunch_hours) || 0;
    // '' clears a hand-entered distance and puts the row back on the computed
    // figure; leaving the field out keeps whatever is already stored.
    const km =
      req.body?.km_manual !== undefined ? manualKm(req.body.km_manual) : p.km_manual ?? null;

    if (
      co &&
      lunchHours > 0 &&
      paidHours({ clock_in: ci, clock_out: co, shop_hours: shopHours, lunch_hours: lunchHours }) <= 0
    )
      return res.status(400).json({ error: 'Lunch is longer than the time on the clock.' });

    await store.punches.updateOne(
      { _id: id },
      {
        $set: {
          clock_in: ci,
          clock_out: co,
          work_done: workDone,
          missed_reason: missedReason,
          note,
          shop_hours: shopHours,
          lunch_hours: lunchHours,
          km_manual: km,
          edited: true,
        },
      }
    );
    res.json({ ok: true });
  })
);

app.delete(
  '/api/admin/punches/:id',
  requireAdmin,
  wrap(async (req, res) => {
    await store.punches.deleteOne({ _id: Number(req.params.id) });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Admin: CSV export
// ---------------------------------------------------------------------------

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get(
  '/api/admin/export.csv',
  requireAdmin,
  wrap(async (req, res) => {
    const rows = await timesheetRows({
      employeeId: req.query.employee_id,
      from: req.query.from,
      to: req.query.to,
    });
    const header = [
      'Employee',
      'Clock In',
      'Clock Out',
      'Shop/Load Hours',
      'Lunch Hours',
      'Hours',
      'Jobs',
      'Km',
      'Work Done',
      'Missed Clock-out Reason',
      'Edited',
      'Note',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          csvCell(r.name),
          csvCell(iso(r.clock_in)),
          csvCell(iso(r.clock_out) || ''),
          csvCell(r.shop_hours || ''),
          csvCell(r.lunch_hours || ''),
          csvCell(hoursOf(r) ?? ''),
          csvCell((r.jobs || []).map(jobLabel).join('; ')),
          csvCell(r.km ?? ''),
          csvCell(r.work_done || ''),
          csvCell(r.missed_reason || ''),
          csvCell(r.edited ? 'yes' : ''),
          csvCell(r.note || ''),
        ].join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="hek-timesheet-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send(lines.join('\n'));
  })
);

// ---------------------------------------------------------------------------
// Admin: QuickBooks payroll sync
//
// Pushes each pay period's approved hours into QuickBooks as TimeActivity
// records so payroll is reviewed and run there with the numbers already in
// place. Intuit has no public API for running payroll or moving money, so the
// final "Run payroll" click stays with a person — see quickbooks.js.
// ---------------------------------------------------------------------------

// Like wrap(), but a QuickBooksError carries a message written for the admin
// (a QuickBooks validation fault, a missing setting) and is passed through
// verbatim instead of being flattened into "Server error".
const qbWrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (res.headersSent) return;
    if (err instanceof qbo.QuickBooksError) {
      return res
        .status(err.status || 400)
        .json({ error: err.message, detail: err.detail || undefined });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  });

// A readable name for whoever is acting, recorded against the connection and
// each sync run. The unified login at "/" doesn't put an email on the session,
// so fall back to their employee record and then to the admin account.
async function adminActor(req) {
  if (req.session?.email) return req.session.email;
  if (req.session?.employeeId) {
    const emp = await store.employees.findOne({ _id: req.session.employeeId });
    if (emp) return emp.email || emp.name;
  }
  try {
    return (await getAdminRecord()).email;
  } catch {
    return null;
  }
}

// Which pay period a request is about. Any date is snapped to the pay-period
// grid, so a preview always covers exactly what a sync would push — an
// arbitrary date range would file its records under the wrong period and break
// the bookkeeping that makes re-syncing safe.
async function resolvePeriod(q) {
  const settings = await qbo.getSettings();
  if (!settings.period_anchor)
    throw new qbo.QuickBooksError('Set the pay period start date before syncing.');
  const today = qbo.localDay(new Date());
  if (q && q.start) {
    if (isNaN(qbo.dayToMs(String(q.start))))
      throw new qbo.QuickBooksError('That is not a real date.');
    return qbo.periodContaining(String(q.start), settings);
  }
  const which = (q && q.period) || 'last_complete';
  if (which === 'current') return qbo.periodContaining(today, settings);
  if (which === 'previous')
    return qbo.shiftPeriod(qbo.periodContaining(today, settings), -1, settings);
  return qbo.lastCompletePeriod(today, settings);
}

app.get(
  '/api/admin/quickbooks/status',
  requireAdmin,
  qbWrap(async (req, res) => {
    const status = await qbo.getStatus();
    // How many people the sync can actually pay attention to, so the dashboard
    // can say "3 of 7 matched" without a second round trip.
    const hourly = await store.employees
      .find({ active: true, pay_type: { $ne: 'Salary' } })
      .toArray();
    status.mapping = {
      total: hourly.length,
      matched: hourly.filter((e) => e.qbo_employee_id).length,
    };
    // The callback URL for *this* deployment, so the form can offer the exact
    // string to paste into the Intuit app rather than describing it.
    status.credentials.suggested_redirect_uri = qbo.derivedRedirectUri(req);
    res.json(status);
  })
);

app.patch(
  '/api/admin/quickbooks/settings',
  requireAdmin,
  qbWrap(async (req, res) => {
    await qbo.saveSettings(req.body || {});
    res.json(await qbo.getStatus());
  })
);

// The products/services and tax codes in the connected company, for the two
// pickers the invoice sync needs.
app.get(
  '/api/admin/quickbooks/items',
  requireAdmin,
  qbWrap(async (req, res) => {
    res.json({ items: await qbo.listQboItems() });
  })
);

app.get(
  '/api/admin/quickbooks/taxcodes',
  requireAdmin,
  qbWrap(async (req, res) => {
    res.json({ taxcodes: await qbo.listQboTaxCodes() });
  })
);

// The Intuit app's own keys. Saved here rather than only in the environment so
// they can be entered and rotated without a redeploy.
app.patch(
  '/api/admin/quickbooks/credentials',
  requireAdmin,
  qbWrap(async (req, res) => {
    const status = await qbo.saveCredentials(req.body || {});
    status.credentials.suggested_redirect_uri = qbo.derivedRedirectUri(req);
    res.json(status);
  })
);

// Start the OAuth handshake. This is a top-level navigation rather than a fetch
// because Intuit's consent screen has to be shown to the person clicking.
app.get(
  '/api/admin/quickbooks/connect',
  requireAdmin,
  wrap(async (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = await qbo.redirectUriFor(req);
    // Remembered so the callback can prove the response belongs to this
    // request, and so the token exchange sends a byte-identical redirect URI.
    req.session.qboState = state;
    req.session.qboRedirect = redirectUri;
    try {
      res.redirect(await qbo.authorizeUrl(state, redirectUri));
    } catch (err) {
      // This is a whole-page navigation, so an error has to come back as one —
      // a JSON body would just be dumped into the browser window.
      res.redirect(
        ADMIN_PATH + '?' + new URLSearchParams({ quickbooks: 'error', message: err.message })
      );
    }
  })
);

// Where Intuit sends the browser back to. Registered with the Intuit app, so
// its path must stay stable.
app.get(
  '/api/quickbooks/callback',
  wrap(async (req, res) => {
    const back = (params) => res.redirect(ADMIN_PATH + '?' + new URLSearchParams(params));
    if (!(req.session && req.session.admin))
      return back({ quickbooks: 'error', message: 'Sign in as an admin and try again.' });

    const { code, state, realmId, error, error_description: errorDescription } = req.query;
    const expected = req.session.qboState;
    const redirectUri = req.session.qboRedirect || (await qbo.redirectUriFor(req));
    req.session.qboState = null;
    req.session.qboRedirect = null;

    if (error) return back({ quickbooks: 'error', message: errorDescription || String(error) });
    // A missing or mismatched state means this response didn't come from the
    // handshake we started — never trade it for tokens.
    if (!state || !expected || state !== expected)
      return back({ quickbooks: 'error', message: 'The QuickBooks sign-in expired. Try again.' });
    if (!code || !realmId)
      return back({ quickbooks: 'error', message: 'QuickBooks did not send a company to connect.' });

    try {
      const actor = await adminActor(req);
      await qbo.exchangeCode({ code: String(code), realmId: String(realmId), redirectUri, actor });
      return back({ quickbooks: 'connected' });
    } catch (err) {
      console.error('QuickBooks connect failed:', err);
      return back({ quickbooks: 'error', message: err.detail || err.message });
    }
  })
);

app.post(
  '/api/admin/quickbooks/disconnect',
  requireAdmin,
  qbWrap(async (req, res) => {
    await qbo.disconnect();
    res.json(await qbo.getStatus());
  })
);

// The QuickBooks employee list, for matching people up.
app.get(
  '/api/admin/quickbooks/qbo-employees',
  requireAdmin,
  qbWrap(async (req, res) => {
    res.json({ employees: await qbo.listQboEmployees() });
  })
);

app.patch(
  '/api/admin/quickbooks/mapping',
  requireAdmin,
  qbWrap(async (req, res) => {
    const id = Number(req.body?.employee_id);
    const qboId = String(req.body?.qbo_employee_id ?? '').trim();
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Which employee?' });
    if (qboId && !/^\d+$/.test(qboId))
      return res.status(400).json({ error: 'That is not a QuickBooks employee id.' });
    const emp = await store.employees.findOne({ _id: id });
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    // Two people pointed at the same QuickBooks employee would pile both
    // timesheets onto one person's paycheque.
    if (qboId) {
      const clash = await store.employees.findOne({ qbo_employee_id: qboId, _id: { $ne: id } });
      if (clash)
        return res
          .status(409)
          .json({ error: `${clash.name} is already matched to that QuickBooks employee.` });
    }
    await store.employees.updateOne(
      { _id: id },
      qboId ? { $set: { qbo_employee_id: qboId } } : { $unset: { qbo_employee_id: '' } }
    );
    res.json({ ok: true, employee_id: id, qbo_employee_id: qboId || null });
  })
);

// Exactly what a sync would push, without pushing it.
app.get(
  '/api/admin/quickbooks/preview',
  requireAdmin,
  qbWrap(async (req, res) => {
    const period = await resolvePeriod(req.query);
    const settings = await qbo.getSettings();
    const report = await qbo.buildPeriod(period, settings);
    const pushed = await store.qboTime.countDocuments({ period_start: period.start });
    res.json({ ...report, settings, already_pushed: pushed });
  })
);

app.post(
  '/api/admin/quickbooks/sync',
  requireAdmin,
  qbWrap(async (req, res) => {
    const period = await resolvePeriod(req.body || {});
    const result = await qbo.syncPeriod(period, {
      actor: await adminActor(req),
      trigger: 'manual',
    });
    res.json(result);
  })
);

app.get(
  '/api/admin/quickbooks/runs',
  requireAdmin,
  qbWrap(async (req, res) => {
    const runs = await store.qboRuns.find({}, { sort: { _id: -1 }, limit: 20 }).toArray();
    res.json({ runs });
  })
);

// The scheduled push. Vercel Cron sends "Authorization: Bearer $CRON_SECRET"
// when that variable is set on the project; without it the endpoint stays shut,
// because anything that can reach this URL can write to the company's books.
function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers.authorization === `Bearer ${secret}`) return true;
  // An admin firing it by hand from the dashboard.
  return !!(req.session && req.session.admin && req.session.role !== 'dev');
}

const cronSync = qbWrap(async (req, res) => {
  if (!cronAuthorized(req)) {
    return res.status(401).json({
      error: process.env.CRON_SECRET
        ? 'Not authorized.'
        : 'CRON_SECRET is not set on the server, so the scheduled sync is disabled.',
    });
  }
  const result = await qbo.runScheduledSync();
  res.json(result);
});
app.get('/api/cron/quickbooks-sync', cronSync);
app.post('/api/cron/quickbooks-sync', cronSync);

// ---------------------------------------------------------------------------
// Admin: quotes / estimates
// ---------------------------------------------------------------------------

const QUOTE_STATUSES = new Set(['draft', 'sent', 'accepted', 'declined']);
const toNum = (v) => {
  const n = Number(v);
  return isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;

function cleanCustomer(c) {
  c = c || {};
  return {
    name: String(c.name || '').trim(),
    address: String(c.address || '').trim(),
    phone: String(c.phone || '').trim(),
    email: String(c.email || '').trim(),
  };
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      description: String(it?.description || '').trim(),
      qty: toNum(it?.qty),
      unit: String(it?.unit || '').trim(),
      unit_price: toNum(it?.unit_price),
    }))
    .filter((it) => it.description || it.qty || it.unit_price);
}

function quoteTotals(items, taxRate) {
  const subtotal = (items || []).reduce((s, it) => s + it.qty * it.unit_price, 0);
  const tax = subtotal * (toNum(taxRate) / 100);
  return { subtotal: round2(subtotal), tax: round2(tax), total: round2(subtotal + tax) };
}

function quoteView(q) {
  return {
    id: q._id,
    number: q.number,
    customer: q.customer || { name: '', address: '', phone: '', email: '' },
    quote_date: iso(q.quote_date),
    items: q.items || [],
    tax_rate: q.tax_rate || 0,
    notes: q.notes || '',
    status: q.status || 'draft',
    created_at: iso(q.created_at),
    updated_at: iso(q.updated_at),
    ...quoteTotals(q.items, q.tax_rate),
  };
}

app.get(
  '/api/admin/quotes',
  requireQuotes,
  wrap(async (req, res) => {
    const rows = await store.quotes.find({}, { sort: { created_at: -1 } }).toArray();
    res.json(rows.map(quoteView));
  })
);

app.get(
  '/api/admin/quotes/:id',
  requireQuotes,
  wrap(async (req, res) => {
    const q = await store.quotes.findOne({ _id: Number(req.params.id) });
    if (!q) return res.status(404).json({ error: 'Quote not found.' });
    res.json(quoteView(q));
  })
);

app.post(
  '/api/admin/quotes',
  requireQuotes,
  wrap(async (req, res) => {
    const b = req.body || {};
    const customer = cleanCustomer(b.customer);
    if (!customer.name) return res.status(400).json({ error: 'Customer name is required.' });

    const _id = await store.nextId('quotes');
    const now = new Date();
    const doc = {
      _id,
      number: 'Q' + String(1000 + _id),
      customer,
      quote_date: b.quote_date ? new Date(b.quote_date) : now,
      items: cleanItems(b.items),
      tax_rate: toNum(b.tax_rate),
      notes: String(b.notes || '').trim(),
      status: QUOTE_STATUSES.has(b.status) ? b.status : 'draft',
      created_at: now,
      updated_at: now,
    };
    await store.quotes.insertOne(doc);
    res.json(quoteView(doc));
  })
);

app.patch(
  '/api/admin/quotes/:id',
  requireQuotes,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const q = await store.quotes.findOne({ _id: id });
    if (!q) return res.status(404).json({ error: 'Quote not found.' });

    const b = req.body || {};
    const set = { updated_at: new Date() };
    if (b.customer != null) set.customer = cleanCustomer(b.customer);
    if (b.items != null) set.items = cleanItems(b.items);
    if (b.tax_rate != null) set.tax_rate = toNum(b.tax_rate);
    if (b.notes != null) set.notes = String(b.notes).trim();
    if (b.quote_date != null && b.quote_date) set.quote_date = new Date(b.quote_date);
    if (b.status != null && QUOTE_STATUSES.has(b.status)) set.status = b.status;

    const name = (set.customer ? set.customer.name : q.customer && q.customer.name) || '';
    if (!name) return res.status(400).json({ error: 'Customer name is required.' });

    await store.quotes.updateOne({ _id: id }, { $set: set });
    const updated = await store.quotes.findOne({ _id: id });
    res.json(quoteView(updated));
  })
);

app.delete(
  '/api/admin/quotes/:id',
  requireQuotes,
  wrap(async (req, res) => {
    await store.quotes.deleteOne({ _id: Number(req.params.id) });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Admin: rate book — what HEK charges per service. Lives in the database (see
// ratebook.js) because the inbox agent prices against the same numbers the
// Pricing calculator uses.
// ---------------------------------------------------------------------------

app.get(
  '/api/admin/ratebook',
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await rateBook.getRateBook());
  })
);

app.patch(
  '/api/admin/ratebook',
  requireAdmin,
  wrap(async (req, res) => {
    try {
      res.json(await rateBook.saveRateBook(req.body || {}));
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      throw err;
    }
  })
);

// Add / rename / reprice / remove a service. This is what makes the rate book
// the admin's list rather than a fixed one in the code.
app.post(
  '/api/admin/ratebook/services',
  requireAdmin,
  wrap(async (req, res) => {
    const { action, ...body } = req.body || {};
    try {
      res.json(await rateBook.editService(action, body));
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      throw err;
    }
  })
);

// The built-in services that have been switched off, so they can be brought back.
app.get(
  '/api/admin/ratebook/hidden',
  requireAdmin,
  wrap(async (req, res) => {
    res.json({ hidden: await rateBook.hiddenServices() });
  })
);

// ---------------------------------------------------------------------------
// Public estimate page ("/estimate") — open to the world, no login.
//
// Only two endpoints are public, both rate limited: one reads the switched-on
// services, the other files a quote request. Prices are always worked out on
// the server from the live rate book, so what the browser sends is only ever
// "which service, how much of it".
// ---------------------------------------------------------------------------

const estimateLimiter = limiter('estimate');

app.get(
  '/api/estimate/config',
  wrap(async (req, res) => {
    res.json(await estimates.publicConfig());
  })
);

// Find the customer's property so they can trace the fence on it. The lookup
// goes through us rather than straight from the browser: OpenStreetMap asks for
// an identifying User-Agent, and proxying keeps this rate limited like the rest
// of the public endpoints.
app.get(
  '/api/estimate/geocode',
  estimateLimiter,
  wrap(async (req, res) => {
    const settings = await estimates.getSettings();
    if (!settings.enabled) return res.json({ results: [] });
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 3) return res.json({ results: [] });
    try {
      const url =
        'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=ca,us&q=' +
        encodeURIComponent(q);
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'HEK-Timeclock/1.0 (customer estimate address lookup)',
          'Accept-Language': 'en',
        },
      });
      if (!r.ok) return res.json({ results: [] });
      const data = await r.json();
      const results = (Array.isArray(data) ? data : [])
        .map((d) => ({ label: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }))
        .filter((x) => x.label && Number.isFinite(x.lat) && Number.isFinite(x.lng));
      res.json({ results });
    } catch (err) {
      console.error('estimate geocode failed:', err.message);
      res.json({ results: [] });
    }
  })
);

// The address at a position — used when the customer lets the browser place
// them, so the request carries a street address rather than bare coordinates.
app.get(
  '/api/estimate/reverse',
  estimateLimiter,
  wrap(async (req, res) => {
    const settings = await estimates.getSettings();
    if (!settings.enabled) return res.json({ label: null });
    const { lat, lng } = cleanLatLng(req.query.lat, req.query.lng);
    if (lat == null) return res.json({ label: null });
    try {
      const url =
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'HEK-Timeclock/1.0 (customer estimate address lookup)',
          'Accept-Language': 'en',
        },
      });
      if (!r.ok) return res.json({ label: null });
      const data = await r.json();
      res.json({ label: (data && data.display_name) || null });
    } catch (err) {
      console.error('estimate reverse geocode failed:', err.message);
      res.json({ label: null });
    }
  })
);

// ---------------------------------------------------------------------------
// Estimate: imagery for the 3D fence preview
// ---------------------------------------------------------------------------

// Satellite tiles, relayed through this server rather than fetched straight
// from Esri by the browser.
//
// The 3D view paints these onto the ground so the fence stands on a picture of
// the customer's actual yard. A canvas that has drawn a cross-origin image is
// "tainted" and can no longer be read back, which would break saving the render
// as a picture. Serving the tiles from our own origin avoids that entirely.
app.get(
  '/api/estimate/tile/:z/:x/:y',
  estimateLimiter,
  wrap(async (req, res) => {
    const settings = await estimates.getSettings();
    if (!settings.enabled) return res.status(404).end();

    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    // Bounds-check before calling out: a tile index outside the pyramid is
    // either a bug or someone probing, and neither deserves an upstream fetch.
    const span = 2 ** z;
    if (
      !Number.isInteger(z) || z < 1 || z > 21 ||
      !Number.isInteger(x) || x < 0 || x >= span ||
      !Number.isInteger(y) || y < 0 || y >= span
    )
      return res.status(400).end();

    try {
      const upstream = await fetch(
        `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
        { headers: { 'User-Agent': 'HEK-Timeclock/1.0 (fence preview)' } }
      );
      if (!upstream.ok) return res.status(502).end();
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
      // Aerial imagery changes about once a year; a long cache keeps repeat
      // views instant and costs the upstream nothing.
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.send(buf);
    } catch (err) {
      console.error('tile proxy failed:', err.message);
      res.status(502).end();
    }
  })
);

// A photo of the property from the road. Proxied so the Google key stays on the
// server — the browser only ever asks us for a picture.
app.get(
  '/api/estimate/streetview',
  estimateLimiter,
  wrap(async (req, res) => {
    const settings = await estimates.getSettings();
    if (!settings.enabled) return res.status(404).json({ error: 'Estimates are closed.' });
    const key = await estimates.googleKey();
    if (!key)
      return res.status(409).json({ error: 'No Google Maps key is set up, so there is no photo.' });

    const { lat, lng } = cleanLatLng(req.query.lat, req.query.lng);
    if (lat == null) return res.status(400).json({ error: 'Where?' });
    const heading = Number(req.query.heading);
    const fov = Math.min(120, Math.max(20, Number(req.query.fov) || 90));
    const pitch = Math.min(60, Math.max(-60, Number(req.query.pitch) || 0));

    const params = new URLSearchParams({
      size: '640x400',
      location: `${lat},${lng}`,
      fov: String(fov),
      pitch: String(pitch),
      // Frame the property rather than whatever the car happened to face.
      source: 'outdoor',
      key,
    });
    if (Number.isFinite(heading)) params.set('heading', String(((heading % 360) + 360) % 360));

    try {
      // Ask the free metadata endpoint first. Without this a location with no
      // coverage silently bills for a "sorry, no imagery" placeholder image.
      const meta = await fetch(
        `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${encodeURIComponent(key)}`
      );
      const info = meta.ok ? await meta.json() : null;
      if (!info || info.status !== 'OK')
        return res
          .status(404)
          .json({ error: 'Google has no road-level photo of this spot.', status: info && info.status });

      const shot = await fetch(`https://maps.googleapis.com/maps/api/streetview?${params}`);
      if (!shot.ok) return res.status(502).json({ error: 'Google would not return the photo.' });
      const buf = Buffer.from(await shot.arrayBuffer());
      res.setHeader('Content-Type', shot.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      // Where the camera actually is, so the 3D overlay can line itself up.
      if (info.location) {
        res.setHeader('X-Pano-Lat', String(info.location.lat));
        res.setHeader('X-Pano-Lng', String(info.location.lng));
      }
      res.send(buf);
    } catch (err) {
      console.error('street view failed:', err.message);
      res.status(502).json({ error: 'Could not reach Google for the photo.' });
    }
  })
);

// Where the Street View camera stands, and which way it must look to face the
// property. The overlay needs both before it can draw anything.
app.get(
  '/api/estimate/streetview/meta',
  estimateLimiter,
  wrap(async (req, res) => {
    const settings = await estimates.getSettings();
    if (!settings.enabled) return res.status(404).json({ error: 'Estimates are closed.' });
    const key = await estimates.googleKey();
    if (!key) return res.status(409).json({ error: 'No Google Maps key is set up.' });
    const { lat, lng } = cleanLatLng(req.query.lat, req.query.lng);
    if (lat == null) return res.status(400).json({ error: 'Where?' });
    try {
      const r = await fetch(
        `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${encodeURIComponent(key)}`
      );
      const info = r.ok ? await r.json() : null;
      if (!info || info.status !== 'OK')
        return res.status(404).json({ error: 'No road-level photo here.', status: info && info.status });
      res.json({ lat: info.location.lat, lng: info.location.lng, date: info.date || null });
    } catch (err) {
      res.status(502).json({ error: 'Could not reach Google.' });
    }
  })
);

// A live total as the customer edits, priced by the server so the figure they
// see is the figure that gets filed.
app.post(
  '/api/estimate/price',
  estimateLimiter,
  wrap(async (req, res) => {
    const settings = await estimates.getSettings();
    if (!settings.enabled)
      return res.status(403).json({ error: 'The estimate page is not available right now.' });
    res.json(await estimates.priceItems(req.body && req.body.items));
  })
);

app.post(
  '/api/estimate/request',
  estimateLimiter,
  wrap(async (req, res) => {
    try {
      const doc = await estimates.createRequest(req.body || {}, {
        ip: clientIp(req),
        agent: req.headers['user-agent'],
      });
      // A failed-attempt counter is only meant to catch abuse, so a genuine
      // request clears it — a busy day of real enquiries never locks anyone out.
      await clearFails(req._rlKey);
      res.json({ ok: true, reference: 'R' + String(1000 + doc._id), total: doc.total });
    } catch (err) {
      if (err.status) {
        await recordFail(req._rlKey);
        return res.status(err.status).json({ error: err.message });
      }
      throw err;
    }
  })
);

// ---------------------------------------------------------------------------
// Admin: the quote requests that page files, and its settings
// ---------------------------------------------------------------------------

app.get(
  '/api/admin/estimate/settings',
  requireAdmin,
  wrap(async (req, res) => {
    res.json({ settings: await estimates.getSettings(), defaults: estimates.DEFAULTS });
  })
);

app.patch(
  '/api/admin/estimate/settings',
  requireAdmin,
  wrap(async (req, res) => {
    try {
      res.json({ settings: await estimates.saveSettings(req.body || {}) });
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      throw err;
    }
  })
);

app.get(
  '/api/admin/estimate/requests',
  requireAdmin,
  wrap(async (req, res) => {
    res.json({ requests: await estimates.listRequests(), unread: await estimates.countNew() });
  })
);

// Approving a request is what turns it into a quote — the page never does.
app.post(
  '/api/admin/estimate/requests/:id/approve',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const r = await store.estimateRequests.findOne({ _id: id });
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    if (r.quote_id)
      return res.status(409).json({ error: 'That request has already been turned into a quote.' });

    const quoteId = await store.nextId('quotes');
    const now = new Date();
    const quote = {
      _id: quoteId,
      number: 'Q' + String(1000 + quoteId),
      customer: cleanCustomer(r.customer),
      quote_date: now,
      items: cleanItems(
        (r.items || []).map((i) => ({
          description: i.description,
          qty: i.qty,
          unit: i.unit,
          unit_price: i.unit_price,
        }))
      ),
      tax_rate: toNum(r.tax_rate),
      notes: r.notes || '',
      status: 'draft',
      // Where it came from, so the estimator can reread the original request.
      source: { type: 'estimate', request_id: id },
      created_at: now,
      updated_at: now,
    };
    await store.quotes.insertOne(quote);
    await store.estimateRequests.updateOne(
      { _id: id },
      { $set: { status: 'approved', quote_id: quoteId, approved_at: now } }
    );
    res.json({ ok: true, quote: quoteView(quote) });
  })
);

app.post(
  '/api/admin/estimate/requests/:id/dismiss',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const r = await store.estimateRequests.findOneAndUpdate(
      { _id: id },
      { $set: { status: 'dismissed', dismissed_at: new Date() } }
    );
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    res.json({ ok: true });
  })
);

app.delete(
  '/api/admin/estimate/requests/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const r = await store.estimateRequests.deleteOne({ _id: Number(req.params.id) });
    if (!r.deletedCount) return res.status(404).json({ error: 'Request not found.' });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Admin: invoices
//
// An invoice is money owed, so unlike a quote it tracks payments and a due
// date. "Paid" and "overdue" are never stored — they are derived from the
// payments and the due date every time it is read, so a recorded payment can
// never disagree with the status shown next to it.
// ---------------------------------------------------------------------------

// Stored statuses only. paid / overdue are computed in invoiceView.
const INVOICE_STATUSES = new Set(['draft', 'sent', 'void']);
const DEFAULT_TERMS_DAYS = 30;

function cleanPayments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => ({
      amount: round2(toNum(p?.amount)),
      date: p?.date ? new Date(p.date) : new Date(),
      method: String(p?.method || '').trim(),
      note: String(p?.note || '').trim(),
    }))
    .filter((p) => p.amount > 0 && !isNaN(p.date));
}

const todayLocal = () => qbo.localDay(new Date());

function invoiceView(inv) {
  const totals = quoteTotals(inv.items, inv.tax_rate);
  const payments = (inv.payments || []).map((p) => ({ ...p, date: iso(p.date) }));
  const paid = round2(payments.reduce((s, p) => s + toNum(p.amount), 0));
  const balance = round2(totals.total - paid);
  const dueDay = inv.due_date ? qbo.localDay(inv.due_date) : null;

  // The stored status only says what the office did with it. Whether it is
  // settled or late falls out of the numbers.
  let status = inv.status || 'draft';
  if (status !== 'void' && status !== 'draft') {
    if (totals.total > 0 && balance <= 0) status = 'paid';
    else if (dueDay && dueDay < todayLocal()) status = 'overdue';
  }

  return {
    id: inv._id,
    number: inv.number,
    customer: inv.customer || { name: '', address: '', phone: '', email: '' },
    items: inv.items || [],
    tax_rate: inv.tax_rate || 0,
    notes: inv.notes || '',
    issue_date: iso(inv.issue_date),
    due_date: iso(inv.due_date),
    stored_status: inv.status || 'draft',
    status,
    quote_id: inv.quote_id || null,
    // Where this invoice stands in QuickBooks, so the list can show it without
    // asking Intuit on every page load.
    qbo: inv.qbo
      ? {
          id: inv.qbo.id || null,
          doc_number: inv.qbo.doc_number || null,
          synced_at: iso(inv.qbo.synced_at),
          sent_at: iso(inv.qbo.sent_at),
          sent_to: inv.qbo.sent_to || null,
        }
      : null,
    payments,
    paid,
    balance,
    created_at: iso(inv.created_at),
    updated_at: iso(inv.updated_at),
    ...totals,
  };
}

function readInvoiceFields(b, { partial } = {}) {
  const set = {};
  if (b.customer != null || !partial) set.customer = cleanCustomer(b.customer);
  if (b.items != null || !partial) set.items = cleanItems(b.items);
  if (b.tax_rate != null || !partial) set.tax_rate = toNum(b.tax_rate);
  if (b.notes != null) set.notes = String(b.notes || '').trim();
  if (b.issue_date != null) set.issue_date = b.issue_date ? new Date(b.issue_date) : new Date();
  if (b.due_date != null) set.due_date = b.due_date ? new Date(b.due_date) : null;
  if (b.status != null && INVOICE_STATUSES.has(b.status)) set.status = b.status;
  if (b.payments != null) set.payments = cleanPayments(b.payments);
  return set;
}

app.get(
  '/api/admin/invoices',
  requireAdmin,
  wrap(async (req, res) => {
    const rows = await store.invoices.find({}, { sort: { created_at: -1 } }).toArray();
    const invoices = rows.map(invoiceView);
    // Totals for the header tiles. Voided invoices are money that was never
    // owed, so they're left out of both.
    const live = invoices.filter((i) => i.status !== 'void');
    res.json({
      invoices,
      totals: {
        outstanding: round2(live.reduce((s, i) => s + Math.max(0, i.balance), 0)),
        overdue: round2(
          live.filter((i) => i.status === 'overdue').reduce((s, i) => s + Math.max(0, i.balance), 0)
        ),
        paid: round2(live.reduce((s, i) => s + i.paid, 0)),
        count: live.length,
      },
    });
  })
);

app.get(
  '/api/admin/invoices/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const inv = await store.invoices.findOne({ _id: Number(req.params.id) });
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    res.json(invoiceView(inv));
  })
);

app.post(
  '/api/admin/invoices',
  requireAdmin,
  wrap(async (req, res) => {
    const b = req.body || {};
    const set = readInvoiceFields(b, { partial: false });
    if (!set.customer.name) return res.status(400).json({ error: 'Customer name is required.' });

    const _id = await store.nextId('invoices');
    const now = new Date();
    const issue = set.issue_date || now;
    const doc = {
      _id,
      number: 'INV-' + String(1000 + _id),
      ...set,
      issue_date: issue,
      due_date: set.due_date || new Date(issue.getTime() + DEFAULT_TERMS_DAYS * 86400000),
      status: set.status || 'draft',
      payments: set.payments || [],
      quote_id: Number.isInteger(b.quote_id) ? b.quote_id : null,
      created_at: now,
      updated_at: now,
    };
    await store.invoices.insertOne(doc);
    res.json(invoiceView(doc));
  })
);

app.patch(
  '/api/admin/invoices/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const inv = await store.invoices.findOne({ _id: id });
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const set = readInvoiceFields(req.body || {}, { partial: true });
    if (set.customer && !set.customer.name)
      return res.status(400).json({ error: 'Customer name is required.' });
    set.updated_at = new Date();
    await store.invoices.updateOne({ _id: id }, { $set: set });
    res.json(invoiceView(await store.invoices.findOne({ _id: id })));
  })
);

// Record a payment against an invoice. Kept separate from the general edit so
// taking money is its own deliberate action, not a side effect of saving a form.
app.post(
  '/api/admin/invoices/:id/payments',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const inv = await store.invoices.findOne({ _id: id });
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const [payment] = cleanPayments([req.body || {}]);
    if (!payment) return res.status(400).json({ error: 'Enter a payment amount.' });
    await store.invoices.updateOne(
      { _id: id },
      { $push: { payments: payment }, $set: { updated_at: new Date() } }
    );
    res.json(invoiceView(await store.invoices.findOne({ _id: id })));
  })
);

app.delete(
  '/api/admin/invoices/:id/payments/:index',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const inv = await store.invoices.findOne({ _id: id });
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const index = Number(req.params.index);
    const payments = [...(inv.payments || [])];
    if (!Number.isInteger(index) || index < 0 || index >= payments.length)
      return res.status(404).json({ error: 'Payment not found.' });
    payments.splice(index, 1);
    await store.invoices.updateOne(
      { _id: id },
      { $set: { payments, updated_at: new Date() } }
    );
    res.json(invoiceView(await store.invoices.findOne({ _id: id })));
  })
);

// Turn an accepted quote into an invoice, carrying the customer and pricing
// across so nothing is retyped.
app.post(
  '/api/admin/quotes/:id/invoice',
  requireAdmin,
  wrap(async (req, res) => {
    const quoteId = Number(req.params.id);
    const q = await store.quotes.findOne({ _id: quoteId });
    if (!q) return res.status(404).json({ error: 'Quote not found.' });

    const existing = await store.invoices.findOne({ quote_id: quoteId });
    if (existing)
      return res.status(409).json({
        error: `That quote is already invoiced as ${existing.number}.`,
        invoice_id: existing._id,
      });

    const _id = await store.nextId('invoices');
    const now = new Date();
    const doc = {
      _id,
      number: 'INV-' + String(1000 + _id),
      customer: q.customer || { name: '', address: '', phone: '', email: '' },
      items: q.items || [],
      tax_rate: q.tax_rate || 0,
      notes: q.notes || '',
      issue_date: now,
      due_date: new Date(now.getTime() + DEFAULT_TERMS_DAYS * 86400000),
      status: 'draft',
      payments: [],
      quote_id: quoteId,
      created_at: now,
      updated_at: now,
    };
    await store.invoices.insertOne(doc);
    // Accepting is implied by billing for it.
    if (q.status !== 'accepted')
      await store.quotes.updateOne({ _id: quoteId }, { $set: { status: 'accepted', updated_at: now } });
    res.json(invoiceView(doc));
  })
);

app.delete(
  '/api/admin/invoices/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const inv = await store.invoices.findOne({ _id: Number(req.params.id) });
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    // Deleting a paid invoice erases the record of money received. Voiding
    // keeps the number and the history, which is what the books need.
    if ((inv.payments || []).length)
      return res
        .status(409)
        .json({ error: 'This invoice has payments recorded. Void it instead of deleting it.' });
    await store.invoices.deleteOne({ _id: Number(req.params.id) });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Invoices -> QuickBooks. QuickBooks is what actually emails a customer, so
// this pushes the invoice across and then asks QuickBooks to send it. Pushing
// twice updates the same QuickBooks invoice rather than making a second one.
// ---------------------------------------------------------------------------

// Record what QuickBooks said against our copy, so the UI can show where an
// invoice stands without asking Intuit again on every page load.
async function saveQboState(id, patch) {
  const set = {};
  for (const [k, v] of Object.entries(patch)) set['qbo.' + k] = v;
  set.updated_at = new Date();
  await store.invoices.updateOne({ _id: id }, { $set: set });
}

app.post(
  '/api/admin/invoices/:id/quickbooks',
  requireAdmin,
  qbWrap(async (req, res) => {
    const id = Number(req.params.id);
    const inv = await store.invoices.findOne({ _id: id });
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    if ((inv.status || 'draft') === 'void')
      return res.status(409).json({ error: 'That invoice is void — nothing to send.' });

    // Push the totals the office sees, not the raw doc, so what lands in
    // QuickBooks matches the invoice on screen.
    const view = invoiceView(inv);
    const result = await qbo.pushInvoice({ ...view, qbo: inv.qbo });
    await saveQboState(id, {
      id: result.id,
      doc_number: result.doc_number,
      total: result.total,
      customer_id: result.customer.id,
      synced_at: new Date(),
    });
    res.json({
      ok: true,
      qbo: result,
      link: await qbo.invoiceLink(result.id),
      // Surfaced rather than swallowed: our flat tax percentage and
      // QuickBooks' tax engine can legitimately disagree.
      warning: result.mismatch
        ? `QuickBooks totalled this at ${result.mismatch.theirs.toFixed(2)} where we have ` +
          `${result.mismatch.ours.toFixed(2)}. QuickBooks works tax out from its own tax code, ` +
          `so check the tax setting before sending.`
        : null,
    });
  })
);

app.post(
  '/api/admin/invoices/:id/quickbooks/send',
  requireAdmin,
  qbWrap(async (req, res) => {
    const id = Number(req.params.id);
    const inv = await store.invoices.findOne({ _id: id });
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    if (!inv.qbo || !inv.qbo.id)
      return res.status(409).json({ error: 'Send it to QuickBooks first.' });

    const to = String((req.body && req.body.email) || (inv.customer && inv.customer.email) || '').trim();
    if (!to)
      return res
        .status(400)
        .json({ error: 'No email address to send to — add one to the invoice first.' });

    const sent = await qbo.sendInvoice(inv.qbo.id, to);
    await saveQboState(id, { sent_at: new Date(), sent_to: sent.sent_to, email_status: sent.status });
    // Emailing it is the moment it stops being a draft on our side too.
    if ((inv.status || 'draft') === 'draft')
      await store.invoices.updateOne({ _id: id }, { $set: { status: 'sent' } });
    res.json({ ok: true, sent_to: sent.sent_to, status: sent.status });
  })
);

// ---------------------------------------------------------------------------
// Admin: AI inbox — reads the mailbox and drafts quotes (see inbox.js).
//
// Nothing here sends mail or creates a quote on its own. The agent files
// *leads*; approving one is what turns it into a quote.
// ---------------------------------------------------------------------------

const inboxWrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (res.headersSent) return;
    if (err instanceof inbox.InboxError)
      return res
        .status(err.status || 400)
        .json({ error: err.message, detail: err.detail || undefined });
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  });

function leadView(l) {
  return {
    id: l._id,
    from_name: l.from_name,
    from_email: l.from_email,
    subject: l.subject,
    received_at: iso(l.received_at),
    body: l.body,
    status: l.status,
    ai: l.ai || null,
    draft: l.draft || null,
    quote_id: l.quote_id || null,
    created_at: iso(l.created_at),
  };
}

app.get(
  '/api/admin/inbox/status',
  requireAdmin,
  inboxWrap(async (req, res) => {
    res.json({ ...(await inbox.getStatus()), models: inbox.ALLOWED_MODELS });
  })
);

app.patch(
  '/api/admin/inbox/settings',
  requireAdmin,
  inboxWrap(async (req, res) => {
    await inbox.saveSettings(req.body || {});
    res.json({ ...(await inbox.getStatus()), models: inbox.ALLOWED_MODELS });
  })
);

app.post(
  '/api/admin/inbox/test',
  requireAdmin,
  inboxWrap(async (req, res) => {
    res.json(await inbox.testConnection(req.body || {}));
  })
);

app.get(
  '/api/admin/inbox/leads',
  requireAdmin,
  inboxWrap(async (req, res) => {
    const status = String(req.query.status || 'new');
    const q = status === 'all' ? {} : { status };
    const rows = await store.inboxLeads
      .find(q, { sort: { received_at: -1 }, limit: 100 })
      .toArray();
    res.json({ leads: rows.map(leadView) });
  })
);

app.post(
  '/api/admin/inbox/scan',
  requireAdmin,
  inboxWrap(async (req, res) => {
    res.json(await inbox.scan({ trigger: 'manual', actor: await adminActor(req) }));
  })
);

// Approve a lead: create the quote from the (possibly edited) draft and mark
// the lead done. The draft sent back from the browser wins, so a correction
// made while reviewing is what gets saved.
app.post(
  '/api/admin/inbox/leads/:id/approve',
  requireAdmin,
  inboxWrap(async (req, res) => {
    const id = Number(req.params.id);
    const lead = await store.inboxLeads.findOne({ _id: id });
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    if (lead.quote_id)
      return res.status(409).json({ error: 'That email has already been turned into a quote.' });

    const draft = req.body && req.body.draft ? req.body.draft : lead.draft || {};
    const customer = cleanCustomer(draft.customer);
    if (!customer.name) return res.status(400).json({ error: 'Customer name is required.' });

    const quoteId = await store.nextId('quotes');
    const now = new Date();
    const quote = {
      _id: quoteId,
      number: 'Q' + String(1000 + quoteId),
      customer,
      quote_date: now,
      items: cleanItems(draft.items),
      tax_rate: toNum(draft.tax_rate),
      notes: String(draft.notes || '').trim(),
      status: 'draft',
      // Where it came from, so the estimator can reread the email later.
      source: { type: 'inbox', lead_id: id, subject: lead.subject, from: lead.from_email },
      created_at: now,
      updated_at: now,
    };
    await store.quotes.insertOne(quote);
    await store.inboxLeads.updateOne(
      { _id: id },
      { $set: { status: 'approved', quote_id: quoteId, draft, approved_at: now } }
    );
    res.json({ ok: true, quote: quoteView(quote) });
  })
);

app.post(
  '/api/admin/inbox/leads/:id/dismiss',
  requireAdmin,
  inboxWrap(async (req, res) => {
    const id = Number(req.params.id);
    const r = await store.inboxLeads.updateOne(
      { _id: id },
      { $set: { status: 'dismissed', dismissed_at: new Date() } }
    );
    if (!r.matchedCount) return res.status(404).json({ error: 'Lead not found.' });
    res.json({ ok: true });
  })
);

const cronInboxScan = inboxWrap(async (req, res) => {
  if (!cronAuthorized(req)) {
    return res.status(401).json({
      error: process.env.CRON_SECRET
        ? 'Not authorized.'
        : 'CRON_SECRET is not set on the server, so the scheduled scan is disabled.',
    });
  }
  res.json(await inbox.runScheduledScan());
});
app.get('/api/cron/inbox-scan', cronInboxScan);
app.post('/api/cron/inbox-scan', cronInboxScan);

// ---------------------------------------------------------------------------
// Admin: "My Tasks" board — a kanban card assigned to a single employee.
// Anyone with dashboard access (admin or the dev account) can create and manage
// tasks; a task can only be assigned to an employee who holds the "tasks"
// permission. Cards move between the To Do / In Progress / Done columns.
// ---------------------------------------------------------------------------

const TASK_STATUSES = ['todo', 'in_progress', 'done'];
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// A short label for whoever is acting, used on comments and the history log.
const actorName = (req) => (req.session && req.session.role === 'dev' ? 'dev' : 'admin');

// The employees a task may be assigned to: active employees granted "tasks".
async function taskAssignees() {
  const rows = await store.employees
    .find({ active: true, permissions: 'tasks' }, { sort: { name: 1 } })
    .toArray();
  return rows.map((e) => ({ id: e._id, name: e.name }));
}

// Shape a task document for the UI, resolving the assignee's name.
function taskView(t, nameById) {
  const time = (t.time_entries || []).reduce((s, e) => {
    const end = e.end ? new Date(e.end) : null;
    return s + (end ? (end - new Date(e.start)) / 1000 : 0);
  }, 0);
  const running = (t.time_entries || []).some((e) => !e.end);
  return {
    id: t._id,
    title: t.title,
    description: t.description || '',
    status: TASK_STATUSES.includes(t.status) ? t.status : 'todo',
    group: t.group || '',
    assignee_id: t.assignee_id == null ? null : t.assignee_id,
    assignee_name: t.assignee_id != null ? nameById[t.assignee_id] || null : null,
    task_type: t.task_type || 'Other',
    labels: t.labels || [],
    priority: TASK_PRIORITIES.includes(t.priority) ? t.priority : 'low',
    due_date: t.due_date || null,
    linked_record: t.linked_record || null,
    completed: !!t.completed,
    order: t.order || 0,
    comments: (t.comments || []).map((c) => ({ ...c, at: iso(c.at) })),
    history: (t.history || []).map((h) => ({ ...h, at: iso(h.at) })),
    attachments: (t.attachments || []).map((a) => ({ ...a, at: iso(a.at) })),
    time_seconds: Math.round(time),
    timer_running: running,
    created_at: iso(t.created_at),
    updated_at: iso(t.updated_at),
  };
}

// Validate + normalize the writable fields shared by create and update. Returns
// { set } on success or { error } when a value is invalid.
async function readTaskFields(body, { partial } = {}) {
  const set = {};
  const has = (k) => body && body[k] !== undefined;

  if (!partial || has('title')) {
    const title = String((body && body.title) || '').trim();
    if (!title) return { error: 'A task needs a title.' };
    set.title = title.slice(0, 300);
  }
  if (has('description')) set.description = String(body.description || '').slice(0, 5000);
  if (has('group')) set.group = String(body.group || '').trim().slice(0, 60);
  if (has('task_type')) set.task_type = String(body.task_type || '').trim().slice(0, 60) || 'Other';
  if (has('linked_record'))
    set.linked_record = body.linked_record ? String(body.linked_record).slice(0, 200) : null;

  if (has('status')) {
    if (!TASK_STATUSES.includes(body.status)) return { error: 'Unknown status.' };
    set.status = body.status;
  }
  if (has('priority')) {
    if (!TASK_PRIORITIES.includes(body.priority)) return { error: 'Unknown priority.' };
    set.priority = body.priority;
  }
  if (has('labels')) {
    if (!Array.isArray(body.labels)) return { error: 'Labels must be a list.' };
    set.labels = [...new Set(body.labels.map((l) => String(l).trim()).filter(Boolean))].slice(0, 20);
  }
  if (has('due_date')) {
    const d = body.due_date;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'Bad due date.' };
    set.due_date = d || null;
  }
  if (has('completed')) set.completed = !!body.completed;
  if (has('order')) set.order = Number(body.order) || 0;

  if (has('assignee_id')) {
    if (body.assignee_id == null || body.assignee_id === '') {
      set.assignee_id = null;
    } else {
      const id = Number(body.assignee_id);
      const emp = await store.employees.findOne({ _id: id, active: true });
      if (!emp) return { error: 'That employee no longer exists.' };
      if (!(emp.permissions || []).includes('tasks'))
        return { error: 'That employee does not have the My Tasks permission.' };
      set.assignee_id = id;
    }
  }
  return { set };
}

app.get(
  '/api/admin/tasks',
  requireAdmin,
  wrap(async (req, res) => {
    const rows = await store.tasks.find({}, { sort: { order: 1, _id: 1 } }).toArray();
    const ids = [...new Set(rows.map((t) => t.assignee_id).filter((x) => x != null))];
    const emps = ids.length ? await store.employees.find({ _id: { $in: ids } }).toArray() : [];
    const nameById = Object.fromEntries(emps.map((e) => [e._id, e.name]));
    res.json({
      tasks: rows.map((t) => taskView(t, nameById)),
      assignees: await taskAssignees(),
    });
  })
);

app.post(
  '/api/admin/tasks',
  requireAdmin,
  wrap(async (req, res) => {
    const { set, error } = await readTaskFields(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const status = set.status || 'todo';
    // New cards go to the top of their column.
    const first = await store.tasks.find({ status }).sort({ order: 1 }).limit(1).toArray();
    const doc = {
      _id: await store.nextId('tasks'),
      title: set.title,
      description: set.description || '',
      status,
      group: set.group || '',
      assignee_id: set.assignee_id ?? null,
      task_type: set.task_type || 'Other',
      labels: set.labels || [],
      priority: set.priority || 'low',
      due_date: set.due_date || null,
      linked_record: set.linked_record || null,
      completed: false,
      order: (first[0] ? first[0].order : 0) - 1,
      comments: [],
      history: [{ id: 1, text: `Task created by ${actorName(req)}`, at: new Date() }],
      time_entries: [],
      created_at: new Date(),
      updated_at: new Date(),
    };
    await store.tasks.insertOne(doc);
    const emp = doc.assignee_id != null
      ? await store.employees.findOne({ _id: doc.assignee_id })
      : null;
    res.json(taskView(doc, emp ? { [emp._id]: emp.name } : {}));
  })
);

app.patch(
  '/api/admin/tasks/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await store.tasks.findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: 'Task not found.' });
    const { set, error } = await readTaskFields(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });

    // Log meaningful changes to the history feed.
    const log = [];
    const who = actorName(req);
    if (set.status && set.status !== existing.status)
      log.push(`Moved to ${set.status.replace('_', ' ')} by ${who}`);
    if (set.priority && set.priority !== existing.priority)
      log.push(`Priority set to ${set.priority} by ${who}`);
    if ('assignee_id' in set && set.assignee_id !== existing.assignee_id) {
      const name = set.assignee_id != null
        ? (await store.employees.findOne({ _id: set.assignee_id }))?.name || 'someone'
        : null;
      log.push(name ? `Assigned to ${name} by ${who}` : `Unassigned by ${who}`);
    }

    set.updated_at = new Date();
    const update = { $set: set };
    if (log.length) {
      const nextId = (existing.history || []).reduce((m, h) => Math.max(m, h.id), 0) + 1;
      update.$push = {
        history: { $each: log.map((text, i) => ({ id: nextId + i, text, at: new Date() })) },
      };
    }
    await store.tasks.updateOne({ _id: id }, update);
    const updated = await store.tasks.findOne({ _id: id });
    const emp = updated.assignee_id != null
      ? await store.employees.findOne({ _id: updated.assignee_id })
      : null;
    res.json(taskView(updated, emp ? { [emp._id]: emp.name } : {}));
  })
);

app.delete(
  '/api/admin/tasks/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await store.tasks.deleteOne({ _id: id });
    await store.taskAttachments.deleteMany({ task_id: id }); // drop its files too
    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/tasks/:id/comment',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'Write a comment first.' });
    const t = await store.tasks.findOne({ _id: id });
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    const nextId = (t.comments || []).reduce((m, c) => Math.max(m, c.id), 0) + 1;
    const comment = { id: nextId, author: actorName(req), text: text.slice(0, 2000), at: new Date() };
    await store.tasks.updateOne(
      { _id: id },
      { $push: { comments: comment }, $set: { updated_at: new Date() } }
    );
    res.json({ ...comment, at: iso(comment.at) });
  })
);

// Start or stop the work timer on a task. Only one entry is ever open at a time.
app.post(
  '/api/admin/tasks/:id/timer',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await store.tasks.findOne({ _id: id });
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    const entries = t.time_entries || [];
    const open = entries.find((e) => !e.end);
    if (req.body && req.body.action === 'stop') {
      if (open) open.end = new Date();
    } else {
      if (!open) {
        const nextId = entries.reduce((m, e) => Math.max(m, e.id), 0) + 1;
        entries.push({ id: nextId, start: new Date(), end: null });
      }
    }
    await store.tasks.updateOne(
      { _id: id },
      { $set: { time_entries: entries, updated_at: new Date() } }
    );
    const emp = t.assignee_id != null ? await store.employees.findOne({ _id: t.assignee_id }) : null;
    const updated = await store.tasks.findOne({ _id: id });
    res.json(taskView(updated, emp ? { [emp._id]: emp.name } : {}));
  })
);

// Task file attachments. The blob lives in its own collection; only lightweight
// metadata is mirrored onto the task so the board lists files without the data.
const TASK_ATTACH_MAX = 4 * 1024 * 1024; // 4 MB per file (Netlify-payload safe)
const safeName = (s) => String(s || 'file').replace(/[\r\n"\\]/g, '').slice(0, 200) || 'file';

app.post(
  '/api/admin/tasks/:id/attachments',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await store.tasks.findOne({ _id: id });
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    const { filename, content_type, data } = req.body || {};
    if (!data || typeof data !== 'string')
      return res.status(400).json({ error: 'No file data received.' });
    let buf;
    try {
      buf = Buffer.from(data, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Could not read that file.' });
    }
    if (!buf.length) return res.status(400).json({ error: 'That file is empty.' });
    if (buf.length > TASK_ATTACH_MAX)
      return res.status(400).json({ error: 'File is too large (max 4 MB).' });

    const attId = crypto.randomUUID();
    const meta = {
      id: attId,
      filename: safeName(filename),
      content_type: String(content_type || 'application/octet-stream').slice(0, 120),
      size: buf.length,
      uploaded_by: actorName(req),
      at: new Date(),
    };
    await store.taskAttachments.insertOne({
      _id: attId,
      task_id: id,
      filename: meta.filename,
      content_type: meta.content_type,
      data: buf,
    });
    await store.tasks.updateOne(
      { _id: id },
      { $push: { attachments: meta }, $set: { updated_at: new Date() } }
    );
    res.json({ ...meta, at: iso(meta.at) });
  })
);

app.get(
  '/api/admin/tasks/:id/attachments/:attId',
  requireAdmin,
  wrap(async (req, res) => {
    const blob = await store.taskAttachments.findOne({
      _id: req.params.attId,
      task_id: Number(req.params.id),
    });
    if (!blob) return res.status(404).json({ error: 'Attachment not found.' });
    const raw = blob.data;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw && raw.buffer ? raw.buffer : raw);
    res.setHeader('Content-Type', blob.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${safeName(blob.filename)}"`);
    res.send(buf);
  })
);

app.delete(
  '/api/admin/tasks/:id/attachments/:attId',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const attId = req.params.attId;
    await store.taskAttachments.deleteOne({ _id: attId, task_id: id });
    await store.tasks.updateOne(
      { _id: id },
      { $pull: { attachments: { id: attId } }, $set: { updated_at: new Date() } }
    );
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Time-off / vacation requests — an employee requests a date range; the admin
// approves or declines it. Available to every signed-in employee (no special
// permission), like their hours and schedule.
// ---------------------------------------------------------------------------

const VACATION_STATUSES = ['pending', 'approved', 'declined'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Whole days covered by an inclusive date range (both ends counted).
function dayCount(start, end) {
  const ms = new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z');
  return Math.floor(ms / 86400000) + 1;
}

// Shape a request for the UI, resolving the employee's name.
function vacationView(v, name) {
  return {
    id: v._id,
    employee_id: v.employee_id,
    employee_name: name || '(deleted)',
    start_date: v.start_date,
    end_date: v.end_date,
    days: dayCount(v.start_date, v.end_date),
    reason: v.reason || '',
    status: VACATION_STATUSES.includes(v.status) ? v.status : 'pending',
    admin_note: v.admin_note || '',
    created_at: iso(v.created_at),
    decided_at: iso(v.decided_at),
    decided_by: v.decided_by || null,
  };
}

// Validate the { start_date, end_date, reason } an employee submits.
function readVacationFields(body) {
  const start_date = String((body && body.start_date) || '').trim();
  const end_date = String((body && body.end_date) || '').trim();
  if (!isDate(start_date) || !isDate(end_date))
    return { error: 'Pick a start and end date.' };
  if (end_date < start_date)
    return { error: 'The end date must be on or after the start date.' };
  const reason = String((body && body.reason) || '').trim().slice(0, 1000);
  return { set: { start_date, end_date, reason } };
}

// An employee's own time-off requests, newest first.
app.get(
  '/api/my/vacations',
  requireEmployee,
  wrap(async (req, res) => {
    const rows = await store.vacations
      .find({ employee_id: req.employee._id })
      .sort({ created_at: -1 })
      .toArray();
    res.json({ requests: rows.map((v) => vacationView(v, req.employee.name)) });
  })
);

// Submit a new request (always starts pending).
app.post(
  '/api/my/vacations',
  requireEmployee,
  wrap(async (req, res) => {
    const { set, error } = readVacationFields(req.body || {});
    if (error) return res.status(400).json({ error });
    const doc = {
      _id: await store.nextId('vacations'),
      employee_id: req.employee._id,
      start_date: set.start_date,
      end_date: set.end_date,
      reason: set.reason,
      status: 'pending',
      admin_note: '',
      created_at: new Date(),
      updated_at: new Date(),
      decided_at: null,
      decided_by: null,
    };
    await store.vacations.insertOne(doc);
    res.json(vacationView(doc, req.employee.name));
  })
);

// Cancel one of my own requests — only while it is still pending.
app.delete(
  '/api/my/vacations/:id',
  requireEmployee,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const v = await store.vacations.findOne({ _id: id, employee_id: req.employee._id });
    if (!v) return res.status(404).json({ error: 'Request not found.' });
    if (v.status !== 'pending')
      return res.status(400).json({ error: 'That request has already been decided.' });
    await store.vacations.deleteOne({ _id: id });
    res.json({ ok: true });
  })
);

// Admin: every time-off request, with employee names. Optional ?status= filter.
app.get(
  '/api/admin/vacations',
  requireAdmin,
  wrap(async (req, res) => {
    const filter = {};
    if (VACATION_STATUSES.includes(req.query.status)) filter.status = req.query.status;
    const rows = await store.vacations
      .find(filter)
      .sort({ status: 1, start_date: 1 })
      .toArray();
    const ids = [...new Set(rows.map((v) => v.employee_id))];
    const emps = ids.length ? await store.employees.find({ _id: { $in: ids } }).toArray() : [];
    const nameById = Object.fromEntries(emps.map((e) => [e._id, e.name]));
    const pending = await store.vacations.countDocuments({ status: 'pending' });
    res.json({
      requests: rows.map((v) => vacationView(v, nameById[v.employee_id])),
      pending,
    });
  })
);

// Admin: approve or decline a request (optionally with a note).
app.patch(
  '/api/admin/vacations/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body && req.body.status;
    if (status !== 'approved' && status !== 'declined')
      return res.status(400).json({ error: 'Choose approve or decline.' });
    const v = await store.vacations.findOne({ _id: id });
    if (!v) return res.status(404).json({ error: 'Request not found.' });
    const admin_note = String((req.body && req.body.admin_note) || '').trim().slice(0, 1000);
    await store.vacations.updateOne(
      { _id: id },
      {
        $set: {
          status,
          admin_note,
          decided_at: new Date(),
          decided_by: actorName(req),
          updated_at: new Date(),
        },
      }
    );
    const emp = await store.employees.findOne({ _id: v.employee_id });
    res.json(vacationView({ ...v, status, admin_note, decided_at: new Date(), decided_by: actorName(req) }, emp && emp.name));
  })
);

// ---------------------------------------------------------------------------
// Bulletins / "Messages" — an admin-posted notice board. Every signed-in
// employee sees the messages targeted to them; the admin writes, schedules and
// tracks who has read each one. Content is Markdown, rendered on the client.
// ---------------------------------------------------------------------------

const BULLETIN_AUDIENCES = ['all', 'employees'];

// The display status of a bulletin: published now, scheduled for later, or a
// draft that hasn't been sent.
function bulletinStatus(b) {
  if (b.status === 'published') return 'published';
  if (b.publish_at && new Date(b.publish_at) > new Date()) return 'scheduled';
  return 'draft';
}

// True if this bulletin is meant for the given employee.
function bulletinMatchesEmployee(b, empId) {
  if (b.audience === 'all') return true;
  return Array.isArray(b.employee_ids) && b.employee_ids.includes(empId);
}

// There is no background job on serverless hosting, so a bulletin scheduled for
// a past time is promoted to "published" lazily, whenever the board is listed.
async function promoteScheduledBulletins() {
  const now = new Date();
  await store.bulletins.updateMany(
    { status: { $ne: 'published' }, publish_at: { $ne: null, $lte: now } },
    [{ $set: { status: 'published', published_at: { $ifNull: ['$published_at', '$publish_at'] } } }]
  );
}

// Validate the fields the admin submits for a new/edited bulletin.
function readBulletinFields(body, { partial }) {
  const set = {};
  if (!partial || body.title != null) {
    const title = String((body && body.title) || '').trim();
    if (!title) return { error: 'A title is required.' };
    set.title = title.slice(0, 200);
  }
  if (!partial || body.content != null) set.content = String((body && body.content) || '').slice(0, 20000);
  if (!partial || body.audience != null)
    set.audience = BULLETIN_AUDIENCES.includes(body && body.audience) ? body.audience : 'all';
  if (body && body.employee_ids != null) {
    set.employee_ids = Array.isArray(body.employee_ids)
      ? [...new Set(body.employee_ids.map(Number).filter(Number.isInteger))]
      : [];
  }
  if (body && body.publish_at !== undefined) {
    const s = String(body.publish_at || '').trim();
    if (!s) {
      set.publish_at = null;
      set.publish_date = '';
    } else if (isDate(s)) {
      // Publishes at 8 AM on the chosen day (server time). Close enough for a
      // notice board; the important thing is the day it appears.
      set.publish_at = new Date(s + 'T08:00:00');
      set.publish_date = s;
    }
  }
  return { set };
}

// Shape a bulletin for the admin management screen (includes the full content so
// the editor can open it without a second request).
function bulletinAdminView(b, empCount, nameById) {
  let target = 'All Employees';
  if (b.audience === 'employees') {
    const names = (b.employee_ids || []).map((id) => nameById[id] || '(removed)');
    target = names.length ? (names.length <= 2 ? names.join(', ') : `${names.length} employees`) : 'No one';
  }
  return {
    id: b._id,
    title: b.title,
    content: b.content || '',
    author: b.author || 'admin',
    audience: b.audience || 'all',
    employee_ids: b.employee_ids || [],
    target,
    status: bulletinStatus(b),
    date: iso(b.published_at || b.publish_at || b.created_at),
    publish_date: b.publish_date || '',
    read_count: (b.reads || []).length,
    audience_size: b.audience === 'all' ? empCount : (b.employee_ids || []).length,
  };
}

// Admin: every bulletin, newest first, with read counts and audience labels.
app.get(
  '/api/admin/bulletins',
  requireAdmin,
  wrap(async (req, res) => {
    await promoteScheduledBulletins();
    const rows = await store.bulletins.find({}).toArray();
    rows.sort(
      (a, b) =>
        new Date(b.published_at || b.publish_at || b.created_at) -
        new Date(a.published_at || a.publish_at || a.created_at)
    );
    const empCount = await store.employees.countDocuments({ active: true });
    const ids = [...new Set(rows.flatMap((b) => (b.audience === 'employees' ? b.employee_ids || [] : [])))];
    const emps = ids.length ? await store.employees.find({ _id: { $in: ids } }).toArray() : [];
    const nameById = Object.fromEntries(emps.map((e) => [e._id, e.name]));
    const activeEmps = await store.employees
      .find({ active: true }, { sort: { name: 1 } })
      .toArray();
    res.json({
      bulletins: rows.map((b) => bulletinAdminView(b, empCount, nameById)),
      employees: activeEmps.map((e) => ({ id: e._id, name: e.name })),
    });
  })
);

app.post(
  '/api/admin/bulletins',
  requireAdmin,
  wrap(async (req, res) => {
    const { set, error } = readBulletinFields(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const action = req.body && req.body.action; // 'publish' | 'draft'
    const now = new Date();
    let status = 'draft';
    let published_at = null;
    if (action === 'publish') {
      status = 'published';
      published_at = now;
    } else if (set.publish_at && set.publish_at <= now) {
      status = 'published';
      published_at = set.publish_at;
    }
    const doc = {
      _id: await store.nextId('bulletins'),
      title: set.title,
      content: set.content || '',
      audience: set.audience || 'all',
      employee_ids: set.audience === 'employees' ? set.employee_ids || [] : [],
      status,
      publish_at: set.publish_at || null,
      publish_date: set.publish_date || '',
      published_at,
      author: actorName(req),
      reads: [],
      created_at: now,
      updated_at: now,
    };
    await store.bulletins.insertOne(doc);
    res.json({ id: doc._id });
  })
);

app.patch(
  '/api/admin/bulletins/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const b = await store.bulletins.findOne({ _id: id });
    if (!b) return res.status(404).json({ error: 'Message not found.' });
    const { set, error } = readBulletinFields(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    if (set.audience === 'all') set.employee_ids = [];

    const action = req.body && req.body.action; // 'publish' | 'draft'
    const now = new Date();
    if (action === 'publish') {
      set.status = 'published';
      if (!b.published_at) set.published_at = now;
    } else if (action === 'draft') {
      set.status = 'draft';
      set.published_at = null;
    }
    set.updated_at = now;
    await store.bulletins.updateOne({ _id: id }, { $set: set });
    res.json({ ok: true });
  })
);

app.delete(
  '/api/admin/bulletins/:id',
  requireAdmin,
  wrap(async (req, res) => {
    await store.bulletins.deleteOne({ _id: Number(req.params.id) });
    res.json({ ok: true });
  })
);

// Employee: the published messages meant for me, newest first.
app.get(
  '/api/my/bulletins',
  requireEmployee,
  wrap(async (req, res) => {
    await promoteScheduledBulletins();
    const rows = await store.bulletins.find({ status: 'published' }).toArray();
    const mine = rows
      .filter((b) => bulletinMatchesEmployee(b, req.employee._id))
      .sort(
        (a, b) =>
          new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at)
      );
    res.json({
      bulletins: mine.map((b) => ({
        id: b._id,
        title: b.title,
        content: b.content || '',
        author: b.author || 'admin',
        published_at: iso(b.published_at || b.created_at),
        read: (b.reads || []).includes(req.employee._id),
      })),
      unread: mine.filter((b) => !(b.reads || []).includes(req.employee._id)).length,
    });
  })
);

// Employee: mark a message as read (idempotent).
app.post(
  '/api/my/bulletins/:id/read',
  requireEmployee,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const b = await store.bulletins.findOne({ _id: id, status: 'published' });
    if (!b) return res.status(404).json({ error: 'Message not found.' });
    if (!bulletinMatchesEmployee(b, req.employee._id))
      return res.status(403).json({ error: 'Not permitted.' });
    await store.bulletins.updateOne({ _id: id }, { $addToSet: { reads: req.employee._id } });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Static pages
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

// The public estimate maker. Served explicitly (not just as /estimate.html) so
// the clean "/estimate" URL works on hosts that route everything through this
// app. The page itself checks whether the feature is switched on.
app.get('/estimate', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'estimate.html'));
});

// Old URLs that no longer exist (the shared PIN clock, old admin paths) — send
// any stale bookmarks to the login page instead of 404ing. Employees now clock
// in from the portal at "/" after signing in.
for (const legacy of ['/timeclock', '/fence', '/office']) {
  if (legacy !== ADMIN_PATH) app.get(legacy, (req, res) => res.redirect('/'));
}

// Admin page is served from /views (outside the static folder) at ADMIN_PATH,
// so it is not reachable at a guessable /admin or /admin.html URL.
app.get(ADMIN_PATH, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// Anything that threw outside a wrap()ed handler still lands here, so the dev
// dashboard sees it rather than only the console. Registered after the routes,
// which is where Express looks for an error handler.
app.use((err, req, res, next) => {
  console.error(err);
  metrics
    .recordError({
      path: req.path,
      method: req.method,
      status: err && err.status ? err.status : 500,
      message: err && err.message,
      stack: err && err.stack,
      who: req.session && req.session.admin ? 'admin' : req.session && req.session.employeeId ? 'employee' : 'anonymous',
      timezone: TIMEZONE,
    })
    .catch(() => {});
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error.' });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Diagnostic: reports whether the database is reachable and, if not, the exact
// error. Always returns HTTP 200 so the body is easy to read.
app.get('/dbcheck', async (req, res) => {
  try {
    await connect();
    await store.client.db().command({ ping: 1 });
    res.json({ db: 'connected', hasUrl: !!process.env.DATABASE_URL });
  } catch (err) {
    res.json({
      db: 'FAILED',
      error: err.message,
      code: err.code || err.codeName || null,
      hasUrl: !!process.env.DATABASE_URL,
    });
  }
});

// Start a normal long-running server only when run directly (local / Render /
// any host that runs `node server.js`). When required by the Netlify function,
// this block is skipped and the function manages the DB connection itself.
if (require.main === module) {
  // Safety net: log transient errors instead of letting one bad request or a
  // brief database hiccup crash the whole server.
  process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
  });

  connect()
    .then(async () => {
      await getDevRecord().catch(() => {}); // ensure the dev account exists in the DB
      app.listen(PORT, () => {
        console.log(`HEK Timeclock running on http://localhost:${PORT}`);
        console.log(`  Employee portal:    http://localhost:${PORT}/`);
        console.log(`  Admin dashboard:    http://localhost:${PORT}${ADMIN_PATH}`);
      });
    })
    .catch((err) => {
      console.error('[FATAL] Could not connect to the database:', err.message);
      process.exit(1);
    });
}

module.exports = { app, connect };
