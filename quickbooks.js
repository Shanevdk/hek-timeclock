// QuickBooks Online payroll sync.
//
// What this does: every pay period it pushes each hourly employee's approved
// hours into QuickBooks as TimeActivity records, so whoever runs payroll opens
// QuickBooks and finds the hours already filled in.
//
// What this does NOT do: pay anybody. Intuit has no public API for running a
// QuickBooks Online Payroll run or issuing direct deposit — a human still opens
// QuickBooks and clicks "Run payroll". This module gets the hours there
// accurately so that click is the only manual step.
//
// Setup lives in an Intuit developer app (https://developer.intuit.com):
//   QBO_CLIENT_ID / QBO_CLIENT_SECRET  — from the app's Keys & credentials
//   QBO_REDIRECT_URI                   — must match the app's redirect URI
//                                        exactly, e.g.
//                                        https://your-app.vercel.app/api/quickbooks/callback
//   QBO_ENVIRONMENT                    — "sandbox" (default) or "production"
//
// Tokens are persisted in MongoDB (settings doc _id:'quickbooks'), never in
// memory: Intuit rotates the refresh token on every refresh and expires it
// after ~100 days, so a serverless cold start must be able to pick up where the
// last invocation left off.

'use strict';

const { store } = require('./db');
const secrets = require('./secrets');

const SETTINGS_ID = 'quickbooks';
const SCOPE = 'com.intuit.quickbooks.accounting';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
// Pinned so a future default minor version can't silently change response
// shapes. Bump deliberately after reading Intuit's changelog.
const MINOR_VERSION = '75';
// Intuit's batch endpoint takes up to 30 operations; 25 leaves headroom and
// keeps a single request well inside a serverless function's time budget.
const BATCH_MAX = 25;
const DAY_MS = 86400000;
// Refresh the access token this far before it actually expires, so a slow
// request can't start with a valid token and finish with an expired one.
const TOKEN_SKEW_MS = 5 * 60 * 1000;
// A sync holds a lock for this long. Two crons (or a cron racing an admin
// clicking "Sync now") must not both create the same TimeActivity.
const LOCK_MS = 5 * 60 * 1000;

