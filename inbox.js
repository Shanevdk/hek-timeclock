// The inbox agent — reads the mailbox, finds quote requests, drafts estimates.
//
// It never sends anything and it never creates a real quote on its own. Every
// message it decides is a quote request becomes a *lead*: the original email
// plus a priced draft, sitting in the Inbox tab waiting for someone to look at
// it. Approving a lead is what creates the quote. Nothing reaches a customer
// without a person clicking twice.
//
// Setup:
//   ANTHROPIC_API_KEY   — from https://platform.claude.com. Without it the tab
//                         still loads and says what is missing.
//   Mail login          — host / user / app password, entered in the dashboard.
//                         For Gmail that is an App Password (needs 2FA on), not
//                         the account password.
//
// The mail password is encrypted before it is stored (see encrypt/decrypt
// below) — it is a live credential to the company's email, not a setting.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { store } = require('./db');
const secrets = require('./secrets');
const { getRateBook, SERVICES, byKey, serviceLabel } = require('./ratebook');

const SETTINGS_ID = 'inbox';
// Claude Opus 5 reads a rambling customer email far better than a cheaper
// model, and the whole point is fewer drafts to correct by hand. Swappable in
// the dashboard once the real monthly cost is visible.
const DEFAULT_MODEL = 'claude-opus-5';
const ALLOWED_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
// Emails are read, not written, so a long one costs input tokens only. Trimming
// keeps a forwarded thread with 40 quoted replies from costing real money.
const MAX_BODY_CHARS = 6000;
const LOCK_MS = 10 * 60 * 1000;

class InboxError extends Error {
  constructor(message, { status = 400, detail = null } = {}) {
    super(message);
    this.name = 'InboxError';
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Settings + credential encryption
// ---------------------------------------------------------------------------

const DEFAULTS = {
  enabled: false,
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  user: '',
  folder: 'INBOX',
  model: DEFAULT_MODEL,
  // How far back a scan looks. Messages already turned into leads are skipped,
  // so overlapping windows cost nothing.
  lookback_days: 3,
  // Hard ceiling on how many new emails one scan will send to the model. Stops
  // a bad filter or a mail-bomb from running up a bill unattended.
  max_per_scan: 25,
  auto_scan: true,
};
const SETTING_KEYS = Object.keys(DEFAULTS);

// The mail password is a live credential to the company's email, so it is
// encrypted before it is stored (see secrets.js). The "inbox" purpose keeps it
// on its own derived key.
const encrypt = (plain) => {
  try {
    return secrets.encrypt('inbox', plain);
  } catch (err) {
    throw new InboxError(err.message);
  }
};
const decrypt = (blob) => secrets.decrypt('inbox', blob);

const loadDoc = () => store.settings.findOne({ _id: SETTINGS_ID });

function settingsOf(doc) {
  const out = { ...DEFAULTS };
  for (const k of SETTING_KEYS) if (doc && doc[k] != null) out[k] = doc[k];
  return out;
}

const getSettings = async () => settingsOf(await loadDoc());

async function saveSettings(patch) {
  const set = {};
  if (patch.host != null) set.host = String(patch.host).trim();
  if (patch.user != null) set.user = String(patch.user).trim();
  if (patch.folder != null) set.folder = String(patch.folder).trim() || 'INBOX';
  if (patch.secure != null) set.secure = !!patch.secure;
  if (patch.enabled != null) set.enabled = !!patch.enabled;
  if (patch.auto_scan != null) set.auto_scan = !!patch.auto_scan;
  if (patch.port != null) {
    const n = Number(patch.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new InboxError('That is not a valid port.');
    set.port = n;
  }
  if (patch.model != null) {
    if (!ALLOWED_MODELS.includes(patch.model)) throw new InboxError('Unknown model.');
    set.model = patch.model;
  }
  if (patch.lookback_days != null) {
    const n = Number(patch.lookback_days);
    if (!Number.isInteger(n) || n < 1 || n > 30)
      throw new InboxError('Look back between 1 and 30 days.');
    set.lookback_days = n;
  }
  if (patch.max_per_scan != null) {
    const n = Number(patch.max_per_scan);
    if (!Number.isInteger(n) || n < 1 || n > 200)
      throw new InboxError('Scan between 1 and 200 emails at a time.');
    set.max_per_scan = n;
  }
  // A blank password means "leave the stored one alone", so clearing it is a
  // separate, explicit action.
  if (patch.password) set.password_enc = encrypt(patch.password);
  if (patch.clear_password) set.password_enc = null;

  if (Object.keys(set).length) {
    set.updated_at = new Date();
    await store.settings.updateOne({ _id: SETTINGS_ID }, { $set: set }, { upsert: true });
  }
  return getSettings();
}

const hasApiKey = () => !!process.env.ANTHROPIC_API_KEY;

async function getStatus() {
  const doc = await loadDoc();
  const settings = settingsOf(doc);
  const hasPassword = !!(doc && doc.password_enc);
  const needs = [];
  if (!hasApiKey()) needs.push('Set ANTHROPIC_API_KEY on the server so the agent can read email.');
  if (!settings.user) needs.push('Enter the mailbox address to watch.');
  if (!hasPassword) needs.push('Enter the mailbox app password.');
  if (!settings.enabled) needs.push('Switch the agent on.');

  const counts = { new: 0, approved: 0, dismissed: 0, not_quote: 0 };
  for (const row of await store.inboxLeads
    .aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
    .toArray())
    counts[row._id] = row.n;

  return {
    configured: hasApiKey(),
    has_password: hasPassword,
    settings,
    counts,
    last_scan: (doc && doc.last_scan) || null,
    needs,
  };
}

// ---------------------------------------------------------------------------
// Reading the mailbox
// ---------------------------------------------------------------------------

// Bulk mail is the bulk of any inbox and none of it is a quote request.
// Skipping it here means never paying to have the model read a newsletter.
function looksLikeBulk(envelope, headers) {
  const from = ((envelope.from && envelope.from[0] && envelope.from[0].address) || '').toLowerCase();
  if (/^(no-?reply|do-?not-?reply|bounce|mailer-daemon|postmaster|notifications?)@/.test(from))
    return true;
  if (headers && (headers.has('list-unsubscribe') || headers.has('list-id'))) return true;
  const precedence = headers && headers.get('precedence');
  if (precedence && /bulk|junk|list/i.test(precedence)) return true;
  return false;
}

// Open the mailbox, hand each unseen message to `onMessage`, and close. Fetches
// envelopes first (cheap) and full bodies only for messages we haven't already
// turned into a lead.
async function withMailbox(settings, password, onMessage) {
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: password },
    logger: false,
    // A wedged connection must not hold a serverless function open until it is
    // killed with no explanation.
    socketTimeout: 60000,
    greetingTimeout: 15000,
  });

