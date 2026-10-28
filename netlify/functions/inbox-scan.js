// Scheduled function: reads the mailbox and files any new quote requests.
//
// Netlify runs this on the cron in netlify.toml. It is the Netlify counterpart
// to the "crons" entry in vercel.json — only whichever host the site is
// actually deployed on will ever run.
//
// The work decides for itself whether anything is due: the agent does nothing
// when it is switched off or unconfigured, and an email it has already read is
// never read (or paid for) a second time. An extra run costs one IMAP round
// trip.

const { connect } = require('../../server');
const { store } = require('../../db');
const inbox = require('../../inbox');

// Netlify stops a scheduled function at 30 seconds. The scan gets most of
// that and stops starting new emails in time to write down what it did; the
// rest waits for the next run.
const BUDGET_MS = 22 * 1000;

// Counts only. A scan's result also carries subjects and error text from
// customers' email, which have no business in a log.
function summary(r) {
  if (!r.ran) return { skipped: r.skipped };
  const s = r.result;
  return {
    ran: true,
    ok: s.ok,
    read: s.considered,
    leads: s.leads,
    not_quotes: s.not_quotes,
    skipped: s.skipped,
    failed: s.failed,
    remaining: s.remaining,
  };
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    await connect();
    // The dev account can switch the inbox off for the client (the
    // "entitlements" settings in server.js). The API enforces that on its own
    // routes; this runs outside them, so it reads the switch itself — fresh,
    // as a warm function would otherwise keep an old answer.
    const ent = await store.settings.findOne({ _id: 'entitlements' });
    if (ent && ent.features && ent.features.inbox === false) {
      console.log('Inbox scan: inbox feature is switched off');
      return { statusCode: 200, body: JSON.stringify({ skipped: 'feature_off' }) };
    }
    const result = summary(await inbox.runScheduledScan({ budgetMs: BUDGET_MS }));
    console.log('Inbox scan:', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    // Logged rather than thrown so Netlify records a readable reason and a bad
    // mailbox doesn't retry in a loop. The scan's own errors are worded for
    // the dashboard; anything else is logged by its stack, not its contents.
    if (err instanceof inbox.InboxError)
      console.error('Inbox scan failed:', err.message, err.detail || '');
    else console.error('Inbox scan failed:', err.stack || err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
