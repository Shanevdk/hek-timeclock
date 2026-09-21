// Netlify serverless function that runs the Express API.
// The static pages (employee clock-in + admin) are served by Netlify from the
// published "dist" folder; only /api/* is routed here (see netlify.toml).

const serverless = require('serverless-http');
const { app, connect } = require('../../server');

// A function's reply travels to Netlify as a string. Left to itself,
// serverless-http only base64-encodes gzip'd bodies and turns everything else
// into UTF-8 text — which silently wrecks any file that is not text. A PDF's
// header and page list survive the conversion, so the viewer opens it and
// shows its title, but the compressed image stream inside does not, and the
// page renders blank. Photos fail outright. So: anything that is not text
// or JSON goes out base64-encoded, as the bytes it actually is.
const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml|xhtml\+xml)|image\/svg\+xml)/i;
const isBinaryResponse = (headers) => {
  const type = String(headers['content-type'] || '').split(';')[0].trim();
  return !!type && !TEXT_TYPES.test(type);
};

const handler = serverless(app, { binary: isBinaryResponse });

exports.handler = async (event, context) => {
  // Don't wait for the (reused) Mongo connection pool to drain before returning.
  context.callbackWaitsForEmptyEventLoop = false;
  await connect(); // memoized — connects on cold start, reused when warm
  return handler(event, context);
};
