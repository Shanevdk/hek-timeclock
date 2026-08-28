// App health — what the dev dashboard reads.
//
// Every request bumps counters on a single document for the day, so keeping
// stats costs one $inc rather than a row per hit. Nothing here stores an IP
// address or anything a customer typed: visitors are counted as a salted hash
// that expires, and paths are collapsed to the route that served them.
//
// The whole thing is best-effort. Failing to record a statistic must never turn
// into a failed request for the person using the app.

'use strict';

const crypto = require('crypto');
const { store } = require('./db');

// Local calendar day, so "today" on the dashboard means today in the office.
function dayKey(d, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d || new Date());
}

// Which part of the app a request belongs to. Raw paths are useless on a chart
// (every id makes a new one) and can carry customer detail, so each request is
// filed under the route that served it.
const ROUTES = [
  [/^\/api\/estimate/, 'estimate (public)'],
  [/^\/api\/login|^\/api\/logout|^\/api\/me/, 'sign-in'],
  [/^\/api\/my\/clock/, 'clock in/out'],
  [/^\/api\/my\//, 'employee portal'],
  [/^\/api\/admin\/timesheet|^\/api\/admin\/export|^\/api\/admin\/punches/, 'timesheets'],
  [/^\/api\/admin\/employees/, 'employees'],
  [/^\/api\/admin\/quotes/, 'quotes'],
  [/^\/api\/admin\/invoices/, 'invoices'],
  [/^\/api\/admin\/inbox/, 'AI inbox'],
  [/^\/api\/admin\/estimate/, 'estimate requests'],
  [/^\/api\/admin\/quickbooks|^\/api\/quickbooks/, 'QuickBooks'],
  [/^\/api\/admin\/schedules|^\/api\/admin\/geocode/, 'scheduling'],
  [/^\/api\/admin\/tasks/, 'tasks'],
  [/^\/api\/admin\/map|^\/api\/admin\/locations|^\/api\/admin\/shop/, 'map'],
  [/^\/api\/dev\//, 'dev tools'],
  [/^\/api\/cron\//, 'scheduled jobs'],
  [/^\/api\//, 'other API'],
];

function routeOf(path) {
  for (const [re, name] of ROUTES) if (re.test(path)) return name;
  if (path === '/') return 'portal page';
  if (path === '/estimate') return 'estimate page';
  if (/^\/admin/.test(path)) return 'admin page';
  return 'other';
}

// Mongo keys cannot contain dots, and a route name is a label rather than a
// path, so it is stored slugged and turned back for display.
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
const unslug = (s) => s.replace(/_/g, ' ');

// A visitor is counted once a day. The hash is salted with this install's own
// secret and with the day, so the same person is a different value tomorrow and
// the stored value cannot be walked back to an address.
function visitorHash(ip, agent, day) {
  const salt = process.env.SESSION_SECRET || 'hek-metrics';
  return crypto
    .createHash('sha256')
    .update(salt + '|' + day + '|' + (ip || '') + '|' + String(agent || '').slice(0, 120))
    .digest('hex')
    .slice(0, 32);
}

// Record one request. Called once the response is on its way out, so none of
// this sits on the critical path of answering the user.
async function record(info) {
  const { path, status, ms, ip, agent, timezone, isPage, who } = info;
  const day = dayKey(new Date(), timezone);
  const route = routeOf(path);
  const bucket = status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'ok';

  const inc = {
    requests: 1,
    total_ms: Math.round(ms) || 0,
  };
  inc['by_route.' + slug(route)] = 1;
  inc['by_status.' + bucket] = 1;
  if (isPage) inc.pages = 1;
  else inc.api = 1;
  if (status >= 500) inc.errors = 1;
  if (who) inc['by_who.' + who] = 1;

  await store.metrics.updateOne(
    { _id: day },
    { $inc: inc, $setOnInsert: { day, created_at: new Date() } },
    { upsert: true }
  );

  // Unique visitors: one document per person per day, which expires itself.
  if (isPage && ip) {
    const h = visitorHash(ip, agent, day);
    await store.metricVisitors.updateOne(
      { _id: day + '|' + h },
      { $setOnInsert: { day, at: new Date() } },
      { upsert: true }
    );
  }
}

// Record a server error with enough context to chase it, and nothing more.
async function recordError(info) {
  const { path, method, status, message, stack, who, timezone } = info;
  await store.appErrors.insertOne({
    at: new Date(),
    day: dayKey(new Date(), timezone),
    path: String(path || '').slice(0, 200),
    method: String(method || '').slice(0, 10),
    status: Number(status) || 500,
    route: routeOf(String(path || '')),
    message: String(message || '').slice(0, 500),
    // First few frames only: enough to find the line, not a novel.
    stack: String(stack || '').split('\n').slice(0, 6).join('\n').slice(0, 1200),
    who: who || 'anonymous',
  });
}

// Everything the dashboard shows, in one call.
async function report(opts) {
  const days = Math.min(Math.max(Number((opts && opts.days) || 30), 7), 90);
  const timezone = opts && opts.timezone;
  const today = new Date();
  const wanted = [];
  for (let i = days - 1; i >= 0; i--) {
    wanted.push(dayKey(new Date(today.getTime() - i * 86400000), timezone));
  }
  const from = wanted[0];

  const [rows, visitorRows, errors, totals, dbStats] = await Promise.all([
    store.metrics.find({ _id: { $gte: from } }).toArray(),
    store.metricVisitors
      .aggregate([{ $match: { day: { $gte: from } } }, { $group: { _id: '$day', n: { $sum: 1 } } }])
      .toArray(),
    store.appErrors.find({}, { sort: { at: -1 } }).limit(50).toArray(),
    appTotals(),
    dbSize(),
  ]);

  const byDay = Object.fromEntries(rows.map((r) => [r._id, r]));
  const visitorsByDay = Object.fromEntries(visitorRows.map((r) => [r._id, r.n]));

  const series = wanted.map((day) => {
    const m = byDay[day] || {};
    const requests = m.requests || 0;
    return {
      day,
      visitors: visitorsByDay[day] || 0,
      pages: m.pages || 0,
      api: m.api || 0,
      requests,
      errors: m.errors || 0,
      // Mean response time for the day, or null when nothing was served — a
      // zero would read as "instant" rather than "nothing happened".
      avg_ms: requests ? Math.round((m.total_ms || 0) / requests) : null,
    };
  });

  // Which parts of the app are actually used, over the whole window.
  const routeTotals = {};
  for (const r of rows) {
    for (const [k, n] of Object.entries(r.by_route || {})) {
      const name = unslug(k);
      routeTotals[name] = (routeTotals[name] || 0) + n;
    }
  }
  const routes = Object.entries(routeTotals)
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);

  const who = {};
  for (const r of rows) {
    for (const [k, n] of Object.entries(r.by_who || {})) who[k] = (who[k] || 0) + n;
  }

  return {
    days,
    series,
    routes,
    who,
    errors: errors.map((e) => ({
      at: e.at,
      path: e.path,
      method: e.method,
      status: e.status,
      route: e.route,
      message: e.message,
      stack: e.stack,
      who: e.who,
    })),
    totals,
    system: {
      uptime_s: Math.round(process.uptime()),
      node: process.version,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      db: store.db ? store.db.databaseName : null,
      db_mb: dbStats.mb,
      db_collections: dbStats.collections,
      storage: dbStats.storage,
      started_at: new Date(Date.now() - process.uptime() * 1000),
    },
  };
}

// How much of the app is actually in use — the business side of "health".
async function appTotals() {
  const count = (name, q) =>
    store[name] ? store[name].countDocuments(q || {}) : Promise.resolve(0);
  const [employees, active, punches, openPunches, quotes, invoices, requests, tasks, schedules] =
    await Promise.all([
      count('employees'),
      count('employees', { active: true }),
      count('punches'),
      count('punches', { clock_out: null }),
      count('quotes'),
      count('invoices'),
      count('estimateRequests'),
      count('tasks'),
      count('schedules'),
    ]);
  return { employees, active, punches, openPunches, quotes, invoices, requests, tasks, schedules };
}

// How full the database is, and how much room is left.
//
// Two kinds of server answer this two different ways. One with a real
// filesystem reports it (fsTotalSize), and there the space left belongs to the
// disk — every database on that server shares it. A shared Atlas tier exposes
// no disk at all; there the ceiling is the plan's quota, which has to be told
// to us, so DB_STORAGE_LIMIT_MB sets it and the free tier's 512 MB is assumed.
const MB = 1048576;
const round1 = (n) => Math.round(n * 10) / 10;
// Read per call, not once at load: the entry points differ in whether the
// environment is in place by the time this file is first required.
const planLimitMb = () => Number(process.env.DB_STORAGE_LIMIT_MB) || 512;

async function dbSize() {
  try {
    const s = await store.db.command({ dbStats: 1 });
    const dbBytes = (s.storageSize || 0) + (s.indexSize || 0);
    const fsTotal = Number(s.fsTotalSize) || 0;
    const fsUsed = Number(s.fsUsedSize) || 0;
    const onDisk = fsTotal > 0 && fsUsed > 0;

    const limitBytes = onDisk ? fsTotal : planLimitMb() * MB;
    const usedBytes = onDisk ? fsUsed : dbBytes;
    const freeBytes = Math.max(limitBytes - usedBytes, 0);

    return {
      mb: round1(dbBytes / MB),
      collections: s.collections || 0,
      storage: {
        used_mb: round1(usedBytes / MB),
        free_mb: round1(freeBytes / MB),
        limit_mb: round1(limitBytes / MB),
        // Capped: a database sitting over its quota is full, not 104% full.
        pct: Math.min(round1((usedBytes / limitBytes) * 100), 100),
        basis: onDisk ? 'disk' : 'plan',
      },
    };
  } catch (e) {
    return { mb: null, collections: null, storage: null };
  }
}

module.exports = { record, recordError, report, dayKey, routeOf };