  try {
    await client.connect();
  } catch (err) {
    throw new InboxError('Could not sign in to the mailbox.', { status: 502, detail: err.message });
  }

  let lock;
  try {
    lock = await client.getMailboxLock(settings.folder);
  } catch (err) {
    await client.logout().catch(() => {});
    throw new InboxError(`Could not open the "${settings.folder}" folder.`, {
      status: 502,
      detail: err.message,
    });
  }

  try {
    const since = new Date(Date.now() - settings.lookback_days * 86400000);
    const uids = await client.search({ since }, { uid: true });
    if (!uids || !uids.length) return { seen: 0, considered: 0 };

    // Newest first, so a capped scan looks at the most recent mail.
    const ordered = [...uids].sort((a, b) => b - a);

    // Pass one: envelopes only, to find what we haven't seen before.
    const candidates = [];
    for await (const msg of client.fetch(ordered, { envelope: true, headers: true }, { uid: true })) {
      const messageId = (msg.envelope && msg.envelope.messageId) || `uid:${settings.folder}:${msg.uid}`;
      if (looksLikeBulk(msg.envelope || {}, msg.headers ? parseHeaders(msg.headers) : null) ) continue;
      candidates.push({ uid: msg.uid, messageId, envelope: msg.envelope || {} });
    }
    if (!candidates.length) return { seen: uids.length, considered: 0 };

    const known = new Set(
      (
        await store.inboxLeads
          .find({ message_id: { $in: candidates.map((c) => c.messageId) } }, { projection: { message_id: 1 } })
          .toArray()
      ).map((d) => d.message_id)
    );
    const fresh = candidates.filter((c) => !known.has(c.messageId)).slice(0, settings.max_per_scan);
    if (!fresh.length) return { seen: uids.length, considered: 0 };

    // Pass two: full bodies, only for the ones we're actually going to read.
    let considered = 0;
    for await (const msg of client.fetch(
      fresh.map((f) => f.uid),
      { source: true, envelope: true },
      { uid: true }
    )) {
      const meta = fresh.find((f) => f.uid === msg.uid);
      if (!meta) continue;
      let parsed;
      try {
        parsed = await simpleParser(msg.source);
      } catch (err) {
        console.error('inbox: could not parse message', msg.uid, err.message);
        continue;
      }
      considered++;
      await onMessage({
        uid: msg.uid,
        message_id: meta.messageId,
        subject: parsed.subject || '(no subject)',
        from_name: (parsed.from && parsed.from.value[0] && parsed.from.value[0].name) || '',
        from_email: (parsed.from && parsed.from.value[0] && parsed.from.value[0].address) || '',
        received_at: parsed.date || new Date(),
        body: (parsed.text || stripHtml(parsed.html || '') || '').trim(),
      });
    }
    return { seen: uids.length, considered };
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

// ImapFlow hands back raw header bytes; turn them into something with .get().
function parseHeaders(buf) {
  const map = new Map();
  for (const line of String(buf).split(/\r?\n(?![ \t])/)) {
    const i = line.indexOf(':');
    if (i > 0) map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return map;
}

const stripHtml = (html) =>
  String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ');

// A forwarded thread is mostly quoted history. The request is nearly always at
// the top, so trim from the end and note that we did.
function trimBody(text) {
  const clean = String(text || '').replace(/\r/g, '');
  if (clean.length <= MAX_BODY_CHARS) return clean;
  return clean.slice(0, MAX_BODY_CHARS) + '\n\n[…email truncated for length…]';
}

// ---------------------------------------------------------------------------
// Reading the email with Claude
// ---------------------------------------------------------------------------

const SERVICE_KEY_LIST = SERVICES.map((s) => s.key);

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    is_quote_request: {
      type: 'boolean',
      description: 'True only if a person is asking about fencing work for a property.',
    },
    reason: { type: 'string', description: 'One short sentence on why you decided that.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    customer: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
      },
      required: ['name', 'email', 'phone', 'address'],
      additionalProperties: false,
    },
    items: {
      type: 'array',
      description: 'One entry per distinct piece of work. Empty if none can be identified.',
      items: {
        type: 'object',
        properties: {
          service: { type: 'string', enum: SERVICE_KEY_LIST },
          qty: { type: 'number', description: 'Quantity in the service unit. 0 if not stated.' },
          note: { type: 'string', description: 'Detail worth keeping, e.g. "6ft high, black".' },
        },
        required: ['service', 'qty', 'note'],
        additionalProperties: false,
      },
    },
    missing: {
      type: 'array',
      description: 'What still has to be asked before this quote can go out.',
      items: { type: 'string' },
    },
    summary: { type: 'string', description: 'One or two sentences an estimator can act on.' },
  },
  required: ['is_quote_request', 'reason', 'confidence', 'customer', 'items', 'missing', 'summary'],
  additionalProperties: false,
};

