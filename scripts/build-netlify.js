// Assembles the static "dist" folder that Netlify publishes:
//   - everything in public/  (login/portal page, assets)
//   - the admin page, copied to  <ADMIN_PATH>.html  (default /admin). Netlify
//     serves "/admin" for "admin.html" automatically. Admins reach it by
//     signing in on the main page, which redirects there.

const fs = require('fs');
const path = require('path');

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

console.log(`Built dist/. Employee page at "/", admin page at "/${adminSlug}".`);
