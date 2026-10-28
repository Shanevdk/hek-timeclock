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
const { getRateBook } = require('./ratebook');

const SETTINGS_ID = 'inbox';
// Claude Opus 5 reads a rambling customer email far better than a cheaper
// model, and the whole point is fewer drafts to correct by hand. Swappable in
// the dashboard once the real monthly cost is visible.
const DEFAULT_MODEL = 'claude-opus-5';
const ALLOWED_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
// Emails are read, not written, so a long one costs input tokens only. Trimming
// keeps a forwarded thread with 40 quoted replies from costing real money.
const MAX_BODY_CHARS = 6000;
// A subject line or sender name is untrusted input, stored and shown as is.
const MAX_HEADER_CHARS = 300;
// A serverless host stops a function at a fixed limit (60 s on Vercel here,
// 30 s for a Netlify scheduled function). Stopped mid-scan, it loses the model
// call it was paying for and never writes down what it did. So a scan works to
// a budget: it stops starting new emails while there is still time to finish
// the one in hand, and leaves the rest for the next run.
const DEFAULT_BUDGET_MS = 45 * 1000;
const MAX_BUDGET_MS = 2 * 60 * 1000;
const MIN_LEFT_MS = 15 * 1000;
// Longer than any scan's budget, so only a scan that died holds it this long.
const LOCK_MS = 3 * 60 * 1000;
// An email that keeps failing is tried on this many scans, then left for a
// person to read.
const MAX_ATTEMPTS = 3;
// Skipped mail costs a download and a database write, not a model call, so a
// scan files more of it than it reads.
const MAX_SKIPPED_PER_SCAN = 25;

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

// The parts of the settings that say which server the password is sent to.
const SERVER_KEYS = ['host', 'port', 'secure', 'user'];
const sameServer = (a, b) =>
  String(a.host || '').trim().toLowerCase() === String(b.host || '').trim().toLowerCase() &&
  Number(a.port) === Number(b.port) &&
  !!a.secure === !!b.secure &&
  String(a.user || '').trim().toLowerCase() === String(b.user || '').trim().toLowerCase();

async function saveSettings(patch) {
  const before = settingsOf(await loadDoc());
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
  // The saved password belongs to the server it was entered for. Pointing the
  // agent at a different host, port, security mode or mailbox without typing it
  // again forgets it — otherwise anyone who can edit these settings could send
  // the company's mail password to a server of their choosing, without ever
  // having been told it.
  if (!patch.password && !sameServer(before, { ...before, ...set })) set.password_enc = null;

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
  const saved = !!(doc && doc.password_enc);
  // A saved password that no longer decrypts (the server's key changed) is as
  // good as none, and has to be shown that way.
  const hasPassword = saved && !!decrypt(doc.password_enc);
  const needs = [];
  if (!hasApiKey()) needs.push('Set ANTHROPIC_API_KEY on the server so the agent can read email.');
  if (!settings.user) needs.push('Enter the mailbox address to watch.');
  if (!saved) needs.push('Enter the mailbox app password.');
  else if (!hasPassword) needs.push("The saved mail password can't be read — enter it again.");
  if (!settings.enabled) needs.push('Switch the agent on.');

  const counts = { new: 0, approved: 0, dismissed: 0, not_quote: 0, skipped: 0, failed: 0 };
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
    // A last_scan with no finished_at is either still running or was cut off
    // by the server; the lock tells the two apart.
    scanning: !!(doc && doc.scan_lock && new Date(doc.scan_lock) > Date.now() - LOCK_MS),
    needs,
  };
}

// ---------------------------------------------------------------------------
// Reading the mailbox
// ---------------------------------------------------------------------------

