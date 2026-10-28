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
// Attachment bytes live in object storage, never in a request body or a MongoDB
// document — see storage.js for why and for the two drivers.
const {
  storage,
  MAX_UPLOAD_BYTES,
  buildKey,
  disposition: storageDisposition,
  serving: storageServing,
  guardHeaders: storageGuard,
} = require('./storage');
const { connect, store } = require('./db');
const secrets = require('./secrets');
const qbo = require('./quickbooks');
const rateBook = require('./ratebook');
const inbox = require('./inbox');
const estimates = require('./estimates');
const metrics = require('./metrics');
// The fence estimator behind the quote editor: the takeoff engine (shared with
// the browser), the materials catalog it prices from, and the quote review.
const takeoff = require('./public/takeoff');
const docTotals = require('./public/totals');
const catalog = require('./catalog');
const quoteReview = require('./quotereview');
// The pages' scripts and stylesheet at content-hashed addresses (see below).
const assets = require('./assets');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@hekfencing.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
// A built-in "dev" account: a limited admin that can use everything in the
// dashboard EXCEPT the clock-in features. It exists only when DEV_PASSWORD is
// set to 12 or more characters — there is no default password, and the short
// one that was once published in this repository can never qualify. The stored
// login follows the env vars: change DEV_PASSWORD and the next start re-hashes it.
const DEV_EMAIL = (process.env.DEV_EMAIL || 'dev@hek-fencing.com').toLowerCase();
const DEV_PASSWORD = process.env.DEV_PASSWORD || '';
const DEV_ENABLED = DEV_PASSWORD.length >= 12;
if (DEV_PASSWORD && !DEV_ENABLED)
  console.warn('\n[WARN] DEV_PASSWORD is shorter than 12 characters — the dev account is off.\n');
// Signs every login cookie. Required, with no fallback — see secrets.js.
const SESSION_SECRET = secrets.sessionSecret();
// How long a login lasts. Enforced on the server, not just by the cookie's
// expiry, so a saved copy of an old cookie stops working too.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
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

// How far TIMEZONE is ahead of UTC at instant t, in milliseconds.
const zoneParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
function zoneOffsetAt(t) {
  const p = Object.fromEntries(zoneParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

// The instant a wall-clock time in TIMEZONE names: "2026-10-23T17:00" is 5 pm
// in Ontario, whatever zone this server runs in (UTC on every host we use).
// A date alone means its midnight. Invalid input gives an Invalid Date.
function wallTimeToDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s || '').trim());
  if (!m) return new Date(NaN);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // Date.UTC rolls "Feb 30" or "25:00" over into a real date; refuse those.
  const back = new Date(asUtc);
  if (
    back.getUTCMonth() !== +m[2] - 1 ||
    back.getUTCDate() !== +m[3] ||
    back.getUTCHours() !== +(m[4] || 0) ||
    back.getUTCMinutes() !== +(m[5] || 0)
  )
    return new Date(NaN);
  // Guess with the offset at that moment, then once more with the offset at
  // the guess, which settles a time near a daylight-saving change.
  let t = asUtc - zoneOffsetAt(asUtc);
  t = asUtc - zoneOffsetAt(t);
  return new Date(t);
}

// The instants a range of local calendar days covers, from/to inclusive, as a
// Mongo condition — or null when neither end is a real date. A day starts at
// midnight in TIMEZONE, not at midnight on the server's clock (UTC on every
// host we use, which put an 8 pm clock-in on the next day).
function dayRange(from, to) {
  const q = {};
  const start = from ? wallTimeToDate(String(from)) : null;
  const nextDay = (d) => {
    const t = Date.parse(String(d) + 'T12:00:00Z');
    return isNaN(t) ? '' : new Date(t + 86400000).toISOString().slice(0, 10);
  };
  const end = to ? wallTimeToDate(nextDay(to)) : null;
  if (start && !isNaN(start)) q.$gte = start;
  if (end && !isNaN(end)) q.$lt = end;
  return Object.keys(q).length ? q : null;
}

// A time sent by a browser. An ISO string with a zone (what the pages send) is
// exact; one without a zone was typed on a clock in TIMEZONE, so read it there
// instead of in the server's own zone.
function clientTime(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/.test(s)) return wallTimeToDate(s);
  return new Date(s);
}

if (ADMIN_PASSWORD.length < 8 || ADMIN_PASSWORD === 'changeme') {
  console.warn(
    '\n[WARN] ADMIN_PASSWORD is not set (or is under 8 characters). A new install will not ' +
      'create the built-in admin login until it is set. (An install that already has one keeps it.)\n'
  );
}

// Compressed responses: the scripts, the stylesheet and the JSON lists are all
// text that shrinks to about a fifth. Only when this file is the server itself
// (Render, a laptop). On Netlify and Vercel the pages and scripts come from
// their own CDN, which compresses them, and the function wrappers expect a
// plain body back.
if (require.main === module) app.use(require('compression')());

// When running as a Netlify function, requests arrive under a
// "/.netlify/functions/<name>" prefix. Strip it so the Express routes below see
// clean paths like "/api/status". Harmless when running as a normal server.
app.use((req, res, next) => {
  req.url = req.url.replace(/^\/\.netlify\/functions\/[^/?]+/, '');
  if (!req.url.startsWith('/')) req.url = '/' + req.url;
  next();
});

// Raised from the 100kb default for the app's larger JSON payloads (an estimate
// with its options, a ratebook import). File attachments no longer travel this
// way at all — they go straight to object storage from the browser (storage.js),
// so no request body needs to be anywhere near this size.
// Not on the storage drivers' part uploads (local and db): those are raw file
// bytes read by their own routes, and a part of a .json file arrives labelled
// application/json — parsing it here would eat (or refuse) the very bytes the
// route has to store. Any letter case, the way Express matches the routes.
const jsonBody = express.json({ limit: '6mb' });
app.use((req, res, next) =>
  /^\/api\/storage\/(local|db)\/part$/i.test(req.path) ? next() : jsonBody(req, res, next)
);
app.use(
  cookieSession({
    name: 'hek_sess',
    secret: SESSION_SECRET,
    maxAge: SESSION_TTL_MS,
    httpOnly: true,
    sameSite: 'lax',
  })
);
// Every host this runs on (Vercel, Netlify, Render) sits behind one proxy that
// ends HTTPS and says so in X-Forwarded-Proto. Trusting that one hop tells the
// app which requests really came over HTTPS, and on those the login cookie is
// marked Secure, so a browser never sends it over plain http to a custom
// domain. A plain-http request (a laptop) keeps an ordinary cookie.
app.set('trust proxy', 1);
app.use((req, res, next) => {
  if (req.secure) req.sessionOptions.secure = true;
  next();
});

// ---------------------------------------------------------------------------
// Is this login still good? Checked on every API request, before anything
// trusts req.session.
//
// A signed cookie only proves the server issued it, not that the person is
// still allowed in — the cookie carries no server-side state to revoke. So each
// request also confirms that:
//   - it is younger than SESSION_TTL_MS (the cookie's own expiry is only an
//     instruction to the browser, and a saved copy ignores it);
//   - the account still exists and is active — and an employee signed into
//     the dashboard still holds the "admin" permission;
//   - the login's email and password are the ones it was issued for, so
//     changing a password signs every other copy of that login out.
// A session that fails is dropped, and the request carries on signed out.
// ---------------------------------------------------------------------------

// A fingerprint of a login's current email + password, kept in the session.
// Keyed, so a cookie (which its holder can read) reveals nothing about the hash.
const credTag = (doc) =>
  crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`${(doc && doc.email) || ''}|${(doc && doc.password_hash) || ''}`)
    .digest('base64url')
    .slice(0, 22);

// The built-in admin and dev logins, cached briefly so a busy dashboard isn't
// a database read per request. A credentials change clears its own entry.
const accountCache = new Map();
async function builtInAccount(id, { fresh } = {}) {
  const hit = accountCache.get(id);
  if (!fresh && hit && Date.now() - hit.at < 15000) return hit.doc;
  const doc = id === 'dev' ? await getDevRecord() : await getAdminRecord();
  accountCache.set(id, { doc, at: Date.now() });
  return doc;
}

async function loginStillValid(req) {
  const s = req.session;
  const age = Date.now() - Number(s.iat);
  if (!Number.isFinite(age) || age < -60000 || age > SESSION_TTL_MS) return false;
  if (s.employeeId) {
    const emp = await store.employees.findOne({ _id: s.employeeId, active: true });
    if (!emp || s.cred !== credTag(emp)) return false;
    // An employee in the dashboard is there on the "admin" permission alone,
    // and is never the dev.
    if (s.admin && (s.role !== 'admin' || !(emp.permissions || []).includes('admin'))) return false;
    req.authEmployee = emp;
    return true;
  }
  if (!s.admin || (s.role !== 'admin' && s.role !== 'dev')) return false;
  const account = await builtInAccount(s.role);
  if (account && s.cred === credTag(account)) return true;
  // The cached copy may be the one that's stale: just after a login change
  // made through another running copy of the app, the new cookie matches the
  // database, not this cache. Look once more before signing anyone out.
  const latest = await builtInAccount(s.role, { fresh: true });
  return !!latest && s.cred === credTag(latest);
}

// Mounted on "/api" rather than tested with a string comparison: Express
// matches routes in any letter case, and so does app.use, so "/API/admin/…"
// is checked exactly like "/api/admin/…". (A case-sensitive startsWith here
// once let a revoked login through on a capitalised path.) The guards below
// refuse any session this check didn't pass.
app.use('/api', async (req, res, next) => {
  const s = req.session;
  if (!s || (!s.admin && !s.employeeId)) return next();
  try {
    if (await loginStillValid(req)) req.sessionChecked = true;
    else req.session = null;
    next();
  } catch (err) {
    // Fail closed: a login that can't be checked is not trusted.
    console.error('session check failed:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// A fresh session for a successful sign-in, built from scratch rather than
// edited in place, so nothing from an earlier login in the same browser (an
// employee id, a role) carries into the new one.
//   role: 'admin' | 'dev' | 'employee'; login: the employee or settings doc.
function startSession(req, role, login, { employee } = {}) {
  req.session = {
    admin: role === 'admin' || role === 'dev',
    role: role === 'employee' ? null : role,
    employeeId: employee ? login._id : null,
    email: (login && login.email) || null,
    iat: Date.now(),
    cred: credTag(login),
  };
}

// ---------------------------------------------------------------------------
// Local-disk storage endpoints.
//
// Only mounted when there is no bucket configured (a laptop with no cloud
// account). They stand in for presigned S3 URLs: the signed token in the query
// string IS the authorisation, exactly as the signature is in a presigned URL,
// and it names one operation on one object and expires.
// ---------------------------------------------------------------------------
if (storage.mode === 'local') {
  const fsp = require('fs/promises');
  const nodePath = require('path');

  // One part of a multipart upload. express.json is skipped for this path (see
  // where it is mounted), so the raw body is still here to be read.
  app.put(
    '/api/storage/local/part',
    // The token is checked before a byte of the body is read, so nobody without
    // a valid upload link can make the server buffer 64 MB.
    (req, res, next) => {
      const t = storage.verify(req.query.token);
      if (!t || t.op !== 'put')
        return res.status(403).json({ error: 'This upload link has expired.' });
      req.uploadToken = t;
      next();
    },
    // type:() => true, not '*/*': a Blob slice carries no MIME type, so the
    // browser sends the part with NO Content-Type header at all — and a matcher
    // based on the header skips exactly those requests, leaving req.body empty.
    express.raw({ type: () => true, limit: '64mb' }),
    (req, res) => {
      const t = req.uploadToken;
      let dest;
      try {
        dest = storage.partPath(t.uploadId, t.part);
      } catch (err) {
        return res.status(400).json({ error: 'This upload link is not valid.' });
      }
      fsp
        .mkdir(nodePath.dirname(dest), { recursive: true })
        .then(() => fsp.writeFile(dest, req.body))
        .then(() => {
          // The client echoes this back on completion, the way it reports an
          // S3 ETag, so both drivers take the same completion payload.
          res.setHeader(
            'ETag',
            '"' + crypto.createHash('md5').update(req.body).digest('hex') + '"'
          );
          res.json({ ok: true });
        })
        .catch((err) => {
          console.error('local part write failed:', err.message);
          res.status(500).json({ error: 'Could not store that part.' });
        });
    }
  );

  // A finished object. Streamed from disk, so size is not a concern here — this
  // driver never runs on a serverless host.
  app.get('/api/storage/local/object', (req, res) => {
    const t = storage.verify(req.query.token);
    if (!t || t.op !== 'get') return res.status(403).type('text').send('This link has expired.');
    // This driver serves from our own address, so a file that could run script
    // (HTML, SVG…) only ever goes out as a download, and nothing is sniffed.
    const out = storageServing(t.ct, t.download);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', storageDisposition(t.filename, out.download));
    storageGuard(res, out.contentType);
    res.sendFile(storage.objectPath(t.key), (err) => {
      if (err && !res.headersSent) res.status(404).type('text').send('That file is gone.');
    });
  });
}

// ---------------------------------------------------------------------------
// MongoDB storage endpoints.
//
// Only mounted on a deployed site with no bucket (see storage.js). The same
// signed-token scheme as the local driver; the bytes live in MongoDB instead of
// on a disk the host would throw away.
// ---------------------------------------------------------------------------
if (storage.mode === 'db') {
  app.put(
    '/api/storage/db/part',
    // The token is checked before a byte of the body is read, as for the
    // local driver: no upload link, nothing buffered.
    (req, res, next) => {
      const t = storage.verify(req.query.token);
      if (!t || t.op !== 'put')
        return res.status(403).json({ error: 'This upload link has expired.' });
      req.uploadToken = t;
      next();
    },
    // type:() => true for the same reason as the local driver: a Blob slice
    // can arrive with no Content-Type at all.
    express.raw({ type: () => true, limit: storage.partBytes + 64 * 1024 }),
    (req, res) => {
      const t = req.uploadToken;
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      storage
        .putPart({ uploadId: t.uploadId, part: t.part, bytes })
        .then(() => {
          // Echoed back on completion the way an S3 ETag is.
          res.setHeader('ETag', '"' + crypto.createHash('md5').update(bytes).digest('hex') + '"');
          res.json({ ok: true });
        })
        .catch((err) => {
          console.error('db part write failed:', err.message);
          res.status(500).json({ error: 'Could not store that part.' });
        });
    }
  );

  // A finished object, read back out of its chunks. Small by construction —
  // the driver caps uploads at what one function response can carry.
  app.get('/api/storage/db/object', (req, res) => {
    const t = storage.verify(req.query.token);
    if (!t || t.op !== 'get') return res.status(403).type('text').send('This link has expired.');
    storage
      .read({ key: t.key })
      .then((buf) => {
        if (!buf) return res.status(404).type('text').send('That file is gone.');
        // Served from our own address, like the local driver: anything that
        // could run script only ever goes out as a download, never sniffed.
        const out = storageServing(t.ct, t.download);
        res.setHeader('Content-Type', out.contentType);
        res.setHeader('Content-Disposition', storageDisposition(t.filename, out.download));
        storageGuard(res, out.contentType);
        res.send(buf);
      })
      .catch((err) => {
        console.error('db object read failed:', err.message);
        if (!res.headersSent) res.status(500).type('text').send('Could not read that file.');
      });
  });
}

// The first API call each page makes as it opens — the portal and the login
// page, the dashboard, the public estimate page, a customer's quote link.
const PAGE_OPENING_CALLS = /^\/api\/(me|admin\/me|estimate\/config|public\/quote\/[^/]+)\/?$/i;

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
        // A page view is counted from the one call each page makes as it opens,
        // not from the page itself: on Netlify and Vercel the pages are static
        // files that never reach this app, so they would never be counted.
        isPage: req.method === 'GET' && PAGE_OPENING_CALLS.test(path),
        who,
      })
      .catch(() => {});
  });
  next();
});

// The "dev" account is a limited admin: it can use the dashboard's non-clock-in
// features (quotes, pricing, scheduling, employees) but not the timeclock data,
// nor the admin's own login settings. Enforced here in one place.
//
// Mounted with app.use, so Express itself decides what each entry covers —
// with the same rules it uses to route the request (any letter case, an
// optional trailing slash, everything below the path). A hand-written string
// comparison here once disagreed with the router: "/api/Admin/credentials"
// slipped past the check and still reached the route.
const DEV_BLOCKED = [
  '/api/admin/active',
  '/api/admin/timesheet',
  '/api/admin/export.csv',
  '/api/admin/credentials',
  '/api/cron/quickbooks-sync',
  '/api/cron/inbox-scan',
  // The client's own business: payroll reads pay rates and writes to their
  // books, invoices are money owed them, and the inbox agent reads their email.
  // The dev may switch any of these features on or off, but never operate them.
  '/api/admin/punches',
  '/api/admin/quickbooks',
  '/api/quickbooks',
  '/api/admin/invoices',
  '/api/admin/inbox',
  // Every clock-in's position — the same timeclock data as the timesheet.
  '/api/admin/locations',
  // Billing, even though the route sits under quotes: it creates an invoice.
  '/api/admin/quotes/:id/invoice',
];
app.use(DEV_BLOCKED, (req, res, next) => {
  if (req.session && req.session.role === 'dev')
    return res.status(403).json({ error: 'Not available for the dev account.' });
  next();
});
const isDev = (req) => !!(req.session && req.session.admin && req.session.role === 'dev');

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
  // The customer's approval page rides on the same switch: with quotes off, a
  // link already sent stops working too.
  quotes: (p) => p.startsWith('/api/admin/quotes') || p.startsWith('/api/public/quote'),
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
  // Includes pushing and emailing an invoice through QuickBooks: that is the
  // books too, so it needs this switch as well as the invoices one.
  quickbooks: (p) =>
    p.startsWith('/api/admin/quickbooks') ||
    p.startsWith('/api/quickbooks') ||
    p === '/api/cron/quickbooks-sync' ||
    /^\/api\/admin\/invoices\/[^/]+\/quickbooks(\/|$)/.test(p),
  // Includes turning a quote into an invoice, which creates one.
  invoices: (p) => p.startsWith('/api/admin/invoices') || /^\/api\/admin\/quotes\/[^/]+\/invoice$/.test(p),
  inbox: (p) => p.startsWith('/api/admin/inbox') || p === '/api/cron/inbox-scan',
  // Both sides of the estimate page: the admin's queue and the public endpoints
  // the page itself calls, so switching the feature off closes it to the world.
  estimate: (p) => p.startsWith('/api/admin/estimate') || p.startsWith('/api/estimate'),
};

