// Page assets a browser can keep for a year without ever running stale code.
//
// Each page refers to its scripts, stylesheet and logo as /v/<hash>/<file>,
// where the hash is of the file's contents. A deploy that changes a file
// changes its address, so a copy saved under the old address is simply never
// asked for again — and a returning visit loads every script straight off the
// device instead of checking each one with the server first. The pages
// themselves are never cached like that: they are what points at the current
// addresses.
//
// Used by server.js (Render, a laptop, the admin page on Vercel) and by
// scripts/build-netlify.js (the static copy Netlify serves).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');
const VERSIONED = /\.(?:js|css|svg)$/;
const PREFIX = '/v/';

const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('base64url').slice(0, 10);

// name -> hash for every versioned file in `dir` (public/ is a flat folder).
// Remembered per file until its size or modified time changes, so a running
// development server picks up an edit on the next page load.
const known = new Map();
function hashes(dir = PUBLIC) {
  const out = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!VERSIONED.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!st.isFile()) continue;
    const hit = known.get(full);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      out.set(name, hit.hash);
      continue;
    }
    const hash = hashOf(fs.readFileSync(full));
    known.set(full, { mtimeMs: st.mtimeMs, size: st.size, hash });
    out.set(name, hash);
  }
  return out;
}

// A page's own references, pointed at their versioned addresses:
//   src="/portal.js"   href="/styles.css"   href="/logo.svg#hek"   import('/fence3d.js')
// Only root-relative references to files in the map change; links to other
// pages, the manifest, icons and other sites are left exactly as written.
function rewrite(html, map) {
  return html.replace(
    /(\b(?:src|href)=["']|\bimport\(\s*["'])\/([A-Za-z0-9._-]+)(?=[#?"'])/g,
    (whole, lead, name) => {
      const hash = map.get(name);
      return hash ? `${lead}${PREFIX}${hash}/${name}` : whole;
    }
  );
}

// The page at `file`, rewritten — kept until the page or any asset changes.
const pages = new Map();
function page(file, dir = PUBLIC) {
  const map = hashes(dir);
  const st = fs.statSync(file);
  const sig = st.mtimeMs + ':' + st.size + ':' + [...map].join(',');
  const hit = pages.get(file);
  if (hit && hit.sig === sig) return hit.html;
  const html = rewrite(fs.readFileSync(file, 'utf8'), map);
  pages.set(file, { sig, html });
  return html;
}

// "/v/<hash>/<name>" -> { name, hash }, or null for anything else.
function parse(urlPath) {
  const m = /^\/v\/([A-Za-z0-9_-]{6,16})\/([A-Za-z0-9._-]+)$/.exec(urlPath);
  return m && VERSIONED.test(m[2]) ? { hash: m[1], name: m[2] } : null;
}

module.exports = { PREFIX, VERSIONED, hashes, rewrite, page, parse };