// Same timezone rule as server.js: a punch belongs to the local calendar day it
// started on, which is how the timesheet and CSV export already count it.
const TIMEZONE = process.env.TIMEZONE || 'America/New_York';
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const localDay = (d) => dayFormatter.format(new Date(d));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Anything the admin should see verbatim (a QuickBooks validation message, a
// missing setting) rather than a generic "Server error".
class QuickBooksError extends Error {
  constructor(message, { status = 400, detail = null } = {}) {
    super(message);
    this.name = 'QuickBooksError';
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Where the Intuit app credentials come from.
//
// Anything saved in the dashboard wins over the matching environment variable,
// so keys can be rotated without a redeploy. The env vars stay as a fallback,
// which keeps deployments already configured that way working untouched. The
// client secret is stored encrypted (see secrets.js) and never sent to the
// browser.
async function creds() {
  const doc = await loadDoc();
  const stored =
    doc && doc.client_secret_enc ? secrets.decrypt('quickbooks', doc.client_secret_enc) : null;
  const clientId = (doc && doc.client_id) || process.env.QBO_CLIENT_ID || '';
  const clientSecret = stored || process.env.QBO_CLIENT_SECRET || '';
  const redirectUri = (doc && doc.redirect_uri) || process.env.QBO_REDIRECT_URI || '';
  const production =
    doc && doc.production != null
      ? !!doc.production
      : (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase() === 'production';

  return {
    clientId,
    clientSecret,
    redirectUri,
    production,
    apiBase: production
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com',
    // Which source won, per field — shown in the dashboard so nobody wonders
    // why editing a box appeared to change nothing.
    source: {
      client_id: doc && doc.client_id ? 'settings' : process.env.QBO_CLIENT_ID ? 'env' : 'none',
      client_secret: stored ? 'settings' : process.env.QBO_CLIENT_SECRET ? 'env' : 'none',
      redirect_uri: doc && doc.redirect_uri ? 'settings' : process.env.QBO_REDIRECT_URI ? 'env' : 'none',
      environment:
        doc && doc.production != null ? 'settings' : process.env.QBO_ENVIRONMENT ? 'env' : 'none',
    },
    // A saved secret that won't decrypt (the server secret changed) must not
    // read as "none configured" — the fix for that is a different one.
    secret_unreadable: !!(doc && doc.client_secret_enc && !stored),
  };
}

// True once the Intuit app credentials are present. Without them the tab still
// loads and explains what is missing instead of erroring.
const isConfigured = async () => {
  const c = await creds();
  return !!(c.clientId && c.clientSecret);
};

// Save credentials entered in the dashboard. A blank secret means "keep the one
// already saved", so re-saving the form never wipes it.
async function saveCredentials(patch) {
  const before = await creds();
  const set = {};

  if (patch.client_id != null) {
    const v = String(patch.client_id).trim();
    // Intuit client ids are long opaque strings. The only useful check is that
    // this isn't a placeholder or a whole URL pasted into the wrong box.
    if (v && (v.length < 20 || /\s/.test(v)))
      throw new QuickBooksError("That doesn't look like an Intuit Client ID.");
    set.client_id = v;
  }
  if (patch.client_secret) {
    const v = String(patch.client_secret).trim();
    if (v.length < 20) throw new QuickBooksError("That doesn't look like an Intuit Client Secret.");
    try {
      set.client_secret_enc = secrets.encrypt('quickbooks', v);
    } catch (err) {
      throw new QuickBooksError(err.message);
    }
  }
  if (patch.clear_client_secret) set.client_secret_enc = null;
  if (patch.redirect_uri != null) {
    const v = String(patch.redirect_uri).trim();
    if (v && !/^https?:\/\/\S+$/i.test(v))
      throw new QuickBooksError('The redirect URI must be a full URL, starting with https://');
    if (v && /\/$/.test(v))
      throw new QuickBooksError('Drop the trailing slash — Intuit matches this string exactly.');
    set.redirect_uri = v;
  }
  if (patch.production != null) set.production = !!patch.production;

  if (!Object.keys(set).length) return getStatus();
  set.credentials_updated_at = new Date();
  await store.settings.updateOne({ _id: SETTINGS_ID }, { $set: set }, { upsert: true });

  // Tokens are issued by one Intuit app for one company. Point the app
  // somewhere else and they authorise nothing — better to drop them and say so
  // than to leave a connection that looks fine and 401s on payroll day.
  const after = await creds();
  const moved = after.clientId !== before.clientId || after.production !== before.production;
  const doc = await loadDoc();
  if (moved && doc && doc.refresh_token) {
    await store.settings.updateOne(
      { _id: SETTINGS_ID },
      {
        $unset: {
          access_token: '',
          access_token_expires_at: '',
          refresh_token: '',
          refresh_token_expires_at: '',
          realm_id: '',
          company_name: '',
          connected_at: '',
          connected_by: '',
        },
      }
    );
    await store.qboTime.deleteMany({});
  }
  return { ...(await getStatus()), disconnected: moved && !!(doc && doc.refresh_token) };
}

// Admin-editable settings, all stored on the same doc as the tokens.
const DEFAULTS = {
  // First day of any known pay period. Every other period is counted forward
  // and backward from here, so this alone defines the biweekly calendar.
  period_anchor: null,
  period_days: 14,
  // Weekly overtime threshold in hours. 0 disables the split entirely (all
  // hours go over as regular). Deliberately off by default — the right number
  // is a labour-law question (44 in Ontario, 40 US federal), not something to
  // guess on someone's behalf.
  ot_weekly: 0,
  // Daily overtime threshold; 0 disables it. Daily overtime is taken out first
  // and does not also count toward the weekly threshold.
  ot_daily: 0,
  // QuickBooks payroll item ids. With both set, each day is pushed as two
  // TimeActivity records tagged regular/overtime. Left blank, each day is one
  // record for the full total and the split is only shown in the description.
  regular_item_id: '',
  overtime_item_id: '',
  // The QuickBooks product/service every invoice line is billed against.
  // QuickBooks requires one on a sales line; the description still carries our
  // own wording, so a single "Fencing" service item is enough for most books.
  // Blank means invoices cannot be pushed yet.
  invoice_item_id: '',
  // Optional QuickBooks tax code applied to the lines. Left blank, the lines go
  // over untaxed and QuickBooks applies whatever the customer's own setup says.
  // Tax is deliberately not forced from our side: our flat percentage and
  // QuickBooks' tax engine can disagree, and QuickBooks is what files the
  // return. Any difference in the total is reported rather than hidden.
  invoice_tax_code_id: '',
  // Whether the daily cron pushes a finished period on its own.
  auto_sync: true,
  // The cron only pushes a period that ended within this many days, so a first
  // deploy doesn't backfill every period since the company started.
  auto_window_days: 3,
};

const SETTING_KEYS = Object.keys(DEFAULTS);

async function loadDoc() {
  return (await store.settings.findOne({ _id: SETTINGS_ID })) || null;
}

function settingsOf(doc) {
  const out = { ...DEFAULTS };
  for (const k of SETTING_KEYS) if (doc && doc[k] != null) out[k] = doc[k];
  return out;
}

async function getSettings() {
  return settingsOf(await loadDoc());
}

// Validate and store a settings patch. Returns the settings as they now stand.
async function saveSettings(patch) {
  const set = {};
  if (patch.period_anchor != null) {
    const v = String(patch.period_anchor).trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v))
      throw new QuickBooksError('Pay period start must be a date (YYYY-MM-DD).');
    if (v && isNaN(dayToMs(v)))
      throw new QuickBooksError('That pay period start is not a real date.');
    set.period_anchor = v || null;
  }
  if (patch.period_days != null) {
    const n = Number(patch.period_days);
    if (![7, 14].includes(n))
      throw new QuickBooksError('Pay period length must be 7 or 14 days.');
    set.period_days = n;
  }
  for (const key of ['ot_weekly', 'ot_daily']) {
    if (patch[key] == null) continue;
    const n = Number(patch[key]);
    if (!Number.isFinite(n) || n < 0 || n > 168)
      throw new QuickBooksError('Overtime thresholds must be between 0 and 168 hours.');
    set[key] = Math.round(n * 100) / 100;
  }
  for (const key of ['regular_item_id', 'overtime_item_id', 'invoice_item_id', 'invoice_tax_code_id']) {
    if (patch[key] == null) continue;
    const v = String(patch[key]).trim();
    if (v && !/^\d+$/.test(v))
      throw new QuickBooksError('A QuickBooks id is the number QuickBooks assigns, e.g. 3.');
    set[key] = v;
  }
  if (patch.auto_sync != null) set.auto_sync = !!patch.auto_sync;
  if (patch.auto_window_days != null) {
    const n = Number(patch.auto_window_days);
    if (!Number.isInteger(n) || n < 1 || n > 30)
      throw new QuickBooksError('The catch-up window must be between 1 and 30 days.');
    set.auto_window_days = n;
  }

  const next = { ...(await getSettings()), ...set };
  // Only one payroll item id set means one of the two kinds of hours would land
  // in QuickBooks untagged, which is worse than not splitting at all.
  if (!!next.regular_item_id !== !!next.overtime_item_id)
    throw new QuickBooksError(
      'Set both payroll item ids or neither — one on its own would push untagged hours.'
    );

  if (Object.keys(set).length)
    await store.settings.updateOne({ _id: SETTINGS_ID }, { $set: set }, { upsert: true });
  return next;
}

// ---------------------------------------------------------------------------
// Pay period arithmetic
//
// Dates are plain YYYY-MM-DD strings throughout — a pay period is a range of
// calendar days, not a range of instants, so it must not drift with timezones
// or daylight saving. UTC milliseconds are used only as a counting device.
// ---------------------------------------------------------------------------

function dayToMs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return NaN;
  const [, y, mo, d] = m.map(Number);
  const ms = Date.UTC(y, mo - 1, d);
  // Rejects 2026-02-31 and friends, which Date.UTC would happily roll over.
  return new Date(ms).getUTCDate() === d && new Date(ms).getUTCMonth() === mo - 1 ? ms : NaN;
}
const msToDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => msToDay(dayToMs(day) + n * DAY_MS);
const daysBetween = (a, b) => Math.round((dayToMs(b) - dayToMs(a)) / DAY_MS);

// The pay period containing `day`, counted off the anchor in both directions.
function periodContaining(day, settings) {
  if (!settings.period_anchor)
    throw new QuickBooksError('Set the pay period start date before syncing.');
  const len = settings.period_days;
  const offset = Math.floor(daysBetween(settings.period_anchor, day) / len);
  const start = addDays(settings.period_anchor, offset * len);
  return { start, end: addDays(start, len - 1) };
}

const shiftPeriod = (period, n, settings) => {
  const start = addDays(period.start, n * settings.period_days);
  return { start, end: addDays(start, settings.period_days - 1) };
};

// The most recent period that has finished — the one payroll is actually for.
function lastCompletePeriod(today, settings) {
  const current = periodContaining(today, settings);
  return current.end < today ? current : shiftPeriod(current, -1, settings);
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

async function authorizeUrl(state, redirectUri) {
  const e = await creds();
  if (e.secret_unreadable)
    throw new QuickBooksError(
      'The saved Client Secret could not be read — enter it again under Intuit app.'
    );
  if (!e.clientId || !e.clientSecret)
    throw new QuickBooksError(
      'QuickBooks is not set up yet — add the Client ID and Client Secret under Intuit app.'
    );
  const params = new URLSearchParams({
    client_id: e.clientId,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTH_URL}?${params}`;
}

// The redirect URI must be byte-identical to the one registered with Intuit.
// Prefer the explicit env var; fall back to the request's own origin so a
// local run works without extra configuration.
// The callback URL this deployment would use if none is configured — worked
// out from the request's own origin. Also what the dashboard offers as the
// string to paste into the Intuit app.
function derivedRedirectUri(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .toString()
    .split(',')[0]
    .trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/quickbooks/callback`;
}

async function redirectUriFor(req) {
  return (await creds()).redirectUri || derivedRedirectUri(req);
}

async function tokenRequest(body) {
  const e = await creds();
  const basic = Buffer.from(`${e.clientId}:${e.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = null;
  }
  if (!res.ok || !data || !data.access_token) {
    const detail = (data && (data.error_description || data.error)) || text.slice(0, 400);
    throw new QuickBooksError('QuickBooks refused the sign-in.', { status: 502, detail });
  }
  return data;
}

// Turn a token response into the fields we persist. Intuit returns lifetimes in
// seconds; we store absolute expiry so a cold start can reason about them.
function tokenFields(data) {
  const now = Date.now();
  const fields = {
    access_token: data.access_token,
    access_token_expires_at: new Date(now + Number(data.expires_in || 3600) * 1000),
  };
  // A refresh response may omit the refresh token when it hasn't rotated.
  if (data.refresh_token) {
    fields.refresh_token = data.refresh_token;
    fields.refresh_token_expires_at = new Date(
      now + Number(data.x_refresh_token_expires_in || 100 * 24 * 3600) * 1000
    );
  }
  return fields;
}

// Finish the OAuth handshake and remember the company we're connected to.
async function exchangeCode({ code, realmId, redirectUri, actor }) {
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  await store.settings.updateOne(
    { _id: SETTINGS_ID },
    {
      $set: {
        ...tokenFields(data),
        realm_id: String(realmId),
        connected_at: new Date(),
        connected_by: actor || null,
        last_error: null,
      },
    },
    { upsert: true }
  );
  // Best effort — a company name makes the dashboard readable, but failing to
  // read it must not undo a connection that otherwise worked.
  try {
    const info = await apiGet(`/v3/company/${realmId}/companyinfo/${realmId}`);
    const name = info && info.CompanyInfo && info.CompanyInfo.CompanyName;
    if (name) await store.settings.updateOne({ _id: SETTINGS_ID }, { $set: { company_name: name } });
  } catch (err) {
    console.error('QuickBooks: could not read the company name:', err.message);
  }
  return getStatus();
}

async function refreshTokens(doc) {
  if (!doc || !doc.refresh_token)
    throw new QuickBooksError('QuickBooks is not connected.', { status: 409 });
  if (doc.refresh_token_expires_at && new Date(doc.refresh_token_expires_at) <= new Date())
    throw new QuickBooksError(
      'The QuickBooks connection expired. Click Connect to re-authorize.',
      { status: 409 }
    );
  const data = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: doc.refresh_token,
  });
  const fields = tokenFields(data);
  await store.settings.updateOne({ _id: SETTINGS_ID }, { $set: fields });
  return { ...doc, ...fields };
}

// A valid access token plus the realm to call against, refreshing if needed.
async function auth() {
  let doc = await loadDoc();
  if (!doc || !doc.refresh_token || !doc.realm_id)
    throw new QuickBooksError('QuickBooks is not connected.', { status: 409 });
  const expires = doc.access_token_expires_at ? new Date(doc.access_token_expires_at).getTime() : 0;
  if (!doc.access_token || expires - TOKEN_SKEW_MS <= Date.now()) doc = await refreshTokens(doc);
  return { token: doc.access_token, realmId: doc.realm_id };
}

async function disconnect() {
  const doc = await loadDoc();
  const e = await creds();
  // Revoke at Intuit so the connection disappears from their side too. If that
  // call fails we still drop our copy — leaving a token we no longer trust
  // stored is worse than an orphaned grant.
  if (doc && doc.refresh_token && e.clientId && e.clientSecret) {
    try {
      const basic = Buffer.from(`${e.clientId}:${e.clientSecret}`).toString('base64');
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: doc.refresh_token }),
      });
    } catch (err) {
      console.error('QuickBooks: revoke failed, clearing local tokens anyway:', err.message);
    }
  }
  await store.settings.updateOne(
    { _id: SETTINGS_ID },
    {
      $unset: {
        access_token: '',
        access_token_expires_at: '',
        refresh_token: '',
        refresh_token_expires_at: '',
        realm_id: '',
        company_name: '',
        connected_at: '',
        connected_by: '',
        sync_lock: '',
      },
    },
    { upsert: true }
  );
  // Pushed-record bookkeeping points at a company we can no longer reach.
  await store.qboTime.deleteMany({});
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function apiCall(path, { method = 'GET', body = null, retry = true } = {}) {
  const { token } = await auth();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch((await creds()).apiBase + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // A 401 here means the access token died early (revoked, or refreshed by a
  // parallel invocation). Force one refresh and try again before giving up.
  if (res.status === 401 && retry) {
    const doc = await loadDoc();
    await refreshTokens(doc);
    return apiCall(path, { method, body, retry: false });
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new QuickBooksError(`QuickBooks rejected the request (${res.status}).`, {
      status: res.status === 429 ? 429 : 502,
      detail: faultMessage(data) || text.slice(0, 400),
    });
  }
  return data;
}

const apiGet = (path) => apiCall(withMinorVersion(path));

function withMinorVersion(path) {
  return path + (path.includes('?') ? '&' : '?') + 'minorversion=' + MINOR_VERSION;
}

// Pull the human-readable part out of Intuit's nested fault envelope.
function faultMessage(data) {
  const fault = data && (data.Fault || (data.fault && data.fault));
  const errors = (fault && fault.Error) || [];
  if (!errors.length) return null;
  return errors
    .map((e) => [e.Message, e.Detail].filter(Boolean).join(' — '))
    .join('; ')
    .slice(0, 600);
}

// Run a QuickBooks SQL-ish query against the connected company.
async function runQuery(sql) {
  const { realmId } = await auth();
  const path = `/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}`;
  return apiCall(withMinorVersion(path));
}

// ---------------------------------------------------------------------------
// Invoices — push one to QuickBooks, then let QuickBooks email it.
//
// QuickBooks is the system of record for anything that goes to a customer, so
// this only ever creates the invoice there and asks it to send. It does not
// duplicate QuickBooks' own emailing, and it never pushes the same invoice
// twice: an invoice already sent over carries its QuickBooks id and is updated
// in place instead.
// ---------------------------------------------------------------------------

// The products/services an invoice line can be billed against.
async function listQboItems() {
  const data = await runQuery(
    "select Id, Name, Type, Active from Item where Active = true maxresults 500"
  );
  const rows = (data && data.QueryResponse && data.QueryResponse.Item) || [];
  return rows
    .filter((r) => r.Type === 'Service' || r.Type === 'NonInventory' || r.Type === 'Inventory')
    .map((r) => ({ id: String(r.Id), name: r.Name, type: r.Type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The tax codes set up in the connected company.
async function listQboTaxCodes() {
  const data = await runQuery('select Id, Name, Active from TaxCode maxresults 200');
  const rows = (data && data.QueryResponse && data.QueryResponse.TaxCode) || [];
  return rows
    .filter((r) => r.Active !== false && /^\d+$/.test(String(r.Id)))
    .map((r) => ({ id: String(r.Id), name: r.Name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Escape a value for QuickBooks' query language (single quotes are the risk).
const qEscape = (s) => String(s || '').replace(/'/g, "\\'");

// Find the customer by the name on the invoice, creating them if QuickBooks
// has never seen them. Matching on display name is what a person would do, and
// it keeps a repeat customer from being duplicated on every invoice.
async function findOrCreateCustomer(customer) {
  const name = String((customer && customer.name) || '').trim();
  if (!name) throw new QuickBooksError('The invoice needs a customer name before it can be sent.');

  const { realmId } = await auth();
  const found = await runQuery(
    `select Id, DisplayName, PrimaryEmailAddr from Customer where DisplayName = '${qEscape(name)}'`
  );
  const existing = (found && found.QueryResponse && found.QueryResponse.Customer) || [];
  if (existing.length) {
    return {
      id: String(existing[0].Id),
      name: existing[0].DisplayName,
      email: (existing[0].PrimaryEmailAddr && existing[0].PrimaryEmailAddr.Address) || null,
      created: false,
    };
  }

  const body = { DisplayName: name };
  if (customer.email) body.PrimaryEmailAddr = { Address: customer.email };
  if (customer.phone) body.PrimaryPhone = { FreeFormNumber: customer.phone };
  if (customer.address) body.BillAddr = { Line1: customer.address };
  const made = await apiCall(withMinorVersion(`/v3/company/${realmId}/customer`), {
    method: 'POST',
    body,
  });
  const c = made && made.Customer;
  if (!c) throw new QuickBooksError('QuickBooks did not return the new customer.');
  return {
    id: String(c.Id),
    name: c.DisplayName,
    email: (c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address) || null,
    created: true,
  };
}

// Turn our invoice into the shape QuickBooks wants.
function invoiceBody(inv, { customerId, itemId, taxCodeId }) {
  const lines = (inv.items || [])
    .map((it) => {
      const qty = Number(it.qty) || 0;
      const rate = Number(it.unit_price) || 0;
      const amount = Math.round(qty * rate * 100) / 100;
      const detail = {
        ItemRef: { value: itemId },
        Qty: qty,
        UnitPrice: rate,
      };
      if (taxCodeId) detail.TaxCodeRef = { value: taxCodeId };
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: amount,
        Description: [it.description, it.unit ? `(${it.unit})` : ''].filter(Boolean).join(' '),
        SalesItemLineDetail: detail,
      };
    })
    .filter((l) => l.Amount || l.Description);

  if (!lines.length)
    throw new QuickBooksError('The invoice has no line items to send.');

  const body = {
    CustomerRef: { value: customerId },
    Line: lines,
    // Our own number, so the two systems can be lined up by eye.
    DocNumber: String(inv.number || '').slice(0, 21),
  };
  if (inv.issue_date) body.TxnDate = localDay(inv.issue_date);
  if (inv.due_date) body.DueDate = localDay(inv.due_date);
  if (inv.notes) body.CustomerMemo = { value: String(inv.notes).slice(0, 1000) };
  if (inv.customer && inv.customer.email) body.BillEmail = { Address: inv.customer.email };
  if (taxCodeId) body.GlobalTaxCalculation = 'TaxExcluded';
  return body;
}

// Create (or update) the invoice in QuickBooks. Returns what happened, plus a
// warning when QuickBooks' own total does not agree with ours.
async function pushInvoice(inv) {
  const settings = await getSettings();
  if (!settings.invoice_item_id)
    throw new QuickBooksError(
      'Choose which QuickBooks product/service invoice lines should bill against first.'
    );
  const { realmId } = await auth();
  const customer = await findOrCreateCustomer(inv.customer);
  const body = invoiceBody(inv, {
    customerId: customer.id,
    itemId: settings.invoice_item_id,
    taxCodeId: settings.invoice_tax_code_id,
  });

  const existingId = inv.qbo && inv.qbo.id;
  let saved;
  if (existingId) {
    // Updating needs the current SyncToken, or QuickBooks refuses the write.
    const current = await apiGet(`/v3/company/${realmId}/invoice/${existingId}`);
    const token = current && current.Invoice && current.Invoice.SyncToken;
    if (token == null)
      throw new QuickBooksError('That invoice no longer exists in QuickBooks.');
    saved = await apiCall(withMinorVersion(`/v3/company/${realmId}/invoice`), {
      method: 'POST',
      body: { ...body, Id: String(existingId), SyncToken: String(token), sparse: false },
    });
  } else {
    saved = await apiCall(withMinorVersion(`/v3/company/${realmId}/invoice`), {
      method: 'POST',
      body,
    });
  }

  const qi = saved && saved.Invoice;
  if (!qi) throw new QuickBooksError('QuickBooks did not return the invoice.');

  // Our tax is a flat percentage; QuickBooks works it out from the tax code and
  // the customer. Say so plainly rather than let the two quietly disagree.
  const ourTotal = Math.round((Number(inv.total) || 0) * 100) / 100;
  const theirTotal = Math.round((Number(qi.TotalAmt) || 0) * 100) / 100;
  const mismatch = Math.abs(ourTotal - theirTotal) > 0.01 ? { ours: ourTotal, theirs: theirTotal } : null;

  return {
    id: String(qi.Id),
    doc_number: qi.DocNumber || null,
    total: theirTotal,
    balance: Number(qi.Balance) || 0,
    updated: !!existingId,
    customer: { id: customer.id, name: customer.name, created: customer.created },
    mismatch,
  };
}

// Ask QuickBooks to email the invoice. This is the actual send — the message,
// the branding and the payment link are all theirs.
async function sendInvoice(qboId, email) {
  const { realmId } = await auth();
  const to = String(email || '').trim();
  const path =
    `/v3/company/${realmId}/invoice/${qboId}/send` +
    (to ? `?sendTo=${encodeURIComponent(to)}` : '');
  const data = await apiCall(withMinorVersion(path), { method: 'POST' });
  const qi = data && data.Invoice;
  return {
    id: String((qi && qi.Id) || qboId),
    status: (qi && qi.EmailStatus) || 'EmailSent',
    sent_to: to || ((qi && qi.BillEmail && qi.BillEmail.Address) || null),
  };
}

// A link straight to the invoice inside QuickBooks.
async function invoiceLink(qboId) {
  const { production } = await creds();
  const host = production ? 'https://qbo.intuit.com' : 'https://sandbox.qbo.intuit.com';
  return `${host}/app/invoice?txnId=${encodeURIComponent(qboId)}`;
}

// Every employee QuickBooks knows about, for the mapping picker.
async function listQboEmployees() {
  const out = [];
  // QuickBooks pages at 1000 rows; a fencing company won't hit that, but
  // paging costs nothing and removes a silent truncation.
  for (let start = 1; ; start += 1000) {
    const data = await runQuery(
      `select Id, DisplayName, GivenName, FamilyName, Active, PrimaryEmailAddr from Employee startposition ${start} maxresults 1000`
    );
    const rows = (data && data.QueryResponse && data.QueryResponse.Employee) || [];
    for (const r of rows) {
      out.push({
        id: String(r.Id),
        name: r.DisplayName || [r.GivenName, r.FamilyName].filter(Boolean).join(' ') || `#${r.Id}`,
        email: (r.PrimaryEmailAddr && r.PrimaryEmailAddr.Address) || null,
        active: r.Active !== false,
      });
    }
    if (rows.length < 1000) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Hours: punches -> per employee, per day, split regular / overtime
// ---------------------------------------------------------------------------

const round2 = (n) => Math.round(n * 100) / 100;

// A punch's paid length in hours: the shift itself, plus the shop/load time
// entered at clock-out, minus the unpaid lunch. Open punches contribute nothing
// — they're reported as a warning instead, since nobody should be paid for a
// shift that hasn't been closed out.
function punchHours(p) {
  if (!p.clock_out) return null;
  const raw = (new Date(p.clock_out) - new Date(p.clock_in)) / 3600000;
  return Math.max(0, raw + (Number(p.shop_hours) || 0) - (Number(p.lunch_hours) || 0));
}

// Split one employee's days into regular and overtime, respecting both
// thresholds. Days are walked in order because overtime accrues once the
// threshold is crossed, so which day it lands on depends on sequence.
function applyOvertime(days, period, settings) {
  const weekly = Number(settings.ot_weekly) || 0;
  const daily = Number(settings.ot_daily) || 0;
  // Work weeks run from the period start, so a 14-day period is two clean
  // 7-day weeks and the weekly threshold never straddles a period boundary.
  let weekIndex = -1;
  let weekRegular = 0;
  return days.map((d) => {
    const idx = Math.floor(daysBetween(period.start, d.day) / 7);
    if (idx !== weekIndex) {
      weekIndex = idx;
      weekRegular = 0;
    }
    let regular = d.hours;
    let overtime = 0;
    if (daily > 0 && regular > daily) {
      overtime = regular - daily;
      regular = daily;
    }
    if (weekly > 0) {
      const room = Math.max(0, weekly - weekRegular);
      if (regular > room) {
        overtime += regular - room;
        regular = room;
      }
    }
    weekRegular += regular;
    return { ...d, regular: round2(regular), overtime: round2(overtime) };
  });
}

// Build the full picture of a pay period: who worked, on which days, how much
// of it is overtime, and everything that stands in the way of pushing it.
async function buildPeriod(period, settings) {
  const employees = await store.employees.find({}, { sort: { name: 1 } }).toArray();
  const byId = new Map(employees.map((e) => [e._id, e]));

  // Query a day wider on each side, then filter by local day — a punch started
  // late on the last evening of the period is still that day's work even
  // though its UTC timestamp may fall outside the naive range.
  const punches = await store.punches
    .find({
      clock_in: {
        $gte: new Date(addDays(period.start, -1) + 'T00:00:00.000Z'),
        $lte: new Date(addDays(period.end, 1) + 'T23:59:59.999Z'),
      },
    })
    .toArray();

  const warnings = [];
  // employee id -> day -> { hours, notes[] }
  const collected = new Map();

  for (const p of punches) {
    const day = localDay(p.clock_in);
    if (day < period.start || day > period.end) continue;
    const emp = byId.get(p.employee_id);
    if (!emp) {
      warnings.push({
        kind: 'orphan_punch',
        message: `A punch on ${day} belongs to employee #${p.employee_id}, who no longer exists. It was not pushed.`,
      });
      continue;
    }
    const hours = punchHours(p);
    if (hours == null) {
      warnings.push({
        kind: 'open_punch',
        employee_id: emp._id,
        message: `${emp.name} is still clocked in from ${day}. That shift was left out — close it and sync again.`,
      });
      continue;
    }
    if (hours <= 0) continue;

    if (!collected.has(emp._id)) collected.set(emp._id, new Map());
    const days = collected.get(emp._id);
    const entry = days.get(day) || { hours: 0, notes: [] };
    entry.hours += hours;
    for (const job of p.jobs || []) {
      const label = [job.address, job.title, job.description].filter(Boolean)[0];
      if (label && !entry.notes.includes(label)) entry.notes.push(label);
    }
    if (p.work_done && !entry.notes.includes(p.work_done)) entry.notes.push(p.work_done);
    days.set(day, entry);
  }

  const rows = [];
  for (const [empId, days] of collected) {
    const emp = byId.get(empId);
    // Salaried staff are paid the same however long the day runs, so their
    // hours are not payroll input. They can still have punches from before
    // they moved onto salary, which is exactly why this is checked here.
    if ((emp.pay_type || '') === 'Salary') continue;

    const ordered = [...days.entries()]
      .map(([day, v]) => ({ day, hours: round2(v.hours), notes: v.notes }))
      .filter((d) => d.hours > 0)
      .sort((a, b) => (a.day < b.day ? -1 : 1));

    const split = applyOvertime(ordered, period, settings);
    const total = round2(split.reduce((s, d) => s + d.hours, 0));

    if (!emp.qbo_employee_id) {
      warnings.push({
        kind: 'unmapped',
        employee_id: emp._id,
        message: `${emp.name} has ${total.toFixed(2)} hours but is not matched to a QuickBooks employee yet.`,
      });
    }
    if (!emp.active) {
      warnings.push({
        kind: 'inactive',
        employee_id: emp._id,
        message: `${emp.name} is deactivated here but has hours in this period.`,
      });
    }

    rows.push({
      employee_id: emp._id,
      name: emp.name,
      qbo_employee_id: emp.qbo_employee_id || null,
      pay_type: emp.pay_type || '',
      hourly_rate: hourlyRateOf(emp),
      days: split,
      regular: round2(split.reduce((s, d) => s + d.regular, 0)),
      overtime: round2(split.reduce((s, d) => s + d.overtime, 0)),
      total,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return {
    period,
    employees: rows,
    warnings,
    totals: {
      employees: rows.length,
      regular: round2(rows.reduce((s, r) => s + r.regular, 0)),
      overtime: round2(rows.reduce((s, r) => s + r.overtime, 0)),
      hours: round2(rows.reduce((s, r) => s + r.total, 0)),
    },
  };
}

// pay_rate is dollars per hour for hourly staff (and per year for salary, which
// is not pushed). Anything unparseable simply means "don't send a rate" —
// QuickBooks will fall back to the rate on the employee record there.
function hourlyRateOf(emp) {
  if ((emp.pay_type || '') !== 'Hourly') return null;
  const n = Number(String(emp.pay_rate || '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? round2(n) : null;
}

// ---------------------------------------------------------------------------
// Pushing to QuickBooks
// ---------------------------------------------------------------------------

// One day of one employee becomes one or two TimeActivity records. Two only
// when payroll items are configured — otherwise a second untagged record would
// be indistinguishable from the first in QuickBooks.
function linesFor(dayRow, settings) {
  const split = !!(settings.regular_item_id && settings.overtime_item_id);
  if (!split) {
    return dayRow.hours > 0
      ? [{ kind: 'all', hours: dayRow.hours, itemId: '', overtime: dayRow.overtime }]
      : [];
  }
  const lines = [];
  if (dayRow.regular > 0)
    lines.push({ kind: 'regular', hours: dayRow.regular, itemId: settings.regular_item_id });
  if (dayRow.overtime > 0)
    lines.push({ kind: 'overtime', hours: dayRow.overtime, itemId: settings.overtime_item_id });
  return lines;
}

function describe(dayRow, line) {
  const parts = [];
  if (line.kind === 'all' && line.overtime > 0)
    parts.push(`${round2(dayRow.regular).toFixed(2)} reg + ${round2(dayRow.overtime).toFixed(2)} OT`);
  if (line.kind === 'overtime') parts.push('Overtime');
  if (dayRow.notes && dayRow.notes.length) parts.push(dayRow.notes.join('; '));
  parts.push('via HEK Timeclock');
  // QuickBooks caps Description at 4000 characters.
  return parts.join(' — ').slice(0, 4000);
}

// QuickBooks stores time as whole hours plus minutes, so round once, here, and
// derive both from the same number — rounding each separately would drift.
function hoursMinutes(hours) {
  const totalMinutes = Math.round(hours * 60);
  return { Hours: Math.floor(totalMinutes / 60), Minutes: totalMinutes % 60 };
}

function timeActivityBody(row, dayRow, line) {
  const { Hours, Minutes } = hoursMinutes(line.hours);
  const body = {
    TxnDate: dayRow.day,
    NameOf: 'Employee',
    EmployeeRef: { value: String(row.qbo_employee_id) },
    Hours,
    Minutes,
    Description: describe(dayRow, line),
  };
  if (row.hourly_rate) body.HourlyRate = row.hourly_rate;
  if (line.itemId) body.PayrollItemRef = { value: String(line.itemId) };
  return body;
}

// Send up to BATCH_MAX operations in one request. Returns the response keyed by
// the bId we assigned, so each result can be matched back to its own record.
async function sendBatch(ops) {
  const { realmId } = await auth();
  const data = await apiCall(withMinorVersion(`/v3/company/${realmId}/batch`), {
    method: 'POST',
    body: { BatchItemRequest: ops },
  });
  const out = new Map();
  for (const item of (data && data.BatchItemResponse) || []) out.set(item.bId, item);
  return out;
}

// Take out the sync lock. Returns false when another sync already holds it.
// A lock older than LOCK_MS is treated as abandoned — a serverless function
// killed mid-sync would otherwise wedge payroll shut until someone noticed.
async function acquireLock() {
  const cutoff = new Date(Date.now() - LOCK_MS);
  // The conditional update below can only match a doc that exists.
  await store.settings.updateOne(
    { _id: SETTINGS_ID },
    { $setOnInsert: { created_at: new Date() } },
    { upsert: true }
  );
  const r = await store.settings.updateOne(
    { _id: SETTINGS_ID, $or: [{ sync_lock: null }, { sync_lock: { $lte: cutoff } }] },
    { $set: { sync_lock: new Date() } }
  );
  return r.matchedCount === 1;
}

const releaseLock = () => store.settings.updateOne({ _id: SETTINGS_ID }, { $unset: { sync_lock: '' } });

// Push a period's hours into QuickBooks.
//
// Re-running is safe and is the normal way to correct a timesheet: every
// pushed record is remembered locally with its QuickBooks id and SyncToken, so
// a second run updates what changed, deletes what no longer has hours, and
// leaves the rest alone rather than creating duplicates.
async function syncPeriod(period, { actor = null, trigger = 'manual' } = {}) {
  const settings = await getSettings();
  const report = await buildPeriod(period, settings);

  if (!(await acquireLock()))
    throw new QuickBooksError('Another sync is already running. Try again in a minute.', {
      status: 409,
    });

  const result = {
    start: period.start,
    end: period.end,
    trigger,
    actor,
    started_at: new Date(),
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    failed: 0,
    hours: report.totals.hours,
    regular: report.totals.regular,
    overtime: report.totals.overtime,
    employees: 0,
    warnings: report.warnings,
    errors: [],
  };

  try {
    const pushable = report.employees.filter((r) => r.qbo_employee_id);
    result.employees = pushable.length;

    // Everything we previously pushed for this period. Anything still here at
    // the end no longer has hours behind it and must be removed from
    // QuickBooks — otherwise a deleted punch would stay paid.
    const stale = new Map();
    for (const doc of await store.qboTime.find({ period_start: period.start }).toArray())
      stale.set(doc._id, doc);

    const ops = []; // { op, key, doc, body, kind }
    for (const row of pushable) {
      for (const dayRow of row.days) {
        for (const line of linesFor(dayRow, settings)) {
          const key = `${period.start}|${row.employee_id}|${dayRow.day}|${line.kind}`;
          const existing = stale.get(key);
          stale.delete(key);
          const body = timeActivityBody(row, dayRow, line);

          if (!existing || !existing.qbo_id) {
            ops.push({ op: 'create', key, body, row, dayRow, line });
            continue;
          }
          // Nothing changed since the last push — skip the round trip.
          if (
            existing.hours === line.hours &&
            existing.qbo_employee_id === String(row.qbo_employee_id) &&
            existing.description === body.Description &&
            existing.item_id === String(line.itemId || '') &&
            existing.hourly_rate === (row.hourly_rate || null)
          ) {
            result.unchanged++;
            continue;
          }
          ops.push({
            op: 'update',
            key,
            doc: existing,
            body: { ...body, Id: existing.qbo_id, SyncToken: existing.sync_token, sparse: false },
            row,
            dayRow,
            line,
          });
        }
      }
    }

    // Whatever is left in `stale` was pushed before and shouldn't exist now.
    for (const [key, doc] of stale) {
      if (!doc.qbo_id) {
        await store.qboTime.deleteOne({ _id: key });
        continue;
      }
      ops.push({
        op: 'delete',
        key,
        doc,
        body: { Id: doc.qbo_id, SyncToken: doc.sync_token },
      });
    }

    for (let i = 0; i < ops.length; i += BATCH_MAX) {
      const chunk = ops.slice(i, i + BATCH_MAX);
      const responses = await sendBatch(
        chunk.map((o, n) => ({ bId: String(n), operation: o.op, TimeActivity: o.body }))
      );

      for (let n = 0; n < chunk.length; n++) {
        const o = chunk[n];
        const res = responses.get(String(n));
        const fault = res && res.Fault ? faultMessage(res) : null;
        if (!res || fault) {
          result.failed++;
          result.errors.push({
            employee: o.row ? o.row.name : null,
            day: o.dayRow ? o.dayRow.day : null,
            message: fault || 'QuickBooks returned no result for this entry.',
          });
          continue;
        }
        const ta = res.TimeActivity || {};
        if (o.op === 'delete') {
          await store.qboTime.deleteOne({ _id: o.key });
          result.deleted++;
          continue;
        }
        await store.qboTime.updateOne(
          { _id: o.key },
          {
            $set: {
              period_start: period.start,
              employee_id: o.row.employee_id,
              day: o.dayRow.day,
              kind: o.line.kind,
              hours: o.line.hours,
              item_id: String(o.line.itemId || ''),
              description: o.body.Description,
              hourly_rate: o.row.hourly_rate || null,
              qbo_employee_id: String(o.row.qbo_employee_id),
              qbo_id: String(ta.Id || (o.doc && o.doc.qbo_id) || ''),
              sync_token: String(ta.SyncToken != null ? ta.SyncToken : '0'),
              pushed_at: new Date(),
            },
          },
          { upsert: true }
        );
        if (o.op === 'create') result.created++;
        else result.updated++;
      }
    }
  } finally {
    await releaseLock();
  }

  result.finished_at = new Date();
  result.ok = result.failed === 0;
  const _id = await store.nextId('qbo_runs');
  await store.qboRuns.insertOne({ _id, ...result });
  await store.settings.updateOne(
    { _id: SETTINGS_ID },
    { $set: { last_run: { ...result, _id } } },
    { upsert: true }
  );
  return { ...result, _id };
}

// ---------------------------------------------------------------------------
// Status + the scheduled run
// ---------------------------------------------------------------------------

async function getStatus() {
  const doc = await loadDoc();
  const settings = settingsOf(doc);
  const connected = !!(doc && doc.refresh_token && doc.realm_id);
  const c = await creds();
  const status = {
    configured: !!(c.clientId && c.clientSecret),
    production: c.production,
    connected,
    company: (doc && doc.company_name) || null,
    realm_id: (doc && doc.realm_id) || null,
    connected_at: (doc && doc.connected_at) || null,
    connected_by: (doc && doc.connected_by) || null,
    refresh_expires_at: (doc && doc.refresh_token_expires_at) || null,
    settings,
    // Everything the credentials form needs to render. The secret itself is
    // never included — only whether one is stored.
    credentials: {
      client_id: c.clientId,
      has_secret: !!c.clientSecret,
      secret_unreadable: c.secret_unreadable,
      redirect_uri: c.redirectUri,
      production: c.production,
      source: c.source,
      updated_at: (doc && doc.credentials_updated_at) || null,
      can_store: secrets.canEncrypt(),
    },
    last_run: (doc && doc.last_run) || null,
    periods: null,
    needs: [],
  };
  if (c.secret_unreadable)
    status.needs.push('The saved Client Secret can no longer be read — enter it again.');
  else if (!c.clientId) status.needs.push('Add the Intuit app Client ID.');
  else if (!c.clientSecret) status.needs.push('Add the Intuit app Client Secret.');
  if (status.configured && !connected) status.needs.push('Connect the QuickBooks company.');
  if (!settings.period_anchor) status.needs.push('Set the pay period start date.');

  if (settings.period_anchor) {
    const today = localDay(new Date());
    const current = periodContaining(today, settings);
    const previous = shiftPeriod(current, -1, settings);
    status.periods = {
      today,
      current,
      previous,
      last_complete: lastCompletePeriod(today, settings),
      next_close: addDays(current.end, 1),
    };
  }
  return status;
}

// The daily cron. It looks for a pay period that has just closed and pushes it
// once — running again the same day finds the work already done and does
// nothing, so a retry is free.
async function runScheduledSync() {
  const settings = await getSettings();
  const doc = await loadDoc();
  if (!doc || !doc.refresh_token) return { skipped: 'not_connected' };
  if (!settings.auto_sync) return { skipped: 'auto_sync_off' };
  if (!settings.period_anchor) return { skipped: 'no_period_anchor' };

  const today = localDay(new Date());
  const period = lastCompletePeriod(today, settings);
  // Only a period that closed recently. Without this, a first deploy would
  // reach back and push every period since the company started.
  const age = daysBetween(period.end, today);
  if (age > settings.auto_window_days) return { skipped: 'nothing_due', period };

  const already = await store.qboRuns.findOne(
    { start: period.start, ok: true },
    { sort: { _id: -1 } }
  );
  if (already) return { skipped: 'already_synced', period, run_id: already._id };

  const result = await syncPeriod(period, { trigger: 'cron' });
  return { ran: true, period, result };
}

module.exports = {
  QuickBooksError,
  isConfigured,
  creds,
  saveCredentials,
  authorizeUrl,
  redirectUriFor,
  derivedRedirectUri,
  exchangeCode,
  disconnect,
  getStatus,
  getSettings,
  saveSettings,
  listQboEmployees,
  listQboItems,
  listQboTaxCodes,
  findOrCreateCustomer,
  pushInvoice,
  sendInvoice,
  invoiceLink,
  buildPeriod,
  // Exported so the overtime split — the one calculation here that decides
  // what somebody is paid — can be checked directly.
  applyOvertime,
  syncPeriod,
  runScheduledSync,
  periodContaining,
  shiftPeriod,
  lastCompletePeriod,
  localDay,
  dayToMs,
  addDays,
};
