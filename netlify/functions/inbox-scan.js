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
const inbox = require('../../inbox');

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    await connect();
    const result = await inbox.runScheduledScan();
    console.log('Inbox scan:', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    // Logged rather than thrown so Netlify records a readable reason and a bad
    // mailbox doesn't retry in a loop.
    console.error('Inbox scan failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
