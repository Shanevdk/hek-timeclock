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
  // credentials (doc _id: 'admin'), seeded from env on first run.
  store.settings = store.db.collection('settings');

  await store.employees.createIndex({ pin: 1 });
  // Unique login email, but only for employees that actually have one set
  // (existing PIN-only employees have no email and must not collide on null).
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