// Bulk mail is the bulk of any inbox and almost none of it is a quote request,
// so the model never reads it. It is still filed, as "skipped" with this
// reason, because of the "almost": a customer writing through a Google Group,
// or a website form that sends from a no-reply address, must not just vanish.
function bulkReason(envelope, headers) {
  const from = ((envelope.from && envelope.from[0] && envelope.from[0].address) || '').toLowerCase();
  if (/^(no-?reply|do-?not-?reply)@/.test(from)) return 'Sent from a no-reply address';
  if (/^(bounce|mailer-daemon|postmaster|notifications?)@/.test(from)) return 'Sent by an automated sender';
  if (headers && headers.has('list-id')) return 'Sent through a mailing list';
  if (headers && headers.has('list-unsubscribe')) return 'A newsletter or mailing (it has an unsubscribe link)';
  const precedence = headers && headers.get('precedence');
  if (precedence && /bulk|junk|list/i.test(precedence)) return 'Marked as bulk mail';
  return null;
}

// Everything a scan needs from the mailbox, in one short session: which
// messages are new, and the text of each. It is all downloaded, and the
// session logged out, before the model sees a word — so a slow model call
// can't time out the mail connection, and a scan that runs out of time leaves
// nothing open. Newest first throughout, so a capped or cut-short scan reads
// the most recent mail and the rest waits for the next one.
async function fetchNewMail(settings, password, deadline) {
  // A wedged connection must not hold a serverless function open until it is
  // killed with no explanation.
  const client = new ImapFlow(imapOptions(settings, password, { socketTimeout: 60000, greetingTimeout: 15000 }));
  client.on('error', (err) => console.error('inbox: mailbox connection error:', err.message));
  // And no mail server, however slow, gets more than the scan's budget.
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    client.close();
  }, Math.max(0, deadline - Date.now()));
  let cut = false;

  try {
    try {
      await client.connect();
    } catch (err) {
      throw new InboxError('Could not sign in to the mailbox.', { status: 502, detail: err.message });
    }

    let lock;
    try {
      lock = await client.getMailboxLock(settings.folder);
    } catch (err) {
      throw new InboxError(`Could not open the "${settings.folder}" folder.`, {
        status: 502,
        detail: err.message,
      });
    }

    try {
      const since = new Date(Date.now() - settings.lookback_days * 86400000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      if (!uids.length) return { seen: 0, emails: [], waiting: 0 };

      // Pass one: envelopes only, to find what we haven't seen before.
      const candidates = [];
      for await (const msg of client.fetch(uids, { envelope: true, headers: true }, { uid: true })) {
        const envelope = msg.envelope || {};
        candidates.push({
          uid: msg.uid,
          message_id: envelope.messageId || `uid:${settings.folder}:${msg.uid}`,
          envelope,
          bulk: bulkReason(envelope, msg.headers ? parseHeaders(msg.headers) : null),
        });
      }
      // The server answers in its own order. Newest (highest UID) first is ours.
      candidates.sort((a, b) => b.uid - a.uid);

      const prior = new Map(
        (
          await store.inboxLeads
            .find(
              { message_id: { $in: candidates.map((c) => c.message_id) } },
              { projection: { message_id: 1, status: 1, attempts: 1 } }
            )
            .toArray()
        ).map((d) => [d.message_id, d])
      );
      const read = [];
      const skip = [];
      const picked = new Set();
      for (const c of candidates) {
        // The same message twice in one folder is still one message.
        if (picked.has(c.message_id)) continue;
        // Already filed — unless it failed and has tries left.
        const lead = prior.get(c.message_id);
        if (lead && !(lead.status === 'failed' && (lead.attempts || 0) < MAX_ATTEMPTS)) continue;
        picked.add(c.message_id);
        if (lead) Object.assign(c, { lead_id: lead._id, attempts: lead.attempts || 0 });
        (c.bulk ? skip : read).push(c);
      }
      const wanted = new Map(
        [...read.slice(0, settings.max_per_scan), ...skip.slice(0, MAX_SKIPPED_PER_SCAN)].map((c) => [c.uid, c])
      );

      // Pass two: full messages, only for the ones this scan will file.
      const emails = [];
      if (wanted.size)
        for await (const msg of client.fetch([...wanted.keys()], { source: true }, { uid: true })) {
          const meta = wanted.get(msg.uid);
          if (meta) emails.push(await openMessage(meta, msg.source));
          // No time left to read any more of it: the rest waits for the next scan.
          if (deadline - Date.now() < MIN_LEFT_MS) {
            cut = true;
            break;
          }
        }
      emails.sort((a, b) => b.uid - a.uid);
      return { seen: uids.length, emails, waiting: read.length };
    } finally {
      lock.release();
    }
  } catch (err) {
    if (timedOut)
      throw new InboxError('The mail server took too long to answer.', {
        status: 504,
        detail: err.detail || err.message,
      });
    throw err;
  } finally {
    // A download cut short leaves the server still sending: hang up rather
    // than wait for it to finish.
    if (cut) client.close();
    else await client.logout().catch(() => {});
    clearTimeout(watchdog);
  }
}