function systemPrompt(rateBook) {
  const menu = rateBook.services.map((s) => `  ${s.key} — ${s.label} (per ${s.unit})`).join('\n');
  return `You read the inbox of HEK Fencing Inc., a fencing contractor in Ontario, and turn customer emails into rough estimates for the office to review.

Services you can quote, by key:
${menu}

Decide two things.

First: is this email a person asking about fencing work? Say no to newsletters, supplier invoices, receipts, spam, job applications, and messages between staff. A short vague note like "how much for a fence out back?" IS a quote request — it just has a lot missing.

Second, if it is: pull out who they are and what they want. Rules that matter:

- Only report what the email actually says. Do not infer a length, a height, or a fence type that was never written down. An estimate built on a guess is worse than one with a blank in it.
- Put anything you could not determine into "missing", written as the question to ask them — "How many linear feet?", "Which side of the property?".
- Set qty to 0 when a quantity is implied but not stated, and add the question to "missing". Do not invent a number.
- Convert plainly stated units into the service's unit. Yards or metres to feet is fine; a guess at "a small backyard" is not.
- Pick the closest service key. Chain link with no colour stated is clgalv. If someone describes work you have no key for, leave it out of items and describe it in "missing".
- If they mention taking down an existing fence, add tearout. If they mention gates, add gate with the count.
- Leave a customer field as an empty string when the email does not give it. The sender's own address counts as their email.

"summary" is for the estimator, not the customer — what the job is, and what you would want to know before pricing it properly.`;
}

