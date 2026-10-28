// Vercel serverless entry point — runs the Express app.
//
// Static assets (public/*) are served by Vercel directly; every other path is
// routed here by vercel.json and handled by the Express app.
//
// Failures are caught and answered as short JSON instead of Vercel's opaque
// "FUNCTION_INVOCATION_FAILED" page. The details (stack, driver message) go to
// the function log only: they name files, hosts and the reason a database
// login failed, which is nobody's business but whoever reads the logs.

// Load the app up front. If this throws (e.g. a file missing from the deployed
// bundle), remember the error so every request can report it clearly rather
// than crashing the function on import.
let app = null;
let connect = null;
let metrics = null;
let loadError = null;
try {
  ({ app, connect } = require('../server'));
  metrics = require('../metrics');
} catch (err) {
  loadError = err;
  console.error('App failed to load:', err);
}

function sendError(res, status, error) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error }));
}

module.exports = async (req, res) => {
  // The app itself failed to load. A setup mistake (e.g. SESSION_SECRET) is
  // ours to word and safe to show; anything else stays in the log.
  if (loadError)
    return sendError(
      res,
      500,
      loadError.code === 'CONFIG'
        ? loadError.message
        : 'The app failed to start on the server — see the function log for why.'
    );

  try {
    // Only the API needs the database; static and the admin page load without it,
    // so the site still comes up even if the database is unreachable. Compared
    // without regard to case, as Express routes are.
    if (/^\/api(\/|$)/i.test(req.url || '')) {
      try {
        await connect(); // memoized; a failed attempt is retried on the next call
      } catch (err) {
        console.error('Database connection failed:', err);
        return sendError(res, 503, 'The database is not reachable right now. Try again in a minute.');
      }
    }
    // Held open until the response is out and the request counts and error
    // records written after it have landed — the platform may freeze this
    // instance as soon as the handler settles.
    await new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      app(req, res);
    });
    await metrics.settle();
  } catch (err) {
    console.error('Unhandled request error:', err);
    return sendError(res, 500, 'Server error.');
  }
};