// Cached briefly. On serverless hosting several copies of the app run at once,
// and only the one that handled a switch would ever see it if the cache lived
// as long as the process; 15 seconds is the most any copy can lag behind.
const ENTITLEMENTS_TTL_MS = 15000;
let _entitlements = null; // { value, at }
function normalizeEntitlements(f) {
  f = f || {};
  const out = {};
  for (const feat of ADMIN_FEATURES) out[feat.key] = f[feat.key] !== false; // default ON
  return out;
}
async function getEntitlements() {
  if (_entitlements && Date.now() - _entitlements.at < ENTITLEMENTS_TTL_MS) return _entitlements.value;
  const doc = await store.settings.findOne({ _id: 'entitlements' });
  _entitlements = { value: normalizeEntitlements(doc && doc.features), at: Date.now() };
  return _entitlements.value;
}
// Writes only the switches that changed, so a copy holding an out-of-date view
// can't put back what another copy just turned off.
async function setEntitlements(patch) {
  const set = {};
  for (const feat of ADMIN_FEATURES)
    if (patch[feat.key] != null) set['features.' + feat.key] = !!patch[feat.key];
  if (Object.keys(set).length)
    await store.settings.updateOne({ _id: 'entitlements' }, { $set: set }, { upsert: true });
  _entitlements = null;
  return getEntitlements();
}

