/* ZimiGames: the little helpers the puzzle and arcade pages share. Our own code, GPL-3.0.
   No network, no modules. Only the pages use it; the rules in each game file stand alone. */
(function (root) {
  'use strict';
  var Play = {};

  Play.$ = function (id) { return document.getElementById(id); };

  // Every visible and spoken string goes through T (text.js). A page's static markup carries data-t="id" (text),
  // data-t-aria="id" (aria-label) or data-t-title="id" (title); the English in the markup is only what shows before
  // this runs. It runs again whenever a translation arrives.
  var T = Play.T = function (key, vars) { return window.ZimiText ? window.ZimiText.T(key, vars) : key; };
  var TRANSLATED = [['data-t', 'textContent'], ['data-t-aria', 'aria-label'], ['data-t-title', 'title']];
  Play.translate = function (scope) {
    TRANSLATED.forEach(function (p) {
      Array.prototype.forEach.call((scope || document).querySelectorAll('[' + p[0] + ']'), function (el) {
        var v = T(el.getAttribute(p[0]));
        if (p[1] === 'textContent') el.textContent = v; else el.setAttribute(p[1], v);
      });
    });
  };
  // (the rules halves are loaded without a page by the node tests: nothing below runs there)
  if (typeof document !== 'undefined') {
    if (window.ZimiText && window.ZimiText.onChange) window.ZimiText.onChange(function () { Play.translate(document); });
    document.addEventListener('DOMContentLoaded', function () { Play.translate(document); });
    if (document.readyState !== 'loading') Play.translate(document);
  }

  // localStorage can throw (private mode, blocked site data): every read and write is guarded.
  Play.load = function (key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : fallback; } catch (e) { return fallback; }
  };
  Play.save = function (key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* play on without it */ }
  };

  Play.reducedMotion = function () {
    if (window.ZimiShell && window.ZimiShell.anim() === 'off') return true;
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  };

  // ?theme=light|dark pins the look (the screenshots use it).
  Play.applyTheme = function () {
    var t = new URLSearchParams(location.search).get('theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  };

  Play.fmtClock = function (ms) {
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  };

  // Call fn when the tab is hidden, so a running game can pause itself.
  Play.onHidden = function (fn) {
    document.addEventListener('visibilitychange', function () { if (document.hidden) fn(); });
  };

  // A sheet over the game; focus goes in on open and back to where it was on close.
  var opener = null;
  Play.openSheet = function (sheet, focusSel) {
    opener = document.activeElement;
    sheet.hidden = false;
    var f = sheet.querySelector(focusSel || 'button, input');
    if (f) f.focus();
  };
  Play.closeSheet = function (sheet) {
    sheet.hidden = true;
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    opener = null;
  };

  // ── the arcade kit: the HUD, the one touch pad, the ready line, pause and the end ──

  // A value in the HUD strip (at most four per game: a 13px label over a 32px value).
  Play.num = function (n) { n = +n || 0; return window.ZimiText ? window.ZimiText.number(n) : String(n); };

  var PAD_KEY = 56, PAD_GAP = 8, HUD_FLOW_PX = 36, SWIPE_PX = 24, SWIPE_HOLD_MS = 80;
  var PAD_GLYPH = { left: '◀', right: '▶', up: '▲', down: '▼' };
  var LANDSCAPE = '(orientation: landscape) and (max-height: 520px)';
  function landscape() { try { return matchMedia(LANDSCAPE).matches; } catch (e) { return false; } }

  // The one touch pad. Portrait: the pad fills everything under the field (the status line sits between), in rows the
  // full width of the screen: the arrows first (a row of two or three, or a d-pad block for four ways), then the actions
  // as one row split evenly. Landscape on a phone: the arrows on the left, the actions on the right, all 56px. The canvas is
  // wrapped in .pl-stage so the pad sits under it, or on either side of the playfield in landscape.
  //   Play.pad(canvas, { dirs: ['left', 'right'], actions: [{ name: 'fire', label: T('play.fire') }], on: function (name, down) {} })
  // A pad with up or down is an arrow pad, so a swipe on the playfield sends one arrow too (24px, the dominant axis, one
  // move per swipe); the pad stays. swipe: false for a game that reads swipes its own way.
  // Returns { el, release() }. Keys answer by pointer and by Space or Enter on a focused key; a game reads the keyboard itself.
  // How many rows of keys a pad has: a four-way d-pad is two, the actions are one.
  function padRows(opts) { var dirs = opts.dirs || []; return (dirs.length > 3 ? 2 : dirs.length ? 1 : 0) + ((opts.actions || []).length ? 1 : 0); }
  Play.pad = function (canvas, opts) {
    var stage = canvas.parentNode.classList.contains('pl-stage') ? canvas.parentNode : null, holds = [];
    if (!stage) {
      stage = document.createElement('div'); stage.className = 'pl-stage';
      canvas.parentNode.insertBefore(stage, canvas); stage.appendChild(canvas);
    }
    function key(name, label, aria, cls) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'pl-key ' + cls; b.setAttribute('data-pad', name); b.setAttribute('aria-label', aria); b.textContent = label;
      holds.push(Play.hold(b, function (down) { opts.on(name, down); }));
      return b;
    }
    var left = document.createElement('div'), right = document.createElement('div'), el = document.createElement('div');
    left.className = 'pl-pad-l'; right.className = 'pl-pad-r'; el.className = 'pl-pad';
    left.setAttribute('role', 'group'); left.setAttribute('aria-label', T('play.pad'));
    left.setAttribute('data-n', String((opts.dirs || []).length));
    (opts.dirs || []).forEach(function (d) { left.appendChild(key(d, PAD_GLYPH[d], T('play.' + d), 'pl-dir')); });
    (opts.actions || []).forEach(function (a) { right.appendChild(key(a.name, a.label, a.label, 'pl-act')); });
    right.setAttribute('role', 'group'); right.setAttribute('aria-label', T('play.actions'));
    el.appendChild(left); el.appendChild(right);
    stage.appendChild(el);
    // The status line sits between the field and the pad, never under the keys.
    var msg = stage.parentNode.querySelector(':scope > .pl-msg');
    if (msg && (stage.compareDocumentPosition(msg) & Node.DOCUMENT_POSITION_FOLLOWING)) stage.insertBefore(msg, el);
    el.setAttribute('data-rows', String(padRows(opts)));
    var dirs = opts.dirs || [];
    if (opts.swipe !== false && (dirs.indexOf('up') >= 0 || dirs.indexOf('down') >= 0)) {
      canvas.style.touchAction = 'none';   // a swipe on the field never scrolls the page or pulls to refresh
      Play.gesture(canvas, { up: function (s) {
        var d = Play.swipeDir(s.dx, s.dy, SWIPE_PX);
        if (d && dirs.indexOf(d) >= 0) { opts.on(d, true); setTimeout(function () { opts.on(d, false); }, SWIPE_HOLD_MS); }
      } });
    }
    return { el: el, stage: stage, release: function () { holds.forEach(function (h) { h.release(); }); } };
  };

  // Room for a playfield: the width and height left once the page's own chrome (everything but the pad) is taken.
  // With a pad the portrait page loses the pad's least height (the pad itself grows to fill what is left); in landscape the halves take the sides.
  var PAD_SIDE = PAD_KEY * 3 + PAD_GAP * 2;
  Play.room = function (chrome) {
    var vw = document.documentElement.clientWidth - 24, vh = window.innerHeight - chrome, pad = document.querySelector('.pl-pad');
    if (pad) {
      if (landscape()) { vw -= PAD_SIDE * 2 + 24; if (document.querySelector('.pl-hud')) vh += HUD_FLOW_PX; }
      else if (pad.getClientRects().length) { var rows = +pad.getAttribute('data-rows') || 1; vh -= rows * PAD_KEY + (rows - 1) * PAD_GAP + 12; }
    }
    return { w: vw, h: vh };
  };

  // The ready line: one short sentence in the status line and the playfield, a tap or any key starts. Returns { cancel }.
  // The line is "Tap to start" on a touch screen and "Press any key" otherwise; a gesture game passes its own
  // (touch: "Tap to start, then swipe to turn") so the gesture is said once, here. Keys that belong to the Menu or a dialog never start it.
  Play.ready = function (o) {
    var done = false, pointer = false;
    try { pointer = matchMedia('(pointer: coarse)').matches; } catch (e) { /* a mouse */ }
    var text = pointer ? (o.touch || T('play.tapStart')) : (o.keys || T('play.pressKey'));
    if (o.say) o.say(text); else if (o.msg) o.msg.textContent = text;
    function stop() { done = true; (o.target || document).removeEventListener('pointerdown', tap); document.removeEventListener('keydown', key, true); }
    function go() { if (done) return; stop(); o.start(); }
    function tap(e) { if (e.button) return; e.preventDefault(); go(); }
    function key(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Tab' || e.key === 'Escape' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      if (document.querySelector('.ar-sheet:not([hidden])')) return;
      var t = e.target;
      if (t && t !== document.body && t.closest && t.closest('button, a, input, select, textarea')) return;
      e.preventDefault(); go();
    }
    (o.target || document).addEventListener('pointerdown', tap);
    document.addEventListener('keydown', key, true);
    return { cancel: stop };
  };

  // A figure that rises off a spot and fades ("+8"): text at x, y (pixels) inside host, a positioned element. Gone when it has played.
  Play.float = function (host, text, x, y) {
    var el = document.createElement('span');
    el.className = 'pl-float'; el.textContent = text; el.setAttribute('aria-hidden', 'true');
    el.style.left = x + 'px'; el.style.top = y + 'px';
    host.appendChild(el);
    var gone = function () { el.remove(); };
    el.addEventListener('animationend', gone); setTimeout(gone, 1200);
    return el;
  };

  // A note, only when the player has turned Sound on (Settings), made only after a tap: one shared context, a soft sine with a short attack.
  var audio = null, TONE_GAIN = 0.22, TONE_ATTACK_S = 0.02;
  Play.tone = function (freq, ms, gain) {
    if (!window.ZimiShell || !window.ZimiShell.sound || !window.ZimiShell.sound()) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      var o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime, len = ms / 1000, peak = gain || TONE_GAIN;
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + TONE_ATTACK_S); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + len + 0.05);
    } catch (e) { /* no audio on this device: play on silently */ }
  };
  // A buzz for a hit (a number of ms or a pattern); phones that cannot buzz, and reduced motion, stay still.
  Play.haptic = function (pattern) {
    try { if (navigator.vibrate && !Play.reducedMotion()) navigator.vibrate(pattern); } catch (e) { /* no haptics here */ }
  };

  // Saved games (ZimiShell.persist): a state as plain JSON (functions such as a game's random source are dropped), and a
  // fresh state with a saved one laid over it. An arcade game restores paused: the Pause/Resume button is the way on.
  Play.plain = function (obj) { return JSON.parse(JSON.stringify(obj)); };
  Play.overlay = function (fresh, saved) { return Object.assign(fresh, Play.plain(saved)); };
  Play.runId = function () { return Date.now(); };

  // The page's one status line (ZimiShell.status: polite, with say() and reason()); a bare version without the shell.
  Play.status = function (el) {
    if (window.ZimiShell && window.ZimiShell.status) return window.ZimiShell.status(el);
    return { say: function (t) { el.textContent = t; }, reason: function (t) { el.textContent = t; } };
  };

  // The Pause button in the bar toggles: its label is Pause while the game runs, Resume while it waits.
  Play.pauseLabel = function (btn, paused) {
    btn.textContent = T(paused ? 'play.resume' : 'play.pause');
    btn.setAttribute('data-t', paused ? 'play.resume' : 'play.pause');
  };

  // A segmented option row for the Menu's New game pane (a game's own choice: wrap, players, mode):
  //   Play.optionRow(T('snake.edges'), [[false, T('shell.off')], [true, T('shell.on')]], value, function (v) {})
  // A fifth argument adds a class to the segmented control ('pl-grid' lays four or more long choices out in two columns).
  Play.optionRow = function (label, choices, value, onPick, cls) {
    var row = document.createElement('div'), lab = document.createElement('label'), seg = document.createElement('div');
    row.className = 'gs-row'; lab.textContent = label; seg.className = 'gs-seg' + (cls ? ' ' + cls : ''); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', label);
    choices.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ar-btn'; b.textContent = c[1]; b.setAttribute('aria-pressed', String(c[0] === value));
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(seg.children, function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true'); onPick(c[0]);
      });
      seg.appendChild(b);
    });
    row.appendChild(lab); row.appendChild(seg);
    return row;
  };

  // Pointer gestures on one element. Handlers: down(x, y), drag(dx, dy, ev) with the totals
  // since the press, up({dx, dy, ms, vx, vy, tap}), cancel(). Velocities are pixels per
  // millisecond over the last VELOCITY_WINDOW_MS, so a flick at the end of a drag counts and a
  // slow drag that ends in a pause does not.
  var TAP_PX = 10, TAP_MS = 350, VELOCITY_WINDOW_MS = 120;
  Play.gesture = function (el, h) {
    var s = null;
    function velocity() {
      var trail = s.trail, last = trail[trail.length - 1], first = trail[0];
      var dt = last.t - first.t;
      return dt > 0 ? { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt } : { vx: 0, vy: 0 };
    }
    el.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      var now = performance.now();
      s = { x: e.clientX, y: e.clientY, t: now, id: e.pointerId, trail: [{ t: now, x: e.clientX, y: e.clientY }] };
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no capture */ }
      if (h.down) h.down(e.clientX, e.clientY, e);
    });
    el.addEventListener('pointermove', function (e) {
      if (!s || e.pointerId !== s.id) return;
      var now = performance.now();
      s.trail.push({ t: now, x: e.clientX, y: e.clientY });
      while (s.trail.length > 2 && now - s.trail[0].t > VELOCITY_WINDOW_MS) s.trail.shift();
      if (h.drag) h.drag(e.clientX - s.x, e.clientY - s.y, e);
    });
    function end(e) {
      if (!s || e.pointerId !== s.id) return;
      var dx = e.clientX - s.x, dy = e.clientY - s.y, ms = performance.now() - s.t, v = velocity();
      s = null;
      if (e.type === 'pointercancel') { if (h.cancel) h.cancel(); return; }
      if (h.up) h.up({ dx: dx, dy: dy, ms: ms, vx: v.vx, vy: v.vy, tap: Math.hypot(dx, dy) < TAP_PX && ms < TAP_MS });
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };

  // The direction of a swipe, or null when it was too short.
  Play.swipeDir = function (dx, dy, min) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < min) return null;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  };

  // ── dice, symbols, loop and hold buttons (the dice, arcade and kids games) ──
  Play.mulberry32 = root.ZimiUtil.mulberry32;
  Play.randomSeed = function () { return Math.floor(Math.random() * 4294967296); };
  Play.shuffle = function (arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  };

  // Fill a die element with nine pip cells, lit for the face n (0 = blank).
  var PIPS = { 0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  Play.pips = function (el, n) {
    if (!el.firstChild) { for (var i = 0; i < 9; i++) el.appendChild(document.createElement('i')); }
    var on = PIPS[n] || [];
    for (var k = 0; k < 9; k++) el.children[k].className = on.indexOf(k) >= 0 ? 'on' : '';
  };

  // Six shapes that tell colours apart without colour: circle, square, triangle, diamond, star, cross.
  var SYMBOLS = [
    '<circle cx="12" cy="12" r="7.5"/>',
    '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
    '<path d="M12 4.5 20 19H4z"/>',
    '<path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/>',
    '<path d="m12 3.5 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 17l-5.4 3 1.2-6-4.5-4.2 6.1-.7z"/>',
    '<path d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z"/>'
  ];
  // 1st, 2nd, 3rd: the ordinal form comes from Intl, the words from the table (circuit.ord.*).
  Play.ordinal = function (n) {
    var rule = 'other';
    try { rule = new Intl.PluralRules(window.ZimiText ? window.ZimiText.lang : undefined, { type: 'ordinal' }).select(n); } catch (e) { /* the 'other' form */ }
    return T('circuit.ord.' + (rule === 'one' || rule === 'two' || rule === 'few' ? rule : 'other'), { n: n });
  };
  Play.SYMBOL_COUNT = SYMBOLS.length;
  Play.symbolSVG = function (i, size) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true" fill="currentColor" stroke="rgba(0,0,0,.55)" stroke-width="1.2" stroke-linejoin="round">' + SYMBOLS[i % SYMBOLS.length] + '</svg>';
  };

  // A timer for turn-based games: fn runs after ms, but never while the tab is hidden
  // (it waits for the tab to come back). Returns {cancel}.
  Play.later = function (fn, ms) {
    var h = { dead: false, id: 0, cancel: function () { h.dead = true; clearTimeout(h.id); } };
    function run() {
      if (h.dead) return;
      if (!document.hidden) { fn(); return; }
      var wait = function () { if (document.hidden) return; document.removeEventListener('visibilitychange', wait); run(); };
      document.addEventListener('visibilitychange', wait);
    }
    h.id = setTimeout(run, ms);
    return h;
  };

  // A fixed-step loop: update(dt) in whole steps of 1/hz, render() once per frame.
  // Stops by itself when the tab is hidden (the caller pauses its own state with Play.onHidden).
  Play.loop = function (update, render, hz) {
    var step = 1 / (hz || 60), acc = 0, last = 0, raf = 0, running = false, MAX_FRAME = 0.1;
    function frame(t) {
      if (!running) return;
      acc += Math.min(MAX_FRAME, (t - last) / 1000); last = t;
      while (acc >= step) { acc -= step; update(step); if (!running) return; }
      render();
      raf = requestAnimationFrame(frame);
    }
    return {
      start: function () { if (running) return; running = true; acc = 0; last = performance.now(); raf = requestAnimationFrame(frame); },
      stop: function () { running = false; cancelAnimationFrame(raf); },
      get running() { return running; }
    };
  };

  // A button that is "down" while held, by pointer or by key; fn(true|false).
  Play.hold = function (el, fn) {
    var down = false;
    function set(v) { if (v !== down) { down = v; el.setAttribute('aria-pressed', String(v)); fn(v); } }
    el.addEventListener('pointerdown', function (e) { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } set(true); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (n) { el.addEventListener(n, function () { set(false); }); });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    el.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); set(true); } });
    el.addEventListener('keyup', function (e) { if (e.key === ' ' || e.key === 'Enter') set(false); });
    el.addEventListener('blur', function () { set(false); });
    return { release: function () { set(false); } };
  };

  // Fit a canvas of logical size w x h into the room left on screen (chrome = pixels used by everything but the pad).
  Play.fitCanvas = function (cv, w, h, chrome, maxW) {
    var room = Play.room(chrome), vw = room.w, vh = room.h;
    var s = Math.min(vw / w, vh / h, (maxW || w) / w);
    s = Math.max(0.4, s);
    var dpr = window.devicePixelRatio || 1;
    cv.style.width = Math.floor(w * s) + 'px'; cv.style.height = Math.floor(h * s) + 'px';
    cv.width = Math.floor(w * s * dpr); cv.height = Math.floor(h * s * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
    // A browser can drop a canvas's drawing surface (a GPU hiccup); when it gives one back, fit and draw again.
    if (!cv.zgWatched) { cv.zgWatched = true; cv.addEventListener('contextrestored', function () { window.dispatchEvent(new Event('resize')); }); }
    return { scale: s, ctx: ctx };
  };

  // ── the arcade page: what every arcade game's page wires the same way ──
  // The ready line ("Tap to start") and arming it again after a game, the key map and touch pad, Pause (the button, P and
  // Escape, the tab going hidden, a tap on the playfield to go on), the New button, the resize, the HUD strip, the end sheet
  // and the saved game that comes back paused. A game keeps its rules, its drawing and what it says; it hands over:
  //   els          { cv, msg, pause, newBtn, ...the HUD cells }
  //   bestKey      the localStorage key of its best score (none: no Best stat, no best kept)
  //   state()      the game's current state object; layout() fits the canvas and draws; draw(); hud() or HUD cells named
  //                score, best, lives, wave or level in els (the default hud sets whichever of them there are)
  //   ready        { touch: 'rocks.readyTouch', keys: 'rocks.readyKeys' } (text ids) or a function returning { touch, keys, start } (words)
  //   newRun(arg)  makes a fresh state for a new run and returns what the status line says (default nothing)
  //   idle()       the state to show before the first run (a game with no state of its own to rest on omits it)
  //   keys         { ArrowLeft: 'left', ' ': 'fire' ... } held while down, read as page.input(); pad { dirs, actions } is the
  //                touch pad (its keys set the same names; on() replaces that, swipe: false as for Play.pad)
  //   release()    more to let go of when the game pauses or ends; resumeOnStage: a tap on the pad's stage also goes on
  //   snapshot()   the state to keep (JSON); restore(saved, d) lays it back and may return false to refuse it
  //   endSaved     keep the end sheet's stats with the saved game instead of rebuilding them from the state
  //   stats(), result, inProgress, onFinish, refresh, pack(d): the end sheet's stats, 'win', the modes that count as a game in
  //                progress, a hook at the end, how to show the state again, and what else goes into the saved game
  // Then page.run(update) makes the 60 Hz loop, page.start() (last) shows the first screen and registers the saved game.
  // The page's own: mode ('ready', 'playing', 'paused', 'over'), best, status, pad, runId, begin(), pause(), resume(), finish().
  var ARM_MS = 650;
  Play.arcadePage = function (o) {
    var els = o.els, KEY = o.keys, held = {}, keyHeld = {}, armed = null, lastEnd = null, inProgress = o.inProgress || ['playing', 'paused'];
    var status = Play.status(els.msg);
    var page = { mode: 'ready', runId: 0, status: status, best: o.bestKey ? Play.load(o.bestKey, { score: 0 }) : null, pad: null, loop: null };
    if (KEY) Object.keys(KEY).forEach(function (k) { held[KEY[k]] = keyHeld[KEY[k]] = false; });
    page.input = function () { var r = {}; Object.keys(held).forEach(function (k) { r[k] = held[k] || keyHeld[k]; }); return r; };
    if (o.pad) page.pad = Play.pad(els.cv, Object.assign({ on: function (name, down) { held[name] = down; } }, o.pad));

    function release() {
      Object.keys(held).forEach(function (k) { held[k] = keyHeld[k] = false; });
      if (page.pad) page.pad.release();
      if (o.release) o.release();
    }
    page.hud = function () {
      if (o.hud) { o.hud(); return; }
      var st = o.state();
      els.score.textContent = Play.num(st.score); els.best.textContent = Play.num(Math.max(page.best.score, st.score)); els.lives.textContent = Play.num(Math.max(0, st.lives));
      if (els.wave) els.wave.textContent = Play.num(st.wave);
      if (els.level) els.level.textContent = Play.num(st.level);
    };
    page.refresh = function () { if (o.refresh) o.refresh(); else { page.hud(); o.draw(); } };
    page.run = function (update) { page.loop = Play.loop(update, function () { o.draw(); page.hud(); }, 60); return page.loop; };

    // The ready line; r overrides its words and what a tap starts (the next lander waits for proceed, not begin).
    page.arm = function (r) {
      r = (typeof r === 'function' ? r() : r) || (typeof o.ready === 'function' ? o.ready() : { touch: T(o.ready.touch), keys: T(o.ready.keys) });
      if (armed) armed.cancel();
      armed = Play.ready({ say: status.say, target: page.pad ? page.pad.stage : els.cv, start: r.start || page.begin, touch: r.touch, keys: r.keys });
    };
    // Once a sheet is up: arm again if the game is still in that mode.
    page.armLater = function (mode, r) { setTimeout(function () { if (page.mode === mode) page.arm(r); }, ARM_MS); };

    page.begin = function (arg) {
      if (armed) armed.cancel();
      var say = o.newRun(arg);
      page.runId = Play.runId(); page.mode = 'playing'; status.say(say || '');
      if (KEY) release();
      Play.pauseLabel(els.pause, false); els.pause.disabled = false; page.refresh(); page.loop.start();
    };
    page.pause = function () {
      if (page.mode !== 'playing') return;
      page.mode = 'paused'; page.loop.stop(); release(); Play.pauseLabel(els.pause, true); status.say(T('play.paused'));
    };
    page.resume = function () {
      if (page.mode !== 'paused') return;
      page.mode = 'playing'; Play.pauseLabel(els.pause, false); status.say(''); page.loop.start();
    };
    function toggle() { if (page.mode === 'playing') page.pause(); else page.resume(); }
    // The loop stops, input lets go, and the screen shows where it ended (a landing, before the next lander).
    page.halt = function () { page.loop.stop(); release(); page.refresh(); };
    page.keepBest = function () {
      var st = o.state();
      if (page.best && st.score > page.best.score) { page.best.score = st.score; Play.save(o.bestKey, page.best); }
    };
    function endStats() {
      var st = o.state();
      return o.stats ? o.stats() : [[T('play.score'), Play.num(st.score)], [T('play.best'), Play.num(page.best.score)]];
    }
    function showEnd(stats) {
      window.ZimiShell.endSheet({ result: o.result || 'over', stats: stats || endStats() });
      page.armLater('over');
    }
    page.finish = function () {
      page.mode = 'over'; page.loop.stop(); els.pause.disabled = true; Play.pauseLabel(els.pause, false); release();
      page.keepBest();
      if (o.onFinish) o.onFinish();
      lastEnd = { stats: endStats() };
      page.refresh(); showEnd(lastEnd.stats);
    };

    els.newBtn.addEventListener('click', function () { page.begin(); });
    els.pause.addEventListener('click', toggle);
    (o.resumeOnStage ? page.pad.stage : els.cv).addEventListener('pointerdown', function () { if (page.mode === 'paused') page.resume(); });
    Play.onHidden(page.pause);
    var game = { inProgress: function () { return inProgress.indexOf(page.mode) >= 0; } };
    if (o.sound) game.sound = true;
    if (page.best) game.stats = function () { return o.alwaysBest || page.best.score ? [[T('play.best'), Play.num(page.best.score)]] : []; };
    window.ZimiShell.game(game);

    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('.ar-sheet:not([hidden])')) return;
      var k = KEY && KEY[e.key];
      if (k) { e.preventDefault(); keyHeld[k] = true; }
      else if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { e.preventDefault(); if (page.mode === 'playing' || page.mode === 'paused') toggle(); }
    });
    if (KEY) {
      document.addEventListener('keyup', function (e) { var k = KEY[e.key]; if (k) keyHeld[k] = false; });
      window.addEventListener('blur', release);
    }

    // A run in progress or over is kept; it comes back paused (or on its end sheet).
    function save() {
      var m = page.mode, d;
      if (m === 'ready') return null;
      if (o.endSaved) return m === 'over' ? (lastEnd ? { end: lastEnd } : null) : m === 'playing' || m === 'paused' ? { st: o.snapshot() } : null;
      d = { runId: page.runId, over: m === 'over', st: o.snapshot() };
      if (o.pack) o.pack(d);
      return d;
    }
    function load(d) {
      if (!d) return false;
      if (o.endSaved && d.end) {
        if (armed) armed.cancel();
        if (o.idle) o.idle();
        page.mode = 'over'; lastEnd = d.end; page.refresh(); showEnd(d.end.stats || d.end);
        return true;
      }
      if (!d.st || o.restore(d.st, d) === false) return false;
      if (armed) { armed.cancel(); armed = null; }
      if (d.runId !== undefined) page.runId = d.runId;
      page.refresh();
      if (d.over) { page.mode = 'over'; els.pause.disabled = true; setTimeout(function () { showEnd(); }, 0); return true; }
      page.mode = 'paused'; els.pause.disabled = false; Play.pauseLabel(els.pause, true); status.say(T('play.paused'));
      return true;
    }
    page.start = function () {
      window.addEventListener('resize', o.layout);
      o.layout();
      if (o.idle) { o.idle(); page.mode = 'ready'; page.refresh(); } else page.hud();
      page.arm();
      window.ZimiShell.persist({ save: save, load: load });
    };
    return page;
  };

  root.ArcadePlay = Play;
})(this);
