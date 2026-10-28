// Snappy — the small shared layer that makes the app feel instant. It loads
// before every other script on every page; anything may use window.Snappy.
//
//   Presses      A control shows it was pressed the moment a finger or mouse
//                lands on it (styles.css, :active). Navigation — the sidebar
//                tabs, the profile tabs, anything marked data-press="fast" —
//                goes further with a mouse: it acts on the way down instead of
//                waiting for the button to come back up. A finger still acts on
//                lift: on a touch screen a press is also how a scroll starts,
//                and jumping tabs because someone began to scroll the menu would
//                be worse than any delay.
//   busy()       A control doing work is disabled at once, so it can't be
//                started twice, but its spinner and "Saving…" label appear only
//                if the wait passes 150 ms. A save that answers in 80 ms never
//                flickers.
//   cache/swr()  The last copy of a list is painted straight away, then
//                replaced if the server's answer differs. Always in memory; on
//                disk only where a page asks, tagged with whose it is, and never
//                kept past that login's expiry.
//   prefetch()   Asks for what someone will probably open next while the device
//                is idle, or the moment they show intent (hover, focus, touch).
//                Never on Save-Data or a 2G connection.
//   optimistic() Shows a change before the server confirms it, and puts it back
//                if the server refuses.
//   Motion       A modal grows out of the point that was pressed to open it.
//                styles.css animates; this only aims it.
//   chunks() /   Long lists render a screenful now and the rest as they are
//   endless()    scrolled toward.
//   leaflet()    The map library loads on the screens that draw a map, not in
//                every page's <head>.
(function () {
  'use strict';
  if (window.Snappy) return;

  const now = () => performance.now();

  // ---------------------------------------------------------------- presses
  // iOS Safari applies :active only when some touchstart listener sits above
  // the element. One passive no-op on the document switches it on everywhere.
  document.addEventListener('touchstart', () => {}, { passive: true });

  // Where the last press landed. A modal opened by it grows from that point.
  let lastPress = null;
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPress = { x: e.clientX, y: e.clientY, at: now() };
    },
    { capture: true, passive: true }
  );
  // Enter or Space on a focused control: the control's centre stands in for
  // the pointer.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = document.activeElement;
      if (!el || el === document.body || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      lastPress = { x: r.left + r.width / 2, y: r.top + r.height / 2, at: now() };
    },
    true
  );

  // A mouse press on navigation acts on the way down. Only for controls whose
  // whole job is to show something — never a save, a send or a delete. Those
  // keep acting on release, where letting go somewhere else still cancels them.
  // Never on anything draggable: the press that starts a drag must not open it.
  const FAST = '.side-nav .tab, .ptab, [data-press="fast"]';
  // Inside a fast control, a press on one of these is that thing's own press
  // (a row's Delete button, a link in a card) and is left alone.
  const OWN = 'button, a[href], input, select, textarea, label, summary, [data-press], [data-act]';
  let fired = null; // the control acted on at press; its own click is swallowed
  let firing = false;

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const el = e.target.closest && e.target.closest(FAST);
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      if (el.closest('[draggable="true"]')) return;
      const own = e.target.closest(OWN);
      if (own && own !== el && el.contains(own)) return;
      fired = { el, at: now() };
      firing = true;
      try {
        el.click();
      } finally {
        firing = false;
      }
    },
    true
  );
  document.addEventListener(
    'click',
    (e) => {
      if (firing || !fired) return;
      const { el, at } = fired;
      fired = null;
      // The button coming back up, after the press already did the work.
      if (now() - at < 1500 && (e.target === el || el.contains(e.target))) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );

  // ------------------------------------------------------------------- busy
  const SHOW_AFTER = 150; // a wait shorter than this shows nothing at all
  const MIN_SHOWN = 300; // one that does show stays long enough not to flicker

  // Runs work() with `el` marked busy. Disabled and aria-busy at once; the
  // spinner (and `label`, e.g. "Saving…", if given) only after SHOW_AFTER.
  // Pass a label only to a control whose text nothing else changes meanwhile:
  // the old text is put back when the work ends.
  async function busy(el, work, { label } = {}) {
    const run = () => (typeof work === 'function' ? work() : work);
    if (!el) return run();
    const was = { disabled: el.disabled, text: el.textContent };
    el.disabled = true;
    el.setAttribute('aria-busy', 'true');
    let shownAt = 0;
    const timer = setTimeout(() => {
      shownAt = now();
      el.classList.add('is-busy');
      if (label) el.textContent = label;
    }, SHOW_AFTER);
    const done = () => {
      el.classList.remove('is-busy');
      el.removeAttribute('aria-busy');
      el.disabled = was.disabled;
      if (label) el.textContent = was.text;
    };
    try {
      return await run();
    } finally {
      clearTimeout(timer);
      const left = shownAt ? MIN_SHOWN - (now() - shownAt) : 0;
      if (left > 0) setTimeout(done, left);
      else done();
    }
  }

  // ------------------------------------------------------------------ cache
  // Everything read through load()/swr() is kept in memory for the life of the
  // page. A page can also ask for a copy on disk (persist), so its next visit
  // opens on the last known state instead of an empty screen. A disk copy is
  // stamped with the account it belongs to, and the whole store is deleted
  // when that login runs out, on sign-out, and when anyone else signs in.
  const KEY = 'hek-cache:';
  const META = 'hek-cache-meta';
  const MAX_DISK = 1024 * 1024; // an answer bigger than this stays in memory only
  const mem = new Map(); // path -> { json, at }
  // What goes on disk for a path, when a page keeps less there than it shows —
  // the schedule leaves the office's internal notes off the device.
  const shapes = new Map(); // path -> (data) => the part worth keeping
  let owner = null; // whose copies these are, e.g. "admin:office@…", "employee:12"

  const disk = (() => {
    try {
      const s = window.localStorage;
      s.setItem(KEY + 'probe', '1');
      s.removeItem(KEY + 'probe');
      return s;
    } catch (e) {
      return null; // private browsing, storage switched off: memory only
    }
  })();

  function diskKeys() {
    const out = [];
    if (!disk) return out;
    for (let i = 0; i < disk.length; i++) {
      const k = disk.key(i);
      if (k && k.startsWith(KEY)) out.push(k);
    }
    return out;
  }
  function wipeDisk() {
    if (!disk) return;
    try {
      diskKeys().forEach((k) => disk.removeItem(k));
      disk.removeItem(META);
    } catch (e) {
      /* nothing more can be done with a store that won't delete */
    }
  }
  function readMeta() {
    try {
      return JSON.parse((disk && disk.getItem(META)) || 'null');
    } catch (e) {
      return null;
    }
  }
  // A path's resource: "/api/admin/quotes/12/send" -> "/api/admin/quotes".
  const resourceOf = (path) => String(path).split('?')[0].split('/').slice(0, 4).join('/');
  // Questions sent as a POST that change nothing on the server — the slope
  // check runs after every edit to a drawing, and must not throw away every
  // kept quote each time.
  const READ_ONLY = /^\/api\/admin\/quotes\/terrain$/;

  const cache = {
    // The account the server just confirmed, and when its login ends. A
    // different account from the one the copies belong to starts from empty.
    identify(who, expires) {
      const meta = readMeta();
      if (owner !== who || !meta || meta.who !== who) {
        dropped(''); // nothing already on its way may land in the new account's copies
        mem.clear();
        wipeDisk();
      }
      owner = who;
      const until = Date.parse(expires) || 0;
      if (disk && until > Date.now()) {
        try {
          disk.setItem(META, JSON.stringify({ who, until }));
        } catch (e) {
          /* memory only, then */
        }
      }
    },
    // Page load, before the server has said who is signed in: the account
    // whose copies are on disk, if its login hasn't run out — so the page can
    // paint them while it asks. Expired copies are deleted here, unread.
    resume() {
      const meta = readMeta();
      if (meta && meta.who && meta.until > Date.now()) {
        owner = meta.who;
        return owner;
      }
      wipeDisk();
      owner = null;
      return null;
    },
    // A copy of what was last read from `path`, or undefined. A fresh copy
    // every call, so a caller sorting or editing it can't change the cache.
    peek(path) {
      const hit = mem.get(path);
      if (hit) return JSON.parse(hit.json);
      if (!disk || !owner) return undefined;
      try {
        const raw = disk.getItem(KEY + path);
        if (!raw) return undefined;
        const a = raw.indexOf('\n');
        const b = raw.indexOf('\n', a + 1);
        if (raw.slice(0, a) !== owner) return undefined;
        const json = raw.slice(b + 1);
        mem.set(path, { json, at: Number(raw.slice(a + 1, b)) || 0 });
        return JSON.parse(json);
      } catch (e) {
        return undefined;
      }
    },
    // persist: true keeps a copy on disk too; a function keeps only what it
    // returns there (the full answer still stays in memory).
    put(path, data, persist) {
      let json;
      try {
        json = JSON.stringify(data);
      } catch (e) {
        return;
      }
      const at = Date.now();
      mem.set(path, { json, at });
      if (typeof persist === 'function') shapes.set(path, persist);
      if (!persist || !disk || !owner) return;
      let kept = json;
      if (typeof persist === 'function') {
        try {
          kept = JSON.stringify(persist(JSON.parse(json)));
        } catch (e) {
          return;
        }
      }
      if (kept.length > MAX_DISK) return;
      try {
        disk.setItem(KEY + path, owner + '\n' + at + '\n' + kept);
      } catch (e) {
        // Full. Old copies are worth less than a working page: start over.
        diskKeys().forEach((k) => {
          try {
            disk.removeItem(k);
          } catch (_) {
            /* ignore */
          }
        });
      }
    },
    // Edit a kept copy in place — take out a deleted row, mark one read — so
    // the next paint from cache doesn't bring back what was just changed.
    update(path, fn) {
      const data = cache.peek(path);
      if (data === undefined) return;
      const next = fn(data);
      const onDisk = !!(disk && disk.getItem(KEY + path));
      cache.put(path, next === undefined ? data : next, onDisk && (shapes.get(path) || true));
    },
    // Forget every copy whose path starts with `prefix`. Each drop is
    // numbered, so an answer already on its way from before it can be told
    // apart from one asked for after (see load()).
    drop(prefix) {
      dropped(prefix);
      for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k);
      diskKeys().forEach((k) => {
        if (k.startsWith(KEY + prefix)) disk.removeItem(k);
      });
    },
    // After a change sent to `path`: forget everything read from the same
    // resource, so nothing paints the state from before it.
    dropFor(path) {
      if (READ_ONLY.test(String(path).split('?')[0])) return;
      cache.drop(resourceOf(path));
    },
    // Whether a copy younger than maxAge ms is in memory.
    fresh(path, maxAge) {
      const hit = mem.get(path);
      return !!hit && Date.now() - hit.at < maxAge;
    },
    clear() {
      dropped('');
      mem.clear();
      shapes.clear();
      owner = null;
      wipeDisk();
    },
  };

  // ------------------------------------------------------------ swr / load
  const inflight = new Map(); // path -> { p, n, background }

  // The drops, numbered. A request remembers the number it set off under; if a
  // drop covering its path has happened since, its answer may be the very
  // state the drop was clearing — a save landed while it was on its way.
  let drops = 0;
  const dropLog = []; // the recent { n, prefix }
  function dropped(prefix) {
    dropLog.push({ n: ++drops, prefix });
    if (dropLog.length > 300) dropLog.splice(0, dropLog.length - 300);
  }
  function droppedSince(path, n) {
    for (let i = dropLog.length - 1; i >= 0 && dropLog[i].n > n; i--)
      if (path.startsWith(dropLog[i].prefix)) return true;
    return false;
  }

  // GET `path` through the page's own api() (so a 401 still signs out the way
  // that page does it), keep the answer, and hand it back. A request for a
  // path already on its way — say, from a prefetch — joins that one, unless
  // a drop covering the path came after it set off: then it asks again, and
  // the older answer is handed to whoever asked for it but not kept.
  //
  // A background fetch (a prefetch) tells api() so with { background: true }:
  // a guess about what someone might open next must never be what signs them
  // out. The shell's api() then just fails it quietly. Someone who joins it
  // for real gets it asked again out loud if it fails, so an expired login is
  // dealt with the usual way.
  function load(api, path, { persist, background } = {}) {
    const running = inflight.get(path);
    if (running && !droppedSince(path, running.n)) {
      if (running.background && !background)
        return running.p.catch(() => ask(api, path, persist, false));
      return running.p;
    }
    return ask(api, path, persist, background);
  }
  function ask(api, path, persist, background) {
    const entry = { n: drops, background: !!background, p: null };
    entry.p = Promise.resolve()
      .then(() => (background ? api(path, { background: true }) : api(path)))
      .then((data) => {
        if (!droppedSince(path, entry.n)) cache.put(path, data, persist);
        return data;
      })
      .finally(() => {
        if (inflight.get(path) === entry) inflight.delete(path);
      });
    inflight.set(path, entry);
    return entry.p;
  }

  // Paint the copy we have, then the server's answer if it differs.
  // render(data, fresh): fresh is false for the kept copy. It can run twice,
  // and the second time may be after the person has moved on — check that what
  // is about to be drawn is still what's on screen. Resolves to the server's
  // data; rejects the way api() does.
  function swr(api, path, render, opts = {}) {
    const cached = cache.peek(path);
    const before = cached === undefined ? null : mem.get(path).json;
    if (cached !== undefined) {
      try {
        render(cached, false);
      } catch (e) {
        console.error(e);
      }
    }
    return load(api, path, opts).then((data) => {
      const hit = mem.get(path);
      if (before === null || !hit || hit.json !== before) render(data, true);
      return data;
    });
  }

  // --------------------------------------------------------------- prefetch
  // Whether to hold back on anything fetched only in case it's wanted: the
  // device asked to save data, the connection is very slow, or the page isn't
  // being looked at. Exposed for warm-ups (a library loaded ahead of time).
  function quiet() {
    const c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return true;
    return document.visibilityState === 'hidden';
  }

  // Ask for what's probably next. Skipped on Save-Data or 2G, when a copy
  // younger than maxAge is already here, or when it is already on its way.
  // Only for plain reads: never a GET that counts or changes something (the
  // customer's quote page counts views) or one with a tight rate limit.
  function prefetch(api, paths, { maxAge = 30000, persist } = {}) {
    if (quiet()) return;
    for (const path of [].concat(paths || [])) {
      if (!path || cache.fresh(path, maxAge)) continue;
      const running = inflight.get(path);
      if (running && !droppedSince(path, running.n)) continue;
      load(api, path, { persist, background: true }).catch(() => {});
    }
  }

  // fn() when the page has nothing better to do (at most `timeout` ms away).
  const idle = (fn, timeout = 1500) =>
    'requestIdleCallback' in window
      ? requestIdleCallback(() => fn(), { timeout })
      : setTimeout(fn, 300);

  // fn(el) when someone shows interest in an element under `root` matching
  // `selector`: a mouse resting on it for a moment, keyboard focus, or a finger
  // landing on it — the tap that follows is ~100 ms behind, which is enough to
  // have the answer on its way. At most once per element every 15 s.
  function intent(root, selector, fn) {
    if (!root) return;
    const seen = new WeakMap();
    let timer = null;
    const fire = (el) => {
      const t = seen.get(el);
      if (t && now() - t < 15000) return;
      seen.set(el, now());
      try {
        fn(el);
      } catch (e) {
        console.error(e);
      }
    };
    const match = (e) => {
      const el = e.target.closest && e.target.closest(selector);
      return el && root.contains(el) ? el : null;
    };
    root.addEventListener('pointerover', (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = match(e);
      if (!el) return;
      clearTimeout(timer);
      timer = setTimeout(() => fire(el), 60);
    });
    root.addEventListener('pointerout', (e) => {
      const el = match(e);
      if (el && !el.contains(e.relatedTarget)) clearTimeout(timer);
    });
    root.addEventListener(
      'pointerdown',
      (e) => {
        const el = match(e);
        if (el) fire(el);
      },
      { passive: true }
    );
    root.addEventListener('focusin', (e) => {
      const el = match(e);
      if (el) fire(el);
    });
  }

  // ------------------------------------------------------------- optimistic
  // apply() makes the change on screen and returns a function that undoes it.
  // If request() fails, the change is undone and the error rethrown for the
  // caller to report — the screen never claims something the server refused.
  async function optimistic(apply, request) {
    const undo = apply();
    try {
      return await request();
    } catch (err) {
      if (typeof undo === 'function') {
        try {
          undo();
        } catch (e) {
          console.error(e);
        }
      }
      throw err;
    }
  }

  // ----------------------------------------------------------------- motion
  // When .open lands on a .modal-back within a moment of a press, the panel's
  // transform origin is put under the press, so the scale-in in styles.css
  // grows it out of the button that opened it. Opened by the app on its own,
  // it grows from its centre.
  function aim(back) {
    const panel = back.querySelector('.modal') || back.firstElementChild;
    if (!panel) return;
    const p = lastPress && now() - lastPress.at < 1500 ? lastPress : null;
    if (!p) {
      panel.style.transformOrigin = '';
      return;
    }
    const r = panel.getBoundingClientRect();
    panel.style.transformOrigin = `${Math.round(p.x - r.left)}px ${Math.round(p.y - r.top)}px`;
  }
  const opened = (r) =>
    r.target.classList &&
    r.target.classList.contains('modal-back') &&
    r.target.classList.contains('open') &&
    !/(^|\s)open(\s|$)/.test(r.oldValue || '');
  new MutationObserver((records) => {
    for (const r of records) if (opened(r)) aim(r.target);
  }).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true,
  });

  // ------------------------------------------------------------ long lists
  const markerFor = (box) => {
    const row = box.tagName === 'TBODY' || box.tagName === 'TABLE';
    const m = document.createElement(row ? 'tr' : 'div');
    m.className = 'snappy-more';
    m.setAttribute('aria-hidden', 'true');
    if (row) m.innerHTML = '<td colspan="99"></td>';
    return m;
  };
  function stopLong(box) {
    if (box.__snappyStop) box.__snappyStop();
    box.__snappyStop = null;
  }

  // rows: an array of HTML strings. The first screenful goes in now and the
  // rest a batch at a time as the end of the list nears the screen — a few
  // thousand rows parsed in one go would freeze a phone for a second. Clicks
  // delegated to `box` keep working. Call again to replace the list.
  function chunks(box, rows, { first = 60, step = 120 } = {}) {
    stopLong(box);
    box.innerHTML = rows.slice(0, first).join('');
    let at = first;
    if (at >= rows.length) return;
    if (!('IntersectionObserver' in window)) {
      box.insertAdjacentHTML('beforeend', rows.slice(at).join(''));
      return;
    }
    const marker = markerFor(box);
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries.some((x) => x.isIntersecting)) return;
        marker.remove();
        box.insertAdjacentHTML('beforeend', rows.slice(at, at + step).join(''));
        at += step;
        if (at >= rows.length) return stopLong(box);
        box.appendChild(marker);
        // A fresh look: moved within one task, the marker never stopped
        // "intersecting", so without this no further batch would be asked for.
        obs.unobserve(marker);
        obs.observe(marker);
      },
      { rootMargin: '800px 0px' }
    );
    box.appendChild(marker);
    obs.observe(marker);
    box.__snappyStop = () => {
      obs.disconnect();
      marker.remove();
    };
  }

  // A list the server sends a page at a time. Whenever the end of `box` nears
  // the screen, more() runs — never two at once — and appends its rows; it
  // resolves to whether there may be more. A failed page leaves a "try again"
  // row rather than a list that silently stops. Call again (or chunks()) to
  // start over; returns a function that stops it.
  function endless(box, more) {
    stopLong(box);
    if (!('IntersectionObserver' in window)) return () => {};
    const marker = markerFor(box);
    let running = false;
    let obs = null;
    const watch = () => {
      box.appendChild(marker); // always after the rows more() just added
      obs.unobserve(marker);
      obs.observe(marker); // a fresh look: still near the end? load again
    };
    obs = new IntersectionObserver(
      async (entries) => {
        if (running || !entries.some((x) => x.isIntersecting)) return;
        running = true;
        let again = false;
        try {
          again = !!(await more());
        } catch (err) {
          console.error(err);
          marker.innerHTML = '';
          const cell = document.createElement(marker.tagName === 'TR' ? 'td' : 'div');
          if (cell.tagName === 'TD') cell.colSpan = 99;
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'link-btn';
          retry.textContent = 'Couldn’t load more — try again';
          retry.addEventListener('click', () => {
            marker.innerHTML = marker.tagName === 'TR' ? '<td colspan="99"></td>' : '';
            watch();
          });
          cell.appendChild(retry);
          marker.appendChild(cell);
          obs.unobserve(marker);
          running = false;
          return;
        }
        running = false;
        if (again && box.__snappyStop === stop) watch();
        else if (box.__snappyStop === stop) stopLong(box);
      },
      { rootMargin: '800px 0px' }
    );
    const stop = () => {
      obs.disconnect();
      marker.remove();
    };
    box.appendChild(marker);
    obs.observe(marker);
    box.__snappyStop = stop;
    return () => {
      if (box.__snappyStop === stop) stopLong(box);
    };
  }

  // -------------------------------------------------------- outside scripts
  const loading = new Map();
  function tag(kind, url, attrs) {
    if (loading.has(url)) return loading.get(url);
    const p = new Promise((resolve, reject) => {
      const el = document.createElement(kind);
      if (kind === 'link') {
        el.rel = 'stylesheet';
        el.href = url;
      } else {
        el.src = url;
        el.async = true;
      }
      for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
      el.onload = () => resolve();
      el.onerror = () => {
        loading.delete(url);
        el.remove();
        reject(new Error('Could not load ' + url));
      };
      document.head.appendChild(el);
    });
    loading.set(url, p);
    return p;
  }
  const script = (src, attrs) => tag('script', src, attrs);
  const style = (href, attrs) => tag('link', href, attrs);

  // Leaflet, pinned to the same version and checked against the same hashes
  // the pages used to load in their <head>.
  const LEAFLET = {
    css: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    cssHash: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=',
    js: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    jsHash: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=',
  };
  // Resolves to window.L once the library and its stylesheet are both in.
  function leaflet() {
    return Promise.all([
      style(LEAFLET.css, { integrity: LEAFLET.cssHash, crossorigin: '' }),
      window.L && window.L.map
        ? Promise.resolve()
        : script(LEAFLET.js, { integrity: LEAFLET.jsHash, crossorigin: '' }),
    ]).then(() => {
      if (!window.L) throw new Error('The map could not load.');
      return window.L;
    });
  }

  window.Snappy = {
    busy,
    cache,
    load,
    swr,
    prefetch,
    quiet,
    idle,
    intent,
    optimistic,
    chunks,
    endless,
    script,
    style,
    leaflet,
  };
})();
