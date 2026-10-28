// Assembles the static "dist" folder that Netlify publishes:
//   - everything in public/  (login/portal page, assets)
//   - the admin page, copied to  <ADMIN_PATH>.html  (default /admin). Netlify
//     serves "/admin" for "admin.html" automatically. Admins reach it by
//     signing in on the main page, which redirects there.
//   - a second copy of every script, stylesheet and the logo at
//     /v/<content hash>/<file>, which the pages are rewritten to use, and a
//     _headers file letting browsers keep those for a year (see assets.js).

const fs = require('fs');
const path = require('path');
const assets = require('../assets');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const publicDir = path.join(root, 'public');

// Fresh dist folder.
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// Copy public/ (flat set of files).
for (const entry of fs.readdirSync(publicDir, { withFileTypes: true })) {
  if (entry.isFile()) {
    fs.copyFileSync(path.join(publicDir, entry.name), path.join(dist, entry.name));
  }
}

// Admin page at its path (default /admin).
const adminSlug =
  (process.env.ADMIN_PATH || '/admin').replace(/^\//, '').replace(/[^a-zA-Z0-9_-]/g, '') ||
  'admin';
fs.copyFileSync(path.join(root, 'views', 'admin.html'), path.join(dist, adminSlug + '.html'));

// Versioned copies. The plain copies above stay too, for anything that still
// asks for /portal.js by name; only the hashed ones are kept for a year.
const hashes = assets.hashes(publicDir);
for (const [name, hash] of hashes) {
  const dir = path.join(dist, 'v', hash);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(publicDir, name), path.join(dir, name));
}
for (const name of fs.readdirSync(dist)) {
  if (!name.endsWith('.html')) continue;
  const file = path.join(dist, name);
  fs.writeFileSync(file, assets.rewrite(fs.readFileSync(file, 'utf8'), hashes));
}
// Netlify reads response headers from this file. The pages keep Netlify's
// default (checked on every visit), which is what makes the year safe.
fs.writeFileSync(
  path.join(dist, '_headers'),
  ['/v/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n')
);

console.log(
  `Built dist/. Employee page at "/", admin page at "/${adminSlug}", ` +
    `${hashes.size} assets at /v/<hash>/.`
);
