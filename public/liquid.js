// The liquid glass dial.
//
// One number, 0 to 100, written onto <html> as --liquid (0 to 1). Every glass
// token in styles.css is a calc() over that scalar, so this file never touches
// a colour, a blur radius or a shadow — it moves one value and the whole app
// re-materialises. Adding a new glass surface therefore means writing CSS, not
// coming back here.
//
// Stored per device, like the phone menu and unlike the theme's account-level
// feel: the laptop that can afford a 30px blur on sixteen panels is rarely the
// three-year-old phone in someone's pocket, and this is the control that lets
// the phone opt out without dragging the laptop down with it.
(function () {
  const KEY = 'hek-liquid';
  const DEFAULT = 55;
  const root = document.documentElement;

  const clamp = (n) => Math.min(100, Math.max(0, Math.round(n)));

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw == null) return DEFAULT;
      const n = Number(raw);
      return Number.isFinite(n) ? clamp(n) : DEFAULT;
    } catch (e) {
      return DEFAULT; // private mode — the default still applies for this session
    }
  }

  // Applying is two things, and the second is the one that matters on a weak
  // device: at zero we stamp data-liquid="off", and the block at the bottom of
  // styles.css deletes every backdrop-filter outright. Leaving blur(0px) in
  // place would keep the compositing pass alive for no visible effect, which is
  // exactly what someone dragging the slider to the floor is trying to stop.
  function apply(v) {
    root.style.setProperty('--liquid', clamp(v) / 100);
    if (v <= 0) root.dataset.liquid = 'off';
    else delete root.dataset.liquid;
  }

  // What the number means, in words. A percentage tells you nothing about what
  // you are about to see, and this slider's whole job is a look.
  function describe(v) {
    if (v <= 0) return 'Off — solid panels, no blur.';
    if (v < 25) return 'A hint of depth. Cheapest on an old phone.';
    if (v < 55) return 'Frosted. Surfaces read as panels that let light through.';
    if (v < 80) return 'Liquid glass. The page moves under every surface.';
    return 'Maximum. Thin, bright and heavily blurred.';
  }

  // Written against however many sliders a page happens to carry, which today
  // is one: the dashboard's Settings panel. Every other page still loads this
  // file and still gets the saved level applied — it simply offers no control
  // to change it, which is why apply() and sync() are separate steps.
  function sync(v) {
    document.querySelectorAll('[data-liquid-slider]').forEach((el) => {
      if (el.value !== String(v)) el.value = String(v);
    });
    document.querySelectorAll('[data-liquid-value]').forEach((el) => {
      el.textContent = v <= 0 ? 'Off' : v + '%';
    });
    document.querySelectorAll('[data-liquid-hint]').forEach((el) => {
      el.textContent = describe(v);
    });
  }

  function set(v, persist) {
    const n = clamp(v);
    apply(n);
    sync(n);
    if (persist) {
      try {
        localStorage.setItem(KEY, String(n));
      } catch (e) {
        /* private mode — the change still holds for this session */
      }
    }
  }

  function init() {
    set(read(), false);
    // 'input' so the page re-materialises under the thumb as it moves; the
    // write to localStorage rides along, which is cheap enough at this rate and
    // saves needing a 'change' handler that could be missed on a touch drag
    // that ends outside the control.
    document.addEventListener('input', (e) => {
      const el = e.target.closest && e.target.closest('[data-liquid-slider]');
      if (el) set(el.value, true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
