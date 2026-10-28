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

  // The login email the server says this account has. The browser's saved copy
  // is only a quick first guess for the sidebar — it may be another person's on
  // a shared computer, or out of date — so the form is filled from this.
  let serverEmail = '';

  function display(email) {
    const who = (email || 'admin').trim();
    if ($('userEmail')) { $('userEmail').textContent = who; $('userEmail').title = who; }
    if ($('userAvatar')) $('userAvatar').textContent = (who[0] || 'A').toUpperCase();
  }

  function fillForm() {
    const box = $('acEmail');
    if (box && document.activeElement !== box) box.value = serverEmail;
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
          serverEmail = d.email;
          display(d.email);
          fillForm();
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
    const shown = () => menu.style.display !== 'none' && !menu.classList.contains('is-leaving');
    let leaving = null;
    // Out quicker than it came in (styles.css, .is-leaving), then gone.
    const close = () => {
      if (!shown()) return;
      gear.classList.remove('open');
      gear.setAttribute('aria-expanded', 'false');
      menu.classList.add('is-leaving');
      leaving = setTimeout(() => {
        menu.classList.remove('is-leaving');
        menu.style.display = 'none';
      }, 120);
    };
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      if (shown()) return close();
      // Reopened while still on its way out: turn it round where it is.
      clearTimeout(leaving);
      menu.classList.remove('is-leaving');
      menu.style.display = 'block';
      gear.classList.add('open');
      gear.setAttribute('aria-expanded', 'true');
    });
    // Clicks inside the menu keep it open; anywhere else closes it.
    document.addEventListener('click', (e) => {
      if (shown() && !menu.contains(e.target) && e.target !== gear) close();
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
      // Only what changed: an email sent unchanged has nothing to say, and one
      // filled in from somewhere stale must not quietly replace the real one.
      const payload = {};
      const typed = ($('acEmail').value || '').trim();
      if (typed && typed.toLowerCase() !== serverEmail.toLowerCase()) payload.email = typed;
      const pass = $('acPass').value;
      if (pass) payload.password = pass;
      if (!payload.email && !payload.password) {
        msg.textContent = 'Enter a new email or a new password.';
        return;
      }
      // Proves it's really you, not someone who found the dashboard left open.
      payload.current_password = $('acCurrent') ? $('acCurrent').value : '';
      if (!payload.current_password) {
        msg.textContent = 'Enter your current password to change your login.';
        if ($('acCurrent')) $('acCurrent').focus();
        return;
      }
      // The last answer doesn't linger beside a new attempt.
      msg.textContent = '';
      try {
        // Busy at once, so a second press can't send it twice; a spinner only
        // if the server takes a moment (snappy.js).
        const d = await Snappy.busy(acSave, () =>
          api('/api/admin/credentials', { method: 'PATCH', body: JSON.stringify(payload) })
        );
        $('acPass').value = '';
        if ($('acCurrent')) $('acCurrent').value = '';
        // The copies this browser keeps for a quick next visit are filed under
        // the login's email. A new one would make the next visit open on them,
        // see a different account, and reload — so start them over now.
        if (payload.email && window.Snappy) Snappy.cache.clear();
        try { localStorage.setItem(EMAIL_KEY, d.email); } catch (e) {}
        serverEmail = d.email;
        display(d.email);
        fillForm();
        msg.className = 'msg ok';
        msg.textContent = 'Saved ✓ — use this to sign in next time.';
      } catch (e) {
        msg.textContent = e.message;
      }
    });
  }

})();
