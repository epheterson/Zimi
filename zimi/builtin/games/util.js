/* ZimiGames: the small things every game would otherwise write for itself. Our own code, GPL-3.0. No modules, no DOM at load.

     ZimiUtil.mulberry32(seed)        a function that returns the next number in [0, 1); one seed is one sequence.
                                     A deal is a promise: never change its arithmetic.
     ZimiUtil.counted(seed, skip)     the same sequence, but it knows its seed and how many it has given (rng.seed, rng.draws),
                                     so a game that holds one can be put back where it was: counted(seed, draws)
     ZimiUtil.snapshot(game)          the game's state as plain JSON (its `rng` becomes { seed, draws })
     ZimiUtil.restore(saved)          a game from a snapshot, its `rng` the same sequence at the same place
     ZimiUtil.clamp(v, lo, hi)        v held between lo and hi
     ZimiUtil.DAY_MS                  86400000
     ZimiUtil.dayKey(date, sep)       the player's calendar day as YYYYMMDD (the server's day key), or YYYY-MM-DD with sep '-'; today by default
     ZimiUtil.DIR_KEYS                the arrow keys and WASD as 'left' | 'right' | 'up' | 'down'; copy it to add a game's own keys
     ZimiUtil.el(tag, cls, text)      a new element with a class and some text (a page only: it needs a document)

   Loaded before the engines (a page's script tag, a test's file list). */
(function (root) {
  'use strict';

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function counted(seed, skip) {
    var next = mulberry32(seed), n = 0;
    function rng() { n++; return next(); }
    rng.seed = seed >>> 0;
    Object.defineProperty(rng, 'draws', { get: function () { return n; } });
    for (var i = 0; i < (skip || 0); i++) rng();
    return rng;
  }

  function snapshot(game) {
    var out = {};
    Object.keys(game).forEach(function (k) { if (k !== 'rng') out[k] = game[k]; });
    out.rng = { seed: game.rng.seed, draws: game.rng.draws };
    return JSON.parse(JSON.stringify(out));
  }

  function restore(saved) {
    var game = JSON.parse(JSON.stringify(saved));
    if (!game.rng || typeof game.rng.seed !== 'number' || typeof game.rng.draws !== 'number') throw new Error('no generator to put back');
    game.rng = counted(game.rng.seed, game.rng.draws);
    return game;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  var DAY_MS = 86400000;
  function dayKey(date, sep) {
    var d = date || new Date(), s = sep || '';
    return d.getFullYear() + s + String(d.getMonth() + 1).padStart(2, '0') + s + String(d.getDate()).padStart(2, '0');
  }

  var DIR_KEYS = Object.freeze({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', a: 'left', d: 'right', w: 'up', s: 'down' });

  function el(tag, cls, text) {
    var e = root.document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  root.ZimiUtil = { mulberry32: mulberry32, counted: counted, snapshot: snapshot, restore: restore, clamp: clamp, DAY_MS: DAY_MS, dayKey: dayKey, DIR_KEYS: DIR_KEYS, el: el };
})(this);
