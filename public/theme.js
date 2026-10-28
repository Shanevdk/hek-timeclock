// Light / dark / system theme control. The saved choice is applied before first
// paint by a tiny inline script in each page's <head>; this file wires up the
// toggle buttons and keeps the browser chrome colour in sync.
(function () {
  const KEY = 'hek-theme';
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="theme-color"]');
  const BG = { light: '#f4f2ee', dark: '#0c0a09' };
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const stored = () => {
    try {
      return localStorage.getItem(KEY) || 'system';
    } catch (e) {
      return 'system';
    }
  };
  const effective = (t) => (t === 'system' ? (media.matches ? 'dark' : 'light') : t);

  function apply(theme) {
    root.dataset.theme = theme;
    if (meta) meta.setAttribute('content', BG[effective(theme)]);
    document.querySelectorAll('.theme-toggle [data-theme-choice]').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeChoice === theme);
    });
  }

  // Keep up with the OS setting while in "system" mode.
  media.addEventListener('change', () => {
    if (stored() === 'system') apply('system');
  });

  function init() {
    apply(stored());
    document.querySelectorAll('.theme-toggle').forEach((tg) => {
      tg.addEventListener('click', (e) => {
        const b = e.target.closest('[data-theme-choice]');
        if (!b) return;
        const theme = b.dataset.themeChoice;
        try {
          localStorage.setItem(KEY, theme);
        } catch (err) {
          /* private mode — theme still applies for this session */
        }
        apply(theme);
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