// One downloaded message, cut down to what a lead keeps. The raw source and
// any attachments are dropped here, so a scan holds text, not photos.
async function openMessage(meta, source) {
  const env = meta.envelope;
  const sender = (env.from && env.from[0]) || {};
  const email = {
    uid: meta.uid,
    message_id: meta.message_id,
    bulk: meta.bulk,
    lead_id: meta.lead_id,
    attempts: meta.attempts,
    // The envelope's version, until the message itself says otherwise.
    subject: clip(env.subject || '(no subject)', MAX_HEADER_CHARS),
    from_name: clip(sender.name, MAX_HEADER_CHARS),
    from_email: clip(sender.address, MAX_HEADER_CHARS),
    // ImapFlow hands back the raw text of a date it couldn't read.
    received_at: env.date instanceof Date ? env.date : new Date(),
    body: '',
  };
  let parsed;
  try {
    // Inline images stay "cid:" links rather than becoming megabytes of
    // base64 in the HTML, which is read here for its text and nothing else.
    parsed = await simpleParser(source, { skipImageLinks: true });
  } catch (err) {
    console.error('inbox: could not parse message', meta.uid, err.message);
    return { ...email, parse_error: err.message };
  }
  const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
  return {
    ...email,
    subject: clip(parsed.subject || '(no subject)', MAX_HEADER_CHARS),
    from_name: clip(from.name, MAX_HEADER_CHARS),
    from_email: clip(from.address, MAX_HEADER_CHARS),
    received_at: parsed.date || email.received_at,
    body: trimBody((parsed.text || stripHtml(parsed.html || '') || '').trim()),
  };
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

// HTML mail as plain text. An email is untrusted input, so this has to stay
// linear in its length: patterns that backtrack on an unterminated tag take
// time that grows with the square of it, and one large email could stall the
// server for minutes. So the HTML is capped first, <script>/<style> blocks are
// found by scanning forward instead of by a lazy match that rescans the rest
// of the message from every opening tag, and the tag pattern can't run past
// the next "<".
const MAX_HTML_CHARS = 200 * 1000;
const BLOCK_END = { script: /<\/script[^<>]*>/gi, style: /<\/style[^<>]*>/gi };

function stripHtml(html) {
  const s = String(html).slice(0, MAX_HTML_CHARS);
  const open = /<(script|style)\b/gi;
  let text = '';
  let from = 0;
  for (let m = open.exec(s); m; m = open.exec(s)) {
    text += s.slice(from, m.index) + ' ';
    const end = BLOCK_END[m[1].toLowerCase()];
    end.lastIndex = open.lastIndex;
    // An unterminated block drops the rest.
    from = end.exec(s) ? end.lastIndex : s.length;
    open.lastIndex = from;
  }
  text += s.slice(from);
  return (
    text
      .replace(/<[^<>]*>/g, ' ')
      // A tag left open at the end (cut by the cap, or never closed) goes too.
      .replace(/<[a-z!/?][^<>]*$/i, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      // Last, so "&amp;lt;" comes out as "&lt;" and not "<".
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
  );
}

// Cut text to a length without leaving half of a character (an emoji, say) at
// the cut — a lone surrogate can make the API reject the whole request.
function clip(v, max) {
  const s = String(v == null ? '' : v).slice(0, max);
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

// A forwarded thread is mostly quoted history. The request is nearly always at
// the top, so trim from the end and note that we did.
function trimBody(text) {
  const clean = String(text || '').replace(/\r/g, '');
  if (clean.length <= MAX_BODY_CHARS) return clean;
  return clip(clean, MAX_BODY_CHARS) + '\n\n[…email truncated for length…]';
}

// ---------------------------------------------------------------------------
// Reading the email with Claude
// ---------------------------------------------------------------------------

// The services the office quotes today: the live rate book, so a renamed or
// re-united built-in, a hidden one and the admin's own additions all come
// through the way the Pricing tab shows them.
const visibleServices = (rateBook) =>
  ((rateBook && rateBook.services) || []).filter((s) => s && s.key && !s.hidden);

function extractionSchema(keys) {
  return {
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
            // An empty rate book would be an empty enum, which no answer can
            // satisfy; draftFrom drops any key the book doesn't have anyway.
            service: keys.length ? { type: 'string', enum: keys } : { type: 'string' },
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
}

function systemPrompt(services) {
  const menu = services.map((s) => `  ${s.key} — ${s.label} (per ${s.unit})`).join('\n');
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
  // The SDK's defaults (a 10-minute timeout, two retries) outlive any
  // serverless function. One retry covers a blip.
  if (!_client) _client = new Anthropic({ timeout: 20000, maxRetries: 1 });
  return _client;
}

// What a failed call means for the scan. A slow answer, or a request Claude
// turned down (a 4xx), may be down to the email itself, so it counts against
// that email. A 4xx also stops the scan: it can just as well be the account
// (out of credit), and would then fail every email after it. Anything else —
// a bad key, a missing model, rate limits, an outage — is Claude being
// unavailable: the scan stops and no email is blamed.
function claudeError(err) {
  if (err instanceof Anthropic.APIUserAbortError || err instanceof Anthropic.APIConnectionTimeoutError)
    return new InboxError('Claude took too long to read that email.', { status: 504, detail: err.message });
  const status = err && err.status;
  const rejected = status >= 400 && status < 500 && ![401, 403, 404, 429].includes(status);
  const e = new InboxError(rejected ? 'Claude could not read that email.' : 'Claude is not available right now.', {
    status: status === 429 ? 429 : 502,
    detail: err && err.message,
  });
  e.stop = true;
  e.strike = rejected;
  return e;
}

// Ask Claude to read one email. Returns the parsed extraction, or throws.
async function readEmail(email, settings, rateBook, deadline) {
  const client = anthropic();
  const services = visibleServices(rateBook);
  const content = [
    `From: ${email.from_name} <${email.from_email}>`,
    `Subject: ${email.subject}`,
    `Date: ${new Date(email.received_at).toISOString()}`,
    '',
    trimBody(email.body),
  ].join('\n');

  let res;
  try {
    res = await client.messages.create(
      {
        model: settings.model,
        max_tokens: 4000,
        system: systemPrompt(services),
        messages: [{ role: 'user', content }],
        output_config: {
          format: { type: 'json_schema', schema: extractionSchema(services.map((s) => s.key)) },
        },
      },
      // Never past the scan's budget, retry included.
      { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }
    );
  } catch (err) {
    throw claudeError(err);
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

// Label, unit and price all come from the same live entry, so a line can't
// pair today's price with yesterday's unit. A key that isn't in the book any
// more is dropped rather than drafted with no price.
function draftFrom(extraction, email, rateBook) {
  const book = Object.fromEntries(visibleServices(rateBook).map((s) => [s.key, s]));
  const items = [];
  for (const item of extraction.items || []) {
    const svc = book[item.service];
    if (!svc) continue;
    // Worded the way ratebook.js's serviceLabel words a quote line.
    const label = svc.install ? `${svc.label} — supply & install` : svc.label;
    const qty = Number(item.qty);
    items.push({
      description: item.note ? `${label} — ${item.note}` : label,
      qty: Number.isFinite(qty) && qty > 0 ? round2(qty) : 0,
      unit: svc.unit,
      unit_price: svc.price,
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

const saveLastScan = (last) =>
  store.settings.updateOne({ _id: SETTINGS_ID }, { $set: { last_scan: last } }, { upsert: true });

// The parts of a lead that come straight from the email.
const leadOf = (email, settings) => ({
  message_id: email.message_id,
  uid: email.uid,
  folder: settings.folder,
  from_name: email.from_name,
  from_email: email.from_email,
  subject: email.subject,
  received_at: new Date(email.received_at),
  body: email.body,
});

const readLead = (email, settings, extraction, rateBook) => {
  const isQuote = !!extraction.is_quote_request;
  return {
    ...leadOf(email, settings),
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
  };
};

// Bulk mail (see bulkReason), filed without the model reading it.
const skippedLead = (email, settings) => ({
  ...leadOf(email, settings),
  status: 'skipped',
  ai: { reason: `${email.bulk}, so the agent didn't read it.`, scanned_at: new Date() },
  draft: null,
});

// An email the scan couldn't read. Filed straight away so it shows, and read
// again by later scans until MAX_ATTEMPTS; after that it's left for a person.
function failedLead(email, settings, err) {
  const attempts = (email.attempts || 0) + 1;
  const why = clip(err.detail ? `${err.message} (${err.detail})` : err.message, 500);
  return {
    ...leadOf(email, settings),
    status: 'failed',
    attempts,
    ai: {
      reason:
        attempts < MAX_ATTEMPTS
          ? `The agent couldn't read this (try ${attempts} of ${MAX_ATTEMPTS}): ${why} The next scan tries again.`
          : `The agent couldn't read this after ${MAX_ATTEMPTS} tries: ${why}`,
      scanned_at: new Date(),
    },
    draft: null,
  };
}

// File what a scan made of one email: a new lead, or the same lead again for
// one that failed before. False when there was nothing to file it over.
async function fileLead(email, fields) {
  if (email.lead_id) {
    // Only while it's still waiting on a retry — someone may have approved or
    // dismissed it since.
    const r = await store.inboxLeads.updateOne({ _id: email.lead_id, status: 'failed' }, { $set: fields });
    return r.matchedCount === 1;
  }
  try {
    const _id = await store.nextId('inbox_leads');
    await store.inboxLeads.insertOne({ _id, ...fields, quote_id: null, created_at: new Date() });
    return true;
  } catch (err) {
    // A duplicate means a parallel scan filed it first — not an error.
    if (err.code !== 11000) throw err;
    return false;
  }
}

// Read the mailbox and file every new message as a lead. Safe to run
// repeatedly: a message once filed is not read again (one that failed gets
// MAX_ATTEMPTS tries), so the cost of an extra scan is one IMAP round trip.
//
// `budgetMs` is how long the scan may take from start to finish (see
// DEFAULT_BUDGET_MS); a host with a shorter limit passes a smaller one.
// Whatever the scan gets through is filed and written down, and the rest
// waits for the next scan.
async function scan({ trigger = 'manual', actor = null, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + Math.min(Number(budgetMs) || DEFAULT_BUDGET_MS, MAX_BUDGET_MS);
  const doc = await loadDoc();
  const settings = settingsOf(doc);
  if (!hasApiKey()) throw new InboxError('ANTHROPIC_API_KEY is not set on the server.', { status: 409 });
  if (!settings.user) throw new InboxError('No mailbox is configured yet.', { status: 409 });
  if (!doc || !doc.password_enc)
    throw new InboxError('No mailbox password is saved yet.', { status: 409 });
  if (!settings.enabled) throw new InboxError('Switch the agent on first.', { status: 409 });

  if (!(await acquireLock()))
    throw new InboxError('A scan is already running. Try again in a minute.', { status: 409 });

  const result = {
    trigger,
    actor,
    started_at: startedAt,
    considered: 0,
    leads: 0,
    not_quotes: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
    errors: [],
  };
  let mail = null;

  // From here on, every way out is written down. The start goes in first, so a
  // scan the server kills still shows up — as one that never finished.
  try {
    await saveLastScan({ trigger, actor, started_at: startedAt });
    const password = decrypt(doc.password_enc);
    if (!password)
      throw new InboxError('The saved mail password could not be read — enter it again.', { status: 409 });
    const rateBook = await getRateBook();
    mail = await fetchNewMail(settings, password, deadline);
    result.mailbox_seen = mail.seen;

    for (const email of mail.emails.filter((e) => e.bulk))
      if (await fileLead(email, skippedLead(email, settings))) result.skipped++;

    for (const email of mail.emails.filter((e) => !e.bulk)) {
      if (deadline - Date.now() < MIN_LEFT_MS) break;
      result.considered++;
      try {
        if (email.parse_error)
          throw new InboxError('That email could not be opened.', { detail: email.parse_error });
        const extraction = await readEmail(email, settings, rateBook, deadline);
        if (await fileLead(email, readLead(email, settings, extraction, rateBook))) {
          if (extraction.is_quote_request) result.leads++;
          else result.not_quotes++;
        }
      } catch (err) {
        if (!(err instanceof InboxError)) throw err;
        result.errors.push({
          subject: email.subject,
          message: err.detail ? `${err.message} ${err.detail}` : err.message,
        });
        if (err.strike !== false) {
          result.failed++;
          await fileLead(email, failedLead(email, settings, err));
        }
        // Not down to this email: the rest wait for the next scan.
        if (err.stop) throw err;
      }
    }
    result.ok = result.failed === 0;
  } catch (err) {
    result.ok = false;
    result.error = err instanceof InboxError ? err.message : 'The scan stopped on a server error.';
    result.detail = (err instanceof InboxError ? err.detail : err.message) || null;
    throw err;
  } finally {
    if (mail) result.remaining = Math.max(0, mail.waiting - result.considered);
    result.finished_at = new Date();
    await saveLastScan(result).catch((e) => console.error('inbox: could not record the scan:', e.message));
    await releaseLock().catch((e) => console.error('inbox: could not release the scan lock:', e.message));
  }
  return result;
}

// The connection options for a mailbox. Never in the clear: without implicit
// TLS ("secure") the session must upgrade with STARTTLS before the password
// is sent, or the connection fails.
const imapOptions = (settings, password, timeouts) => ({
  host: settings.host,
  port: Number(settings.port),
  secure: !!settings.secure,
  ...(settings.secure ? {} : { doSTARTTLS: true }),
  auth: { user: settings.user, pass: password },
  logger: false,
  ...timeouts,
});

// Verify a mailbox login without reading or filing anything.
async function testConnection(patch) {
  const doc = await loadDoc();
  const saved = settingsOf(doc);
  const p = patch || {};
  // Only the connection fields can be tried out here.
  const settings = { ...saved };
  for (const k of [...SERVER_KEYS, 'folder']) if (p[k] != null && p[k] !== '') settings[k] = p[k];
  // The saved password is only ever sent to the server it was saved for. To
  // try a different one, type the password in.
  let password = p.password ? String(p.password) : null;
  if (!password) {
    if (!sameServer(saved, settings))
      throw new InboxError('Enter the app password to test a different mail server.');
    password = decrypt(doc && doc.password_enc);
  }
  if (!settings.user || !password)
    throw new InboxError('Enter the mailbox address and app password first.');

  const client = new ImapFlow(imapOptions(settings, password, { socketTimeout: 30000, greetingTimeout: 15000 }));
  // A socket error after connecting is emitted, not thrown; unheard, it would
  // crash the process.
  client.on('error', (err) => console.error('inbox: mailbox connection error:', err.message));
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
// `budgetMs` goes to scan(), for a host with a shorter limit.
async function runScheduledScan({ budgetMs } = {}) {
  const doc = await loadDoc();
  const settings = settingsOf(doc);
  if (!settings.enabled) return { skipped: 'disabled' };
  if (!settings.auto_scan) return { skipped: 'auto_scan_off' };
  if (!hasApiKey()) return { skipped: 'no_api_key' };
  if (!settings.user || !doc.password_enc) return { skipped: 'not_configured' };
  return { ran: true, result: await scan({ trigger: 'cron', budgetMs }) };
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
