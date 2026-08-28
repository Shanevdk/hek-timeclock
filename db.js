// Database layer for the HEK timeclock (MongoDB).
//
// Connection comes from the DATABASE_URL environment variable — set it to the
// MongoDB connection string your provider gives you (e.g. MongoDB Atlas:
// mongodb+srv://user:pass@cluster.mongodb.net/?...). Nothing is stored on the
// app server itself.
//
// The database name can be set with DB_NAME (default "hektimeclock"); MongoDB
// creates it automatically on first write.

const { MongoClient } = require('mongodb');

// Collections are filled in by connect() before the server starts handling
// requests, so handlers can safely read them off this object.
const store = {
  client: null,
  db: null,
  employees: null,
  punches: null,
  counters: null,
  quotes: null,
  schedules: null,
  tasks: null,
  vacations: null,
  bulletins: null,
  settings: null,
  qboTime: null,
  qboRuns: null,
  invoices: null,
  inboxLeads: null,
  nextId,
};

// Memoized so repeated calls (e.g. per serverless-function invocation) reuse a
// single connection/pool instead of reconnecting every time.
let connecting = null;

function connect() {
  if (!connecting) connecting = doConnect();
  return connecting;
}

async function doConnect() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Put your MongoDB connection string in the ' +
        'DATABASE_URL environment variable (see .env.example).'
    );
  }

  // Short server-selection timeout so a bad/unreachable connection fails fast
  // with a clear error, instead of hanging until the serverless function is
  // killed (which shows up as a generic FUNCTION_INVOCATION_FAILED crash).
  store.client = new MongoClient(url, { serverSelectionTimeoutMS: 8000 });
  await store.client.connect();
  store.db = store.client.db(process.env.DB_NAME || 'hektimeclock');
  store.employees = store.db.collection('employees');
  store.punches = store.db.collection('punches');
  store.counters = store.db.collection('counters');
  store.rateLimits = store.db.collection('rate_limits');
  store.quotes = store.db.collection('quotes');
  // Scheduled jobs: an address + description assigned to one or more employees.
  store.schedules = store.db.collection('schedules');
  // "My Tasks" board — a kanban card assigned to a single employee, with
  // status columns (todo / in_progress / done), comments, time, and history.
  store.tasks = store.db.collection('tasks');
  // File attachments for tasks. The binary blob lives here (one doc per file);
  // lightweight metadata is mirrored onto the task doc so the board can list
  // attachments without loading the file data.
  store.taskAttachments = store.db.collection('task_attachments');
  // Time-off requests: an employee asks for a date range; the admin approves or
  // declines it. Statuses: pending / approved / declined.
  store.vacations = store.db.collection('vacations');
  // Bulletin board / "Messages" — an admin-posted notice. Every signed-in
  // employee sees the ones targeted to them; the admin tracks who has read each.
  store.bulletins = store.db.collection('bulletins');
  // Small key/value collection for app config — currently the admin login
  // credentials (doc _id: 'admin'), seeded from env on first run, and the
  // QuickBooks connection (doc _id: 'quickbooks').
  store.settings = store.db.collection('settings');
  // One doc per hours record pushed to QuickBooks, keyed
  // "<period start>|<employee id>|<day>|<kind>". Holds the QuickBooks id and
  // SyncToken so re-running a pay period updates what changed instead of
  // creating a second copy of everyone's hours.
  store.qboTime = store.db.collection('qbo_time');
  // History of sync runs (manual and scheduled), newest id last.
  store.qboRuns = store.db.collection('qbo_runs');
  // Customer invoices — line items, tax, due date, status and payments. A quote
  // that gets accepted is converted into one of these.
  store.invoices = store.db.collection('invoices');
  // Inbox agent leads: one doc per email the agent has read, holding the
  // original message and the estimate it drafted from it. Approving a lead is
  // what turns it into a real quote — the agent never creates one itself.
  store.inboxLeads = store.db.collection('inbox_leads');
  // Quote requests sent in from the public estimate page at "/estimate". One
  // doc per request, holding what the customer picked and the price the server
  // worked out. Approving one is what turns it into a real quote.
  store.estimateRequests = store.db.collection('estimate_requests');
  // ---- App health (dev dashboard) ----
  // One rollup document per day rather than a row per request: a busy day is a
  // handful of $inc calls on one document, so keeping stats costs almost
  // nothing in storage or write load.
  store.metrics = store.db.collection('metrics');
  // One document per (day, visitor) so unique visitors can be counted without
  // an ever-growing array on the daily document. Expires itself.
  store.metricVisitors = store.db.collection('metric_visitors');
  // Recent server errors, newest first. Expires itself so it can never grow
  // without bound.
  store.appErrors = store.db.collection('app_errors');

  // Unique login email, but only for employees that actually have one set
  // (older records may have no email and must not collide on null).
  await store.employees.createIndex(
    { email: 1 },
    { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
  );
  await store.punches.createIndex({ employee_id: 1 });
  await store.punches.createIndex({ employee_id: 1, clock_out: 1 });
  await store.quotes.createIndex({ created_at: -1 });
  await store.schedules.createIndex({ date: 1 });
  await store.schedules.createIndex({ employee_ids: 1 });
  await store.tasks.createIndex({ status: 1, order: 1 });
  await store.tasks.createIndex({ assignee_id: 1 });
  await store.taskAttachments.createIndex({ task_id: 1 });
  await store.vacations.createIndex({ employee_id: 1 });
  await store.vacations.createIndex({ status: 1, created_at: -1 });
  await store.bulletins.createIndex({ status: 1, published_at: -1 });
  await store.bulletins.createIndex({ status: 1, publish_at: 1 });
  await store.qboTime.createIndex({ period_start: 1 });
  await store.qboTime.createIndex({ employee_id: 1, day: 1 });
  await store.qboRuns.createIndex({ start: 1, _id: -1 });
  await store.invoices.createIndex({ created_at: -1 });
  await store.invoices.createIndex({ status: 1, due_date: 1 });
  await store.invoices.createIndex({ quote_id: 1 });
  // Unique on the email's Message-ID so the same message is never read (or
  // paid for) twice, even if two scans overlap.
  await store.inboxLeads.createIndex({ message_id: 1 }, { unique: true });
  await store.inboxLeads.createIndex({ status: 1, received_at: -1 });
  await store.estimateRequests.createIndex({ status: 1, created_at: -1 });
  // Health data ages out on its own — 60 days is plenty to spot a trend.
  await store.metricVisitors.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 86400 });
  await store.metricVisitors.createIndex({ day: 1 });
  await store.appErrors.createIndex({ at: -1 });
  await store.appErrors.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 86400 });
  // Auto-remove stale rate-limit records an hour after they were last touched.
  await store.rateLimits.createIndex({ windowStart: 1 }, { expireAfterSeconds: 3600 });
}

// Atomic auto-incrementing integer id per collection name, so employees and
// punches keep simple numeric ids (1, 2, 3, …) instead of ObjectIds.
async function nextId(name) {
  const r = await store.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = r && r.value ? r.value : r; // driver v6 returns the doc directly
  return doc.seq;
}

module.exports = { connect, store };
