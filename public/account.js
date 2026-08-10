// Signed-in user + settings gear for the admin sidebar. Self-contained so it
// doesn't touch admin.js. Shows who is signed in (email + initial avatar) and
// opens a small menu with the theme switch, a "change admin login" form (email
// + password, stored in MongoDB), and Sign out.
(function () {
  const $ = (id) => document.getElementById(id);
  const EMAIL_KEY = 'hek-admin-email';

  async function api(path, opts) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...(opts || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function display(email) {
    const who = (email || 'admin').trim();
    if ($('userEmail')) { $('userEmail').textContent = who; $('userEmail').title = who; }
    if ($('userAvatar')) $('userAvatar').textContent = (who[0] || 'A').toUpperCase();
    if ($('acEmail') && !$('acEmail').value) $('acEmail').value = email && email !== 'admin' ? email : '';
  }

  // Show a quick value from what we already know, then confirm with the server.
  function setUser() {
    let saved = '';
    try { saved = localStorage.getItem(EMAIL_KEY) || ''; } catch (e) {}
    const typed = $('email') && $('email').value ? $('email').value.trim() : '';
    display(typed || saved);
    api('/api/admin/me')
      .then((d) => {
        if (d.admin && d.email) {
          try { localStorage.setItem(EMAIL_KEY, d.email); } catch (e) {}
          display(d.email);
        }
      })
      .catch(() => {});
  }

  // The dashboard flips #app from display:none to block when signed in.
  const app = $('app');
  if (app) {
    new MutationObserver(() => {
      if (app.style.display !== 'none') setUser();
    }).observe(app, { attributes: true, attributeFilter: ['style'] });
    if (app.style.display !== 'none') setUser();
  }

  // ---- settings gear menu ----
  const gear = $('settingsGear');
  const menu = $('settingsMenu');
  if (gear && menu) {
    const close = () => {
      menu.style.display = 'none';
      gear.classList.remove('open');
      gear.setAttribute('aria-expanded', 'false');
    };
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.style.display !== 'none') return close();
      menu.style.display = 'block';
      gear.classList.add('open');
      gear.setAttribute('aria-expanded', 'true');
    });
    // Clicks inside the menu keep it open; anywhere else closes it.
    document.addEventListener('click', (e) => {
      if (menu.style.display !== 'none' && !menu.contains(e.target) && e.target !== gear) close();
    });
    const logout = $('logoutBtn');
    if (logout) logout.addEventListener('click', close);
  }

  // ---- change admin login (email + password -> MongoDB) ----
  const acSave = $('acSave');
  if (acSave) {
    acSave.addEventListener('click', async () => {
      const msg = $('acMsg');
      msg.className = 'msg err';
      const payload = { email: ($('acEmail').value || '').trim() };
      const pass = $('acPass').value;
      if (pass) payload.password = pass;
      try {
        const d = await api('/api/admin/credentials', { method: 'PATCH', body: JSON.stringify(payload) });
        $('acPass').value = '';
        try { localStorage.setItem(EMAIL_KEY, d.email); } catch (e) {}
        display(d.email);
        msg.className = 'msg ok';
        msg.textContent = 'Saved ✓ — use this to sign in next time.';
      } catch (e) {
        msg.textContent = e.message;
      }
    });
  }

})();
