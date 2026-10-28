/* ZimiGames: controllers. Any Gamepad API controller (USB or Bluetooth) drives the keys the games already read, so
   no game knows a controller is there and a keyboard and a controller work together.

     D-pad or left stick   the arrow keys (held: they repeat, as a keyboard's do)
     A                     Space, or a click on what has focus (a button, a tile)
     B                     closes an open sheet; else Undo; else Escape (pause)
     Start                 the Menu

   Arrow keys a game does not use move focus to the nearest thing in that direction, so the shelf, the Menu and every
   sheet can be walked with the D-pad. shell.js loads this file the first time a controller reports in; the pure
   parts (reading pads, repeat timing, choosing where focus goes) are tested in node. Several controllers act as one. */
(function (root) {
  'use strict';

  var ROW_PX = 24, STICK_DEAD = 0.5, REPEAT_DELAY_MS = 380, REPEAT_EVERY_MS = 110;
  // The standard mapping's buttons and the left stick's axes.
  var BUTTON = { a: 0, b: 1, start: 9, up: 12, down: 13, left: 14, right: 15 };
  var DIRECTIONS = ['up', 'down', 'left', 'right'];
  var KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: ' ' };
  var KEY_CODE = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32, Escape: 27 };
  var KEY_NAME = { ' ': 'Space' };
  var CLICKABLE = 'a[href], button, summary, input:not([type="text"]):not([type="search"]), [role="button"]';
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  var DIALOG = '[role="dialog"]:not([hidden]), .ar-sheet:not([hidden]), .gs-sheet:not([hidden])';

  // ── Pure: pads in, what is held out ──────────────────────────────────────
  function pressed(b) { return !!b && (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5); }

  // Every connected pad folded into one set of held inputs.
  function held(pads) {
    var h = { up: false, down: false, left: false, right: false, a: false, b: false, start: false };
    (pads || []).forEach(function (p) {
      if (!p || p.connected === false) return;
      var bs = p.buttons || [], ax = p.axes || [];
      Object.keys(BUTTON).forEach(function (k) { if (pressed(bs[BUTTON[k]])) h[k] = true; });
      if (ax[0] <= -STICK_DEAD) h.left = true;
      if (ax[0] >= STICK_DEAD) h.right = true;
      if (ax[1] <= -STICK_DEAD) h.up = true;
      if (ax[1] >= STICK_DEAD) h.down = true;
    });
    // Opposite directions cancel rather than both fire.
    if (h.left && h.right) h.left = h.right = false;
    if (h.up && h.down) h.up = h.down = false;
    return h;
  }

  // Edge and repeat timing. step(now, held) returns [{ input, kind: 'down' | 'repeat' | 'up' }].
  function stepper() {
    var since = {}, next = {}, was = {};
    return function (now, h) {
      var out = [];
      Object.keys(h).forEach(function (k) {
        if (h[k] && !was[k]) { since[k] = now; next[k] = now + REPEAT_DELAY_MS; out.push({ input: k, kind: 'down' }); }
        else if (h[k] && DIRECTIONS.indexOf(k) >= 0 && now >= next[k]) { next[k] = now + REPEAT_EVERY_MS; out.push({ input: k, kind: 'repeat' }); }
        else if (!h[k] && was[k]) out.push({ input: k, kind: 'up' });
        was[k] = h[k];
      });
      return out;
    };
  }

  // The nearest of `rects` ({ x, y, w, h }, index kept) from `from` in a direction, or -1. Straight ahead beats
  // off to the side: the cross distance counts double.
  function nearest(from, rects, dir) {
    var fx = from.x + from.w / 2, fy = from.y + from.h / 2, best = -1, bestScore = Infinity;
    rects.forEach(function (r, i) {
      var dx = r.x + r.w / 2 - fx, dy = r.y + r.h / 2 - fy;
      var along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
      var across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (along < 2) return;
      var score = along + 2 * across;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  var api = { held: held, stepper: stepper, nearest: nearest, STICK_DEAD: STICK_DEAD, REPEAT_DELAY_MS: REPEAT_DELAY_MS, REPEAT_EVERY_MS: REPEAT_EVERY_MS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.ZimiGamepad = api;

  // ── The page ─────────────────────────────────────────────────────────────
  var d = root.document;
  if (!d || !root.navigator || !root.navigator.getGamepads) return;
  var step = stepper(), raf = 0, aClicked = false;
  var html = d.documentElement;

  function key(type, k, repeat) {
    var target = d.activeElement || d.body;
    var e = new root.KeyboardEvent(type, { key: k, code: KEY_NAME[k] || k, keyCode: KEY_CODE[k], which: KEY_CODE[k], repeat: !!repeat, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  }
  function visible(e) {
    var r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = root.getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }
  function openDialog() {
    var all = d.querySelectorAll(DIALOG), i;
    for (i = all.length - 1; i >= 0; i--) if (visible(all[i])) return all[i];
    return null;
  }
  function focusables() {
    var scope = openDialog() || d;
    return Array.prototype.filter.call(scope.querySelectorAll(FOCUSABLE), visible);
  }
  function focusAt(e) {
    e.focus({ preventScroll: true });
    if (e.scrollIntoView) e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // Where focus lands first: the top left of the play area, not the bar or a search box.
  function firstOf(list) {
    var play = list.filter(function (e) { return !e.closest('.ar-bar, header') && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName); });
    var pool = play.length ? play : list;
    var tops = pool.map(function (e) { var r = e.getBoundingClientRect(); return { e: e, row: Math.round(r.top / ROW_PX), x: r.left }; });
    tops.sort(function (a, b) { return a.row - b.row || a.x - b.x; });
    return tops[0].e;
  }
  // The arrow was not the game's: walk focus. With nothing focused yet, the first press only lands focus.
  function walk(dir) {
    var list = focusables(), from = d.activeElement;
    if (!list.length) return;
    if (!from || from === d.body || list.indexOf(from) < 0) {
      focusAt(firstOf(list));
      return;
    }
    var rects = list.map(function (e) { var r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    var f = from.getBoundingClientRect();
    var i = nearest({ x: f.left, y: f.top, w: f.width, h: f.height }, rects, dir);
    if (i >= 0 && list[i] !== from) focusAt(list[i]);
  }
  function back() {
    if (openDialog()) { key('keydown', 'Escape'); key('keyup', 'Escape'); return; }
    var undo = d.querySelector('.ar-bar [id$="undo"]');
    if (undo && !undo.disabled && !undo.hidden && visible(undo)) { undo.click(); return; }
    key('keydown', 'Escape'); key('keyup', 'Escape');
  }
  function menu() {
    var S = root.ZimiShell;
    if (!S || !S.openMenu) return;
    var sheet = d.querySelector('.gs-sheet');
    if (sheet && !sheet.hidden) S.closeMenu(); else S.openMenu();
  }
  function act(ev) {
    var i = ev.input, k = ev.kind;
    if (DIRECTIONS.indexOf(i) >= 0) {
      if (k === 'up') { key('keyup', KEY[i]); return; }
      var e = key('keydown', KEY[i], k === 'repeat');
      if (!e.defaultPrevented) walk(i);
    } else if (i === 'a') {
      var on = d.activeElement;
      if (k === 'down') {
        aClicked = !!on && on !== d.body && on.matches && on.matches(CLICKABLE);
        if (aClicked) on.click(); else key('keydown', ' ');
      } else if (k === 'up' && !aClicked) key('keyup', ' ');
    } else if (k === 'down' && i === 'b') back();
    else if (k === 'down' && i === 'start') menu();
  }

  function poll(now) {
    raf = 0;
    var pads = Array.prototype.slice.call(root.navigator.getGamepads() || []).filter(function (p) { return p && p.connected; });
    if (!pads.length) return;
    if (!d.hidden) {
      var events = step(now, held(pads));
      if (events.length) { html.classList.add('gs-pad'); events.forEach(act); }
    }
    raf = root.requestAnimationFrame(poll);
  }
  function start() { if (!raf) raf = root.requestAnimationFrame(poll); }

  d.addEventListener('pointerdown', function () { html.classList.remove('gs-pad'); }, true);
  root.addEventListener('gamepadconnected', start);
  d.addEventListener('visibilitychange', function () { if (!d.hidden) start(); });
  start();
})(typeof globalThis !== 'undefined' ? globalThis : window);
