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

// The "dev" account is a limited admin: it can use the dashboard's non-clock-in
// features (quotes, pricing, scheduling, employees) but not the timeclock data,
// nor the admin's own login settings. Enforced here in one place.
const DEV_BLOCKED = [
  '/api/admin/active',
  '/api/admin/timesheet',
  '/api/admin/export.csv',
  '/api/admin/credentials',
];
app.use((req, res, next) => {
  if (req.session && req.session.role === 'dev') {
    if (DEV_BLOCKED.includes(req.path) || req.path.startsWith('/api/admin/punches')) {
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
];
// Which request paths belong to each feature (used to block them when disabled).
const FEATURE_MATCH = {
  quotes: (p) => p.startsWith('/api/admin/quotes'),
  schedule: (p) =>
    p.startsWith('/api/admin/schedules') ||
    p === '/api/admin/geocode' ||
    p.startsWith('/api/my/schedules'),
  pricing: () => false, // client-only calculator; no endpoints to guard
  map: (p) => p.startsWith('/api/admin/locations') || p.startsWith('/api/my/locations'),
  tasks: (p) => p.startsWith('/api/admin/tasks') || p.startsWith('/api/my/tasks'),
  messages: (p) => p.startsWith('/api/admin/bulletins') || p.startsWith('/api/my/bulletins'),
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
  ...ADMIN_FEATURES.map((f) => ({
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
    if (!res.headersSent) res.status(500).json({ error: 'Server error.' });
  });

async function getOpenPunch(employeeId) {
  return store.punches.findOne(
    { employee_id: employeeId, clock_out: null },
    { sort: { clock_in: -1 } }
  );
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
      ...(day ? { $or: [{ date: day }, { date: null }] } : { date: null }),
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
    .map((d) => ({ id: d._id, address: d.address, description: d.description || null }));
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
    const entries = rows.map((r) => {
      const hours = hoursOf(r);
      if (hours) total += hours;
      return { ...r, clock_in: iso(r.clock_in), clock_out: iso(r.clock_out), hours };
    });
    res.json({ entries, totalHours: Math.round(total * 100) / 100 });
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

    await store.punches.updateOne(
      { _id: open._id },
      { $set: { clock_out: out, work_done: workDone, jobs, ...(backdated ? { edited: true } : {}) } }
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
    await store.punches.updateOne(
      { _id: p._id },
      { $set: { clock_out: co, work_done: work, jobs, missed_reason: why, edited: true } }
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
    time: d.time || null,
    lat: d.lat ?? null,
    lng: d.lng ?? null,
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
      date: cleanDate(req.body?.date),
      time: cleanTime(req.body?.time),
      lat,
      lng,
      employee_ids: await cleanEmployeeIds(req.body?.employee_ids),
      created_at: new Date(),
      updated_at: new Date(),
    });
    res.json({ id: _id });
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
    if (req.body?.date != null) set.date = cleanDate(req.body.date);
    if (req.body?.time != null) set.time = cleanTime(req.body.time);
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
    await store.schedules.deleteOne({ _id: Number(req.params.id) });
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
  return named.map((r) => ({
    id: r._id,
    employee_id: r.employee_id,
    name: r.name,
    clock_in: r.clock_in,
    clock_out: r.clock_out,
    work_done: r.work_done,
    jobs: r.jobs || [],
    missed_reason: r.missed_reason,
    note: r.note,
    edited: r.edited,
    clock_in_lat: r.clock_in_lat ?? null,
    clock_in_lng: r.clock_in_lng ?? null,
  }));
}

function hoursOf(row) {
  if (!row.clock_out) return null;
  const ms = new Date(row.clock_out) - new Date(row.clock_in);
  return Math.round((ms / 3600000) * 100) / 100;
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
    const entries = rows.map((r) => {
      const hours = hoursOf(r);
      if (hours) total += hours;
      return { ...r, clock_in: iso(r.clock_in), clock_out: iso(r.clock_out), hours };
    });
    res.json({ entries, totalHours: Math.round(total * 100) / 100 });
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
    await store.punches.updateOne(
      { _id: id },
      {
        $set: {
          clock_in: ci,
          clock_out: co,
          work_done: workDone,
          missed_reason: missedReason,
          note,
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
      'Hours',
      'Jobs',
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
          csvCell(hoursOf(r) ?? ''),
          csvCell((r.jobs || []).map(jobLabel).join('; ')),
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