let _client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY)
    throw new InboxError('ANTHROPIC_API_KEY is not set on the server.', { status: 409 });
  if (!_client) _client = new Anthropic();
  return _client;
}

// Ask Claude to read one email. Returns the parsed extraction, or throws.
async function readEmail(email, settings, rateBook) {
  const client = anthropic();
  const content = [
    `From: ${email.from_name} <${email.from_email}>`,
    `Subject: ${email.subject}`,
    `Date: ${new Date(email.received_at).toISOString()}`,
    '',
    trimBody(email.body),
  ].join('\n');

  let res;
  try {
    res = await client.messages.create({
      model: settings.model,
      max_tokens: 4000,
      system: systemPrompt(rateBook),
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    });
  } catch (err) {
    throw new InboxError('Claude could not read that email.', {
      status: err.status === 429 ? 429 : 502,
      detail: err.message,
    });
  }

  // A safety refusal comes back as a normal response, not an error — so this
  // has to be checked before reading content, or it reads as an empty reply.
  if (res.stop_reason === 'refusal')
    throw new InboxError('Claude declined to read that email.', {
      status: 422,
      detail: (res.stop_details && res.stop_details.category) || null,
    });

  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InboxError('Claude returned something unreadable for that email.', {
      status: 502,
      detail: text.slice(0, 300),
    });
  }
  data._usage = res.usage || null;
  data._model = res.model || settings.model;
  return data;
}

// ---------------------------------------------------------------------------
// Turning an extraction into a priced draft
// ---------------------------------------------------------------------------

const round2 = (n) => Math.round(n * 100) / 100;

