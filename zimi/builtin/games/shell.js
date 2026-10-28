/* ZimiGames: the shell every game shares. Our own code, GPL-3.0. No network, no modules.

   One bar (back, title, one stat, Undo or Pause, Menu) and one Menu sheet with the same rows in every
   game: New game, Settings, How to play, Stats, About this game (Watch and learn and History sit
   before Stats in the games that have them). The rules are docs/design/games.md.

   It loads synchronously in <head> (scripts/games_shell.py writes the tag), so the settings
   are on <html> before the first paint; the bar and the sheet are built when the page is
   ready. A game's own buttons are not rewritten: the shell moves them into the Menu and
   clicks the originals, so every game's own code keeps working as it was.

   A game may tell the shell more (all optional):
     ZimiShell.game({ stats: fn -> text or [text], sound: true, hints: true, inProgress: fn, about: fn -> text,
                      settings: fn -> [nodes] (the game's own rows in Settings, built each time the pane opens; use .gs-row, .gs-seg),
                      menu: fn -> { options: [nodes] }, newGame: fn,
                      moveTimer: true, watch: { script, start(ctl), stop(kind) } })
   and reads the settings with ZimiShell.settings.get('anim'), etc.

   What a game calls (every string goes through T, see text.js):

     ZimiShell.sheet({ title, text, body: [nodes], actions: [{ label, primary, onclick }], onClose })
         One sheet anatomy for every start sheet and dialog: the pebble and the title, one line of text,
         option rows, actions last with the primary last. Focus lands on the sheet itself; Esc closes.
         Use it only when the choice changes the game (players, seats, mode); a game with no real choice
         opens ready to play with one line ("Tap to start"). Returns { el, close }.

     ZimiShell.endSheet({ result: 'win' | 'lose' | 'draw' | 'over', title, name, team, stats: [[label, value]], extra: [nodes under the chips], after, onNew, onClose, newLabel })
         The end of a game, the same in every game. The title is the result ("You win", "You lose", "Draw";
         `name` makes it "Name wins" for games with several people; 'over' is "Game over", for solo score
         games with no win state). At most two stat chips, then Close and New game in amber. It appears
         `after` ms from now (default 600: call it when the last animation ends) and ignores keys for its
         first 600 ms, so a player still pressing Space or Enter cannot dismiss or restart it unseen.
         onNew defaults to the game's own New game; a loss looks like a win. Closing the sheet leaves the result line and a large
         New game over the bottom of the board until a new game starts, so no game is a dead end. `newLabel` (T('shell.nextLevel'))
         names the amber button for a game that goes on to a next level rather than a new game.

     ZimiShell.status(el)            makes el the game's one status line (role=status, aria-live=polite);
                                     returns { say(text), reason(text, ms) } where reason shows for 2 s,
                                     then goes back to the line before it.
     ZimiShell.shake(el)             the illegal-move shake (120 ms; an outline flash under reduced motion).
     ZimiShell.reducedMotion()       the one answer: the device asks for less motion, or Animation is Off.
     ZimiShell.settings, .anim(), .ms(n), .sound(), .stripClock(text)   as before.

     ZimiShell.persist({ save, load })
         Never lose a game: leaving a game and coming back puts the same position on the screen. `save()` returns
         the game's state as plain JSON (null when there is nothing worth keeping: no move made yet). The shell
         calls it when the page is hidden or closed and shortly after every tap or key, and keeps the result in
         localStorage under the page's name. `load(data)` is called at once if something is kept; return false (or
         throw) when it no longer fits and the shell forgets it. A game that builds its own state first can
         skip `load` and ask ZimiShell.saved() for the data instead. A finished game is saved as finished (so
         it comes back to its end sheet). Only an explicit New game or a puzzle's day rolling over discards a
         save: the game then returns null from save(), or calls ZimiShell.forget(). A kept save is never written over or
         removed until the game has read it (ZimiShell.saved()) or forgotten it, so a library game that reads it once the
         library answers loses nothing to a tap or a pagehide before then. Arcade games restore paused.
     ZimiShell.saved()  the kept data or null.   ZimiShell.saveNow()  save right now.   ZimiShell.forget()  discard.

   Where a game overrides a shared rule it says why in a comment where it happens. */
