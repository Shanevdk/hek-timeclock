// Scheduled function: pushes a finished pay period's hours into QuickBooks.
//
// Netlify runs this on the cron in netlify.toml. It is the Netlify counterpart
// to the "crons" entry in vercel.json — only whichever host the site is
// actually deployed on will ever run.
//
// Unlike the HTTP route (/api/cron/quickbooks-sync) this runs inside Netlify's
// own scheduler, so there is no request to authenticate and no CRON_SECRET
// needed here. The work itself decides whether anything is due: a period that
// has already been pushed is skipped, so an extra run costs nothing.

const { connect } = require('../../server');
const qbo = require('../../quickbooks');

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    await connect();
    // Scheduled functions stop at 30 s; the sync stops between batches well
    // before that and finishes on the next run. (It also checks the client's
    // QuickBooks switch itself.)
    const result = await qbo.runScheduledSync({ budgetMs: 20000 });
    // Counts only: the full result lists people and their hours.
    const r = result.result || {};
    const summary = {
      ran: !!result.ran,
      skipped: result.skipped || null,
      period: result.period || null,
      error: result.error || null,
      created: r.created,
      updated: r.updated,
      deleted: r.deleted,
      failed: r.failed,
      incomplete: !!r.incomplete,
    };
    console.log('QuickBooks scheduled sync:', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    // Logged rather than thrown so Netlify records a clear reason instead of a
    // bare stack, and so a bad pay period doesn't retry in a loop.
    console.error('QuickBooks scheduled sync failed:', err.message, err.detail || '');
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