function draftFrom(extraction, email, rateBook) {
  const priceOf = Object.fromEntries(rateBook.services.map((s) => [s.key, s.price]));
  const items = [];
  for (const item of extraction.items || []) {
    const svc = byKey[item.service];
    if (!svc) continue;
    const qty = Number(item.qty);
    items.push({
      description: item.note ? `${serviceLabel(item.service)} — ${item.note}` : serviceLabel(item.service),
      qty: Number.isFinite(qty) && qty > 0 ? round2(qty) : 0,
      unit: svc.unit,
      unit_price: priceOf[item.service],
    });
  }
  const c = extraction.customer || {};
  return {
    customer: {
      name: c.name || email.from_name || '',
      // Fall back to the address it actually arrived from — that one is never
      // a guess, and it's what a reply would go to.
      email: c.email || email.from_email || '',
      phone: c.phone || '',
      address: c.address || '',
    },
    items,
    tax_rate: rateBook.tax_rate,
    notes: '',
  };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

async function acquireLock() {
  const cutoff = new Date(Date.now() - LOCK_MS);
  await store.settings.updateOne(
    { _id: SETTINGS_ID },
    { $setOnInsert: { created_at: new Date() } },
    { upsert: true }
  );
  const r = await store.settings.updateOne(
    { _id: SETTINGS_ID, $or: [{ scan_lock: null }, { scan_lock: { $lte: cutoff } }] },
    { $set: { scan_lock: new Date() } }
  );
  return r.matchedCount === 1;
}
const releaseLock = () => store.settings.updateOne({ _id: SETTINGS_ID }, { $unset: { scan_lock: '' } });

// Read the mailbox and file every new quote request as a lead. Safe to run
// repeatedly: a message already turned into a lead is never read twice, so the
// cost of an extra scan is one IMAP round trip.
async function scan({ trigger = 'manual', actor = null } = {}) {
  const doc = await loadDoc();
  const settings = settingsOf(doc);
  if (!hasApiKey()) throw new InboxError('ANTHROPIC_API_KEY is not set on the server.', { status: 409 });
  if (!settings.user) throw new InboxError('No mailbox is configured yet.', { status: 409 });
  if (!doc || !doc.password_enc)
    throw new InboxError('No mailbox password is saved yet.', { status: 409 });
  const password = decrypt(doc.password_enc);
  if (!password)
    throw new InboxError(
      'The saved mail password could not be read — enter it again.',
      { status: 409 }
    );

  if (!(await acquireLock()))
    throw new InboxError('A scan is already running. Try again in a minute.', { status: 409 });

  const rateBook = await getRateBook();
  const result = {
    trigger,
    actor,
    started_at: new Date(),
    considered: 0,
    leads: 0,
    not_quotes: 0,
    failed: 0,
    errors: [],
  };

  try {
    const stats = await withMailbox(settings, password, async (email) => {
      let extraction;
      try {
        extraction = await readEmail(email, settings, rateBook);
      } catch (err) {
        result.failed++;
        result.errors.push({ subject: email.subject, message: err.detail || err.message });
        return;
      }

      const isQuote = !!extraction.is_quote_request;
      const _id = await store.nextId('inbox_leads');
      const lead = {
        _id,
        message_id: email.message_id,
        uid: email.uid,
        folder: settings.folder,
        from_name: email.from_name,
        from_email: email.from_email,
        subject: email.subject,
        received_at: new Date(email.received_at),
        body: trimBody(email.body),
        // Emails that aren't quote requests are still recorded, so the same
        // message is never paid to be read a second time.
        status: isQuote ? 'new' : 'not_quote',
        ai: {
          is_quote_request: isQuote,
          confidence: extraction.confidence || 'low',
          reason: extraction.reason || '',
          summary: extraction.summary || '',
          missing: Array.isArray(extraction.missing) ? extraction.missing : [],
          model: extraction._model,
          usage: extraction._usage,
          scanned_at: new Date(),
        },
        draft: isQuote ? draftFrom(extraction, email, rateBook) : null,
        quote_id: null,
        created_at: new Date(),
      };
      try {
        await store.inboxLeads.insertOne(lead);
      } catch (err) {
        // A duplicate means a parallel scan filed it first — not an error.
        if (err.code !== 11000) throw err;
        return;
      }
      if (isQuote) result.leads++;
      else result.not_quotes++;
    });
    result.considered = stats.considered;
    result.mailbox_seen = stats.seen;
  } finally {
    await releaseLock();
  }

  result.finished_at = new Date();
  result.ok = result.failed === 0;
  await store.settings.updateOne({ _id: SETTINGS_ID }, { $set: { last_scan: result } }, { upsert: true });
  return result;
}

// Verify a mailbox login without reading or filing anything.
async function testConnection(patch) {
  const doc = await loadDoc();
  const settings = { ...settingsOf(doc), ...(patch || {}) };
  const password = patch && patch.password ? patch.password : decrypt(doc && doc.password_enc);
  if (!settings.user || !password)
    throw new InboxError('Enter the mailbox address and app password first.');

  const client = new ImapFlow({
    host: settings.host,
    port: Number(settings.port),
    secure: !!settings.secure,
    auth: { user: settings.user, pass: password },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });
  try {
    await client.connect();
    const box = await client.mailboxOpen(settings.folder, { readOnly: true });
    return { ok: true, folder: settings.folder, messages: box.exists };
  } catch (err) {
    throw new InboxError('Could not sign in to that mailbox.', { status: 502, detail: err.message });
  } finally {
    await client.logout().catch(() => {});
  }
}

// The scheduled scan. Silent when the agent is off or unconfigured, so a cron
// firing on a deployment that never set this up does nothing and says why.
async function runScheduledScan() {
  const doc = await loadDoc();
  const settings = settingsOf(doc);
  if (!settings.enabled) return { skipped: 'disabled' };
  if (!settings.auto_scan) return { skipped: 'auto_scan_off' };
  if (!hasApiKey()) return { skipped: 'no_api_key' };
  if (!settings.user || !doc.password_enc) return { skipped: 'not_configured' };
  return { ran: true, result: await scan({ trigger: 'cron' }) };
}

module.exports = {
  InboxError,
  ALLOWED_MODELS,
  getStatus,
  getSettings,
  saveSettings,
  testConnection,
  scan,
  runScheduledScan,
  draftFrom,
};