(function (root) {
  'use strict';
  var d = root.document;
  // ZimiText first (text.js beside this file): it must exist before anything below draws a string. A page
  // that did not load it writes the tag here, synchronously, so the strings are ready before the first paint.
  if (!root.ZimiText && d && d.currentScript && d.currentScript.src && d.readyState === 'loading') {
    d.write('<script src="' + d.currentScript.src.replace(/shell\.js(\?.*)?$/, 'text.js') + '"><\/script>');
  }
  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };
  // The folder this file is in: a page one level down (puzzles/<name>.html) finds games.json and its manual from here, not from itself.
  var HOME = d && d.currentScript && d.currentScript.src ? d.currentScript.src.replace(/shell\.js(\?.*)?$/, '') : '';

  // ── a failure to start is never silent ──
  // A script that did not load, or threw while the page was starting (a kept old file beside a new one, a failed
  // fetch), left a blank page. It now says so, with a Reload. Plain English on purpose: the strings (text.js) may be
  // the very file that failed. Errors later in play are the game's own and are not announced here.
  var START_GRACE_MS = 2500;
  var starting = true, failed = false;
  // The banner speaks the player's language when the strings loaded (text.js is rarely the file that failed); plain English only if not.
  function bannerText(key, english) { return root.ZimiText && root.ZimiText.has && root.ZimiText.has(key) ? T(key) : english; }
  function failedToStart(late) {
    if (failed || (!starting && !late) || !d) return;
    failed = true;
    function paint() {
      var box = d.createElement('div');
      box.setAttribute('role', 'alert');
      box.dir = (d.documentElement && d.documentElement.dir) || 'ltr';
      box.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:2147483647;padding:14px 16px;border-radius:12px;background:#fff;color:#1b2233;border:2px solid #c62828;font:600 16px/1.35 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;justify-content:space-between';
      var msg = d.createElement('span'); msg.textContent = bannerText('shell.failedStart', 'This game failed to start.');
      var btn = d.createElement('button'); btn.type = 'button'; btn.textContent = bannerText('shell.reload', 'Reload');
      btn.style.cssText = 'font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#d97706;color:#fff;cursor:pointer';
      btn.addEventListener('click', function () { root.location.reload(); });
      box.appendChild(msg); box.appendChild(btn);
      (d.body || d.documentElement).appendChild(box);
    }
    if (d.body) paint(); else d.addEventListener('DOMContentLoaded', paint);
  }
  // A thrown error only counts when the game then has nothing on screen: an error from a later corner of a game
  // that did start (a ResizeObserver loop note, a late listener) must not cover a working table with an alarm.
  var NOTHING_DRAWN_MIN = 3;
  function nothingDrawn() {
    // A game that put up its own sheet (a setup, a start, a menu) ran far enough to draw it: that is a start
    // (ZimiKart's setup covers a board not drawn until Start, and read as a blank page).
    var sheets = d.querySelectorAll('.gs-sheet:not([hidden]) button, .ar-sheet:not([hidden]) button');
    for (var k = 0; k < sheets.length; k++) { var b = sheets[k].getBoundingClientRect(); if (b.width > 4 && b.height > 4) return false; }
    var n = 0, els = d.querySelectorAll('body *');
    for (var i = 0; i < els.length && n < NOTHING_DRAWN_MIN; i++) {
      var el = els[i];
      if (el.closest && el.closest('.ar-bar, .gs-sheet, .ar-sheet, script, style')) continue;
      if (!/^(CANVAS|SVG|svg|BUTTON|IMG)$/.test(el.tagName) && !(el.childNodes.length === 1 && el.firstChild.nodeType === 3 && el.textContent.trim())) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) n++;
    }
    return n < NOTHING_DRAWN_MIN;
  }
  function threwWhileStarting(e) {
    if (e && /ResizeObserver loop/.test(e.message || '')) return;
    root.setTimeout(function () { if (nothingDrawn()) failedToStart(true); }, START_GRACE_MS);
  }
  root.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== root && t.tagName !== 'SCRIPT') return;   // an image or a sound that did not load is not a start
    // Either way the banner waits and asks the page: a helper that failed to load or a stray throw can leave a game
    // that plays fine, and only a page with nothing of the game on it is a failure to start. The cause is kept for a report.
    var why = t && t !== root && t.tagName === 'SCRIPT' ? 'script did not load: ' + (t.src || '') : (e && (e.message || e.reason)) || 'error';
    try { root.localStorage.setItem('zimi.games.lastStartError', JSON.stringify({ at: Date.now(), page: root.location.pathname, why: String(why).slice(0, 300) })); } catch (x) {}
    if (root.console) root.console.warn('ZimiGames start:', why);
    if (starting || (t && t.tagName === 'SCRIPT')) threwWhileStarting(e);
  }, true);
  root.addEventListener('unhandledrejection', function (e) { if (starting) threwWhileStarting(e); });
  root.addEventListener('load', function () { root.setTimeout(function () { starting = false; }, START_GRACE_MS); });
  // An app, not a page to read: a reader (Zimi's) leaves out highlight, note and lookup.
  if (d.head && !d.querySelector('meta[name="zimi-app"]')) {
    var app = d.createElement('meta'); app.name = 'zimi-app'; d.head.appendChild(app);
  }
  // The tab icon is the ZIM's felt with the pebble alone (favicon.svg); the full tile is mush at 16px. Found beside this script.
  if (d.head && !d.querySelector('link[rel~="icon"]') && d.currentScript && d.currentScript.src) {
    var fav = d.createElement('link'); fav.rel = 'icon'; fav.type = 'image/svg+xml';
    fav.href = d.currentScript.src.replace(/shell\.js(\?.*)?$/, 'favicon.svg'); d.head.appendChild(fav);
  }
  var KEY = 'zimi.games.settings';
  var DEFAULTS = { timer: 'show', moveTimer: 0, hints: 'on', anim: 'normal', sound: 'off', confirm: 'on' };
  // Each choice is [value, string id]; a binary setting is On and Off. A name never carries its state.
  var CHOICES = {
    timer: [['show', 'shell.on'], ['hide', 'shell.off']],
    moveTimer: [[0, 'shell.off'], [15, 'shell.seconds'], [30, 'shell.seconds'], [60, 'shell.seconds']],
    hints: [['on', 'shell.on'], ['off', 'shell.off']],
    anim: [['normal', 'shell.normal'], ['fast', 'shell.fast'], ['off', 'shell.off']],
    sound: [['off', 'shell.off'], ['on', 'shell.on']],
    confirm: [['on', 'shell.on'], ['off', 'shell.off']]
  };
  var LABEL_IDS = { timer: 'shell.set.timer', moveTimer: 'shell.set.moveTimer', hints: 'shell.set.hints', anim: 'shell.set.anim', sound: 'shell.set.sound', confirm: 'shell.set.confirm' };
  function labelOf(key) { return T(LABEL_IDS[key]); }
  function choiceText(c) { return T(c[1], { n: c[0] }); }
  // Elements that are only a clock (a clock with a score in it is trimmed by stripClock instead).
  var TIMER_SELECTOR = '#su-clock, #mj-time, [data-gs-timer]';
  var CLOCK_PREFIX = /^\d+:\d\d(?: · )?/;
  var HINT_SELECTOR = '[id$="-hint"], [id$="-hints"]';
  var MOVE_TIMER_TICK_MS = 250;

  // ── the page ──
  var ID = (root.location.pathname.split('/').pop() || '').replace(/\.html?$/, '') || 'index';
  var Shell = { id: ID };
  root.ZimiShell = Shell;

  function h(tag, attrs, kids) {
    var e = d.createElement(tag), k;
    for (k in (attrs || {})) {
      if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else if (k === 'onclick') e.addEventListener('click', attrs[k]); else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (n) { if (n) e.appendChild(typeof n === 'string' ? d.createTextNode(n) : n); });
    return e;
  }

  // ── settings: global, with per-game overrides ──
  var data = { g: {}, games: {} };
  function load() {
    try {
      var v = JSON.parse(root.localStorage.getItem(KEY));
      data = { g: (v && v.g) || {}, games: (v && v.games) || {} };
    } catch (e) { data = { g: {}, games: {} }; }
  }
  function save() { try { root.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* private window: settings last for this page */ } }
  function deviceReducedMotion() { try { return !!root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function valid(key, value) { return (CHOICES[key] || []).some(function (c) { return c[0] === value; }); }

  var listeners = [];
  var settings = Shell.settings = {
    // The value in force for a game: its own choice, else the global one, else the default.
    get: function (key, game) {
      var o = (data.games[game || ID] || {})[key];
      if (valid(key, o)) return o;
      if (valid(key, data.g[key])) return data.g[key];
      return key === 'anim' && deviceReducedMotion() ? 'off' : DEFAULTS[key];
    },
    // Has anybody chosen this (so a game should not override it with its own default)?
    explicit: function (key, game) { return valid(key, (data.games[game || ID] || {})[key]) || valid(key, data.g[key]); },
    hasOverride: function (key, game) { return valid(key, (data.games[game || ID] || {})[key]); },
    // scope 'all' (default) or 'game'. Choosing for all games drops this game's own choice.
    set: function (key, value, scope) {
      if (!valid(key, value)) return;
      if (scope === 'game') { (data.games[ID] = data.games[ID] || {})[key] = value; }
      else { data.g[key] = value; if (data.games[ID]) delete data.games[ID][key]; }
      save(); apply(); emit(key);
    },
    // Forget this game's own choices.
    reset: function (game) { delete data.games[game || ID]; save(); apply(); emit('*'); },
    hasOverrides: function (game) { return Object.keys(data.games[game || ID] || {}).length > 0; },
    on: function (fn) { listeners.push(fn); },
    off: function (fn) { listeners = listeners.filter(function (f) { return f !== fn; }); },
    reload: function () { load(); apply(); emit('*'); }
  };
  function emit(key) { listeners.slice().forEach(function (fn) { try { fn(key); } catch (e) { /* a listener must not stop the others */ } }); }

  // The settings as attributes on <html>, for the stylesheet.
  function apply() {
    var r = d.documentElement;
    r.setAttribute('data-timer', settings.get('timer'));
    r.setAttribute('data-anim', settings.get('anim'));
    r.setAttribute('data-hints', settings.get('hints'));
    r.setAttribute('data-sound', settings.get('sound'));
  }
  load(); apply();
  d.documentElement.classList.add('gs');
  // Rapid taps on a board, a pad or a key (ZimiKart, Echo, the arcade) double-tapped into a text selection and the iOS callout.
  // Nothing on a game page is for selecting but its reading: How to play and About, its text, and its fields.
  if (d.head) {
    var noSelect = d.createElement('style');
    noSelect.textContent = 'html.gs body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
      'html.gs :is(.gs-help,.gs-about,.gs-text,.bg-help,input,textarea,select,[contenteditable]){-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}';
    d.head.appendChild(noSelect);
  }
  root.addEventListener('storage', function (e) { if (e.key === KEY) settings.reload(); });

  // Animation helpers for games that time things in script.
  var SPEED_SCALE = { normal: 1, fast: 0.35, off: 0 };
  Shell.anim = function () { return settings.get('anim'); };
  Shell.ms = function (ms) { return Math.round(ms * SPEED_SCALE[settings.get('anim')]); };
  // A clock's text without its time when the timer is hidden ("0:42 · 12" becomes "12").
  Shell.stripClock = function (text) { return settings.get('timer') === 'hide' ? String(text).replace(CLOCK_PREFIX, '') : text; };
  // The bar's one stat: a clock with something after it ("0:42 · 12", "0:42 · 3-1") is the clock alone while the timer is
  // shown, and what follows it when the timer is hidden. A text with no clock is left as the game wrote it.
  var STAT_SEP = ' \u00b7 ', CLOCK_TEXT = /^\d+:\d\d(:\d\d)?$/;
  Shell.barStat = function (text) {
    var parts = String(text).split(STAT_SEP);
    if (parts.length < 2 || !CLOCK_TEXT.test(parts[0])) return text;
    return settings.get('timer') === 'hide' ? parts[1] : parts[0];
  };
  Shell.sound = function () { return settings.get('sound') === 'on'; };

  // ── what a game tells us ──
  var game = Shell.gameInfo = {};
  Shell.game = function (info) { Object.keys(info || {}).forEach(function (k) { game[k] = info[k]; }); return Shell; };

  // ── saved games: leaving and coming back never loses the position ──
  var SAVE_KEY = 'zimi.games.save.' + ID, SAVE_VERSION = 1, SAVE_DEBOUNCE_MS = 400;
  var saver = null, saveTimer = 0, saveWired = false;
  // A kept save the game has not read yet (library games read it only once the library answers) is never touched:
  // a tap or a pagehide before then has nothing of the game's to write, and a null save() is not "forget".
  var saveUnread = false, saveRead = false;
  function readSave() {
    try {
      var v = JSON.parse(root.localStorage.getItem(SAVE_KEY));
      return v && v.v === SAVE_VERSION && v.data !== undefined && v.data !== null ? v.data : null;
    } catch (e) { return null; }
  }
  function forgetSave() { Shell.clearRest(); saveUnread = false; root.clearTimeout(saveTimer); try { root.localStorage.removeItem(SAVE_KEY); } catch (e) { /* blocked */ } }
  function writeSave() {
    root.clearTimeout(saveTimer);
    if (!saver || saveUnread) return;
    var data = null;
    try { data = saver.save(); } catch (e) { data = null; }
    try {
      if (data === null || data === undefined) root.localStorage.removeItem(SAVE_KEY);
      else root.localStorage.setItem(SAVE_KEY, JSON.stringify({ v: SAVE_VERSION, at: Date.now(), data: data }));
    } catch (e) { /* full or blocked: play on without it */ }
  }
  function saveSoon() { root.clearTimeout(saveTimer); saveTimer = root.setTimeout(writeSave, SAVE_DEBOUNCE_MS); }
  Shell.persist = function (opts) {
    saver = opts || null;
    if (!saveWired && saver) {
      saveWired = true;
      d.addEventListener('visibilitychange', function () { if (d.hidden) writeSave(); });
      root.addEventListener('pagehide', writeSave);
      ['pointerup', 'keyup'].forEach(function (t) { d.addEventListener(t, saveSoon, true); });
    }
    var kept = readSave();
    saveUnread = !!saver && !saver.load && kept !== null && !saveRead;
    if (saver && saver.load && kept !== null) {
      var fits = false;
      try { fits = saver.load(kept) !== false; } catch (e) { fits = false; }
      if (!fits) forgetSave();
    }
    return Shell;
  };
  Shell.saved = function () { saveRead = true; saveUnread = false; return readSave(); };
  Shell.saveNow = writeSave; Shell.forget = forgetSave;

  // ── the narrator: one line under the bar while a demo runs ──
  var strip = null;
  Shell.narrate = function (text) {
    var el = strip && strip.querySelector('.gs-watch-text');
    if (el) el.textContent = text || '';
  };

  // ── the move timer: a thin bar under the bar, for a person's turn ──
  var MS_PER_S = 1000, MOVE_TIMER_LOW_MS = 5000;   // the bar turns red with this long left
  var mt = { key: undefined, timer: 0, left: 0, total: 0, expire: null, bar: null, label: null, held: false };
  Shell.moveTimer = {
    supported: function () { return !!game.moveTimer; },
    seconds: function () { return +settings.get('moveTimer') || 0; },
    // Begin a person's turn. onExpire runs when the time is up.
    start: function (onExpire) {
      Shell.moveTimer.stop();
      var secs = Shell.moveTimer.seconds();
      if (!secs || !mt.bar) return;
      mt.total = mt.left = secs * MS_PER_S; mt.expire = onExpire;
      mt.bar.hidden = false; paintTimer();
      mt.timer = root.setInterval(function () {
        if (mt.held || d.hidden) return;
        mt.left -= MOVE_TIMER_TICK_MS; paintTimer();
        if (mt.left <= 0) { var f = mt.expire; Shell.moveTimer.stop(); if (f) f(); }
      }, MOVE_TIMER_TICK_MS);
    },
    stop: function () { root.clearInterval(mt.timer); mt.timer = 0; mt.key = undefined; mt.expire = null; if (mt.bar) mt.bar.hidden = true; },
    hold: function (on) { mt.held = !!on; }
  };
  // A person's turn begins (active) or the turn is not a person's: one call for both.
  // `key` names the turn (a move count): the same turn asked again keeps its clock running.
  Shell.turn = function (active, onExpire, key) {
    if (!active) { Shell.moveTimer.stop(); return; }
    if (mt.timer && mt.key === key && key !== undefined) return;
    Shell.moveTimer.start(onExpire); mt.key = key;
  };
  function paintTimer() {
    var frac = Math.max(0, mt.left / mt.total);
    mt.bar.firstChild.style.transform = 'scaleX(' + frac + ')';
    mt.label.textContent = T('shell.seconds', { n: Math.ceil(Math.max(0, mt.left) / MS_PER_S) });
    mt.bar.classList.toggle('gs-low', mt.left <= MOVE_TIMER_LOW_MS);
  }

  // ── the bar ──
  var bar, menuBtn, newBtn, extras = [], holder, hasUndo = false;
  function isNewLike(b) { return /(^|-)(new|menu|level|newgame)$/.test(b.id) || /^new\b/i.test(b.textContent.trim()); }
  // data-gs-bar: a page's own button that stays in the bar (like Undo), and is absent while disabled (the puzzles' Redo).
  function keepInBar(b) { return /undo$/.test(b.id) || /pause$/.test(b.id) || b.id === 'ms-flagmode' || (b.hasAttribute('data-gs-bar') && !inZimi()); }   // in Zimi's own bar only Undo or Pause fit: the rest go to the Menu
  function buildBar() {
    bar = d.querySelector('.ar-bar');
    if (!bar) return false;
    var controls = Array.prototype.filter.call(bar.children, function (c) { return c.classList.contains('ar-btn'); });
    controls.forEach(function (b) {
      if (/undo$/.test(b.id)) hasUndo = true;
      if (keepInBar(b)) return;
      if (b.id === 'zc-menu') { b.hidden = true; return; }
      if (!newBtn && isNewLike(b)) { newBtn = b; b.hidden = true; return; }
      if (isNewLike(b)) { b.hidden = true; return; }
      extras.push(b);
    });
    // Out of the bar at once; the Menu puts them back in its own sheet.
    holder = h('div', { hidden: '' }, extras);
    d.body.appendChild(holder);
    // Timers are only a clock: tagged here so the stylesheet can hide them.
    Array.prototype.forEach.call(d.querySelectorAll(TIMER_SELECTOR), function (t) { t.setAttribute('data-gs-timer', ''); });
    // Back is one 44 px target with a name for screen readers; the page's own chevron text stays unseen.
    var backLink = bar.querySelector('.ar-back');
    if (backLink) backLink.setAttribute('aria-label', T('shell.back'));
    menuBtn = h('button', { class: 'ar-btn gs-menu-btn', type: 'button', 'aria-haspopup': 'dialog', text: T('shell.menu') });
    menuBtn.addEventListener('click', openMenu);
    // The clock sits before the buttons, the Menu last.
    var firstBtn = Array.prototype.filter.call(bar.children, function (c) { return c.classList.contains('ar-btn') && !c.hidden; })[0];
    Array.prototype.forEach.call(bar.querySelectorAll('.ar-stat'), function (s) { bar.insertBefore(s, firstBtn || null); keepOneStat(s); });
    // An Undo that cannot be used (a fresh game) is absent, not ghosted.
    Array.prototype.forEach.call(bar.querySelectorAll('[id$="undo"], [data-gs-bar]'), hideWhileDisabled);
    bar.appendChild(menuBtn);
    // The move timer's thin bar, right under the header.
    mt.label = h('span', { class: 'gs-turn-n', 'aria-hidden': 'true' });
    mt.bar = h('div', { class: 'gs-turn', hidden: '', 'aria-hidden': 'true' }, [h('i'), mt.label]);
    bar.parentNode.insertBefore(mt.bar, bar.nextSibling);
    strip = h('div', { class: 'gs-watch', hidden: '', role: 'region', 'aria-label': T('shell.menu.watch') });
    mt.bar.parentNode.insertBefore(strip, mt.bar.nextSibling);
    return true;
  }

  // The stat is rewritten to the one value whenever a game paints it (the guard stops our own write from looping).
  function keepOneStat(el) {
    if (!root.MutationObserver) return;
    var fit = function () { var t = el.textContent, one = Shell.barStat(t); if (one !== t) el.textContent = one; };
    new root.MutationObserver(fit).observe(el, { childList: true, characterData: true, subtree: true });
    fit();
  }
  function hideWhileDisabled(btn) {
    var sync = function () { btn.hidden = btn.disabled; };
    if (root.MutationObserver) new root.MutationObserver(sync).observe(btn, { attributes: true, attributeFilter: ['disabled'] });
    sync();
  }

  // The tab's title, one format for every page: "Chess · ZimiGames" (the shelf is just "ZimiGames"). A page may be
  // written with its own ending (" - ZimiGames", ", an unfinished puzzle from Simon Tatham's ...") or none; the name is
  // what is left once those are taken off, and ZimiShell.setTitle(name) is how a page that renames itself says so.
  var TAB_SUFFIX = 'ZimiGames', TAB_SEP = ' \u00b7 ';
  function bareName(s) { return String(s || '').replace(/\s+[-\u00b7]\s+ZimiGames$/, '').replace(/,( an unfinished puzzle)? from .*$/, '').trim(); }
  Shell.setTitle = function (name) {
    name = bareName(name);
    d.title = !name || name === TAB_SUFFIX ? TAB_SUFFIX : name + TAB_SEP + TAB_SUFFIX;
  };

  function titleOf() {
    var t = d.querySelector('.ar-bar h1'), s = '';
    if (!t) return bareName(d.title);
    Array.prototype.forEach.call(t.childNodes, function (n) { if (n.nodeType === 3) s += n.nodeValue; });
    return s.trim() || d.title;
  }

  // A game's name and blurb in the player's language: game.<page>.title, .blurb, .tile in the string table (puzzles are
  // game.puzzles.<name>.*). Used for the bar's title, the tab, About, and every tile on the shelf and the puzzles page.
  function pageStem() {
    var m = /(?:^|\/)(puzzles\/)?([^/]+)\.html?$/.exec((root.location && root.location.pathname) || '');
    return m ? (m[1] ? 'puzzles.' : '') + m[2] : '';
  }
  function gameWord(stem, part) {
    var k = 'game.' + stem + '.' + part;
    return root.ZimiText && root.ZimiText.has(k) ? T(k) : '';
  }
  function hrefStem(href) {
    var m = /^(?:\.\/)?(puzzles\/)?([^/?#]+)\.html?(?:[?#].*)?$/.exec(href || '');
    return m ? (m[1] ? 'puzzles.' : '') + m[2] : '';
  }
  Shell.localizeTiles = function (scope) {
    Array.prototype.forEach.call((scope || d).querySelectorAll('a.ar-game[href]'), function (a) {
      var stem = hrefStem(a.getAttribute('href')), strong = a.querySelector('strong'), span = a.querySelector('.ar-game-text > span');
      var title = gameWord(stem, 'title'), blurb = gameWord(stem, 'tile') || gameWord(stem, 'blurb');
      if (strong && title) strong.textContent = title;
      if (span && blurb) span.textContent = blurb;
    });
  };
  // The bar's h1 is English in the page; it changes (and the name is returned) only when it still says exactly what the table's English says.
  function localizeName() {
    var h1 = d.querySelector('.ar-bar h1'), stem = pageStem(), en = root.ZimiText && root.ZimiText.table && root.ZimiText.table.en;
    if (!h1 || !stem || !en) return '';
    var node = Array.prototype.filter.call(h1.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); })[0];
    if (!node) return '';
    var keys = ['game.' + stem + '.title'].concat(stem === 'puzzles' ? ['shelf.section.puzzles'] : []);
    for (var i = 0; i < keys.length; i++) {
      if (en[keys[i]] === node.nodeValue.trim() && root.ZimiText.has(keys[i])) { node.nodeValue = T(keys[i]); return node.nodeValue; }
    }
    return '';
  }

  // ── motion, status and the shake ──
  // The one answer to "should this move?": the device asks for less motion, or Animation is Off.
  function reducedMotion() { return deviceReducedMotion() || settings.get('anim') === 'off'; }
  Shell.reducedMotion = reducedMotion;
  var SHAKE_MS = 120, REASON_MS = 2000;
  // The illegal-move shake: 120 ms sideways, or an outline flash for a player who asked for less motion.
  Shell.shake = function (el) {
    if (!el) return;
    var cls = reducedMotion() ? 'gs-flash' : 'gs-shake';
    el.classList.remove('gs-shake', 'gs-flash');
    void el.offsetWidth;
    el.classList.add(cls);
    root.setTimeout(function () { el.classList.remove(cls); }, reducedMotion() ? REASON_MS / 4 : SHAKE_MS);
  };
  // A game's one status line: polite for screen readers, say() for the line, reason() for a refusal that gives way
  // to the line before it after two seconds.
  Shell.status = function (el) {
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    var line = el.textContent, timer = 0;
    return {
      say: function (text) { line = text; root.clearTimeout(timer); el.textContent = text; },
      reason: function (text, ms) {
        root.clearTimeout(timer); el.textContent = text;
        timer = root.setTimeout(function () { el.textContent = line; }, ms || REASON_MS);
      }
    };
  };

  // ── the arcade pause: opening the Menu and leaving the page both pause a running game ──
  function pauseButton() { return d.querySelector('.ar-bar [id$="pause"]'); }
  function pauseNow() {
    var pause = pauseButton();
    if (pause && !pause.disabled && /^pause/i.test(pause.textContent.trim())) { try { pause.click(); } catch (e) { /* not running */ } }
  }
  function watchBlur() {
    d.addEventListener('visibilitychange', function () { if (d.hidden) pauseNow(); });
    root.addEventListener('blur', pauseNow);
    root.addEventListener('pagehide', pauseNow);
  }

  // ── the status line is one aria-live slot ──
  function markStatusLines() {
    Array.prototype.forEach.call(d.querySelectorAll('.bg-status, .pl-msg, .ms-msg, .ct-status'), function (el) {
      if (!el.getAttribute('role')) el.setAttribute('role', 'status');
      if (!el.getAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
    });
  }

  // ── records: a line of wins and losses is hidden until there is a first game, and the number is a sans figure ──
  var RECORD_SELECTOR = '.bg-stats, #wk-stats';
  function recordsCount(el) { return /[1-9]/.test(el.textContent); }
  function watchRecords() {
    Array.prototype.forEach.call(d.querySelectorAll(RECORD_SELECTOR), function (el) {
      var paint = function () { el.hidden = !recordsCount(el); };
      paint();
      if (root.MutationObserver) new root.MutationObserver(paint).observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  // ── sheets ──
  // The one anatomy: the pebble and the title, one line of text, option rows, actions with the primary last.
  // Focus goes to the sheet itself, never into a field; Esc closes it; a tap on the scrim closes it.
  var SHEET_GUARD_MS = 600;
  function sheetKeys(el, card, close, guard) {
    var openedAt = Date.now();
    el.addEventListener('keydown', function (e) {
      if (guard && Date.now() - openedAt < SHEET_GUARD_MS) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(card.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]'), function (n) { return n.offsetParent !== null; });
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (d.activeElement === first || d.activeElement === card)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && d.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  Shell.sheet = function (opts) {
    var prev = d.activeElement, el, card, api = { el: null, close: null };
    card = h('div', { class: 'ar-sheet-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title, tabindex: '-1' });
    card.appendChild(h('h2', { text: opts.title }));
    if (opts.text) card.appendChild(h('p', { class: 'gs-text', text: opts.text }));
    (opts.body || []).forEach(function (n) { card.appendChild(n); });
    api.close = function () {
      if (!api.el) return;
      api.el.remove(); api.el = null;
      if (prev && prev.focus && d.contains(prev)) try { prev.focus(); } catch (e) { /* gone */ }
      if (opts.onClose) opts.onClose();
    };
    if (opts.actions && opts.actions.length) {
      var row = h('div', { class: 'ar-sheet-actions' });
      opts.actions.forEach(function (a) {
        var b = h('button', { class: 'ar-btn' + (a.primary ? ' gs-primary' : ''), type: 'button', text: a.label });
        if (a.primary) b.setAttribute('aria-pressed', 'true');
        b.addEventListener('click', function () { if (a.keep) { if (a.onclick) a.onclick(); } else { api.close(); if (a.onclick) a.onclick(); } });
        row.appendChild(b);
      });
      card.appendChild(row);
    }
    el = api.el = h('div', { class: 'ar-sheet' }, [card]);
    el.addEventListener('pointerdown', function (e) { if (e.target === el) api.close(); });
    sheetKeys(el, card, api.close, !!opts.guard);
    d.body.appendChild(el);
    try { card.focus({ preventScroll: true }); } catch (e) { /* no focus */ }
    return api;
  };
  var END_TITLES = { win: 'shell.end.win', lose: 'shell.end.lose', draw: 'shell.end.draw', over: 'shell.end.over' };

  // ── the end of a game is a moment ──
  // A win lands: a pebble stamps the middle of the game, a ring opens from it, a few pebbles scatter and confetti in the
  // mark's own colours falls (about 1.8 s, the game's own flourish plays first), then the sheet comes up with its title heavier and its numbers counting up.
  // A loss is dignified: no motion over the board, the sheet settles in softly. A draw is plain. A tap, a key or the
  // sheet being asked for early skips the beat; under reduced motion there is none and the sheet is there at once.
  var BEAT_MS = 1800, COUNT_MS = 600, MOMENT_OUT_MS = 300, SKIP_SETTLE_MS = 250, SKIP_GRACE_MS = 450, SCATTER = 14, SCATTER_REACH = 120, CONFETTI = 44, CONFETTI_COLOURS = 5, GOLDEN = 2.399963, HAPTIC = { win: [14, 70, 26], lose: [30] };
  function haptic(result) {
    try { if (HAPTIC[result] && root.navigator && root.navigator.vibrate && !reducedMotion()) root.navigator.vibrate(HAPTIC[result]); } catch (e) { /* no haptics here */ }
  }
  Shell.haptic = haptic;
  function momentNode() {
    var kids = [h('i', { class: 'gs-m-ring' }), h('img', { class: 'gs-m-stamp', src: 'mark.svg', alt: '' })], i, a, r;
    for (i = 0; i < SCATTER; i++) {
      a = i * GOLDEN; r = SCATTER_REACH * (0.55 + 0.45 * ((i * 7) % 5) / 4);
      kids.push(h('i', { class: 'gs-m-bit gs-m-bit' + (i % 3), style: '--dx:' + Math.round(Math.cos(a) * r) + 'px;--dy:' + Math.round(Math.sin(a) * r) + 'px;--s:' + (6 + (i % 4) * 2) + 'px' }));
    }
    var rain = [];
    for (i = 0; i < CONFETTI; i++) {   // each piece's place, drift, turn and start is a function of its number: the same fall every win
      rain.push(h('i', { class: 'gs-m-conf gs-m-conf' + (i % CONFETTI_COLOURS), style: '--x:' + (((i * 0.618034) % 1) * 100).toFixed(1) + '%;--sway:' + (((i * 37) % 11) - 5) * 9 + 'px;--turn:' + (((i * 53) % 9) - 4) * 150 + 'deg;--delay:' + ((i * 29) % 13) * 40 + 'ms;--fall:' + (1050 + ((i * 17) % 7) * 70) + 'ms' }));
    }
    return h('div', { class: 'gs-moment', 'aria-hidden': 'true' }, [h('div', { class: 'gs-m-rain' }, rain), h('div', { class: 'gs-m-at' }, kids)]);
  }
  // The figures in the chips count up from nothing; the chip says its final value to a screen reader at once.
  function countUp(chips) {
    chips.forEach(function (c) {
      var b = c.querySelector('b'), to = b ? parseInt(b.textContent, 10) : NaN, text = b && b.textContent;
      if (!b || !/^\d+$/.test(text) || to < 2) return;
      c.setAttribute('aria-label', c.textContent);
      var t0 = null;
      (function step(now) {
        if (!b.isConnected) return;
        t0 = t0 === null ? now : t0;
        var k = Math.min(1, (now - t0) / COUNT_MS);
        b.textContent = k < 1 ? String(Math.round(to * (1 - Math.pow(1 - k, 3)))) : text;
        if (k < 1) root.requestAnimationFrame(step);
      })(root.performance ? root.performance.now() : 0);
      b.textContent = '0';
    });
  }
  // After a finished game's sheet is closed the board is not a dead end: the result and a large New game stay on it, over the
  // bottom of the screen, until a new game starts (by this button, the Menu, the game's own button or a discarded save).
  var rest = null;
  function clearRest() { if (rest) { rest.remove(); rest = null; } }
  Shell.clearRest = clearRest;
  function showRest(title, label, onNew) {
    clearRest();
    var btn = h('button', { class: 'ar-btn gs-primary gs-rest-new', type: 'button', 'aria-pressed': 'true', text: label });
    btn.addEventListener('click', function () { clearRest(); onNew(); });
    rest = h('div', { class: 'gs-rest', role: 'status' }, [h('p', { text: title }), btn]);
    d.body.appendChild(rest);
    if (newBtn) newBtn.addEventListener('click', clearRest, { once: true });
  }
  Shell.endSheet = function (opts) {
    // `title`: the caller's own headline, already in the player's language ("2nd of 5", "Solved"), over the result's.
    var title = opts.title ? String(opts.title) : opts.name ? T(opts.team ? 'shell.end.winsTeam' : 'shell.end.wins', { name: opts.name }) : T(END_TITLES[opts.result] || END_TITLES.over);
    var chips = (opts.stats || []).slice(0, 2).map(function (s) { return h('span', { class: 'gs-chip' }, [h('span', { text: s[0] }), h('b', { text: String(s[1]) })]); });
    var newGame = function () { dirty = false; clearRest(); if (opts.onNew) opts.onNew(); else if (newBtn) newBtn.click(); };
    var after = opts.after === undefined ? (opts.result === 'win' && !reducedMotion() ? BEAT_MS : SHEET_GUARD_MS) : opts.after;
    // A win always gets its whole beat, even when a game asks for a shorter wait for its own flourish.
    if (opts.result === 'win' && after > 0 && !reducedMotion()) after = Math.max(after, BEAT_MS);
    var beat = opts.result === 'win' && after > 0 && !reducedMotion(), shown = false, opened = null, timers = [], overlay = null, release = function () {};
    var label = opts.newLabel || T('shell.menu.new');
    var show = function () {
      if (shown) return;
      shown = true; release(); clearRest();
      var started = false, api = Shell.sheet({
        title: title, text: opts.text, guard: true,
        onClose: function () { if (!started) showRest(title, label, newGame); if (opts.onClose) opts.onClose(); },
        body: (chips.length ? [h('div', { class: 'gs-chips' }, chips)] : []).concat(opts.extra || []),
        actions: [{ label: T('shell.close') }, { label: label, primary: true, keep: true, onclick: function () { started = true; api.close(); newGame(); } }]
      });
      opened = api && api.el;
      var card = opened && opened.querySelector('.ar-sheet-card');
      if (card && opts.result && !reducedMotion()) card.classList.add('gs-end-' + opts.result);
      if (opts.result === 'win' && !reducedMotion()) countUp(chips);
    };
    if (!(after > 0)) { show(); return; }
    haptic(opts.result);
    if (beat) {
      // The stamp lands in the last BEAT_MS before the sheet; a game that took longer on its own flourish has finished by then.
      timers.push(root.setTimeout(function () { if (!shown) { overlay = momentNode(); d.body.appendChild(overlay); } }, Math.max(0, after - BEAT_MS)));
    }
    // A tap or key anywhere skips the beat (the sheet is up at once); a tap on the bar (Menu, Back) is the player doing something else.
    var armedAt = Date.now();
    var skip = function (e) {
      if (shown) return;
      // The burst of taps that made the winning move (a double tap, a second finger) is not a request to skip.
      if (Date.now() - armedAt < SKIP_GRACE_MS) return;
      var bar = e.target && e.target.closest && e.target.closest('.ar-bar');
      release();
      if (bar) { shown = true; return; }
      show();
      // The tap that skipped the beat must not also press a button of the sheet it brought up.
      var up = opened;
      if (up) { up.style.pointerEvents = 'none'; root.setTimeout(function () { up.style.pointerEvents = ''; }, SKIP_SETTLE_MS); }
    };
    release = function () {
      timers.forEach(root.clearTimeout); timers = [];
      // The stamp stays under the sheet's scrim and fades with it, rather than vanishing as the sheet arrives.
      if (overlay) { var gone = overlay; gone.classList.add('gs-m-out'); root.setTimeout(function () { gone.remove(); }, MOMENT_OUT_MS); overlay = null; }
      ['pointerdown', 'keydown'].forEach(function (ev) { d.removeEventListener(ev, skip, true); });
    };
    ['pointerdown', 'keydown'].forEach(function (ev) { d.addEventListener(ev, skip, true); });
    timers.push(root.setTimeout(show, after));
  };

  // ── the Menu sheet ──
  var sheet, card, paneStack = [], opener = null, watchPaused = false;
  function ensureSheet() {
    if (sheet) return;
    card = h('div', { class: 'ar-sheet-card gs-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': titleOf(), tabindex: '-1' });
    sheet = h('div', { class: 'ar-sheet gs-sheet', hidden: '' }, [card]);
    sheet.addEventListener('pointerdown', function (e) { if (e.target === sheet) closeMenu(); });
    sheetKeys(sheet, card, function () { if (paneStack.length > 1) back(); else closeMenu(); }, false);
    d.body.appendChild(sheet);
  }
  // A game's own clock waits while the Menu (and Settings inside it) is open: fn(true) when it opens, fn(false) when it closes.
  var holdListeners = [];
  Shell.onHold = function (fn) { holdListeners.push(fn); };
  function holdAll(on) { Shell.moveTimer.hold(on); Shell.watchHold(on); holdListeners.forEach(function (fn) { fn(on); }); }
  function openMenu() {
    ensureSheet();
    if (!sheet.hidden) return;
    opener = d.activeElement;
    pauseNow();   // a running arcade game waits while the menu is open
    holdAll(true);
    paneStack = [];
    sheet.hidden = false;
    show(rootPane);
  }
  function closeMenu() {
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true; paneStack = [];
    holdAll(false);
    if (opener && opener.focus && d.contains(opener)) try { opener.focus(); } catch (e) { /* gone */ }
  }
  Shell.openMenu = openMenu; Shell.closeMenu = closeMenu;

  // A pane is a function that fills the card: show(fn) pushes it, back() pops.
  function show(fn) { paneStack.push(fn); render(); }
  function back() { paneStack.pop(); render(); }
  function render() {
    var fn = paneStack[paneStack.length - 1];
    card.textContent = '';
    fn();
    // Focus lands on the sheet, never into a control; a pane the person is changing keeps its place in the tab order.
    try { card.focus({ preventScroll: true }); } catch (e) { /* no focus */ }
  }
  function head(title, isRoot) {
    var row = h('div', { class: 'gs-head' + (isRoot ? ' gs-head-root' : '') });
    if (!isRoot) row.appendChild(h('button', { class: 'gs-back', type: 'button', 'aria-label': T('shell.back'), onclick: back }));
    row.appendChild(h('h2', { text: title }));
    row.appendChild(h('button', { class: 'gs-x', type: 'button', 'aria-label': T('shell.close'), onclick: closeMenu }));
    card.appendChild(row);
  }

  function hasHints() { return !!game.hints || !!d.querySelector(HINT_SELECTOR); }
  function hasTimer() { return !!d.querySelector('#zc-stat') || !!d.querySelector(TIMER_SELECTOR); }
  function hasBacks() { return !!(root.ZimiCards && root.ZimiCards.backsSheet && d.querySelector('.zc-table')); }
  var DIRTY_EVENTS = ['pointerdown', 'keydown'];
  var dirty = false;
  function markDirty(e) { if (e.target && e.target.closest && e.target.closest('main, .zc-table, [role="main"], #stage, canvas')) dirty = true; }
  function underway() { return game.inProgress ? !!game.inProgress() : dirty; }

  // New game: one tap when nothing is under way. When a game is, one pane asks ("Start a new game?" and what is lost),
  // with the game's own options in that same pane and Start last; without options its button says New game.
  function startNew() {
    dirty = false; clearRest(); closeMenu(); stopWatching('new'); if (newBtn) newBtn.click();
  }
  function newGameTapped() {
    var options = menuOptions();
    if (!options.length && !(underway() && settings.get('confirm') === 'on')) { startNew(); return; }
    show(newPane);
  }
  // A game of ours whose Simon Tatham twin stays in the ZIM, off the shelf (puzzles/zimi-fit.js: FOLDED), links to it from its New game
  // pane: Mines has no-guess boards and other grids, Solo has killer and jigsaw, Guess has your own pegs and colours.
  var MORE_CHEVRON = '<svg class="gs-more-chev" aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  var MORE_VERSIONS = { minesweeper: ['puzzles/mines.html', 'pz.more.mines'], sudoku: ['puzzles/solo.html', 'pz.more.solo'], codebreaker: ['puzzles/guess.html', 'pz.more.guess'] };
  function newPane() {
    var asking = underway() && settings.get('confirm') === 'on', options = capturedOptions ? capturedOptions.options : [];
    head(asking ? T('shell.new.ask') : T('shell.menu.new'), false);
    if (asking) card.appendChild(h('p', { class: 'gs-text', text: T('shell.new.lost') }));
    if (options.length) {
      var box = h('div', { class: 'gs-options' });
      options.forEach(function (n) { box.appendChild(n); });
      if (MORE_VERSIONS[ID]) {   // a quiet row of the sheet's own: the label, what is there, a chevron
        var more = h('a', { class: 'gs-more', href: HOME + MORE_VERSIONS[ID][0] }, [h('span', { class: 'gs-more-text' }, [h('small', { text: T('pz.more') }), h('span', { text: T(MORE_VERSIONS[ID][1]) })])]);
        more.insertAdjacentHTML('beforeend', MORE_CHEVRON);
        box.appendChild(more);
      }
      card.appendChild(box);
    }
    card.appendChild(h('div', { class: 'gs-actions' }, [
      h('button', { class: 'ar-btn', type: 'button', text: T('shell.cancel'), onclick: back }),
      h('button', { class: 'ar-btn gs-primary', type: 'button', 'aria-pressed': 'true', text: options.length ? T('shell.start') : T('shell.menu.new'), onclick: startNew })
    ]));
  }

  function seg(key, opts) {
    var value = settings.get(key), row = h('div', { class: 'gs-seg', role: 'group', 'aria-label': labelOf(key) });
    CHOICES[key].forEach(function (c) {
      row.appendChild(h('button', { class: 'ar-btn', type: 'button', 'aria-pressed': String(c[0] === value), text: choiceText(c), onclick: function () { opts.onPick(key, c[0]); } }));
    });
    return row;
  }
  function chevronRow(label, hint, onclick) {
    return h('button', { class: 'gs-item', type: 'button', onclick: onclick }, [h('span', { class: 'gs-item-l', text: label }), h('span', { class: 'gs-item-r', text: hint || '' })]);
  }

  // The root: the game's own buttons, then the same rows in every game. The page footer's About link lives here now.
  function aboutLink() { return d.querySelector('.gm-about a[href]'); }
  function rootPane() {
    head(titleOf(), true);
    var options = menuOptions(), list = h('div', { class: 'gs-list' });
    if (extras.length) {
      var box = h('div', { class: 'gs-actions gs-extras' });
      extras.forEach(function (b) { b.classList.add('gs-moved'); box.appendChild(b); });
      card.appendChild(box);
      if (!box.dataset.wired) { box.dataset.wired = '1'; box.addEventListener('click', function (e) { if (e.target.closest('.ar-btn')) closeMenu(); }); }
    }
    if (newBtn) list.appendChild(chevronRow(T('shell.menu.new'), '', newGameTapped));
    list.appendChild(chevronRow(T('shell.menu.settings'), summary(), function () { show(settingsPane); }));
    if (helpFor(ID)) list.appendChild(chevronRow(T('shell.menu.how'), '', function () { show(helpPane); }));
    if (game.watch) list.appendChild(chevronRow(T('shell.menu.watch'), watching ? T('shell.running') : '', function () { show(watchPane); }));
    if (historyFor(ID)) list.appendChild(chevronRow(T('shell.menu.history'), '', function () { show(historyPane); }));
    list.appendChild(chevronRow(T('shell.menu.stats'), '', function () { show(statsPane); }));
    if (aboutLink()) list.appendChild(chevronRow(T('shell.menu.about'), '', function () { show(aboutPane); }));
    card.appendChild(list);
    void options;
  }
  function summary() {
    var bits = [];
    if (settings.get('anim') !== 'normal') bits.push(T('shell.summary.anim', { mode: choiceText(CHOICES.anim.filter(function (c) { return c[0] === settings.get('anim'); })[0]) }));
    if (hasTimer() && settings.get('timer') === 'hide') bits.push(T('shell.summary.timer'));
    return bits.join(', ');
  }

  // The game's own options (cards: draw one or three, players), shown in the New game pane.
  var capturedOptions = null;
  function menuOptions() {
    capturedOptions = null;
    if (game.menu) {
      try { capturedOptions = game.menu() || null; } catch (e) { capturedOptions = null; }
    }
    return capturedOptions ? capturedOptions.options : [];
  }

  function settingsPane() {
    head(T('shell.menu.settings'), false);
    var scope = paneState.scope || 'all';
    function pick(key, value) { settings.set(key, value, paneState.scope === 'game' ? 'game' : 'all'); render(); }
    function row(key, note) {
      card.appendChild(h('div', { class: 'gs-row' }, [h('label', { text: labelOf(key) }), seg(key, { onPick: pick }), note ? h('p', { class: 'gs-note', text: note }) : null]));
    }
    card.appendChild(h('div', { class: 'gs-scope' }, [
      h('span', { text: T('shell.set.scope') }),
      h('div', { class: 'gs-seg', role: 'group', 'aria-label': T('shell.set.scope') }, [
        h('button', { class: 'ar-btn', type: 'button', 'aria-pressed': String(scope === 'all'), text: T('shell.set.allGames'), onclick: function () { paneState.scope = 'all'; render(); } }),
        h('button', { class: 'ar-btn', type: 'button', 'aria-pressed': String(scope === 'game'), text: T('shell.set.thisGame'), onclick: function () { paneState.scope = 'game'; render(); } })
      ])
    ]));
    if (hasTimer()) row('timer');
    if (game.moveTimer) row('moveTimer', T('shell.set.moveTimerNote'));
    if (hasHints()) row('hints');
    if (game.settings) { var own = null; try { own = game.settings(); } catch (e) { own = null; } (own || []).forEach(function (n) { card.appendChild(n); }); }
    row('anim', deviceReducedMotion() && !settings.explicit('anim') ? T('shell.set.reducedNote') : '');
    if (game.sound) row('sound');
    if (newBtn) row('confirm');
    if (hasBacks()) {
      card.appendChild(h('div', { class: 'gs-row' }, [h('label', { text: T('shell.set.cardBack') }), h('button', { class: 'ar-btn', type: 'button', text: T('shell.choose'), onclick: function () { closeMenu(); root.ZimiCards.backsSheet(); } })]));
    }
    if (settings.hasOverrides()) {
      card.appendChild(h('button', { class: 'gs-link', type: 'button', text: T('shell.set.useAll'), onclick: function () { settings.reset(); render(); } }));
    }
  }
  var paneState = {};

  // How to play: goal, a turn, the end, a tip; the page's old key hint last.
  // The data for this game, with any part the game itself overrides (Mancala's two rule sets).
  // The words come from the string table (help.<game>.goal and so on); the game's own override wins per part.
  var HELP_FIELDS = ['goal', 'turn', 'end', 'tip', 'keys'];
  function helpFor(id) {
    var base = null;
    HELP_FIELDS.forEach(function (f) {
      var k = 'help.' + id + '.' + f;
      if (root.ZimiText && root.ZimiText.has(k)) { base = base || {}; base[f] = T(k); }
    });
    if (!base) return null;
    var own = game.help ? game.help() : null;
    return own ? Object.assign({}, base, own) : base;
  }
  var HELP_PARTS = [['goal', 'shell.help.goal'], ['turn', 'shell.help.turn'], ['end', 'shell.help.end'], ['tip', 'shell.help.tip']];
  function keysLine() {
    var p = d.querySelector('.bg-help'), s = '';
    if (!p) return '';
    (p.textContent.match(/[^.]+\./g) || []).forEach(function (t) { if (/\bkeys?\b|\bEnter\b|\bpress\b/i.test(t)) s += t.trim() + ' '; });
    return s.trim();
  }
  // The Goal / Your turn / The end / Tip list of a game's help (the shelf's long-press menu shows the same list).
  function helpList(hp, keys) {
    var dl = h('dl', { class: 'gs-help' });
    HELP_PARTS.forEach(function (p) { if (hp[p[0]]) { dl.appendChild(h('dt', { text: T(p[1]) })); dl.appendChild(h('dd', { text: hp[p[0]] })); } });
    if (keys) { dl.appendChild(h('dt', { text: T('shell.help.keys') })); dl.appendChild(h('dd', { text: keys })); }
    return dl;
  }
  function helpPane() {
    head(T('shell.menu.how'), false);
    var hp = helpFor(ID);
    card.appendChild(helpList(hp, hp.keys || keysLine()));
    (hp.extra || []).forEach(function (n) { card.appendChild(n); });   // a game's own addition, e.g. a piece key
  }
  // For a page that is not the game (the shelf): the list for game `id`, or null when it has no help.
  Shell.helpList = function (id) { var hp = helpFor(id); return hp ? helpList(hp, hp.keys) : null; };

  // The game's own row in games.json, fetched once for the History and About panes (null when there is none).
  var rowPromise = null;
  function gameRow() {
    if (!rowPromise) {
      rowPromise = !root.fetch ? Promise.resolve(null) : root.fetch(HOME + 'games.json').then(function (r) { return r.json(); }).then(function (rows) {
        return (rows || []).filter(function (x) { return x.path === ID + '.html' || (x.path || '').slice(-ID.length - 6) === '/' + ID + '.html'; })[0] || null;
      }).catch(function () { return null; });
    }
    return rowPromise;
  }
  // Facts as short words, never raw data: where and when it began as one phrase, how many play, how long it takes.
  var REGION_IDS = { 'East Asia': 'eastAsia', 'South Asia': 'southAsia', 'Southeast Asia': 'southeastAsia', 'Middle East': 'middleEast', 'Americas': 'americas', 'Europe': 'europe', 'Africa': 'africa', 'Worldwide/Modern': 'worldwide' };
  function yearWords(year, era) {
    var approx = /^c\./.test(era || ''), n = Math.abs(year);
    var bit = year < 0 ? T('shell.year.bc', { n: n }) : year < 1000 ? T('shell.year.ad', { n: n }) : String(n);
    return approx ? T('shell.year.about', { year: bit }) : bit;
  }
  function originWords(row) {
    var o = row.origin || {}, when = '';
    if (typeof o.year === 'number') when = yearWords(o.year, o.era);
    else if (o.era) { var m = /^(\d+)s$/.exec(o.era); when = m ? T('shell.year.decade', { n: m[1] }) : String(o.era); }
    var where = REGION_IDS[row.region] ? T('shell.region.' + REGION_IDS[row.region]) : '';
    return [where, when].filter(Boolean).join(', ');
  }
  function playersWords(p) {
    var m = /^(\d+)(?: to (\d+))?$/.exec(String(p || ''));
    if (!m) return '';
    return m[2] ? T('shell.players.range', { a: m[1], b: m[2] }) : T('shell.players.n', { n: +m[1] });
  }
  function lengthWords(l) {
    var m = /^(\d+) min(\+)?$/.exec(String(l || ''));
    return m ? T(m[2] ? 'shell.length.minPlus' : 'shell.length.min', { n: +m[1] }) : '';
  }
  // History carries where and when (one line under its own sentences); About carries how many play and how long.
  var HISTORY_FACTS = ['shell.meta.origin'], ABOUT_FACTS = ['shell.meta.players', 'shell.meta.length'];
  function factRows(row, keys) {
    var all = [['shell.meta.origin', originWords(row)], ['shell.meta.players', playersWords(row.players)], ['shell.meta.length', lengthWords(row.length)]];
    return all.filter(function (f) { return f[1] && keys.indexOf(f[0]) >= 0; });
  }
  // History: a few plain sentences, then the facts games.json holds about the game, if it has any.
  function historyFor(id) { return root.ZimiText && root.ZimiText.has('history.' + id) ? T('history.' + id) : ''; }
  function historyPane() {
    head(T('shell.menu.history'), false);
    card.appendChild(h('p', { class: 'gs-text gs-history', text: historyFor(ID) }));
    var facts = h('dl', { class: 'gs-help gs-meta' });
    card.appendChild(facts);
    gameRow().then(function (row) {
      if (!row || !facts.isConnected) return;
      factRows(row, HISTORY_FACTS).forEach(function (f) { facts.appendChild(h('dt', { text: T(f[0]) })); facts.appendChild(h('dd', { text: f[1] })); });
    });
  }
  // About: what the game is, in the Menu where the game is, so reading it never leaves the table.
  // The About text of a game's games.json row: what it is, why it matters, how many play, how long, a Tatham puzzle's credit.
  // `source` is what the game is playing from right now (only the game itself knows).
  function aboutInto(body, row, source) {
    var stem = hrefStem(row.path), facts = h('dl', { class: 'gs-help gs-meta' });
    body.appendChild(h('p', { class: 'gs-text', text: gameWord(stem, 'blurb') || row.blurb || gameWord(stem, 'title') || row.title }));
    if (row.why) body.appendChild(h('p', { class: 'gs-text', text: gameWord(stem, 'why') || row.why }));
    if (source) body.appendChild(h('p', { class: 'gs-text gs-source', text: source }));
    factRows(row, ABOUT_FACTS).forEach(function (f) { facts.appendChild(h('dt', { text: T(f[0]) })); facts.appendChild(h('dd', { text: f[1] })); });
    if (facts.childNodes.length) body.appendChild(facts);
    var pz = /^puzzles\/([a-z]+)\.html$/.exec(row.path || '');
    if (pz) {
      body.appendChild(h('p', { class: 'gs-text', text: T('shell.about.credit') }));
      body.appendChild(h('p', { class: 'gs-text' }, [h('a', { href: HOME + 'puzzles/LICENCE', text: T('shell.about.licence') }), ' \u00b7 ', h('a', { href: HOME + 'puzzles/doc/' + pz[1] + '.html', text: T('shell.about.manual') })]));
    }
  }
  Shell.aboutInto = aboutInto;
  Shell.historyFor = historyFor;
  // About: what the game is, in the Menu where the game is, so reading it never leaves the table.
  function aboutPane() {
    head(T('shell.menu.about'), false);
    var body = h('div', { class: 'gs-about' });
    card.appendChild(body);
    gameRow().then(function (row) {
      if (!body.isConnected) return;
      if (!row) { body.appendChild(h('p', { class: 'gs-text', text: titleOf() })); return; }
      aboutInto(body, row, game.about ? game.about() : '');
    });
  }

  // Stats: a labelled list. A line "Medium: 3 won, 1 lost" is a label and its figures; a line with no label stands alone.
  function statRows(lines) {
    var dl = h('dl', { class: 'gs-statlist' });
    lines.forEach(function (t) {
      if (Array.isArray(t)) { dl.appendChild(h('dt', { text: String(t[0]) })); dl.appendChild(h('dd', { text: String(t[1]) })); return; }
      var m = /^([^:]{1,40}):\s+(.+)$/.exec(String(t).trim());
      if (m) { dl.appendChild(h('dt', { text: m[1] })); dl.appendChild(h('dd', { text: m[2] })); }
      else dl.appendChild(h('dd', { class: 'gs-stat-alone', text: String(t).trim() }));
    });
    return dl;
  }
  function statsPane() {
    head(T('shell.menu.stats'), false);
    var lines = [], s = game.stats ? game.stats() : null;
    if (s) lines = [].concat(s);
    else {
      var el = d.querySelector('.bg-stats, .zc-stats, #wk-stats');
      if (el && el.textContent.trim()) lines = [el.textContent.trim()];
    }
    lines = lines.filter(function (t) { return t && (Array.isArray(t) || String(t).trim()); });
    if (!lines.length) card.appendChild(h('p', { class: 'gs-text', text: T('shell.stats.none') }));
    else card.appendChild(h('div', { class: 'gs-stats' }, [statRows(lines)]));
  }

  // ── Watch and learn (the driver is in watch.js, fetched when first wanted) ──
  var watching = false, watchApi = null;
  Shell.isWatching = function () { return watching; };
  Shell.watchHold = function (on) { if (watchApi && watchApi.hold) watchApi.hold(on); };
  function watchPane() {
    head(T('shell.menu.watch'), false);
    if (watching) {
      card.appendChild(h('p', { class: 'gs-text', text: T('shell.watch.running') }));
      card.appendChild(h('div', { class: 'gs-actions' }, [h('button', { class: 'ar-btn gs-primary', type: 'button', 'aria-pressed': 'true', text: T('shell.watch.stop'), onclick: function () { closeMenu(); stopWatching('stop'); } })]));
      return;
    }
    card.appendChild(h('p', { class: 'gs-text', text: T('shell.watch.intro') }));
    card.appendChild(h('div', { class: 'gs-actions' }, [h('button', { class: 'ar-btn gs-primary', type: 'button', 'aria-pressed': 'true', text: T('shell.watch.start'), onclick: function () { closeMenu(); startWatching(); } })]));
  }
  function loadScript(src, done) {
    var s = d.createElement('script'); s.src = src; s.onload = function () { done(); }; s.onerror = function () { done(new Error(src)); };
    d.head.appendChild(s);
  }
  function startWatching() {
    var go = function (err) {
      if (err || !root.ZimiWatch) { return; }
      watching = true; watchApi = root.ZimiWatch.create({ strip: strip, game: game, id: ID, stop: stopWatching });
      d.documentElement.classList.add('gs-watching');
      watchApi.begin();
    };
    var need = [game.watch.script].filter(Boolean);
    loadScript('watch.js', function (err) {
      if (err) return go(err);
      if (!need.length || root.ZimiExplain && root.ZimiExplain[ID]) return go();
      loadScript(need[0], go);
    });
  }
  // kind: 'takeover' keeps the position and lets the person play on; 'stop' and 'new' end the demo.
  function stopWatching(kind) {
    if (!watching) return;
    watching = false; d.documentElement.classList.remove('gs-watching');
    var api = watchApi; watchApi = null;
    if (api) api.end(kind);
    if (game.watch && game.watch.stop) game.watch.stop(kind);
  }
  Shell.stopWatching = stopWatching;

  // ── inside Zimi: one header ──
  // Zimi's reader (same origin) has its own top bar. There the game's name, its Undo or Pause and its
  // Menu live in that bar and this page's own bar steps aside (a clock or score in it stays). Anywhere
  // else (Kiwix, a browser tab) nothing here runs. The page tells Zimi what it has; Zimi asks it to act.
  var HOST_CSS = 'html.gs-hosted .ar-bar > :not(.ar-stat):not(#ms-flagmode) { display: none !important; }' +
    'html.gs-hosted .ar-bar:not(:has(.ar-stat, #ms-flagmode)) { display: none; }' +
    'html.gs-hosted .ar-bar { min-height: 0; padding-block: 4px; justify-content: flex-end; }' +
    'html.gs-hosted .ar-shelf .ar-brand, html.gs-hosted .ar-shelf > header > p { display: none; }';
  // The bar carried the pebble; here it is hidden behind Zimi's header. The pebble lies on the ground of the game instead, 20px in
  // the bottom-right corner, under everything (the felt of a card table, the page's ground elsewhere): a maker's mark on the table,
  // never over a board, a card or a control. docs/design/games.md, the mark.
  var MARK_PX = 20, MARK_GAP = 12;
  function hostMarkCss(url) {
    var at = 'content:"";position:absolute;pointer-events:none;width:' + MARK_PX + 'px;height:' + MARK_PX + 'px;background:url(' + url + ') center/contain no-repeat;';
    return 'html.gs-hosted body:has(> .ar-bar) .zc-table::before{' + at + 'z-index:0;right:' + MARK_GAP + 'px;bottom:' + MARK_GAP + 'px}' +
      'html.gs-hosted body:has(> .ar-bar):not(:has(.zc-table))::before{' + at.replace('absolute', 'fixed') + 'z-index:-1;right:' + MARK_GAP + 'px;bottom:calc(' + MARK_GAP + 'px + env(safe-area-inset-bottom))}' +
      ':root[data-theme="dark"].gs-hosted body:has(> .ar-bar):not(:has(.zc-table))::before{filter:drop-shadow(1px 0 0 var(--mark-ring)) drop-shadow(-1px 0 0 var(--mark-ring)) drop-shadow(0 1px 0 var(--mark-ring)) drop-shadow(0 -1px 0 var(--mark-ring))}' +
      '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]).gs-hosted body:has(> .ar-bar):not(:has(.zc-table))::before{filter:drop-shadow(1px 0 0 var(--mark-ring)) drop-shadow(-1px 0 0 var(--mark-ring)) drop-shadow(0 1px 0 var(--mark-ring)) drop-shadow(0 -1px 0 var(--mark-ring))}}';
  }
  function inZimi() {
    try { var f = root.parent !== root && root.parent.document.getElementById('reader-frame'); return !!f && f.contentWindow === root; } catch (e) { return false; }
  }
  var hosted = Shell.hosted = inZimi();
  if (hosted) {
    d.documentElement.classList.add('gs-hosted');
    var hostStyle = d.createElement('style'); hostStyle.textContent = HOST_CSS + hostMarkCss(HOME + 'mark.svg'); d.head.appendChild(hostStyle);
  }
  function hostAct() { return d.querySelector('.ar-bar [id$="undo"], .ar-bar [id$="pause"]'); }
  function hostSay() {
    var a = hostAct(), msg = { zimi: 'game', title: titleOf(), menu: !!menuBtn };
    if (a) msg.act = { kind: /undo$/.test(a.id) ? 'undo' : 'pause', label: a.textContent.trim(), disabled: !!a.disabled };
    root.parent.postMessage(msg, root.location.origin);
  }
  function hostReady() {
    hostSay();
    var a = hostAct();
    if (a && root.MutationObserver) new root.MutationObserver(hostSay).observe(a, { attributes: true, attributeFilter: ['disabled'], childList: true, characterData: true, subtree: true });
    root.addEventListener('message', function (e) {
      if (e.source !== root.parent || e.origin !== root.location.origin || !e.data || e.data.zimi !== 'game-do') return;
      if (e.data.what === 'menu') openMenu();
      else if (e.data.what === 'act') { var b = hostAct(); if (b && !b.disabled) b.click(); }
      else if (e.data.what === 'hello') hostSay();
    });
    root.addEventListener('pagehide', function () { root.parent.postMessage({ zimi: 'game-gone' }, root.location.origin); });
  }

  var shellSrc = d.currentScript && d.currentScript.src;

  // ── live tiles ──
  // Leaving a game in progress, the shell keeps a small picture of the table for the shelf's tile and the game table
  // (recent.js reads it). A game may hand one over: ZimiShell.game({ snapshot: fn }) returning a canvas or an
  // svg string. Without one, the largest canvas on the page is used. Nothing is kept for a game not under way.
  var SNAP_KEY = 'zimi.games.snaps', SNAP_CAP = 8, SNAP_W = 320, SNAP_H = 180, SNAP_JPEG_QUALITY = 0.72, SNAP_PIXEL_ART_MAX = 200;
  function snapPath() {
    var base = shellSrc && new root.URL('.', shellSrc).pathname, p = decodeURIComponent(root.location.pathname);
    return base && p.indexOf(base) === 0 ? p.slice(base.length) : '';
  }
  function bigCanvas() {
    var best = null, area = 0;
    Array.prototype.forEach.call(d.querySelectorAll('main canvas, #stage canvas, body > canvas'), function (c) {
      var r = c.getBoundingClientRect(), a = r.width * r.height;
      if (a > area && c.width > 8 && c.height > 8) { best = c; area = a; }
    });
    return best;
  }
  // A canvas as a 16 by 9 picture: fitted whole on its own background colour; pixel art is kept sharp and lossless.
  function canvasPicture(c) {
    var out = d.createElement('canvas'), x = out.getContext('2d'), pixel = Math.max(c.width, c.height) <= SNAP_PIXEL_ART_MAX;
    out.width = SNAP_W; out.height = SNAP_H;
    var corner = c.getContext && c.getContext('2d') ? c.getContext('2d').getImageData(0, 0, 1, 1).data : null;
    x.fillStyle = corner && corner[3] ? 'rgb(' + corner[0] + ',' + corner[1] + ',' + corner[2] + ')' : root.getComputedStyle(d.body).backgroundColor;
    x.fillRect(0, 0, SNAP_W, SNAP_H);
    x.imageSmoothingEnabled = !pixel;
    var k = Math.min(SNAP_W / c.width, SNAP_H / c.height), w = Math.round(c.width * k), hh = Math.round(c.height * k);
    x.drawImage(c, Math.round((SNAP_W - w) / 2), Math.round((SNAP_H - hh) / 2), w, hh);
    return pixel ? out.toDataURL('image/png') : out.toDataURL('image/jpeg', SNAP_JPEG_QUALITY);
  }
  function takeSnapshot() {
    var src = game.snapshot ? game.snapshot() : bigCanvas();
    if (!src) return null;
    if (typeof src === 'string') return /^\s*<svg[\s>]/.test(src) ? { svg: src } : null;
    try { return { img: canvasPicture(src) }; } catch (e) { return null; }   // a tainted or lost canvas: no picture
  }
  function readSnaps() { try { var v = JSON.parse(root.localStorage.getItem(SNAP_KEY)); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }
  function keepSnapshot() {
    var path = snapPath();
    if (!path) return;
    var all = readSnaps(), snap = underway() ? takeSnapshot() : null;
    if (snap) { snap.at = Date.now(); all[path] = snap; } else delete all[path];
    Object.keys(all).sort(function (a, b) { return all[b].at - all[a].at; }).slice(SNAP_CAP).forEach(function (k) { delete all[k]; });
    try { root.localStorage.setItem(SNAP_KEY, JSON.stringify(all)); } catch (e) { /* full or blocked: the tile keeps its art */ }
  }
  function watchSnapshots() {
    d.addEventListener('visibilitychange', function () { if (d.hidden) keepSnapshot(); });
    root.addEventListener('pagehide', keepSnapshot);
  }

  // ── controllers ──
  // A controller (USB or Bluetooth) is read by gamepad.js, loaded the first time one reports in: nothing here until then.
  function padsReady() { return !!(root.ZimiGamepad || d.querySelector('script[data-gamepad]')); }
  function loadPads() {
    if (padsReady() || !shellSrc) return;
    var s = d.createElement('script'); s.src = new root.URL('gamepad.js', shellSrc).href; s.setAttribute('data-gamepad', '');
    d.head.appendChild(s);
  }
  if (root.navigator && root.navigator.getGamepads) {
    root.addEventListener('gamepadconnected', loadPads);
    // Already connected before this page loaded: the browser reports it again on the first button press.
    var early = root.navigator.getGamepads();
    for (var gi = 0; early && gi < early.length; gi++) if (early[gi] && early[gi].connected) { loadPads(); break; }
  }

  // ── start ──
  function ready() {
    var named = localizeName();
    Shell.localizeTiles();
    Shell.setTitle(named || d.title);
    // The shelf, About and the puzzles list only tell Zimi their name: no Menu of their own.
    var built = !d.querySelector('meta[name="zimi-games-host"]') && buildBar();
    if (hosted) hostReady();
    if (!built) return;
    DIRTY_EVENTS.forEach(function (t) { d.addEventListener(t, markDirty, true); });
    watchSnapshots(); watchBlur(); watchRecords(); markStatusLines();
    d.documentElement.classList.add('gs-ready');
    if (helpFor(ID)) d.documentElement.classList.add('gs-help');
    // Settings that a game paints itself (a clock's text) are repainted when they change.
    settings.on(function () { if (game.paint) game.paint(); });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', ready); else ready();
})(typeof globalThis !== 'undefined' ? globalThis : window);