// Block a disabled feature's endpoints for everyone except the dev.
//
// Matched on the path as the router sees it: Express routes ignore letter case
// and a trailing slash, so the comparison here must too, or "/API/Estimate/…"
// would reach a feature that is switched off.
app.use(async (req, res, next) => {
  try {
    if (req.sessionChecked && req.session && req.session.role === 'dev') return next();
    const p = req.path.toLowerCase().replace(/\/+$/, '');
    if (!p.startsWith('/api/')) return next();
    // Every feature a path belongs to must be on — pushing an invoice to
    // QuickBooks needs both Invoices and QuickBooks.
    const feats = ADMIN_FEATURES.filter((f) => FEATURE_MATCH[f.key] && FEATURE_MATCH[f.key](p));
    if (feats.length) {
      const ent = await getEntitlements();
      if (feats.some((f) => !ent[f.key]))
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

// A session that passed this request's check (see loginStillValid). Every
// guard asks this rather than trusting the cookie's own flags, so a request
// that somehow skipped the check is refused instead of let through.
const checkedSession = (req) => (req.session && req.sessionChecked ? req.session : null);

function requireAdmin(req, res, next) {
  const s = checkedSession(req);
  if (s && s.admin) return next();
  return res.status(401).json({ error: 'Not authorized' });
}

// Only the dev account may manage which features the client can use.
function requireDev(req, res, next) {
  const s = checkedSession(req);
  if (s && s.admin && s.role === 'dev') return next();
  if (s && s.admin) return res.status(403).json({ error: 'Not authorized' });
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

// The default admin password is in the source, so a brand-new install is never
// seeded with it: until ADMIN_PASSWORD is set there is simply no built-in admin
// login. (An install that already has its admin doc is unaffected.)
const ADMIN_SEEDABLE = ADMIN_PASSWORD.length >= 8 && ADMIN_PASSWORD !== 'changeme';

// An install whose admin login was created before ADMIN_PASSWORD was required
// may still hold the published default. Checked once per start (it costs a
// password hash): with a safe ADMIN_PASSWORD set, that replaces it; without
// one the default keeps working nowhere — sign-in refuses it (see the login
// routes) and the log says what to do.
let defaultAdminCheck = null;
function replaceDefaultAdminPassword() {
  if (!defaultAdminCheck)
    defaultAdminCheck = (async () => {
      const doc = await store.settings.findOne({ _id: 'admin' });
      if (!doc || !verifyPassword('changeme', doc.password_salt, doc.password_hash)) return;
      if (ADMIN_SEEDABLE) {
        await store.settings.updateOne(
          { _id: 'admin' },
          { $set: { ...hashPassword(ADMIN_PASSWORD), updated_at: new Date() } }
        );
        accountCache.delete('admin');
        console.warn('[security] The admin password was the published default; it now comes from ADMIN_PASSWORD.');
      } else {
        console.warn(
          '[security] The admin password is still the published default and is refused at sign-in. ' +
            'Set ADMIN_PASSWORD (8+ characters, not "changeme") and restart.'
        );
      }
    })().catch((err) => {
      defaultAdminCheck = null; // try again next time
      throw err;
    });
  return defaultAdminCheck;
}

// Load the admin credential doc, creating it from the env vars on first run.
// Null when it doesn't exist yet and there is no safe password to seed it with.
async function getAdminRecord() {
  let doc = await store.settings.findOne({ _id: 'admin' });
  if (!doc) {
    if (!ADMIN_SEEDABLE) return null;
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

// The "dev" account lives in the same settings collection (doc _id:'dev'). It
// follows the env vars: once per start, the stored login is made to match
// DEV_EMAIL / DEV_PASSWORD, so rotating the password is just changing the
// variable. With DEV_PASSWORD unset there is no dev login at all — a record
// left over from an earlier install can't be signed into.
let devSync = null;
async function getDevRecord() {
  if (!DEV_ENABLED) return null;
  if (!devSync)
    devSync = (async () => {
      const doc = await store.settings.findOne({ _id: 'dev' });
      const current =
        doc &&
        (doc.email || '').toLowerCase() === DEV_EMAIL &&
        verifyPassword(DEV_PASSWORD, doc.password_salt, doc.password_hash);
      if (!current)
        await store.settings.updateOne(
          { _id: 'dev' },
          {
            $set: { email: DEV_EMAIL, ...hashPassword(DEV_PASSWORD), updated_at: new Date() },
            $setOnInsert: { created_at: new Date() },
          },
          { upsert: true }
        );
    })().catch((err) => {
      devSync = null; // try again on the next call
      throw err;
    });
  await devSync;
  return store.settings.findOne({ _id: 'dev' });
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

// The signed-in employee's record. The session check above has usually just
// loaded it for this request; reusing it saves a second read.
const sessionEmployee = (req) =>
  req.authEmployee && req.authEmployee._id === req.session.employeeId
    ? Promise.resolve(req.authEmployee)
    : store.employees.findOne({ _id: req.session.employeeId, active: true });

// Require a signed-in employee; attaches the fresh employee doc as req.employee.
function requireEmployee(req, res, next) {
  const s = checkedSession(req);
  if (!s || !s.employeeId) return res.status(401).json({ error: 'Please sign in.' });
  sessionEmployee(req)
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
    const s = checkedSession(req);
    if (s && s.admin) return next();
    if (!s || !s.employeeId) return res.status(401).json({ error: 'Please sign in.' });
    sessionEmployee(req)
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

// What an error means for the reply. A deliberate refusal — bad input, a body
// too large to read — keeps its own status and says what it is. Anything on
// the server's side is a fault: logged and kept for the dev dashboard. Its
// reply is a plain "Server error." unless it was written for the person who
// hit it (err.expose) — file storage that isn't set up, a bucket refusing an
// upload — which says so, so the office isn't left with nothing to act on.
function errorReply(err) {
  const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const shown = status < 500 || (err && err.expose === true);
  return { status, fault: status >= 500, message: shown ? err.message : 'Server error.' };
}

// Only what a fault needs: never the whole error object, which for a body that
// failed to parse carries the raw request — a sign-in form's password with it.
function recordFault(req, err, status) {
  console.error(`[${req.method} ${req.path}]`, (err && err.stack) || err);
  // Keep it for the dev dashboard as well as the log — a log line on a
  // serverless host is gone the moment you look away.
  metrics
    .recordError({
      path: req.path,
      method: req.method,
      status,
      message: err && err.message,
      stack: err && err.stack,
      who: req.session && req.session.admin ? 'admin' : req.session && req.session.employeeId ? 'employee' : 'anonymous',
      timezone: TIMEZONE,
    })
    .catch(() => {});
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    const reply = errorReply(err);
    if (reply.fault) recordFault(req, err, reply.status);
    if (!res.headersSent) res.status(reply.status).json({ error: reply.message });
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
// Rate limiting, kept in MongoDB so it holds across serverless instances.
//
//   limiter(scope)       counts FAILED attempts per address — a quote link that
//                        doesn't exist. Too many and that address has to wait.
//   loginLimiter(scope)  counts EVERY sign-in attempt as it arrives, before the
//                        password is checked, per address and per account (the
//                        email typed). Counting first means a burst of parallel
//                        guesses is counted too, and the per-account count is
//                        the same whatever address the guesses claim to come
//                        from. A successful sign-in takes its own attempt back
//                        off the address and clears that account — nobody
//                        else's — so signing into your own account can't reset
//                        the count against someone else's.
//   budget(scope, …)     counts every request per address, for public
//                        endpoints that cost money or a third party's goodwill.
// ---------------------------------------------------------------------------

const RL_LIMIT = 10;
const RL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
// One address trying many accounts. Successful sign-ins don't count, so a whole
// crew signing in from the shop's connection never gets near it.
const LOGIN_ADDRESS_LIMIT = 30;
// Many addresses trying one account.
const LOGIN_ACCOUNT_LIMIT = 10;
const LOGIN_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

// The caller's address, read from the header the hosting platform itself sets.
// Any other header is whatever the client chose to send, so trusting one would
// let every attempt claim a fresh address. Netlify: its own connection header
// (the function wrapper marks the platform). Vercel: X-Forwarded-For, which
// Vercel overwrites. Elsewhere, CLIENT_IP_HEADER may name the header your
// proxy guarantees; failing that the first X-Forwarded-For hop is used, which
// a client can choose — the per-account sign-in limit doesn't depend on it.
function clientIp(req) {
  const h = req.headers;
  const first = (v) => String(v || '').split(',')[0].trim();
  if (process.env.HEK_PLATFORM === 'netlify') return first(h['x-nf-client-connection-ip']) || 'unknown';
  if (process.env.VERCEL) return first(h['x-real-ip']) || first(h['x-forwarded-for']) || 'unknown';
  const named = String(process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (named && h[named]) return first(h[named]);
  return first(h['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Add one to key's count, starting a fresh window when the last has run out.
// Returns the counter after the update.
async function bump(key, windowMs) {
  const r = await store.rateLimits.findOneAndUpdate(
    { _id: key },
    [
      {
        $set: {
          windowStart: {
            $cond: [
              {
                $gt: [
                  { $subtract: ['$$NOW', { $ifNull: ['$windowStart', new Date(0)] }] },
                  windowMs,
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
    { upsert: true, returnDocument: 'after' }
  );
  return r && r.value !== undefined && r.ok !== undefined ? r.value : r; // driver v6 returns the doc
}

// How long until counter `doc` is back under `limit`, or 0 if it is under now.
function waitFor(doc, limit, windowMs) {
  if (!doc || !(doc.count > limit)) return 0;
  return Math.max(1000, windowMs - (Date.now() - new Date(doc.windowStart).getTime()));
}

const tooMany = (res, waitMs, what = 'attempts') => {
  const mins = Math.ceil(waitMs / 60000);
  return res
    .status(429)
    .json({ error: `Too many ${what}. Please wait ${mins} minute${mins > 1 ? 's' : ''} and try again.` });
};

async function isBlocked(key) {
  const doc = await store.rateLimits.findOne({ _id: key });
  if (!doc || !doc.windowStart) return 0;
  const elapsed = Date.now() - new Date(doc.windowStart).getTime();
  if (elapsed > RL_WINDOW_MS) return 0;
  return doc.count >= RL_LIMIT ? RL_WINDOW_MS - elapsed : 0;
}

const recordFail = (key) => bump(key, RL_WINDOW_MS);

// Middleware factory: blocks a request if its address has failed too often
// within the window for `scope`. The route calls recordFail on a failure.
const limiter = (scope) => async (req, res, next) => {
  const key = `${scope}:${clientIp(req)}`;
  req._rlKey = key;
  try {
    const waitMs = await isBlocked(key);
    if (waitMs > 0) return tooMany(res, waitMs);
  } catch (err) {
    console.error('rate-limit check failed (allowing request):', err.message);
  }
  next();
};

// Sign-in forms. See the note at the top of this section.
const loginLimiter = (scope) => async (req, res, next) => {
  const raw = req.body && req.body.email;
  const email = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 254) : '';
  req._login = {
    addressKey: `${scope}:${clientIp(req)}`,
    accountKey: email ? `${scope}-account:${email}` : null,
  };
  try {
    const [byAddress, byAccount] = await Promise.all([
      bump(req._login.addressKey, RL_WINDOW_MS),
      req._login.accountKey ? bump(req._login.accountKey, LOGIN_ACCOUNT_WINDOW_MS) : null,
    ]);
    const waitMs = Math.max(
      waitFor(byAddress, LOGIN_ADDRESS_LIMIT, RL_WINDOW_MS),
      waitFor(byAccount, LOGIN_ACCOUNT_LIMIT, LOGIN_ACCOUNT_WINDOW_MS)
    );
    if (waitMs > 0) return tooMany(res, waitMs);
  } catch (err) {
    console.error('rate-limit check failed (allowing request):', err.message);
  }
  next();
};

// After a successful sign-in: this attempt stops counting against the address
// and the account starts clean. Other accounts' counts are left alone.
async function loginSucceeded(req) {
  const k = req._login;
  if (!k) return;
  try {
    await Promise.all([
      store.rateLimits.updateOne({ _id: k.addressKey, count: { $gt: 0 } }, { $inc: { count: -1 } }),
      k.accountKey ? store.rateLimits.deleteOne({ _id: k.accountKey }) : null,
    ]);
  } catch (err) {
    console.error('rate-limit reset failed:', err.message);
  }
}

// Middleware factory for public endpoints: at most `limit` requests per
// address in `windowMs`, counting every request, successful or not.
const budget = (scope, limit, windowMs) => async (req, res, next) => {
  try {
    const doc = await bump(`${scope}:${clientIp(req)}`, windowMs);
    const waitMs = waitFor(doc, limit, windowMs);
    if (waitMs > 0) return tooMany(res, waitMs, 'requests');
  } catch (err) {
    console.error('rate-limit check failed (allowing request):', err.message);
  }
  next();
};

// A ceiling for everyone together, per local day — the last line against a
// flood that changes address. True once `limit` is passed.
async function overDailyCap(scope, limit) {
  const r = await store.rateLimits.findOneAndUpdate(
    { _id: `${scope}:day:${localDay(new Date())}` },
    { $inc: { count: 1 }, $setOnInsert: { expireAt: new Date(Date.now() + 2 * 86400000) } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = r && r.value !== undefined && r.ok !== undefined ? r.value : r;
  return !!doc && doc.count > limit;
}

// Who an email belongs to, before any password is checked: the built-in admin,
// the dev account, or an employee.
async function loginTarget(email) {
  if (!email) return null;
  await replaceDefaultAdminPassword().catch((err) => console.error('default password check failed:', err.message));
  const admin = await getAdminRecord();
  if (admin && email === String(admin.email || '').toLowerCase()) return { kind: 'admin', doc: admin };
  const dev = await getDevRecord();
  if (dev && email === String(dev.email || '').toLowerCase()) return { kind: 'dev', doc: dev };
  const emp = await store.employees.findOne({ email });
  return emp ? { kind: 'employee', doc: emp } : null;
}

// Exactly one password check per attempt, whoever the email belongs to — and
// against a throwaway hash when it belongs to nobody — so a wrong email takes
// as long to refuse as a wrong password and the timing doesn't tell anyone
// which emails have accounts.
let dummyLogin = null;
function passwordMatches(target, password) {
  if (!dummyLogin) dummyLogin = hashPassword(crypto.randomBytes(16).toString('hex'));
  const d = target ? target.doc : dummyLogin;
  const ok = verifyPassword(password, d.password_salt || dummyLogin.password_salt, d.password_hash || dummyLogin.password_hash);
  return !!target && ok;
}

// The email and password from a sign-in form, or null when either is missing
// or not text.
function credentialsFrom(body) {
  const email = body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = body && typeof body.password === 'string' ? body.password : '';
  return email && password ? { email, password } : null;
}

const adminLimiter = loginLimiter('admin');
const userLimiter = loginLimiter('login');

// ---------------------------------------------------------------------------
// Employee / unified auth (used by the login page at "/")
// ---------------------------------------------------------------------------

// One login form for everyone. Admin credentials sign in as admin (and the
// client redirects to the dashboard); everyone else signs in as an employee.
app.post(
  '/api/login',
  userLimiter,
  wrap(async (req, res) => {
    const creds = credentialsFrom(req.body);
    if (!creds) return res.status(400).json({ error: 'Enter your email and password.' });
    const target = await loginTarget(creds.email);
    if (
      !passwordMatches(target, creds.password) ||
      (target.kind === 'employee' && !target.doc.active) ||
      (target.kind === 'admin' && creds.password === 'changeme')
    )
      return res.status(401).json({ error: 'Wrong email or password.' });
    await loginSucceeded(req);

    const { kind, doc } = target;
    // The admin, and the dev — a limited admin (everything in the dashboard
    // except clock-in) — go to the dashboard.
    if (kind !== 'employee') {
      startSession(req, kind, doc);
      return res.json({ role: 'admin', redirect: ADMIN_PATH });
    }
    // An employee granted the "admin" role signs into the full dashboard.
    if ((doc.permissions || []).includes('admin')) {
      startSession(req, 'admin', doc, { employee: true });
      return res.json({ role: 'admin', redirect: ADMIN_PATH });
    }
    startSession(req, 'employee', doc, { employee: true });
    res.json({
      role: 'employee',
      ...selfView(doc, await getEntitlements()),
      // When this login ends — the portal may keep copies on the device until then.
      session_expires: sessionEnds(req),
    });
  })
);

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});


// When this login runs out. The pages keep copies of what they last showed so
// the next visit opens on it (snappy.js), and throw them away at this time —
// a copy must never outlive the login that was allowed to see it.
function sessionEnds(req) {
  const iat = Number(req.session && req.session.iat);
  return Number.isFinite(iat) ? new Date(iat + SESSION_TTL_MS).toISOString() : null;
}

// Who am I? Used by the portal (and by the shared login page) to restore state.
app.get(
  '/api/me',
  wrap(async (req, res) => {
    if (req.session && req.session.admin) return res.json({ role: 'admin', redirect: ADMIN_PATH });
    if (req.session && req.session.employeeId) {
      const emp = await store.employees.findOne({ _id: req.session.employeeId, active: true });
      if (emp)
        return res.json({
          role: 'employee',
          ...selfView(emp, await getEntitlements()),
          session_expires: sessionEnds(req),
        });
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
    try {
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
    } catch (err) {
      // The one-open-punch index: another tap (or phone) clocked in first.
      if (err.code === 11000) return res.status(409).json({ error: 'You are already clocked in.' });
      throw err;
    }
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
      out = clientTime(req.body.clockOut);
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

    // Only while it is still open: a second tap, or another phone, that got
    // here at the same time must not overwrite the first clock-out.
    const closed = await store.punches.updateOne(
      { _id: open._id, clock_out: null },
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
    if (!closed.matchedCount) return res.status(409).json({ error: 'You are already clocked out.' });
    res.json({ clockedIn: false, since: iso(open.clock_in), until: iso(out) });
  })
);

// The longest shift an employee can record when fixing a missed clock-out.
const MAX_SHIFT_MS = 24 * 60 * 60 * 1000;

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

    // The portal sends an exact instant; an older page sent the bare time off
    // the phone's clock, which is read in TIMEZONE rather than as UTC.
    const co = clientTime(clockOut);
    if (isNaN(co)) return res.status(400).json({ error: 'Invalid finish time.' });
    if (co.getTime() > Date.now() + 60000)
      return res.status(400).json({ error: "Finish time can't be in the future." });
    if (co < new Date(p.clock_in))
      return res.status(400).json({ error: 'Finish time must be after your clock-in.' });
    // Nobody works a shift longer than a day; a finish later than that is a
    // wrong date, and it would go to payroll as days of hours.
    if (co - new Date(p.clock_in) > MAX_SHIFT_MS)
      return res.status(400).json({
        error: "That's more than 24 hours after you clocked in. Check the date, or ask the office to fix this entry.",
      });

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

    const resolved = await store.punches.updateOne(
      { _id: p._id, clock_out: null },
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
    if (!resolved.matchedCount) return res.status(409).json({ error: 'That clock-out was already fixed.' });
    res.json({ ok: true });
  })
);

app.get(
  '/api/my/schedules',
  requireEmployee,
  wrap(async (req, res) => {
    // What's coming up, anything undated, and the last two months — not every
    // job they have ever been on, oldest first, above today's.
    const since = localDay(new Date(Date.now() - 60 * 86400000));
    const docs = await store.schedules
      .find({ employee_ids: req.employee._id, ...recentJobs(since) })
      .toArray();
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
    await serveAttachment(req, res, blob);
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
    const range = dayRange(from, to);
    if (range) q.clock_in = range;
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
    const creds = credentialsFrom(req.body);
    if (!creds) return res.status(400).json({ error: 'Enter your email and password.' });
    const target = await loginTarget(creds.email);
    // An employee granted the "admin" role may also sign in on the admin form.
    const allowed =
      target &&
      (target.kind !== 'employee' ||
        (target.doc.active && (target.doc.permissions || []).includes('admin')));
    if (!passwordMatches(target, creds.password) || !allowed || (target.kind === 'admin' && creds.password === 'changeme'))
      return res.status(401).json({ error: 'Wrong email or password.' });
    await loginSucceeded(req);
    if (target.kind === 'employee') startSession(req, 'admin', target.doc, { employee: true });
    else startSession(req, target.kind, target.doc);
    res.json({ ok: true, email: creds.email, role: target.kind === 'dev' ? 'dev' : 'admin' });
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
          const account = await builtInAccount(role);
          email = account ? account.email : null;
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
    res.json({ admin, role, email, features, session_expires: admin ? sessionEnds(req) : null });
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
    // The dev's login comes from DEV_EMAIL / DEV_PASSWORD. Refused here as well
    // as by DEV_BLOCKED, because the fall-through below edits the built-in
    // admin's login — the one thing a dev session must never reach.
    if (isDev(req))
      return res.status(403).json({ error: 'The dev login is set with DEV_EMAIL and DEV_PASSWORD.' });

    let email = null;
    if (req.body?.email != null) {
      email = String(req.body.email).trim().toLowerCase();
      if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    }
    let password = null;
    if (req.body?.password) {
      password = String(req.body.password);
      if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      // The published default is refused at sign-in, so it can't be chosen.
      if (password === 'changeme') return res.status(400).json({ error: 'Choose a different password.' });
    }
    if (!email && !password)
      return res.status(400).json({ error: 'Enter a new email or password.' });

    // Whoever this is must know the current password. A session alone isn't
    // enough to rewrite the login — someone at an unattended screen, or holding
    // a stolen cookie, could otherwise lock the real owner out.
    const current = String(req.body?.current_password || '');
    const mine = req.session.employeeId
      ? await store.employees.findOne({ _id: req.session.employeeId, active: true })
      : await getAdminRecord();
    if (!mine || !verifyPassword(current, mine.password_salt, mine.password_hash))
      return res.status(403).json({ error: 'Your current password is not right.' });

    const set = { updated_at: new Date() };
    if (password) Object.assign(set, hashPassword(password));

    // An employee who signs into the dashboard via the "admin" role: this is
    // their employee record, so changing it here must not touch the built-in
    // admin account (which is how the whole company gets in).
    if (req.session.employeeId) {
      const id = req.session.employeeId;
      if (email && email !== String(mine.email || '').toLowerCase()) {
        // Taking the built-in admin's address would shadow that login.
        if ((await store.employees.findOne({ email, _id: { $ne: id } })) || (await builtInEmail(email)))
          return res.status(409).json({ error: 'That email is already in use.' });
        set.email = email;
      }
      await store.employees.updateOne({ _id: id }, { $set: set });
      const emp = await store.employees.findOne({ _id: id });
      // This browser stays signed in; every other copy of the old login is out.
      startSession(req, 'admin', emp, { employee: true });
      return res.json({ ok: true, email: emp.email || emp.name });
    }

    // The built-in admin account, stored in the settings collection. The form
    // always sends the email, so only a different one is checked for a clash.
    if (email && email !== String(mine.email || '').toLowerCase()) {
      if (await store.employees.findOne({ email }))
        return res.status(409).json({ error: 'That email is already in use.' });
      set.email = email;
    }
    await store.settings.updateOne({ _id: 'admin' }, { $set: set });
    accountCache.delete('admin');
    const updated = await getAdminRecord();
    startSession(req, 'admin', updated);
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
      (p) => (!FEATURE_KEYS.has(p.key) || ent[p.key] !== false) && !(p.key === 'admin' && isDev(req))
    );
    res.json({ permissions });
  })
);

// What the dev may not do to an employee. The dev is kept away from payroll,
// invoices, the books and the inbox (DEV_BLOCKED) — but an employee holding
// "admin" signs in with none of those limits. So the dev can't hand that
// permission out, take it away, or take over the login of anyone who holds it;
// and since deleting an employee deletes their time entries, it can't delete
// anyone with payroll history either. Returns the reason, or null.
function devEmployeeRefusal(req, emp, body) {
  if (!isDev(req)) return null;
  const isAdminEmp = !!emp && (emp.permissions || []).includes('admin');
  const wantsAdmin = Array.isArray(body && body.permissions) && body.permissions.includes('admin');
  if (wantsAdmin && !isAdminEmp) return 'Only the admin can give someone admin access.';
  if (!isAdminEmp) return null;
  const b = body || {};
  if (b.password) return "Only the admin can change an admin's password.";
  if (b.email != null && String(b.email).trim().toLowerCase() !== (emp.email || '').toLowerCase())
    return "Only the admin can change an admin's email.";
  if (b.active != null && !!b.active !== !!emp.active) return 'Only the admin can switch an admin on or off.';
  return null;
}

// True when an email is the built-in admin's or the dev's login. An employee
// given that address would never be able to sign in (the built-in login is
// checked first), and the admin could no longer save their own login.
async function builtInEmail(email) {
  if (!email) return false;
  const accounts = await Promise.all([getAdminRecord(), getDevRecord()]);
  return accounts.some((d) => d && String(d.email || '').toLowerCase() === email);
}

app.post(
  '/api/admin/employees',
  requireAdmin,
  wrap(async (req, res) => {
    const first = String(req.body?.first_name || '').trim();
    const last = String(req.body?.last_name || '').trim();
    let name = String(req.body?.name || '').trim();
    if (!name) name = [first, last].filter(Boolean).join(' ').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const permissions = cleanPermissions(req.body?.permissions);
    const refusal = devEmployeeRefusal(req, null, { permissions });
    if (refusal) return res.status(403).json({ error: refusal });
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (email && !validEmail(email))
      return res.status(400).json({ error: 'Enter a valid email address.' });

    if (email && ((await store.employees.findOne({ email })) || (await builtInEmail(email))))
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
    const refusal = devEmployeeRefusal(req, emp, req.body);
    if (refusal) return res.status(403).json({ error: refusal });

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
      if (
        email &&
        email !== (emp.email || '') &&
        ((await store.employees.findOne({ email, _id: { $ne: id } })) || (await builtInEmail(email)))
      )
        return res.status(409).json({ error: 'That email is already in use.' });
      set.email = email || null;
    }

    // Your own login (an employee with the admin role editing their own record)
    // changes only with your current password, exactly as on "Your login" — a
    // session alone must not be enough to lock the real owner out.
    const loginChange = !!req.body?.password || (set.email !== undefined && set.email !== (emp.email || null));
    if (
      req.session.employeeId === id &&
      loginChange &&
      !verifyPassword(String(req.body?.current_password || ''), emp.password_salt, emp.password_hash)
    )
      return res
        .status(403)
        .json({ error: 'To change your own email or password, use "Your login" — it asks for your current password.' });

    // Permissions: replace the whole list when provided. For the dev, "admin"
    // isn't theirs to change either way: the dev's editor never shows that box,
    // so an admin employee keeps it however the rest of their list is edited.
    if (req.body?.permissions != null) {
      set.permissions = cleanPermissions(req.body.permissions);
      if (isDev(req)) {
        set.permissions = set.permissions.filter((p) => p !== 'admin');
        if ((emp.permissions || []).includes('admin')) set.permissions.unshift('admin');
      }
    }

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
    // Editing your own record changes your login's fingerprint; keep this
    // browser signed in rather than bouncing you to the sign-in page. (If you
    // just removed your own admin access, the next request signs you out.)
    if (req.session.employeeId === id && (updated.permissions || []).includes('admin') && updated.active)
      startSession(req, 'admin', updated, { employee: true });
    res.json(employeeView(updated));
  })
);

app.delete(
  '/api/admin/employees/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (isDev(req)) {
      const emp = await store.employees.findOne({ _id: id });
      if (emp && (emp.permissions || []).includes('admin'))
        return res.status(403).json({ error: 'Only the admin can delete an admin.' });
      if (await store.punches.findOne({ employee_id: id }))
        return res.status(403).json({
          error: 'This employee has time entries, so only the admin can delete them. Switch them off instead.',
        });
    }
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

// Narrow a list of ids down to employees that exist and are still active: an
// employee who has been switched off can't sign in to see the job, so putting
// them on a crew only hides that nobody is covering it.
async function cleanEmployeeIds(list) {
  const ids = Array.isArray(list)
    ? [...new Set(list.map(Number).filter((n) => Number.isInteger(n)))]
    : [];
  if (!ids.length) return [];
  const found = await store.employees.find({ _id: { $in: ids }, active: true }).toArray();
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

// OpenStreetMap's free Nominatim geocoder, used for every address lookup —
// staff and public. Its usage policy asks for an identifying User-Agent and at
// most one request a second, so lookups queue behind each other (per running
// copy of the app), and answers are remembered for a day so asking again costs
// nothing. A wait that would run past a few seconds is refused instead: better
// "busy, try again" than a request that hangs until the host kills it.
const NOMINATIM_GAP_MS = 1100;
const nominatimCache = new Map(); // url -> { at, data }
let nominatimNext = 0;
async function nominatim(url, purpose) {
  const hit = nominatimCache.get(url);
  if (hit && Date.now() - hit.at < 86400000) return hit.data;
  const now = Date.now();
  const wait = Math.max(0, nominatimNext - now);
  if (wait > 4000) {
    const err = new Error('Address search is busy right now. Try again in a moment.');
    err.status = 503;
    throw err;
  }
  nominatimNext = Math.max(now, nominatimNext) + NOMINATIM_GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const r = await fetch(url, {
    headers: { 'User-Agent': `HEK-Timeclock/1.0 (${purpose})`, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = new Error('Address search is not available right now. Try again later.');
    err.status = r.status === 429 ? 429 : 503;
    throw err;
  }
  const data = await r.json();
  if (nominatimCache.size >= 500) nominatimCache.delete(nominatimCache.keys().next().value);
  nominatimCache.set(url, { at: Date.now(), data });
  return data;
}

const placesFrom = (data) =>
  (Array.isArray(data) ? data : [])
    .map((d) => ({ label: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }))
    .filter((x) => x.label && Number.isFinite(x.lat) && Number.isFinite(x.lng));

// Staff address lookup. Never throws: a failed lookup is just no results.
async function searchAddress(raw, purpose) {
  const q = String(raw || '').trim().slice(0, 200);
  if (q.length < 3) return [];
  try {
    return placesFrom(
      await nominatim(
        'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' + encodeURIComponent(q),
        purpose
      )
    );
  } catch (err) {
    console.error('geocode failed:', err.message);
    return [];
  }
}

app.get(
  '/api/admin/geocode',
  requireAdmin,
  wrap(async (req, res) => {
    res.json({ results: await searchAddress(req.query.q, 'job scheduling address lookup') });
  })
);

// Whether a job's office note must be kept from this session: a dev looking at
// a job that came from an invoice.
const hidesBilling = (req, job) => isDev(req) && !!(job && job.source && job.source.type === 'invoice');

// Jobs still worth listing as of a local day: undated ones (the backlog), and
// any that run on or after it. Without a cut-off the board and the crew's
// schedule return every job ever, and after a few thousand of them the reply
// outgrows what a serverless response can carry.
function recentJobs(since) {
  return {
    $or: [{ date: null }, { date: { $gte: since } }, { end_date: { $gte: since } }],
  };
}

app.get(
  '/api/admin/schedules',
  requireAdmin,
  wrap(async (req, res) => {
    // The board looks around now; older weeks are asked for with ?since=.
    const asked = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.since || '')) ? String(req.query.since) : null;
    const since = asked || localDay(new Date(Date.now() - 400 * 86400000));
    const docs = await store.schedules.find(recentJobs(since)).toArray();
    const emps = await store.employees.find({}).toArray();
    const nameById = Object.fromEntries(emps.map((e) => [e._id, e.name]));
    const jobs = docs
      .map((d) => ({
        ...publicScheduleView(d),
        // Admin-only, so the internal note is added back on top of the view the
        // employee portal gets. Not for the dev on a job an invoice made: its
        // note carries the invoice's money and billing contact, and invoices
        // are the client's business, closed to the dev account.
        notes_internal: hidesBilling(req, d) ? null : d.notes_internal || null,
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
    // The dev never saw this note on an invoice's job (see the list), so what
    // its form sends back is not an edit of it.
    if (req.body?.notes_internal != null && !hidesBilling(req, doc))
      set.notes_internal = cleanNote(req.body.notes_internal);
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
    // Don't leave orphans — in the database or in the bucket. Files go first,
    // each row with its object, and the job last: if a big job is cut short by
    // a serverless time limit, what's left still hangs off a job that exists,
    // and deleting it again finishes the work.
    await dropFiles(store.jobFiles, await store.jobFiles.find({ job_id: id }).toArray());
    await store.schedules.deleteOne({ _id: id });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Job files — every scheduled job has its own filing cabinet: folders (kept on
// the job document, so an empty one sticks around) and files (the blob in
// job_files, lightweight metadata mirrored onto the job so listing a job never
// loads file data). The crew sees the same shelf in the portal, read-only.
// ---------------------------------------------------------------------------

// ---- Serverless response ceiling (legacy attachments only) ---------------
// Netlify Functions cap a response at 6 MB, and serverless-http base64-encodes
// binary bodies on the way out, which inflates them by 4/3. So a file small
// enough to store could still be too big to hand back — and when that happened
// the platform killed the whole invocation with its own "This function has
// crashed" page, which told the crew nothing and looked like the app was down.
//
// New attachments never come through here: they are uploaded straight to object
// storage and read back through a redirect, so no file size can reach this
// ceiling (see storage.js). What remains is the reader for attachments stored in
// the database before that change — those are still measured before being sent.
const FN_RESPONSE_MAX = 6291556; // bytes, Netlify's documented limit
// Headers, the response envelope, and a long multi-byte filename all ride along
// with the body and count towards the same budget.
const FN_RESPONSE_HEADROOM = 96 * 1024;
const FN_BODY_MAX = FN_RESPONSE_MAX - FN_RESPONSE_HEADROOM;
const base64Size = (n) => Math.ceil(n / 3) * 4;
// The largest raw blob whose base64 form still fits inside that budget.
const BLOB_MAX = Math.floor((FN_BODY_MAX * 3) / 4);

// Filenames come from whoever uploaded the file, so they are escaped before
// being written into the oversized-file page below.
const escHtml = (v) =>
  String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

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
// Hand a stored file back to the browser.
//
// These URLs are opened as a navigation, not fetched, so the reply has to be
// readable by a person: an oversized file answers with a short page saying so,
// rather than being sent anyway and taking the whole function down with it.
// Files stored before the cap existed are the ones that hit this.
function sendStoredFile(res, blob) {
  const raw = blob.data;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw && raw.buffer ? raw.buffer : raw);
  if (base64Size(buf.length) > FN_BODY_MAX) {
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    res.status(413).type('html').send(
      `<!doctype html><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px 24px;` +
        `background:#0c0a09;color:#f3f0ea}h1{font-size:20px;margin:0 0 12px}` +
        `p{margin:0 0 10px;color:#9a938a}b{color:#f3f0ea}</style>` +
        `<h1>This file is too big to open here</h1>` +
        `<p><b>${escHtml(blob.filename || 'The file')}</b> is ${mb(buf.length)} MB. ` +
        `Anything over about ${mb(BLOB_MAX)} MB can't be sent through the app.</p>` +
        `<p>Ask the office to send it to you another way.</p>`
    );
    return;
  }
  // Served from our own address: anything that could run script goes out as a
  // download only, and the name is written so any character survives.
  const out = storageServing(blob.content_type, false);
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', storageDisposition(blob.filename, out.download));
  storageGuard(res, out.contentType);
  res.send(buf);
}

// Kept as the old name so both job-file routes read the same as before.
const sendJobFile = sendStoredFile;

// ---- attachments in object storage ---------------------------------------
//
// The three steps of an upload are: ask for URLs, PUT the parts straight to
// storage, then tell the app it landed. The app never sees a byte, which is what
// lifts the old 4 MB ceiling to 1 GB.

const GB = 1024 * 1024 * 1024;
const uploadLimitLabel = () =>
  MAX_UPLOAD_BYTES % GB === 0
    ? MAX_UPLOAD_BYTES / GB + ' GB'
    : Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)) + ' MB';

// What the client says it is about to send. Size is all that can be checked
// before the bytes exist — it is checked again against the stored object, since
// a browser can claim anything.
function plannedUpload(body, res) {
  const size = Number(body?.size);
  if (!Number.isFinite(size) || size <= 0) {
    res.status(400).json({ error: 'That file looks empty.' });
    return null;
  }
  if (size > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: `File is too large (max ${uploadLimitLabel()}).` });
    return null;
  }
  return {
    filename: safeName(body?.filename),
    content_type: String(body?.content_type || 'application/octet-stream').slice(0, 120),
    size,
  };
}

// The parts list a client reports on completion, cleaned up.
const cleanParts = (list) =>
  (Array.isArray(list) ? list : [])
    .map((p) => ({ partNumber: Number(p?.partNumber), etag: p?.etag ? String(p.etag) : undefined }))
    .filter((p) => Number.isInteger(p.partNumber) && p.partNumber > 0);

// Hand back a stored attachment.
//
// Authorisation has already happened in the route — that is the whole point of
// coming through the app at all. What goes back is a 302 to a signed URL that
// lives five minutes, so the response is a few hundred bytes and the 6 MB
// function ceiling can no longer be reached. Files uploaded before this change
// still have their bytes in MongoDB and are sent the old way.
async function serveAttachment(req, res, doc) {
  if (doc.storage_key) {
    if (doc.status && doc.status !== 'ready')
      return res.status(409).json({ error: 'That file is still uploading.' });
    const url = await storage.presignGet({
      key: doc.storage_key,
      filename: doc.filename,
      contentType: doc.content_type,
      // Tapping a row views it (phones open images and PDFs inline); the
      // download button asks for it as a file.
      download: req.query.download === '1',
    });
    return res.redirect(302, url);
  }
  return sendStoredFile(res, doc); // legacy blob, still in the database
}

// Forget the bytes behind attachment rows: a half-finished upload is aborted, a
// finished object deleted. Legacy in-database blobs need nothing — deleting the
// row is deleting the bytes.
async function dropStored(docs) {
  for (const d of docs || []) {
    if (!d || !d.storage_key) continue;
    if (d.status === 'pending' && d.upload_id)
      await storage.abortUpload({ key: d.storage_key, uploadId: d.upload_id });
    await storage.remove({ key: d.storage_key });
  }
}

// Finishing an upload, step 1: move its row from "pending" to "completing" in
// one step. Abort only ever touches pending rows, so a cancel that races the
// last step can no longer delete the row (and the object) that /complete is
// about to file onto the job. Answers whether this request now owns the
// completion; when it doesn't, the row as it stands says why.
async function claimCompletion(collection, doc) {
  const r = await collection.updateOne(
    { _id: doc._id, status: 'pending' },
    { $set: { status: 'completing', completing_at: new Date() } }
  );
  return r.modifiedCount === 1;
}

// A completion that failed part-way gives the row back to "pending", so the
// browser's abort (or the sweep) can clean it up.
const releaseCompletion = (collection, doc) =>
  collection.updateOne({ _id: doc._id, status: 'completing' }, { $set: { status: 'pending' } });

// Uploads started and never finished — a closed tab, a phone that died — are
// swept up once their signed links are long dead (6 h), so their parts aren't
// billed forever. Run from the upload-url routes, at most hourly per copy.
const ABANDONED_UPLOAD_MS = 7 * 60 * 60 * 1000;
let lastUploadSweep = 0;
async function sweepAbandonedUploads() {
  if (Date.now() - lastUploadSweep < 60 * 60 * 1000) return;
  lastUploadSweep = Date.now();
  const cutoff = new Date(Date.now() - ABANDONED_UPLOAD_MS);
  try {
    for (const collection of [store.jobFiles, store.taskAttachments]) {
      const old = await collection
        .find({ status: { $in: ['pending', 'completing'] }, created_at: { $lt: cutoff } })
        .limit(50)
        .toArray();
      if (old.length) await dropFiles(collection, old);
    }
  } catch (err) {
    console.error('upload sweep failed:', err.message);
  }
}

// Delete file rows along with their objects, a batch at a time, each row only
// once its object is gone — so stopping part-way never leaves a row pointing
// at nothing, nor an object nothing points at.
async function dropFiles(collection, docs) {
  for (let i = 0; i < docs.length; i += 10) {
    const batch = docs.slice(i, i + 10);
    await Promise.all(batch.map((d) => dropStored([d])));
    await collection.deleteMany({ _id: { $in: batch.map((d) => d._id) } });
  }
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
    if (doomed.length) {
      const ids = doomed.map((f) => f.id);
      // Read the rows before dropping them: the storage keys live there.
      await dropFiles(store.jobFiles, await store.jobFiles.find({ _id: { $in: ids } }).toArray());
    }
    // Pull exactly what was deleted rather than writing back lists read before
    // the (slow) storage deletes: an upload, rename or delete that landed on
    // this job in the meantime must survive.
    await store.schedules.updateOne(
      { _id: job._id },
      {
        $pull: {
          folders: { $in: (job.folders || []).filter((p) => hit(p)) },
          files: { id: { $in: doomed.map((f) => f.id) } },
        },
        $set: { updated_at: new Date() },
      }
    );
    res.json({ ok: true, removed: doomed.length });
  })
);

// Step 1: authorise the upload and hand back one signed URL per part.
app.post(
  '/api/admin/schedules/:id/files/upload-url',
  requireAdmin,
  wrap(async (req, res) => {
    const job = await jobOr404(req, res);
    if (!job) return;
    const plan = plannedUpload(req.body, res);
    if (!plan) return;
    await sweepAbandonedUploads();

    const fileId = crypto.randomUUID();
    const key = buildKey('jobs/' + job._id, fileId, plan.filename);
    const up = await storage.createUpload({
      key,
      contentType: plan.content_type,
      size: plan.size,
    });
    // The row exists from the moment the upload starts. An upload that is never
    // finished is then a visible pending row rather than an orphaned object
    // nothing in the database knows about.
    await store.jobFiles.insertOne({
      _id: fileId,
      job_id: job._id,
      filename: plan.filename,
      content_type: plan.content_type,
      size: plan.size,
      folder: cleanFolder(req.body?.folder),
      storage_key: key,
      storage_mode: storage.mode,
      upload_id: up.uploadId,
      status: 'pending',
      uploaded_by: actorName(req),
      created_at: new Date(),
    });
    res.json({ fileId, partSize: up.partSize, parts: up.parts });
  })
);

// Step 3: the parts are all in storage — stitch them together and file the
// metadata onto the job, in the same shape the board has always read.
app.post(
  '/api/admin/schedules/:id/files/:fileId/complete',
  requireAdmin,
  wrap(async (req, res) => {
    const job = await jobOr404(req, res);
    if (!job) return;
    const doc = await store.jobFiles.findOne({ _id: req.params.fileId, job_id: job._id });
    if (!doc) return res.status(404).json({ error: 'Upload not found.' });
    // A retried completion (flaky connection at the last step) must not file the
    // same attachment twice.
    if (doc.status === 'ready') {
      const existing = (job.files || []).find((f) => f.id === doc._id);
      return res.json(existing || { id: doc._id, filename: doc.filename, size: doc.size });
    }

    const parts = cleanParts(req.body?.parts);
    if (!parts.length) return res.status(400).json({ error: 'No uploaded parts reported.' });
    if (!(await claimCompletion(store.jobFiles, doc)))
      return res.status(409).json({ error: 'That upload is already being finished. Try again in a moment.' });
    let head;
    try {
      await storage.completeUpload({ key: doc.storage_key, uploadId: doc.upload_id, parts });
      // Trust the object, not the claim: its real length is what gets recorded,
      // and it enforces the cap even if the browser lied at step 1.
      head = await storage.head({ key: doc.storage_key });
    } catch (err) {
      await releaseCompletion(store.jobFiles, doc);
      throw err;
    }
    if (!head) {
      await releaseCompletion(store.jobFiles, doc);
      return res.status(502).json({ error: 'That upload did not arrive. Try again.' });
    }
    if (head.size > MAX_UPLOAD_BYTES) {
      await storage.remove({ key: doc.storage_key });
      await store.jobFiles.deleteOne({ _id: doc._id });
      return res.status(413).json({ error: `File is too large (max ${uploadLimitLabel()}).` });
    }

    await store.jobFiles.updateOne(
      { _id: doc._id },
      { $set: { status: 'ready', size: head.size, upload_id: null, at: new Date() } }
    );
    const meta = {
      id: doc._id,
      filename: doc.filename,
      folder: doc.folder || '',
      content_type: doc.content_type,
      size: head.size,
      uploaded_by: doc.uploaded_by,
      at: new Date(),
    };
    const update = { $push: { files: meta }, $set: { updated_at: new Date() } };
    // Filing into "Permits/Approved" registers "Permits" as well, so the folder
    // you walk through on the way exists in its own right.
    if (meta.folder) update.$addToSet = { folders: { $each: ancestors(meta.folder) } };
    await store.schedules.updateOne({ _id: job._id }, update);
    res.json({ ...meta, at: iso(meta.at) });
  })
);

// A cancelled or failed upload cleans up after itself, so a half-sent gigabyte
// is not billed for ever.
app.post(
  '/api/admin/schedules/:id/files/:fileId/abort',
  requireAdmin,
  wrap(async (req, res) => {
    const doc = await store.jobFiles.findOne({
      _id: req.params.fileId,
      job_id: Number(req.params.id),
      status: 'pending',
    });
    if (doc) {
      await dropStored([doc]);
      await store.jobFiles.deleteOne({ _id: doc._id });
    }
    res.json({ ok: true });
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
    await serveAttachment(req, res, blob);
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
    const doc = await store.jobFiles.findOne({ _id: fileId, job_id: id });
    await dropStored([doc]);
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
    const range = dayRange(from, to);
    if (range) q.clock_in = range;
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
        // A multi-day job that started before the range but is still running
        // in it is on the map too, as it is on the board.
        ...(from
          ? [{ date: { $lt: String(from), ...(to ? { $lte: String(to) } : {}) }, end_date: { $gte: String(from) } }]
          : []),
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
  const range = dayRange(from, to);
  if (range) q.clock_in = range;
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

    const ci = clientTime(clock_in);
    const co = clock_out ? clientTime(clock_out) : null;
    if (isNaN(ci)) return res.status(400).json({ error: 'Invalid clock-in time.' });
    if (co && isNaN(co)) return res.status(400).json({ error: 'Invalid clock-out time.' });
    if (co && co < ci)
      return res.status(400).json({ error: 'Clock-out must be after clock-in.' });
    const clash = await overlappingPunch(employeeId, ci, co, null);
    if (clash) return res.status(409).json({ error: clashMessage(clash) });

    const _id = await store.nextId('punches');
    try {
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
    } catch (err) {
      if (err.code === 11000)
        return res.status(409).json({ error: 'This employee already has an entry with no clock-out.' });
      throw err;
    }
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

    const ci = req.body?.clock_in ? clientTime(req.body.clock_in) : new Date(p.clock_in);
    let co;
    if (req.body?.clock_out === '' || req.body?.clock_out === null) {
      co = null; // explicitly reopen the entry
    } else if (req.body?.clock_out) {
      co = clientTime(req.body.clock_out);
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
    const clash = await overlappingPunch(p.employee_id, ci, co, id);
    if (clash) return res.status(409).json({ error: clashMessage(clash) });

    try {
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
    } catch (err) {
      // Reopening while another entry is still open: the one-open-punch index.
      if (err.code === 11000)
        return res.status(409).json({ error: 'This employee already has an entry with no clock-out.' });
      throw err;
    }
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

// Another entry of the same employee whose time overlaps clock_in…clock_out (an
// entry with no clock-out runs until now). Hours on top of hours would be paid
// twice, so an edit that would cause that is refused and points at the other.
function overlappingPunch(employeeId, ci, co, exceptId) {
  return store.punches.findOne({
    employee_id: employeeId,
    ...(exceptId != null ? { _id: { $ne: exceptId } } : {}),
    clock_in: { $lt: co || new Date() },
    $or: [{ clock_out: null }, { clock_out: { $gt: ci } }],
  });
}
const clashMessage = (p) =>
  `That overlaps another entry for this employee (clocked in ${localDateTime(p.clock_in)}${
    p.clock_out ? `, out ${localDateTime(p.clock_out)}` : ', still open'
  }). Change or delete that one first.`;

// ---------------------------------------------------------------------------
// Admin: CSV export
// ---------------------------------------------------------------------------

function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  // Text starting with = + - @ (or a tab or return) is run as a formula when
  // the file is opened in Excel or Google Sheets — and work notes are typed by
  // employees. A leading apostrophe makes the spreadsheet show it as text.
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// "2026-10-23 17:00" in TIMEZONE — how the office reads a time. (An ISO string
// is UTC, four or five hours off what anyone in Ontario expects to see.)
const csvTimeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
function localDateTime(d) {
  if (d == null) return '';
  const p = Object.fromEntries(csvTimeFormat.formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
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
          csvCell(localDateTime(r.clock_in)),
          csvCell(localDateTime(r.clock_out)),
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
    const reply = errorReply(err);
    if (reply.fault) recordFault(req, err, reply.status);
    res.status(reply.status).json({ error: reply.message });
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
      // Matched in the company connected now — a match from another one (the
      // sandbox) doesn't count.
      matched: hourly.filter((e) => qbo.matchIn(e, status.realm_id)).length,
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
    if (!(checkedSession(req) && req.session.admin))
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
    // Noted with the company it belongs to: the same id in another company is
    // another person.
    const realm = (await qbo.getStatus()).realm_id;
    await store.employees.updateOne(
      { _id: id },
      qboId
        ? { $set: { qbo_employee_id: qboId, qbo_realm_id: realm || null } }
        : { $unset: { qbo_employee_id: '', qbo_realm_id: '' } }
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
    const pushed = await store.qboTime.countDocuments({ day: { $gte: period.start, $lte: period.end } });
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
      // Fits the host's time limit; a period too big for one go finishes on
      // the next click (nothing is pushed twice).
      budgetMs: Number(process.env.QBO_SYNC_BUDGET_MS) || 45000,
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
  if (secret) {
    const want = Buffer.from(`Bearer ${secret}`);
    const got = Buffer.from(String(req.headers.authorization || ''));
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return true;
  }
  // An admin firing it by hand from the dashboard — by POST only. The browser
  // sends the login cookie with a plain GET from any other site (a link, an
  // image), which would let a page the admin happens to open set it off.
  if (req.method !== 'POST') return false;
  const s = checkedSession(req);
  return !!(s && s.admin && s.role !== 'dev');
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
  // Counts only: the full result lists people and their hours, and a
  // scheduler's log is no place for that.
  const r = result.result || {};
  res.json({
    ran: !!result.ran,
    skipped: result.skipped || null,
    period: result.period || null,
    error: result.error || null,
    created: r.created,
    updated: r.updated,
    deleted: r.deleted,
    failed: r.failed,
    incomplete: !!r.incomplete,
  });
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

// `src: 'layout'` marks a line the estimator generated from the drawing, so
// redrawing the fence replaces those lines and leaves typed ones alone.
function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => {
      const line = {
        description: String(it?.description || '').trim(),
        qty: toNum(it?.qty),
        unit: String(it?.unit || '').trim(),
        unit_price: toNum(it?.unit_price),
      };
      if (it?.src === 'layout') line.src = 'layout';
      return line;
    })
    .filter((it) => it.description || it.qty || it.unit_price);
}

// The same arithmetic as the editor, the PDF and the customer's page (see
// public/totals.js), so every copy of a quote agrees to the cent.
function quoteTotals(items, taxRate) {
  const t = docTotals.totalsOf(items, toNum(taxRate));
  return { subtotal: t.subtotal, tax: t.tax, total: t.total };
}

// The job a quote or invoice is for, which is often not where the bill goes:
// a farm's mailing address and the back forty are different places.
const cleanLine = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const cleanPct = (v) => Math.min(100, Math.max(0, toNum(v)));
const dateOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
};
const QUOTE_VALID_DAYS = 30;

// "Valid until" is a calendar day. A quote is still good all through that day
// in the business's own timezone, and an accepted one never expires.
const quoteExpired = (q) =>
  !!q.valid_until && q.status !== 'accepted' && qbo.localDay(new Date()) > qbo.calendarDay(q.valid_until);

// The drawn fence, priced, as kept on the quote — so the list and the review
// can show cost and margin without re-running the takeoff. Recomputed here on
// every save from the current catalog, never taken from the browser.
function takeoffSummary(t) {
  if (!t || !t.groups.length) return null;
  return {
    fence_ft: t.totals.fence_ft,
    gates: t.totals.gates,
    posts: t.totals.posts,
    material_cost: t.totals.material_cost,
    labor_cost: t.totals.labor_cost,
    cost: t.totals.cost,
    price: t.totals.price,
    fences: t.groups.map((g) => ({ label: g.label, fence_ft: g.fence_ft })),
  };
}

async function readLayout(raw) {
  const layout = takeoff.cleanLayout(raw);
  if (!layout) return { layout: null, takeoff: null };
  return { layout, takeoff: takeoffSummary(takeoff.compute(layout, await catalog.getCatalog())) };
}

// `list` leaves out the heavy parts (the drawing, the signature image, the
// last review) that only the editor needs.
function quoteView(q, { list } = {}) {
  const totals = quoteTotals(q.items, q.tax_rate);
  const depositPct = q.deposit_pct || 0;
  const t = q.takeoff || null;
  return {
    id: q._id,
    number: q.number,
    customer: q.customer || { name: '', address: '', phone: '', email: '' },
    project: q.project || '',
    job_site: q.job_site || '',
    quote_date: iso(q.quote_date),
    valid_until: iso(q.valid_until),
    expired: quoteExpired(q),
    items: q.items || [],
    tax_rate: q.tax_rate || 0,
    deposit_pct: depositPct,
    deposit: docTotals.deposit(totals.total, depositPct),
    notes: q.notes || '',
    status: q.status || 'draft',
    created_at: iso(q.created_at),
    updated_at: iso(q.updated_at),
    ...totals,
    takeoff: t,
    margin_pct: t && totals.subtotal > 0 ? round2(((totals.subtotal - t.cost) / totals.subtotal) * 100) : null,
    // The customer's side: the link, and what they have done with it.
    share_token: q.share_token || null,
    sent_at: iso(q.sent_at),
    viewed_at: iso(q.viewed_at),
    last_viewed_at: iso(q.last_viewed_at),
    view_count: q.view_count || 0,
    accepted_at: iso(q.accepted_at),
    declined_at: iso(q.declined_at),
    decline_reason: q.decline_reason || '',
    signed_total: q.signed_total != null ? q.signed_total : null,
    signature: q.signature
      ? { name: q.signature.name, at: iso(q.signature.at), ...(list ? {} : { image: q.signature.image }) }
      : null,
    // False once the terms have moved on from what was signed: nothing may
    // then present the signature as agreeing to them.
    signature_current: signatureCurrent(q),
    ...(list ? {} : { layout: q.layout || null, review: q.review || null }),
    request_notes: q.request_notes || '',
    source: q.source || null,
  };
}

// One row of the quotes list: only what the list shows. Opening a quote loads
// the rest. Line items, terms and the drawing stay on the server — over a few
// years of quotes they were most of the list's weight.
function quoteListRow(q) {
  const v = quoteView(q, { list: true });
  return {
    id: v.id,
    number: v.number,
    customer: { name: v.customer.name || '' },
    project: v.project,
    quote_date: v.quote_date,
    created_at: v.created_at,
    total: v.total,
    margin_pct: v.margin_pct,
    status: v.status,
    expired: v.expired,
    sent_at: v.sent_at,
    viewed_at: v.viewed_at,
    last_viewed_at: v.last_viewed_at,
    view_count: v.view_count,
    declined_at: v.declined_at,
    signature: v.signature ? { name: v.signature.name } : null,
    signature_current: v.signature_current,
  };
}

// "<created_at>_<id>" of the last row sent: the next page starts after it.
const quoteCursor = (q) => (q.created_at ? q.created_at.toISOString() + '_' + q._id : null);
function parseQuoteCursor(s) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)_(\d+)$/.exec(String(s || ''));
  if (!m) return null;
  const at = new Date(m[1]);
  return Number.isNaN(at.getTime()) ? null : { at, id: Number(m[2]) };
}

// The quotes list, newest first. With ?limit=N it comes a page at a time —
// { quotes, next }, and ?before=<next> asks for the page after — in the short
// row shape above. Without it, every quote in the full shape, as it always was.
//
// The drawing is read (not sent) even for the list: whether a signature still
// stands depends on it, and leaving it out once made every signed quote with a
// drawing read "Changed since it was signed".
app.get(
  '/api/admin/quotes',
  requireQuotes,
  wrap(async (req, res) => {
    const projection = { review: 0, 'signature.image': 0 };
    if (req.query.limit === undefined) {
      const rows = await store.quotes.find({}, { sort: { created_at: -1 }, projection }).toArray();
      return res.json(rows.map((q) => quoteView(q, { list: true })));
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const after = parseQuoteCursor(req.query.before);
    const filter = after
      ? { $or: [{ created_at: { $lt: after.at } }, { created_at: after.at, _id: { $lt: after.id } }] }
      : {};
    const rows = await store.quotes
      .find(filter, { sort: { created_at: -1, _id: -1 }, projection, limit: limit + 1 })
      .toArray();
    const more = rows.length > limit;
    if (more) rows.pop();
    res.json({
      quotes: rows.map(quoteListRow),
      next: more && rows.length ? quoteCursor(rows[rows.length - 1]) : null,
    });
  })
);

// ---- the estimator's helpers (registered before "/:id" so Express never
//      reads "catalog" as a quote id) ----

// The materials & labour catalog. Everyone who can quote reads it; only the
// office changes the prices in it.
app.get(
  '/api/admin/quotes/catalog',
  requireQuotes,
  wrap(async (req, res) => {
    res.json({ ...(await catalog.getCatalog()), can_edit: !!(checkedSession(req) && req.session.admin) });
  })
);

app.patch(
  '/api/admin/quotes/catalog',
  requireAdmin,
  wrap(async (req, res) => {
    res.json({ ...(await catalog.saveCatalog(req.body || {})), can_edit: true });
  })
);

app.post(
  '/api/admin/quotes/catalog/reset',
  requireAdmin,
  wrap(async (req, res) => {
    res.json({ ...(await catalog.resetCatalog()), can_edit: true });
  })
);

// Find the customer's property for the satellite estimator.
app.get(
  '/api/admin/quotes/geocode',
  requireQuotes,
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    let results = await searchAddress(q, 'fence quote address lookup');
    // OpenStreetMap knows most rural roads but few rural house numbers, so a
    // farm address finds nothing as typed. The road itself still lands the map
    // in the right place to find the property by eye.
    const street = q.replace(/^\s*\d+[a-z]?\s+/i, '');
    if (!results.length && street !== q)
      results = (await searchAddress(street, 'fence quote address lookup')).map((r) => ({ ...r, approx: true }));
    res.json({ results });
  })
);

// How steep each drawn leg is. Natural Resources Canada's elevation service
// (CDEM, free under the Open Government Licence) is sampled along the leg; the
// rise over the run is its grade. It is a ~20 m terrain model with whole-metre
// heights — good for "this run climbs a hill", not for a gentle swale, so a
// short leg reads as flat rather than as noise. Canada only.
const inCanada = (lat, lng) => lat > 41.6 && lat < 84 && lng > -141.1 && lng < -52;

// Ground distance in metres, unrounded. (distanceKm rounds to 0.1 km for the
// mileage sheet, which would turn every yard-sized leg into 0 or 100 m.)
function metresBetween(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// A leg's grade in percent; 0 for a leg too short for the terrain model to
// say anything about; null when the service could not be asked or answered.
async function legGrade(a, b, timeoutMs = 6000) {
  const lenM = metresBetween(a, b);
  if (lenM < 12) return 0;
  const steps = Math.max(1, Math.min(8, Math.round(lenM / 15)));
  const path = `LINESTRING(${a[1]} ${a[0]},${b[1]} ${b[0]})`;
  const r = await fetch(
    `https://geogratis.gc.ca/services/elevation/cdem/profile?path=${encodeURIComponent(path)}&steps=${steps}`,
    { headers: { 'User-Agent': 'HEK-Timeclock/1.0 (fence slope check)' }, signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!r.ok) return null;
  const alts = (await r.json()).map((p) => Number(p && p.altitude)).filter(Number.isFinite);
  if (alts.length < 2) return null;
  return Math.round(((Math.max(...alts) - Math.min(...alts)) / lenM) * 1000) / 10;
}

app.post(
  '/api/admin/quotes/terrain',
  requireQuotes,
  wrap(async (req, res) => {
    const layout = takeoff.cleanLayout({ segments: (req.body && req.body.segments) || [] });
    if (!layout) return res.json({ terrain: {} });
    const first = layout.segments[0].points[0];
    if (!inCanada(first[0], first[1]))
      return res.json({ terrain: {}, note: 'Slope data covers Canada only.' });
    const jobs = [];
    for (const s of layout.segments)
      for (let i = 1; i < s.points.length; i++) jobs.push({ id: s.id, i: i - 1, a: s.points[i - 1], b: s.points[i] });
    // Keyed by run id, which comes from the request: no prototype, so no id can
    // reach Object.prototype. (cleanLayout refuses such ids too.)
    const terrain = Object.create(null);
    for (const s of layout.segments) terrain[s.id] = new Array(Math.max(0, s.points.length - 1)).fill(null);
    let unknown = 0;
    // A few at a time — it is a public government service. A leg it can't
    // answer for stays null ("not checked"), never 0 ("level"), so the editor
    // can say so and ask again later.
    const LIMIT = 60;
    unknown += Math.max(0, jobs.length - LIMIT);
    const todo = jobs.slice(0, LIMIT);
    // One deadline for the whole check, well inside a serverless time limit:
    // a slow service then means "not checked" for the legs left over, not a
    // request the host kills and an editor left with nothing.
    const deadline = Date.now() + 8000;
    for (let k = 0; k < todo.length; k += 6) {
      if (Date.now() > deadline) {
        unknown += todo.length - k;
        break;
      }
      await Promise.all(
        todo.slice(k, k + 6).map(async (j) => {
          let g = null;
          try {
            g = await legGrade(j.a, j.b, Math.max(1000, Math.min(6000, deadline - Date.now())));
          } catch (err) {
            g = null;
          }
          if (g == null) unknown++;
          terrain[j.id][j.i] = g;
        })
      );
    }
    res.json({
      terrain: { ...terrain },
      unknown,
      note: !unknown
        ? null
        : unknown === jobs.length
          ? 'The elevation service did not answer — slope was not checked.'
          : `Slope couldn't be checked for ${unknown} of ${jobs.length} legs — they are priced as level.`,
    });
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
    const quoteDate = dateOrNull(b.quote_date) || now;
    const status = QUOTE_STATUSES.has(b.status) ? b.status : 'draft';
    const doc = {
      _id,
      number: 'Q' + String(1000 + _id),
      customer,
      project: cleanLine(b.project, 200),
      job_site: cleanLine(b.job_site, 400),
      quote_date: quoteDate,
      valid_until:
        dateOrNull(b.valid_until) || new Date(quoteDate.getTime() + QUOTE_VALID_DAYS * 86400000),
      items: cleanItems(b.items),
      tax_rate: toNum(b.tax_rate),
      deposit_pct: cleanPct(b.deposit_pct),
      notes: String(b.notes || '').trim(),
      status,
      ...(await readLayout(b.layout)),
      ...(status === 'sent' ? { sent_at: now } : {}),
      ...(status === 'accepted' ? { accepted_at: now } : {}),
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
    if (b.quote_date != null && dateOrNull(b.quote_date)) set.quote_date = dateOrNull(b.quote_date);
    // Blank means "no expiry", so an explicit null is honoured, not skipped.
    if (b.valid_until !== undefined) set.valid_until = dateOrNull(b.valid_until);
    if (b.project != null) set.project = cleanLine(b.project, 200);
    if (b.job_site != null) set.job_site = cleanLine(b.job_site, 400);
    if (b.deposit_pct != null) set.deposit_pct = cleanPct(b.deposit_pct);
    if (b.status != null && QUOTE_STATUSES.has(b.status) && b.status !== (q.status || 'draft')) {
      // The customer can change the status too (accepting or declining online),
      // so a status change says which status it is changing FROM. If that is no
      // longer the stored one, the editor is out of date — most likely the
      // customer has just answered — and the change is refused rather than
      // silently undoing what they did.
      if (b.status_from != null && b.status_from !== (q.status || 'draft'))
        return res.status(409).json({
          error:
            q.status === 'accepted'
              ? 'The customer has just accepted this quote. Reopen it to see their signature.'
              : q.status === 'declined'
                ? 'The customer has just declined this quote. Reopen it to see why.'
                : 'This quote changed since you opened it. Reopen it and try again.',
          status: q.status || 'draft',
        });
      set.status = b.status;
      // Marked by hand — e.g. a paper copy came back signed.
      if (b.status === 'sent' && !q.sent_at) set.sent_at = set.updated_at;
      if (b.status === 'accepted' && !q.accepted_at) set.accepted_at = set.updated_at;
    }
    if (b.layout !== undefined) Object.assign(set, await readLayout(b.layout));

    const name = (set.customer ? set.customer.name : q.customer && q.customer.name) || '';
    if (!name) return res.status(400).json({ error: 'Customer name is required.' });

    // An accepted quote is the record of what was agreed. Contact details can
    // be corrected, but the work, price and terms change only after reopening
    // it (status back to Sent or Draft), and then it is signed again.
    const accepted = (q.status || 'draft') === 'accepted';
    const reopening = accepted && set.status !== undefined && set.status !== 'accepted';
    if (accepted && !reopening && quoteVersion({ ...q, ...set }) !== quoteVersion(q))
      return res.status(409).json({
        error:
          'This quote has been accepted, so its work, price and terms are locked. To change them, set the status ' +
          'back to Sent — the customer will then need to sign the new version.',
        locked: true,
      });
    const update = { $set: set };
    if (reopening) {
      // The signature was given to the old version. It is kept on file, but it
      // no longer stands for this quote — the customer signs again.
      update.$push = {
        signature_history: {
          signature: q.signature || null,
          accepted_at: q.accepted_at || null,
          signed_total: q.signed_total != null ? q.signed_total : null,
          signed_items: q.signed_items || null,
          signed_version: q.signed_version || null,
          reopened_at: set.updated_at,
        },
      };
      update.$unset = { signature: '', accepted_at: '', signed_total: '', signed_items: '', signed_version: '', signed_layout: '' };
    }

    // Only if the status is still the one read above: a customer's answer that
    // lands in between must not be overwritten by this save.
    const written = await store.quotes.updateOne({ _id: id, status: q.status }, update);
    if (!written.matchedCount)
      return res.status(409).json({ error: 'This quote changed while you were saving. Reopen it and try again.' });
    const updated = await store.quotes.findOne({ _id: id });
    res.json(quoteView(updated));
  })
);

app.delete(
  '/api/admin/quotes/:id',
  requireQuotes,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const q = await store.quotes.findOne({ _id: id });
    if (!q) return res.json({ ok: true });
    // A signed or invoiced quote is the only record of what the customer agreed
    // to, and its link is in their inbox. It stays.
    if (q.status === 'accepted' || q.signature || (await store.invoices.findOne({ quote_id: id })))
      return res.status(409).json({
        error: 'This quote has been accepted or invoiced, so it is kept as the record of what was agreed.',
      });
    await store.quotes.deleteOne({ _id: id, status: { $ne: 'accepted' }, signature: { $exists: false } });
    res.json({ ok: true });
  })
);

// The customer's link: a long random token, made the first time the quote is
// sent or previewed and kept for good, so a link already in someone's inbox
// never stops working. `sent: true` also records that it went out.
app.post(
  '/api/admin/quotes/:id/share',
  requireQuotes,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const q = await store.quotes.findOne({ _id: id });
    if (!q) return res.status(404).json({ error: 'Quote not found.' });
    if (!q.share_token)
      // Only if still unset, so two clicks at once can't hand out two links.
      await store.quotes.updateOne(
        { _id: id, share_token: { $in: [null, ''] } },
        { $set: { share_token: crypto.randomBytes(18).toString('base64url') } }
      );
    if (req.body && req.body.sent) {
      const now = new Date();
      const set = { updated_at: now };
      if (!q.sent_at) set.sent_at = now;
      if ((q.status || 'draft') === 'draft') set.status = 'sent';
      await store.quotes.updateOne({ _id: id }, { $set: set });
    }
    res.json(quoteView(await store.quotes.findOne({ _id: id })));
  })
);

// "Analyze with AI": the arithmetic checks, then Claude's read of the quote.
// The result is kept on the quote so it is still there the next time it opens.
const analyzing = new Set(); // quote ids with a review in progress on this instance
app.post(
  '/api/admin/quotes/:id/analyze',
  requireQuotes,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const q = await store.quotes.findOne({ _id: id });
    if (!q) return res.status(404).json({ error: 'Quote not found.' });
    // A double click shouldn't pay for the same review twice.
    if (analyzing.has(id)) return res.status(409).json({ error: 'Already reviewing this quote — one moment.' });
    if (q.review && q.review.at && Date.now() - new Date(q.review.at).getTime() < 15000 && q.updated_at < new Date(q.review.at))
      return res.json(q.review);
    analyzing.add(id);
    try {
      const result = await quoteReview.review(q, {
        catalog: await catalog.getCatalog(),
        rateBook: await rateBook.getRateBook(),
        expired: quoteExpired(q),
      });
      await store.quotes.updateOne({ _id: id }, { $set: { review: result } });
      res.json(result);
    } finally {
      analyzing.delete(id);
    }
  })
);

// ---------------------------------------------------------------------------
// The customer's quote page ("/quote?k=<token>") — no login. The token is the
// whole of the access: it is long and random, a miss counts as a failed
// attempt, and too many misses from one address lock it out like a bad
// password does. What it returns is what the customer is shown — never the
// cost, margin or review.
// ---------------------------------------------------------------------------

const quotePortalLimiter = limiter('quote-portal');
const isStaff = (req) => !!(checkedSession(req) && (req.session.admin || req.session.employeeId));

// What the customer is agreeing to, as a short fingerprint: the lines, tax,
// deposit, terms, job and expiry. The page sends back the fingerprint of the
// version it showed; if the office has changed any of it since, the signature
// is refused and the page reloads the new version — nobody can end up on
// record as agreeing to a price they never saw.
function quoteVersion(q) {
  const items = (q.items || []).map((it) => [
    it.description || '',
    Number(it.qty) || 0,
    it.unit || '',
    Number(it.unit_price) || 0,
  ]);
  // The drawing too: the page shows the customer where the fence goes, so a
  // moved run or a removed gate is a different quote even at the same price.
  const l = q.layout && Array.isArray(q.layout.segments) ? q.layout : null;
  const drawing = l
    ? [
        l.segments.map((s) => [
          s.system || '',
          Number(s.height_ft) || 0,
          !!s.tearout,
          (s.points || []).map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]),
        ]),
        (l.gates || []).map((g) => [g.seg || '', Number(g.leg) || 0, Number(g.t) || 0, Number(g.width) || 0, !!g.double]),
      ]
    : null;
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        items,
        Number(q.tax_rate) || 0,
        Number(q.deposit_pct) || 0,
        q.notes || '',
        q.project || '',
        q.job_site || '',
        iso(q.valid_until),
        drawing,
      ])
    )
    .digest('base64url')
    .slice(0, 16);
}

// Whether a quote's signature still stands for what the quote says now. A
// quote signed before versions were kept falls back on its signed total.
function signatureCurrent(q) {
  if (!q.signature || q.status !== 'accepted') return false;
  if (q.signed_version) return q.signed_version === quoteVersion(q);
  if (q.signed_total == null) return true;
  return docTotals.toCents(q.signed_total) === docTotals.toCents(quoteTotals(q.items, q.tax_rate).total);
}

function portalView(q, cat) {
  const totals = quoteTotals(q.items, q.tax_rate);
  const depositPct = q.deposit_pct || 0;
  const layout = q.layout
    ? { segments: q.layout.segments, gates: q.layout.gates, center: q.layout.center, zoom: q.layout.zoom }
    : null;
  return {
    number: q.number,
    status: q.status || 'draft',
    expired: quoteExpired(q),
    customer: { name: (q.customer && q.customer.name) || '', address: (q.customer && q.customer.address) || '' },
    project: q.project || '',
    job_site: q.job_site || '',
    quote_date: iso(q.quote_date),
    valid_until: iso(q.valid_until),
    items: (q.items || []).map((it) => ({
      description: it.description,
      qty: it.qty,
      unit: it.unit,
      unit_price: it.unit_price,
    })),
    tax_rate: q.tax_rate || 0,
    ...totals,
    deposit_pct: depositPct,
    deposit: docTotals.deposit(totals.total, depositPct),
    notes: q.notes || '',
    layout,
    // The legend, so the page doesn't need the catalog: each fence's name,
    // colour and footage, and the gates — without the estimator's own prices.
    legend: layout
      ? takeoff.layoutLegend(layout, cat).map((g) => ({
          label: g.label,
          color: g.color,
          fence_ft: g.fence_ft,
          gates: (g.gates || []).map((x) => ({ count: x.count, label: x.label })),
        }))
      : [],
    version: quoteVersion(q),
    accepted_at: iso(q.accepted_at),
    declined_at: iso(q.declined_at),
    signature: q.signature ? { name: q.signature.name, at: iso(q.signature.at), image: q.signature.image } : null,
    signature_current: signatureCurrent(q),
  };
}

async function quoteByToken(req, res) {
  const token = String(req.params.token || '');
  const q = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await store.quotes.findOne({ share_token: token }) : null;
  if (!q) {
    await recordFail(req._rlKey);
    res.status(404).json({ error: 'This quote link is not valid. Please check it, or contact HEK Fencing.' });
    return null;
  }
  return q;
}

app.get(
  '/api/public/quote/:token',
  quotePortalLimiter,
  wrap(async (req, res) => {
    const q = await quoteByToken(req, res);
    if (!q) return;
    // The office previewing its own link isn't the customer reading it.
    if (!isStaff(req)) {
      const now = new Date();
      await store.quotes.updateOne(
        { _id: q._id },
        { $set: { last_viewed_at: now, ...(q.viewed_at ? {} : { viewed_at: now }) }, $inc: { view_count: 1 } }
      );
    }
    res.json(portalView(q, await catalog.getCatalog()));
  })
);

// Approve & sign. The signature is the picture they drew plus their typed
// name, stamped with when and from where. What they signed for — the lines
// and the total — is kept alongside, so a later edit can't quietly change
// what was agreed.
app.post(
  '/api/public/quote/:token/accept',
  quotePortalLimiter,
  wrap(async (req, res) => {
    const q = await quoteByToken(req, res);
    if (!q) return;
    const b = req.body || {};
    if (q.status === 'accepted') return res.status(409).json({ error: 'This quote has already been accepted.' });
    if (quoteExpired(q))
      return res.status(410).json({ error: 'This quote has expired. Please contact us for an updated price.' });
    const name = cleanLine(b.name, 120);
    if (name.length < 2) return res.status(400).json({ error: 'Please type your full name.' });
    const image = String(b.signature || '');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length < 200)
      return res.status(400).json({ error: 'Please sign in the box.' });
    if (image.length > 400000) return res.status(400).json({ error: 'That signature is too large — please clear it and sign again.' });
    if (b.agree !== true) return res.status(400).json({ error: 'Please tick the box to accept the quote.' });

    // Signing what is on their screen, not whatever the quote says now.
    const changed = () =>
      res.status(409).json({
        error: 'We have updated this quote since you opened it. Please look over the new version before signing.',
        changed: true,
      });
    if (String(b.version || '') !== quoteVersion(q)) return changed();

    const now = new Date();
    const totals = quoteTotals(q.items, q.tax_rate);
    // Only if nothing has changed since it was read a moment ago — an edit
    // saved in between must not be signed for on the customer's behalf.
    const r = await store.quotes.updateOne(
      { _id: q._id, status: { $ne: 'accepted' }, updated_at: q.updated_at },
      {
        $set: {
          status: 'accepted',
          accepted_at: now,
          signature: {
            name,
            image,
            at: now,
            ip: cleanLine(clientIp(req), 60),
            agent: cleanLine(req.headers['user-agent'], 200),
          },
          signed_total: totals.total,
          signed_items: q.items || [],
          // Exactly what was signed: the version (checked against the page's
          // just above) and the drawing that went with it.
          signed_version: quoteVersion(q),
          signed_layout: q.layout ? { segments: q.layout.segments, gates: q.layout.gates || [] } : null,
          updated_at: now,
        },
        $unset: { declined_at: '', decline_reason: '' },
      }
    );
    if (!r.matchedCount) return changed();
    res.json(portalView(await store.quotes.findOne({ _id: q._id }), await catalog.getCatalog()));
  })
);

app.post(
  '/api/public/quote/:token/decline',
  quotePortalLimiter,
  wrap(async (req, res) => {
    const q = await quoteByToken(req, res);
    if (!q) return;
    if (q.status === 'accepted')
      return res.status(409).json({ error: 'This quote has already been accepted — please call us to make a change.' });
    const now = new Date();
    // Not over an acceptance that lands at the same moment (another tab, or
    // the office marking it accepted): only a quote still not accepted.
    const r = await store.quotes.updateOne(
      { _id: q._id, status: { $ne: 'accepted' } },
      {
        $set: {
          status: 'declined',
          declined_at: now,
          decline_reason: cleanLine(req.body && req.body.reason, 1000),
          updated_at: now,
        },
      }
    );
    if (!r.matchedCount)
      return res.status(409).json({ error: 'This quote has already been accepted — please call us to make a change.' });
    res.json(portalView(await store.quotes.findOne({ _id: q._id }), await catalog.getCatalog()));
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

// Every request counts here, not just failed ones: these cost money (the road
// photo is billed per picture) or lean on a free service's goodwill (the map
// tiles, the address search), whether or not they "succeed".
const geoBudget = budget('estimate-geo', 30, RL_WINDOW_MS);
const tileBudget = budget('estimate-tile', 600, RL_WINDOW_MS);
const photoBudget = budget('estimate-photo', 30, RL_WINDOW_MS);
const priceBudget = budget('estimate-price', 200, RL_WINDOW_MS);
const requestBudget = budget('estimate-request', 5, 60 * 60 * 1000);
// Ceilings for everyone together, per day. Generous for real customers; a
// flood that keeps changing address stops here.
const STREETVIEW_DAILY_CAP = Number(process.env.STREETVIEW_DAILY_CAP) || 500;
const REQUEST_DAILY_CAP = Number(process.env.ESTIMATE_REQUEST_DAILY_CAP) || 200;

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
  geoBudget,
  wrap(async (req, res) => {
    const settings = await estimates.getSettings();
    if (!settings.enabled) return res.json({ results: [] });
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 3) return res.json({ results: [] });
    try {
      const data = await nominatim(
        'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=ca,us&q=' +
          encodeURIComponent(q),
        'customer estimate address lookup'
      );
      res.json({ results: placesFrom(data) });
    } catch (err) {
      // Said plainly, so "nothing found" never stands in for "couldn't look".
      console.error('estimate geocode failed:', err.message);
      res.status(err.status || 503).json({ error: err.status ? err.message : 'Address search failed. Try again.', results: [] });
    }
  })
);

// The address at a position — used when the customer lets the browser place
// them, so the request carries a street address rather than bare coordinates.
app.get(
  '/api/estimate/reverse',
  geoBudget,
  wrap(async (req, res) => {
    const settings = await estimates.getSettings();
    if (!settings.enabled) return res.json({ label: null });
    const { lat, lng } = cleanLatLng(req.query.lat, req.query.lng);
    if (lat == null) return res.json({ label: null });
    try {
      // Rounded to about a metre: close enough for a street address, and
      // repeat asks for the same spot hit the cache.
      const data = await nominatim(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`,
        'customer estimate address lookup'
      );
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
  tileBudget,
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
  photoBudget,
  wrap(async (req, res) => {
    const settings = await estimates.getSettings();
    if (!settings.enabled) return res.status(404).json({ error: 'Estimates are closed.' });
    // Each picture is billed to the business's Google account.
    if (await overDailyCap('estimate-photo', STREETVIEW_DAILY_CAP))
      return res.status(429).json({ error: 'Road photos are unavailable for the rest of today.' });
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
  photoBudget,
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
  priceBudget,
  wrap(async (req, res) => {
    const settings = await estimates.getSettings();
    if (!settings.enabled)
      return res.status(403).json({ error: 'The estimate page is not available right now.' });
    res.json(await estimates.priceItems(req.body && req.body.items));
  })
);

app.post(
  '/api/estimate/request',
  requestBudget,
  wrap(async (req, res) => {
    if (await overDailyCap('estimate-request', REQUEST_DAILY_CAP))
      return res
        .status(429)
        .json({ error: 'We can\'t take more requests online today. Please call or email us instead.' });
    try {
      const doc = await estimates.createRequest(req.body || {}, {
        ip: clientIp(req),
        agent: req.headers['user-agent'],
      });
      res.json({ ok: true, reference: 'R' + String(1000 + doc._id), total: doc.total });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
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

// Just the number of new requests, for the sidebar badge on every dashboard
// load — no need to ship the whole queue for one figure.
app.get(
  '/api/admin/estimate/requests/count',
  requireAdmin,
  wrap(async (req, res) => {
    res.json({ unread: await estimates.countNew() });
  })
);

// The fence system a rate-book service is, or undefined (tear-out, repairs and
// the like are per-foot services too, but not a fence anyone can draw).
const systemForService = (service) =>
  Object.keys(takeoff.SYSTEMS).find((k) => takeoff.SYSTEMS[k].ratebook === service);

// The line of a request that is the traced fence: the first per-foot line
// whose service is a fence system. Null when none is.
const fenceLineOf = (r) =>
  (r.items || []).find((i) => takeoff.isLinearFoot(i.unit) && systemForService(i.service)) || null;

// A public request's traced runs as an estimator layout, as the fence they
// priced (the rate book and the catalog name the same fences), at the height
// they picked in the 3D view if they did.
function layoutFromRequest(r) {
  const runs = (r.measurement && r.measurement.runs) || [];
  if (!runs.length) return null;
  const line = fenceLineOf(r);
  const system = (line && systemForService(line.service)) || 'wood_privacy';
  const height = (r.preview && Number(r.preview.height_ft)) || takeoff.SYSTEMS[system].height;
  return {
    address: r.site || '',
    segments: runs.map((points, i) => ({ id: 's' + (i + 1), system, height_ft: height, points })),
    gates: [],
  };
}

// The editor's starting terms for a new quote (the same words as in quotes.js).
const QUOTE_DEFAULT_TERMS =
  'Free estimate. Prices in CAD; top-quality materials and professional ' +
  'installation included unless noted. A deposit may be required to ' +
  'schedule your installation.';

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

    // Everything that can fail is worked out before the request is claimed, so
    // a failure here leaves it approvable instead of "already quoted".
    const layout = await readLayout(layoutFromRequest(r));
    const fence = layout.layout ? fenceLineOf(r) : null;
    const items = (r.items || []).map((i) => ({
      description: i.description,
      qty: i.qty,
      unit: i.unit,
      unit_price: i.unit_price,
      // With the drawing attached, the fence line IS the drawn fence: tagged
      // as such, "Put on quote" replaces it with the estimator's lines instead
      // of pricing the fence a second time. Only that line — tear-out or a
      // second service priced by the foot is not part of the drawing.
      ...(fence && i.service === fence.service ? { src: 'layout' } : {}),
    }));
    // The page lifted a small job to the minimum charge, and that is the total
    // the customer was shown; the quote carries the difference as its own line.
    if (r.below_minimum) {
      const lines = round2(items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0));
      const topUp = round2((Number(r.subtotal) || 0) - lines);
      if (topUp > 0) items.push({ description: 'Minimum job charge', qty: 1, unit: 'each', unit_price: topUp });
    }

    const quoteId = await store.nextId('quotes');
    const now = new Date();
    // Claimed first, in one step, so a double click can't make two quotes.
    const claim = await store.estimateRequests.updateOne(
      { _id: id, quote_id: null },
      { $set: { status: 'approved', quote_id: quoteId, approved_at: now } }
    );
    if (!claim.modifiedCount)
      return res.status(409).json({ error: 'That request has already been turned into a quote.' });

    const quote = {
      _id: quoteId,
      number: 'Q' + String(1000 + quoteId),
      customer: cleanCustomer(r.customer),
      quote_date: now,
      valid_until: new Date(now.getTime() + QUOTE_VALID_DAYS * 86400000),
      items: cleanItems(items),
      tax_rate: toNum(r.tax_rate),
      // The quote's notes are its printed terms. What the customer wrote on
      // the request is kept for the office to read, not sent back to them as
      // something they agree to.
      notes: QUOTE_DEFAULT_TERMS,
      request_notes: cleanLine(r.notes, 2000),
      status: 'draft',
      // The line the customer traced comes across as the quote's fence
      // layout, so the estimator starts from their drawing, not a blank map.
      ...layout,
      // Where it came from, so the estimator can reread the original request.
      source: { type: 'estimate', request_id: id },
      created_at: now,
      updated_at: now,
    };
    try {
      await store.quotes.insertOne(quote);
    } catch (err) {
      // Give the request back rather than leave it pointing at nothing.
      await store.estimateRequests.updateOne(
        { _id: id, quote_id: quoteId },
        { $set: { status: r.status || 'new', quote_id: null }, $unset: { approved_at: '' } }
      );
      throw err;
    }
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
// Payment terms printed on the invoice. "custom" means someone picked a due
// date by hand, so the terms no longer describe it.
const INVOICE_TERMS = { receipt: 0, net7: 7, net15: 15, net30: 30, net45: 45, net60: 60, custom: null };

// Each payment carries an id of its own, made here — never taken from the
// browser — so removing one names exactly that payment, whatever has been
// added or removed since the page was drawn.
function cleanPayments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => ({
      id: crypto.randomUUID(),
      amount: round2(toNum(p?.amount)),
      date: p?.date ? new Date(p.date) : new Date(),
      method: String(p?.method || '').trim().slice(0, 60),
      note: String(p?.note || '').trim().slice(0, 500),
    }))
    .filter((p) => p.amount > 0 && !isNaN(p.date));
}

// Payments recorded before they had ids get them, once, the first time the
// invoice is opened. Written only if the list is still exactly as read, so a
// payment added meanwhile is never lost; the fresh copy is returned either way.
async function withPaymentIds(inv) {
  if (!inv || (inv.payments || []).every((p) => p.id)) return inv;
  const payments = inv.payments.map((p) => (p.id ? p : { ...p, id: crypto.randomUUID() }));
  await store.invoices.updateOne({ _id: inv._id, payments: inv.payments }, { $set: { payments } });
  return store.invoices.findOne({ _id: inv._id });
}

const todayLocal = () => qbo.localDay(new Date());

function invoiceView(inv) {
  const totals = quoteTotals(inv.items, inv.tax_rate);
  const payments = (inv.payments || []).map((p) => ({ ...p, id: p.id || null, date: iso(p.date) }));
  const paid = round2(payments.reduce((s, p) => s + toNum(p.amount), 0));
  const balance = round2(totals.total - paid);
  // A picked due date is a calendar day; see calendarDay in quickbooks.js.
  const dueDay = inv.due_date ? qbo.calendarDay(inv.due_date) : null;

  // The stored status only says what the office did with it. Whether it is
  // settled or late falls out of the numbers.
  let status = inv.status || 'draft';
  if (status !== 'void' && status !== 'draft') {
    if (totals.total > 0 && balance <= 0) status = 'paid';
    // Late only while something is actually owed: a no-charge invoice (a
    // warranty call, say) is never overdue.
    else if (balance > 0 && dueDay && dueDay < todayLocal()) status = 'overdue';
  }

  return {
    id: inv._id,
    number: inv.number,
    customer: inv.customer || { name: '', address: '', phone: '', email: '' },
    project: inv.project || '',
    job_site: inv.job_site || '',
    items: inv.items || [],
    tax_rate: inv.tax_rate || 0,
    notes: inv.notes || '',
    issue_date: iso(inv.issue_date),
    due_date: iso(inv.due_date),
    terms: inv.terms || 'net30',
    po: inv.po || '',
    stored_status: inv.status || 'draft',
    status,
    quote_id: inv.quote_id || null,
    quote_number: inv.quote_number || null,
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
  if (b.project != null) set.project = cleanLine(b.project, 200);
  if (b.job_site != null) set.job_site = cleanLine(b.job_site, 400);
  if (b.po != null) set.po = cleanLine(b.po, 60);
  if (b.terms != null && Object.prototype.hasOwnProperty.call(INVOICE_TERMS, b.terms)) set.terms = b.terms;
  if (b.status != null && INVOICE_STATUSES.has(b.status)) set.status = b.status;
  if (b.payments != null) set.payments = cleanPayments(b.payments);
  return set;
}

app.get(
  '/api/admin/invoices',
  requireAdmin,
  wrap(async (req, res) => {
    const rows = await store.invoices
      .find({}, { sort: { created_at: -1 }, projection: { notes: 0, terms: 0, po: 0 } })
      .toArray();
    const all = rows.map(invoiceView);
    // Totals for the header tiles. Voided invoices are money that was never
    // owed, so they're left out of both.
    const live = all.filter((i) => i.status !== 'void');
    // Each row carries only what the list shows; opening one loads the rest.
    const invoices = all.map((i) => ({
      id: i.id,
      number: i.number,
      customer: { name: (i.customer && i.customer.name) || '' },
      project: i.project,
      issue_date: i.issue_date,
      due_date: i.due_date,
      status: i.status,
      total: i.total,
      paid: i.paid,
      balance: i.balance,
      qbo: i.qbo ? { id: i.qbo.id } : null,
    }));
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
    const inv = await withPaymentIds(await store.invoices.findOne({ _id: Number(req.params.id) }));
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    res.json({ ...invoiceView(inv), shipment: await shipmentOf(inv) });
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
    const termDays = INVOICE_TERMS[set.terms] ?? DEFAULT_TERMS_DAYS;
    const doc = {
      _id,
      number: 'INV-' + String(1000 + _id),
      ...set,
      terms: set.terms || 'net30',
      issue_date: issue,
      due_date: set.due_date || new Date(issue.getTime() + termDays * 86400000),
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
    // Money received is recorded and removed through its own routes, one
    // payment at a time. A form save must never rewrite the list — an editor
    // opened before a payment was recorded would quietly erase it.
    delete set.payments;
    if (set.customer && !set.customer.name)
      return res.status(400).json({ error: 'Customer name is required.' });
    set.updated_at = new Date();

    // Voiding one that is in QuickBooks voids it there too, or the customer
    // keeps getting reminders and a pay link for money they don't owe. If that
    // can't be done now, it is still voided here and the office is told.
    let warning = null;
    if (set.status === 'void' && (inv.status || 'draft') !== 'void' && inv.qbo && inv.qbo.id) {
      try {
        const realm = (await qbo.getStatus()).realm_id;
        if (qbo.sameCompany(inv.qbo, realm)) {
          await qbo.voidInvoice(inv.qbo.id);
          set['qbo.voided_at'] = new Date();
        } else warning = 'Voided here. It was sent to a QuickBooks company that is not connected now — void it there too.';
      } catch (err) {
        warning = `Voided here, but QuickBooks didn't void its copy (${err.detail || err.message}). Void it in QuickBooks too.`;
      }
    }
    await store.invoices.updateOne({ _id: id }, { $set: set });
    res.json({ ...invoiceView(await store.invoices.findOne({ _id: id })), ...(warning ? { warning } : {}) });
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

// Removes the payment with this id — by id, not by its row on someone's
// screen, which may no longer be the row it is on.
app.delete(
  '/api/admin/invoices/:id/payments/:paymentId',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const inv = await withPaymentIds(await store.invoices.findOne({ _id: id }));
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const pid = String(req.params.paymentId);
    const payment = (inv.payments || []).find((p) => p.id === pid);
    if (!payment)
      return res.status(404).json({ error: 'That payment is no longer on this invoice. Reload it to see the current list.' });
    // Recorded in QuickBooks too: take it back there first, so the two don't
    // disagree about what is owed.
    const qboPaymentId = inv.qbo && inv.qbo.payment_ids && inv.qbo.payment_ids[pid];
    if (qboPaymentId) {
      try {
        await qbo.deletePayment(qboPaymentId);
      } catch (err) {
        return res.status(502).json({
          error: `QuickBooks wouldn't remove this payment (${err.detail || err.message}). Remove it there first, then here.`,
        });
      }
    }
    await store.invoices.updateOne(
      { _id: id },
      {
        $pull: { payments: { id: pid } },
        $set: { updated_at: new Date() },
        ...(qboPaymentId ? { $unset: { ['qbo.payment_ids.' + pid]: '' } } : {}),
      }
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
    // Claimed on the quote first, in one step: two people (or two tabs)
    // converting at once would both pass the check above and bill the job twice.
    const claim = await store.quotes.updateOne({ _id: quoteId, invoice_id: null }, { $set: { invoice_id: _id } });
    if (!claim.modifiedCount)
      return res.status(409).json({ error: 'That quote has just been turned into an invoice.' });
    const doc = {
      _id,
      number: 'INV-' + String(1000 + _id),
      customer: q.customer || { name: '', address: '', phone: '', email: '' },
      project: q.project || '',
      job_site: q.job_site || '',
      items: q.items || [],
      tax_rate: q.tax_rate || 0,
      notes: q.notes || '',
      issue_date: now,
      due_date: new Date(now.getTime() + DEFAULT_TERMS_DAYS * 86400000),
      terms: 'net30',
      po: '',
      status: 'draft',
      payments: [],
      quote_id: quoteId,
      quote_number: q.number,
      created_at: now,
      updated_at: now,
    };
    try {
      await store.invoices.insertOne(doc);
    } catch (err) {
      // Give the quote back rather than leave it claimed by nothing.
      await store.quotes.updateOne({ _id: quoteId, invoice_id: _id }, { $set: { invoice_id: null } });
      throw err;
    }
    // Accepting is implied by billing for it.
    if (q.status !== 'accepted')
      await store.quotes.updateOne(
        { _id: quoteId },
        { $set: { status: 'accepted', updated_at: now, ...(q.accepted_at ? {} : { accepted_at: now }) } }
      );
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
    // Once it is in QuickBooks the customer may already have it, with a pay
    // link. Deleting our copy would leave theirs open and owed with nothing
    // here to show for it; voiding voids both.
    if (inv.qbo && inv.qbo.id)
      return res
        .status(409)
        .json({ error: 'This invoice is in QuickBooks. Void it instead of deleting it — that voids it there too.' });
    // Only while that is still true: a payment recorded a moment ago, or a push
    // to QuickBooks, keeps it.
    const r = await store.invoices.deleteOne({
      _id: inv._id,
      'payments.0': { $exists: false },
      'qbo.id': { $exists: false },
    });
    if (!r.deletedCount)
      return res.status(409).json({ error: 'This invoice just changed. Reload it and try again.' });
    // Its quote can be invoiced again.
    if (inv.quote_id != null)
      await store.quotes.updateOne({ _id: inv.quote_id, invoice_id: inv._id }, { $set: { invoice_id: null } });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Invoice -> shipment. Puts the job on the Schedule board's "To be scheduled"
// list with everything the crew and the office need, so nothing is retyped.
// It goes in without a date on purpose: booking the day is the scheduler's
// call, made on the board like any other job.
// ---------------------------------------------------------------------------

const fmtMoney = (n) =>
  '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n) => String(Math.round((Number(n) || 0) * 100) / 100);

// The shipment an invoice made, as the board has it now — or null if none was
// made or it has since been deleted.
//
// An invoice can have several (a split delivery), so it keeps every job id it
// made; the one shown is the latest still on the board, with a count.
const shipmentIdsOf = (inv) => [...(inv.shipment_ids || []), ...(inv.shipment_id ? [inv.shipment_id] : [])];
async function shipmentOf(inv) {
  const ids = shipmentIdsOf(inv);
  if (!ids.length) return null;
  const jobs = await store.schedules.find({ _id: { $in: ids } }).toArray();
  if (!jobs.length) return null;
  const job = jobs.sort((a, b) => b._id - a._id)[0];
  return {
    id: job._id,
    date: job.date || null,
    end_date: job.end_date || null,
    time: job.time || null,
    job_type: job.job_type || 'Delivery',
    count: jobs.length,
  };
}

// A street address for the job's one-line address field. Typed addresses are
// multi-line on the invoice; the schedule's input would silently drop the line
// breaks and run the lines together, so they become ", " here.
const oneLine = (s) =>
  String(s || '')
    .split(/\s*[\r\n]+\s*/)
    .filter(Boolean)
    .join(', ')
    .trim();

// Join lines into a note no longer than the job form keeps (cleanNote cuts
// at 2000), dropping whole lines from the end rather than cutting one in half.
function fitNote(lines, max = 2000) {
  const out = [];
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (len + line.length + 1 > max - 60) {
      const left = lines.slice(i).filter((l) => l.startsWith('•')).length;
      if (left) out.push(`…and ${left} more — see the invoice.`);
      break;
    }
    out.push(line);
    len += line.length + 1;
  }
  return out.join('\n');
}

app.post(
  '/api/admin/invoices/:id/shipment',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const inv = await store.invoices.findOne({ _id: id });
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    // The board is its own feature; if it has been switched off there is
    // nowhere for the shipment to go.
    if (!(await getEntitlements()).schedule)
      return res.status(403).json({ error: 'Scheduling is turned off, so there is no board to add it to.' });
    const existing = await shipmentOf(inv);
    if (existing && !(req.body && req.body.again))
      return res.status(409).json({ error: 'This invoice already has a shipment on the schedule.', shipment: existing });

    // Where it is going. The quote's drawing, when there is one, says exactly
    // where on the property — better than whatever a geocoder guesses.
    const quote = inv.quote_id ? await store.quotes.findOne({ _id: inv.quote_id }) : null;
    const layout = quote && quote.layout && quote.layout.segments && quote.layout.segments.length ? quote.layout : null;
    const c = inv.customer || {};
    const address = oneLine(inv.job_site || c.address || (layout && layout.address) || '');
    if (!address)
      return res.status(400).json({ error: 'Add a job site or billing address to the invoice first — the crew needs to know where it goes.' });
    let lat = null;
    let lng = null;
    if (layout) {
      const pts = layout.segments.flatMap((s) => s.points);
      ({ lat, lng } = cleanLatLng(
        pts.reduce((s, p) => s + p[0], 0) / pts.length,
        pts.reduce((s, p) => s + p[1], 0) / pts.length
      ));
    }

    const v = invoiceView(inv);
    const items = (inv.items || []).filter((it) => it.description || Number(it.qty));
    const bullet = (it) => {
      const head = String(it.description || '').split('\n')[0].trim();
      const qty = Number(it.qty) || 0;
      return `• ${qty ? `${fmtQty(qty)}${it.unit ? ' ' + it.unit : ''} — ` : ''}${head}`;
    };

    // For the crew: who to call, what is going, and — if the job was drawn —
    // the load list the estimator worked out.
    const crew = [
      `Customer: ${[c.name, c.phone].filter(Boolean).join(' · ')}`,
      `${inv.number}${inv.po ? ` · PO ${inv.po}` : ''}${inv.project ? ` · ${inv.project}` : ''}`,
    ];
    if (items.length) crew.push('', 'What’s going:', ...items.map(bullet));
    if (layout) {
      const t = takeoff.compute(layout, await catalog.getCatalog());
      if (t.materials.length) {
        crew.push('', `Load list (from the drawing — ${t.totals.fence_ft} ft, ${t.totals.gates} gate${t.totals.gates === 1 ? '' : 's'}):`);
        crew.push(...t.materials.map((m) => `• ${fmtQty(m.qty)} ${m.unit} — ${m.label}`));
      }
    }

    // For the office only: the money side, which the crew never sees.
    const office = fitNote([
      `From invoice ${inv.number}${inv.quote_number ? ` (quote ${inv.quote_number})` : ''}.`,
      `Total ${fmtMoney(v.total)} · paid ${fmtMoney(v.paid)} · balance ${fmtMoney(v.balance)}${
        v.due_date
          ? ` · due ${new Date(qbo.calendarDay(inv.due_date) + 'T12:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`
          : ''
      }`,
      `Bill to: ${[c.name, c.address, c.phone, c.email].filter(Boolean).join(', ')}`,
      inv.notes ? `Invoice notes: ${inv.notes}` : '',
    ].filter(Boolean));

    const _id = await store.nextId('schedules');
    const now = new Date();
    // Claim the invoice's next shipment in one step: two clicks at once both
    // read the same count, and only one of them can move it on.
    const seq = inv.shipment_seq || 0;
    const claim = await store.invoices.updateOne(
      { _id: id, shipment_seq: seq ? seq : { $in: [null, 0] } },
      { $set: { shipment_seq: seq + 1 }, $push: { shipment_ids: _id } }
    );
    if (!claim.modifiedCount)
      return res.status(409).json({ error: 'A shipment for this invoice was just created.', shipment: await shipmentOf(inv) });
    await store.schedules.insertOne({
      _id,
      address,
      // The first line is the card's title on the board.
      description: `${c.name || 'Customer'}${inv.project ? ' — ' + inv.project : ''}\n${inv.number}`,
      date: null,
      end_date: null,
      time: null,
      due_date: null,
      job_type: cleanJobType(req.body && req.body.job_type),
      notes_driver: fitNote(crew),
      notes_internal: office,
      confirmed: false,
      lat,
      lng,
      employee_ids: [],
      source: { type: 'invoice', invoice_id: id, invoice_number: inv.number },
      created_at: now,
      updated_at: now,
    });
    res.json({ id: _id, shipment: await shipmentOf(await store.invoices.findOne({ _id: id })) });
  })
);

// ---------------------------------------------------------------------------
// Invoices -> QuickBooks. QuickBooks is what actually emails a customer, so
// this pushes the invoice across and then asks QuickBooks to send it. Pushing
// twice updates the same QuickBooks invoice rather than making a second one.
// ---------------------------------------------------------------------------

// Record what QuickBooks said against our copy, so the UI can show where an
// invoice stands without asking Intuit again on every page load.
// (Not touching updated_at: that is when the invoice itself was last edited.)
async function saveQboState(id, patch) {
  const set = {};
  for (const [k, v] of Object.entries(patch)) set['qbo.' + k] = v;
  await store.invoices.updateOne({ _id: id }, { $set: set });
}

// One push or send per invoice at a time: two clicks (or two people) must not
// both create it in QuickBooks. A claim older than two minutes is a crashed
// attempt and can be taken over.
async function claimQboWork(id) {
  const r = await store.invoices.updateOne(
    { _id: id, $or: [{ qbo_busy_at: null }, { qbo_busy_at: { $lt: new Date(Date.now() - 120000) } }] },
    { $set: { qbo_busy_at: new Date() } }
  );
  return r.modifiedCount === 1;
}
const releaseQboWork = (id) => store.invoices.updateOne({ _id: id }, { $unset: { qbo_busy_at: '' } });

// Push the invoice as it stands, then any payments recorded here that
// QuickBooks doesn't have yet. Returns the push result and the refreshed doc.
async function pushToQbo(inv) {
  const view = invoiceView(inv);
  // Push the totals the office sees, not the raw doc, so what lands in
  // QuickBooks matches the invoice on screen.
  const result = await qbo.pushInvoice({ ...view, qbo: inv.qbo });
  const sameCo = qbo.sameCompany(inv.qbo, result.realm_id);
  const known = (sameCo && sameCo.id === result.id && inv.qbo.payment_ids) || {};
  await saveQboState(inv._id, {
    id: result.id,
    doc_number: result.doc_number,
    total: result.total,
    customer_id: result.customer.id,
    realm_id: result.realm_id,
    hash: result.hash,
    mismatch: result.mismatch,
    synced_at: new Date(),
    payment_ids: known,
  });
  const added = await qbo.pushPayments(view, { invoiceId: result.id, customerId: result.customer.id, known });
  if (Object.keys(added).length)
    await saveQboState(inv._id, { payment_ids: { ...known, ...added } });
  return { result, payments: Object.keys(added).length, inv: await store.invoices.findOne({ _id: inv._id }) };
}

const mismatchWarning = (m) =>
  m
    ? `QuickBooks totalled this at ${m.theirs.toFixed(2)} where we have ${m.ours.toFixed(2)}. QuickBooks works tax out ` +
      'from its own tax code, so check the tax setting before sending.'
    : null;

app.post(
  '/api/admin/invoices/:id/quickbooks',
  requireAdmin,
  qbWrap(async (req, res) => {
    const id = Number(req.params.id);
    const inv = await store.invoices.findOne({ _id: id });
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    if ((inv.status || 'draft') === 'void')
      return res.status(409).json({ error: 'That invoice is void — nothing to send.' });

    if (!(await claimQboWork(id)))
      return res.status(409).json({ error: 'This invoice is already being sent to QuickBooks.' });
    try {
      const { result, payments } = await pushToQbo(inv);
      res.json({
        ok: true,
        qbo: result,
        payments_sent: payments,
        link: await qbo.invoiceLink(result.id),
        // Surfaced rather than swallowed: our flat tax percentage and
        // QuickBooks' tax engine can legitimately disagree.
        warning: mismatchWarning(result.mismatch),
      });
    } finally {
      await releaseQboWork(id);
    }
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

    if ((inv.status || 'draft') === 'void')
      return res.status(409).json({ error: 'That invoice is void — nothing to send.' });

    const to = String((req.body && req.body.email) || (inv.customer && inv.customer.email) || '').trim();
    if (!to)
      return res
        .status(400)
        .json({ error: 'No email address to send to — add one to the invoice first.' });

    if (!(await claimQboWork(id)))
      return res.status(409).json({ error: 'This invoice is already being sent to QuickBooks.' });
    try {
      // QuickBooks emails its own copy, so first make sure it is this one:
      // edited since the push (or pushed to another company), it goes over
      // again; payments recorded here go over too.
      let current = inv;
      if (!(await qbo.pushedIsCurrent({ ...invoiceView(inv), qbo: inv.qbo })))
        current = (await pushToQbo(inv)).inv;
      else {
        const known = inv.qbo.payment_ids || {};
        const added = await qbo.pushPayments(invoiceView(inv), { invoiceId: inv.qbo.id, customerId: inv.qbo.customer_id, known });
        if (Object.keys(added).length) await saveQboState(id, { payment_ids: { ...known, ...added } });
        current = await store.invoices.findOne({ _id: id });
      }
      // The customer is asked for whatever QuickBooks says is owed. If that
      // isn't what this invoice says (QuickBooks' tax engine, a payment taken
      // there), say so instead of sending a different figure.
      const view = invoiceView(current);
      const owed = await qbo.invoiceBalance(current.qbo.id);
      if (owed != null && Math.abs(owed - view.balance) > 0.01)
        return res.status(409).json({
          error:
            `QuickBooks shows ${owed.toFixed(2)} owing on this invoice, but it says ${view.balance.toFixed(2)} here. ` +
            'Sort out the difference (the tax setting, or a payment recorded in only one place) before emailing it.',
        });

      const sent = await qbo.sendInvoice(current.qbo.id, to);
      await saveQboState(id, { sent_at: new Date(), sent_to: sent.sent_to, email_status: sent.status });
      // Emailing it is the moment it stops being a draft on our side too.
      if ((inv.status || 'draft') === 'draft')
        await store.invoices.updateOne({ _id: id }, { $set: { status: 'sent' } });
      res.json({ ok: true, sent_to: sent.sent_to, status: sent.status });
    } finally {
      await releaseQboWork(id);
    }
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
    const reply = errorReply(err);
    if (reply.fault) recordFault(req, err, reply.status);
    res.status(reply.status).json({ error: reply.message });
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
    // One status, "all", or several separated by commas ("not_quote,skipped,failed").
    const wanted = String(req.query.status || 'new')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 10);
    const q = wanted.includes('all') ? {} : { status: { $in: wanted } };
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
    // How long a scan may run in this request; the default suits Vercel and
    // Render. On a host with a shorter limit (Netlify: 10 s unless raised) set
    // INBOX_SCAN_BUDGET_MS to fit it.
    res.json(
      await inbox.scan({
        trigger: 'manual',
        actor: await adminActor(req),
        budgetMs: Number(process.env.INBOX_SCAN_BUDGET_MS) || undefined,
      })
    );
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

    const raw = req.body && req.body.draft ? req.body.draft : lead.draft || {};
    // Only the cleaned draft is kept, on the quote and on the lead alike: the
    // lead card shows it again later, so whatever the browser sent must not be
    // stored as it came.
    const draft = {
      customer: cleanCustomer(raw.customer),
      items: cleanItems(raw.items),
      tax_rate: toNum(raw.tax_rate),
      notes: cleanLine(raw.notes, 4000),
    };
    if (!draft.customer.name) return res.status(400).json({ error: 'Customer name is required.' });

    const quoteId = await store.nextId('quotes');
    const now = new Date();
    // Claimed first, in one step, so a double click can't make two quotes.
    const claim = await store.inboxLeads.updateOne(
      { _id: id, quote_id: null },
      { $set: { status: 'approved', quote_id: quoteId, draft, approved_at: now } }
    );
    if (!claim.modifiedCount)
      return res.status(409).json({ error: 'That email has already been turned into a quote.' });
    const quote = {
      _id: quoteId,
      number: 'Q' + String(1000 + quoteId),
      customer: draft.customer,
      quote_date: now,
      valid_until: new Date(now.getTime() + QUOTE_VALID_DAYS * 86400000),
      items: draft.items,
      tax_rate: draft.tax_rate,
      notes: draft.notes,
      status: 'draft',
      // Where it came from, so the estimator can reread the email later.
      source: { type: 'inbox', lead_id: id, subject: lead.subject, from: lead.from_email },
      created_at: now,
      updated_at: now,
    };
    try {
      await store.quotes.insertOne(quote);
    } catch (err) {
      // Give the lead back rather than leave it pointing at nothing.
      await store.inboxLeads.updateOne(
        { _id: id, quote_id: quoteId },
        { $set: { status: lead.status || 'new', quote_id: null }, $unset: { approved_at: '' } }
      );
      throw err;
    }
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
  // Counts only: the full result names customers' emails, and a scheduler's
  // log is no place for that.
  const r = await inbox.runScheduledScan();
  res.json(
    r && typeof r === 'object'
      ? Object.fromEntries(Object.entries(r).filter(([, v]) => v == null || typeof v !== 'object'))
      : r
  );
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
    // Its files go too — the rows and the stored objects, which are otherwise
    // paid for forever with nothing pointing at them — and the task last, as
    // with a job.
    await dropFiles(store.taskAttachments, await store.taskAttachments.find({ task_id: id }).toArray());
    await store.tasks.deleteOne({ _id: id });
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

// Task file attachments. Same three-step upload as job files — the bytes go
// browser-to-storage and only metadata is mirrored onto the task, so the board
// lists attachments without loading anything.
const safeName = (s) => String(s || 'file').replace(/[\r\n"\\]/g, '').slice(0, 200) || 'file';

app.post(
  '/api/admin/tasks/:id/attachments/upload-url',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await store.tasks.findOne({ _id: id });
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    const plan = plannedUpload(req.body, res);
    if (!plan) return;
    await sweepAbandonedUploads();

    const attId = crypto.randomUUID();
    const key = buildKey('tasks/' + id, attId, plan.filename);
    const up = await storage.createUpload({
      key,
      contentType: plan.content_type,
      size: plan.size,
    });
    await store.taskAttachments.insertOne({
      _id: attId,
      task_id: id,
      filename: plan.filename,
      content_type: plan.content_type,
      size: plan.size,
      storage_key: key,
      storage_mode: storage.mode,
      upload_id: up.uploadId,
      status: 'pending',
      uploaded_by: actorName(req),
      created_at: new Date(),
    });
    res.json({ fileId: attId, partSize: up.partSize, parts: up.parts });
  })
);

app.post(
  '/api/admin/tasks/:id/attachments/:attId/complete',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await store.tasks.findOne({ _id: id });
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    const doc = await store.taskAttachments.findOne({ _id: req.params.attId, task_id: id });
    if (!doc) return res.status(404).json({ error: 'Upload not found.' });
    if (doc.status === 'ready') {
      const existing = (t.attachments || []).find((a) => a.id === doc._id);
      return res.json(existing || { id: doc._id, filename: doc.filename, size: doc.size });
    }

    const parts = cleanParts(req.body?.parts);
    if (!parts.length) return res.status(400).json({ error: 'No uploaded parts reported.' });
    if (!(await claimCompletion(store.taskAttachments, doc)))
      return res.status(409).json({ error: 'That upload is already being finished. Try again in a moment.' });
    let head;
    try {
      await storage.completeUpload({ key: doc.storage_key, uploadId: doc.upload_id, parts });
      head = await storage.head({ key: doc.storage_key });
    } catch (err) {
      await releaseCompletion(store.taskAttachments, doc);
      throw err;
    }
    if (!head) {
      await releaseCompletion(store.taskAttachments, doc);
      return res.status(502).json({ error: 'That upload did not arrive. Try again.' });
    }
    if (head.size > MAX_UPLOAD_BYTES) {
      await storage.remove({ key: doc.storage_key });
      await store.taskAttachments.deleteOne({ _id: doc._id });
      return res.status(413).json({ error: `File is too large (max ${uploadLimitLabel()}).` });
    }

    await store.taskAttachments.updateOne(
      { _id: doc._id },
      { $set: { status: 'ready', size: head.size, upload_id: null, at: new Date() } }
    );
    const meta = {
      id: doc._id,
      filename: doc.filename,
      content_type: doc.content_type,
      size: head.size,
      uploaded_by: doc.uploaded_by,
      at: new Date(),
    };
    await store.tasks.updateOne(
      { _id: id },
      { $push: { attachments: meta }, $set: { updated_at: new Date() } }
    );
    res.json({ ...meta, at: iso(meta.at) });
  })
);

app.post(
  '/api/admin/tasks/:id/attachments/:attId/abort',
  requireAdmin,
  wrap(async (req, res) => {
    const doc = await store.taskAttachments.findOne({
      _id: req.params.attId,
      task_id: Number(req.params.id),
      status: 'pending',
    });
    if (doc) {
      await dropStored([doc]);
      await store.taskAttachments.deleteOne({ _id: doc._id });
    }
    res.json({ ok: true });
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
    // Same as job files: a redirect to signed storage, with the old in-database
    // blobs still served directly.
    await serveAttachment(req, res, blob);
  })
);

app.delete(
  '/api/admin/tasks/:id/attachments/:attId',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const attId = req.params.attId;
    const doc = await store.taskAttachments.findOne({ _id: attId, task_id: id });
    await dropStored([doc]);
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
    // Only while still pending, in the same step: an approval that lands
    // between the check above and this delete must not be wiped out.
    const gone = await store.vacations.deleteOne({ _id: id, employee_id: req.employee._id, status: 'pending' });
    if (!gone.deletedCount) return res.status(400).json({ error: 'That request has already been decided.' });
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
      // A schedule date that has already passed would publish it again on the
      // next look at the board (see promoteScheduledBulletins) — pulling it
      // back to a draft clears that. A date still ahead stays scheduled.
      const at = set.publish_at !== undefined ? set.publish_at : b.publish_at;
      if (at && new Date(at) <= now) set.publish_at = null;
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
//
// Each page names its scripts, stylesheet and logo by content hash —
// /v/<hash>/<file>, see assets.js — and those addresses are cached for a year:
// a returning visit loads them off the device without asking. The pages
// themselves are checked with the server every time (no-cache, answered 304
// when unchanged), and that is what keeps the year-long copies honest: a new
// deploy gives a changed file a new address.
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public');
const sendPage = (file) => (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(assets.page(file, PUBLIC_DIR));
};

app.get('/v/:hash/:name', (req, res, next) => {
  const want = assets.parse(req.path);
  const current = want && assets.hashes(PUBLIC_DIR).get(want.name);
  if (!current) return next();
  // An address from an older page still gets today's file — just not to keep.
  const keep = current === want.hash;
  res.sendFile(path.join(PUBLIC_DIR, want.name), {
    maxAge: keep ? 365 * 86400000 : 0,
    immutable: keep,
  });
});

app.get(['/', '/index.html'], sendPage(path.join(PUBLIC_DIR, 'index.html')));

// The public estimate maker. Served explicitly (not just as /estimate.html) so
// the clean "/estimate" URL works on hosts that route everything through this
// app. The page itself checks whether the feature is switched on.
app.get(['/estimate', '/estimate.html'], sendPage(path.join(PUBLIC_DIR, 'estimate.html')));

// The customer's quote: view, approve and sign ("/quote?k=<token>"). Same
// reasoning as /estimate for the explicit route.
app.get(['/quote', '/quote.html'], sendPage(path.join(PUBLIC_DIR, 'quote.html')));

app.use(express.static(PUBLIC_DIR));

// Old URLs that no longer exist (the shared PIN clock, old admin paths) — send
// any stale bookmarks to the login page instead of 404ing. Employees now clock
// in from the portal at "/" after signing in.
for (const legacy of ['/timeclock', '/fence', '/office']) {
  if (legacy !== ADMIN_PATH) app.get(legacy, (req, res) => res.redirect('/'));
}

// Admin page is served from /views (outside the static folder) at ADMIN_PATH,
// so it is not reachable at a guessable /admin or /admin.html URL.
app.get(ADMIN_PATH, sendPage(path.join(__dirname, 'views', 'admin.html')));

// Anything that threw outside a wrap()ed handler still lands here, so the dev
// dashboard sees it rather than only the console. Registered after the routes,
// which is where Express looks for an error handler.
// A body that isn't JSON, or is too big, lands here from express.json with its
// own 400/413 — answered as that, not as a server fault, and not recorded.
app.use((err, req, res, next) => {
  const reply = errorReply(err);
  if (reply.fault) recordFault(req, err, reply.status);
  if (res.headersSent) return next(err);
  res.status(reply.status).json({
    error:
      reply.status === 400 && err.type === 'entity.parse.failed'
        ? 'That request could not be read.'
        : reply.status === 413
          ? 'That is too large to send.'
          : reply.message,
  });
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
    console.error('dbcheck failed:', err.message);
    res.json({ db: 'FAILED', hasUrl: !!process.env.DATABASE_URL, detail: 'See the server log for why.' });
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
      await replaceDefaultAdminPassword().catch(() => {});
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
