/* ZimiGames: Shut the Box. Our own code, GPL-3.0. No network, no fonts, no modules.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document).
   Nine tiles stand open. Roll the dice and shut tiles that add up to the roll. When none fits, the tiles still open are
   your score: lower is better, and nothing left is "shutting the box". With tiles 7, 8 and 9 shut, one die is rolled. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var TILES = 9, FULL = (1 << TILES) - 1, HIGH_MASK = 0x1c0, SIDES = 6;   // HIGH_MASK: tiles 7, 8 and 9
  var Z = { set: function (m, n) { return (m & (1 << (n - 1))) !== 0; } };

  function sumOf(mask) { var s = 0; for (var n = 1; n <= TILES; n++) if (Z.set(mask, n)) s += n; return s; }
  function tilesOf(mask) { var out = []; for (var n = 1; n <= TILES; n++) if (Z.set(mask, n)) out.push(n); return out; }
  function maskOf(tiles) { return tiles.reduce(function (m, n) { return m | (1 << (n - 1)); }, 0); }
  function diceFor(open) { return (open & HIGH_MASK) ? 2 : 1; }

  // Every way to shut open tiles that add up to the total (each a mask of tiles that are open now).
  function moves(open, total) {
    var out = [];
    for (var m = (open & -open) ? open : 0; m > 0; m = (m - 1) & open) if (sumOf(m) === total) out.push(m);
    return out;
  }

  // The best a player can hope for: the expected tiles left when every roll is answered with the best move, for each box.
  // Bits come in increasing order, so every box a move leads to is already known.
  var EXPECTED = (function () {
    var e = new Array(FULL + 1), m, total, rolls, moveList, best, i, a, b, p, acc, count;
    e[0] = 0;
    for (m = 1; m <= FULL; m++) {
      rolls = [];
      if (diceFor(m) === 1) for (a = 1; a <= SIDES; a++) rolls.push(a);
      else for (a = 1; a <= SIDES; a++) for (b = 1; b <= SIDES; b++) rolls.push(a + b);
      acc = 0; count = rolls.length;
      for (i = 0; i < count; i++) {
        total = rolls[i];
        moveList = moves(m, total);
        if (!moveList.length) { acc += sumOf(m); continue; }
        best = Infinity;
        for (p = 0; p < moveList.length; p++) best = Math.min(best, e[m & ~moveList[p]]);
        acc += best;
      }
      e[m] = acc / count;
    }
    return e;
  })();

  function createGame(players, seed) {
    return { n: players, turn: 0, open: FULL, dice: [], rolled: false, last: null, results: players === 2 ? [null, null] : [null], over: false, winner: -1, rng: root.ZimiUtil.counted(seed) };
  }
  function die(g) { return 1 + Math.floor(g.rng() * SIDES); }
  function total(g) { return g.dice.reduce(function (a, b) { return a + b; }, 0); }

  // This turn is over: the tiles still open are the score; the next player starts with a full box, or the game ends.
  function finishTurn(g, blocked) {
    var score = sumOf(g.open);
    g.results[g.turn] = score;
    g.last = { player: g.turn, score: score, blocked: !!blocked, shut: score === 0 };
    if (g.turn < g.n - 1) { g.turn++; g.open = FULL; g.rolled = false; return; }
    g.over = true;
    g.rolled = false;
    if (g.n === 2) g.winner = g.results[0] === g.results[1] ? -1 : (g.results[0] < g.results[1] ? 0 : 1);
    else g.winner = score === 0 ? 0 : -1;
  }
  // Roll the dice for whoever's turn it is. False when it is not time to roll. A roll no tile fits ends the turn.
  function roll(g) {
    if (g.over || g.rolled) return false;
    var count = diceFor(g.open);
    g.dice = [];
    for (var i = 0; i < count; i++) g.dice.push(die(g));
    g.rolled = true; g.last = null;
    if (!moves(g.open, total(g)).length) { g.rolled = false; finishTurn(g, true); }
    return true;
  }
  // Shut these tiles (numbers). They must be open, and add up to the roll.
  function shut(g, tiles) {
    if (g.over || !g.rolled || !tiles.length) return false;
    var m = maskOf(tiles);
    if (tilesOf(m).length !== tiles.length || (m & g.open) !== m || sumOf(m) !== total(g)) return false;
    g.open &= ~m; g.rolled = false;
    if (g.open === 0) finishTurn(g, false);
    return true;
  }

  // The computer. Hard shuts the tiles that leave the box with the fewest tiles to expect; Easy shuts any tiles that fit.
  function aiMove(g, level) {
    var list = moves(g.open, total(g));
    if (!list.length) return [];
    if (level === 'easy') return tilesOf(list[Math.floor(g.rng() * list.length)]);
    var best = list[0], bv = Infinity;
    list.forEach(function (m) { var v = EXPECTED[g.open & ~m]; if (v < bv - 1e-9) { bv = v; best = m; } });
    return tilesOf(best);
  }

  var Engine = { TILES: TILES, FULL: FULL, EXPECTED: EXPECTED, sumOf: sumOf, tilesOf: tilesOf, maskOf: maskOf, diceFor: diceFor, moves: moves, createGame: createGame, roll: roll, shut: shut, total: total, aiMove: aiMove, snapshot: root.ZimiUtil.snapshot, restore: root.ZimiUtil.restore };
  root.ShutTheBoxEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var SETTINGS_KEY = 'zimi.games.shutthebox.settings', STATS_KEY = 'zimi.games.shutthebox.stats';
  var CPU_DELAY_MS = 750, TUMBLE_MS = 320, END_AFTER_MS = 900, BLOCK_PAUSE_MS = 1100;
  Play.applyTheme();

  var els = { msg: $('st-msg'), roll: $('st-roll'), box: $('st-box'), dice: $('st-dice'), total: $('st-total'), picked: $('st-picked'), left: $('st-left'), nu: $('st-new'), results: $('st-results') };
  var line = Play.status(els.msg);
  var settings = Play.load(SETTINGS_KEY, { mode: 'cpu', level: 'hard' }), stats = Play.load(STATS_KEY, { games: 0, shut: 0, best: null, a: 0, b: 0, d: 0 });
  var g, timer = null, tiles = [], dieEls = [], picked = [], note = '';

  function players() { return settings.mode === 'solo' ? 1 : 2; }
  function cpuSeat(i) { return settings.mode === 'cpu' && i === 1; }
  function nameOf(i) { return settings.mode === 'two' ? T('pig.player', { n: i + 1 }) : T(i === 0 ? 'board.you' : 'board.zimi'); }
  function mine() { return !g.over && !cpuSeat(g.turn) && !timer; }
  function pickedSum() { return picked.reduce(function (a, b) { return a + b; }, 0); }

  function build() {
    els.box.textContent = '';
    tiles = [];
    for (var n = 1; n <= TILES; n++) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'st-tile'; b.textContent = String(n);
      (function (k) { b.addEventListener('click', function () { tap(k); }); })(n);
      els.box.appendChild(b); tiles.push(b);
    }
    root.ZimiUtil.gridAria(els.box, tiles, 3);
    root.ZimiUtil.gridRove(els.box, tiles, 3);
    els.dice.textContent = '';
    dieEls = [0, 1].map(function () { var d = document.createElement('span'); d.className = 'pl-die st-die'; d.setAttribute('role', 'img'); els.dice.appendChild(d); return d; });
  }

  function base() {
    if (g.over) return '';
    if (cpuSeat(g.turn)) return T('shell.thinking');
    if (g.rolled) return T('shutthebox.pick', { n: total(g) });
    return T('shutthebox.roll');
  }
  function say() { if (!g.over) line.say((note ? note + ' ' : '') + base()); }

  function paint() {
    var t = g.rolled ? total(g) : 0;
    tiles.forEach(function (b, i) {
      var n = i + 1, open = Z.set(g.open, n), sel = picked.indexOf(n) >= 0;
      b.classList.toggle('st-shut', !open); b.classList.toggle('st-sel', sel);
      b.setAttribute('aria-disabled', String(!open));
      b.setAttribute('aria-label', T(!open ? 'shutthebox.tile.shut' : sel ? 'shutthebox.tile.chosen' : 'shutthebox.tile.open', { n: n }));
    });
    dieEls.forEach(function (d, i) {
      var v = g.dice[i] || 0;
      d.hidden = i === 1 && diceFor(g.open) === 1 && !g.dice[1];
      Play.pips(d, v);
      d.setAttribute('aria-label', v ? T('pig.die', { n: v }) : T('pig.dieBlank'));
    });
    els.total.textContent = g.rolled ? Play.num(t) : '–';
    els.picked.textContent = Play.num(pickedSum());
    els.left.textContent = Play.num(sumOf(g.open));
    els.roll.disabled = !mine() || g.rolled;
    els.roll.setAttribute('aria-disabled', String(els.roll.disabled));
    // The score of each finished turn, for the table that has more than one player.
    els.results.textContent = '';
    if (g.n > 1) g.results.forEach(function (r, i) {
      var s = document.createElement('span'); s.className = 'st-res' + (i === g.turn && !g.over ? ' st-cur' : '');
      s.textContent = nameOf(i) + ' ' + (r === null ? '–' : Play.num(r));
      els.results.appendChild(s);
    });
  }
  function tumble() {
    if (Play.reducedMotion()) return;
    dieEls.forEach(function (d) { d.classList.remove('st-tumble'); void d.offsetWidth; d.classList.add('st-tumble'); setTimeout(function () { d.classList.remove('st-tumble'); }, TUMBLE_MS); });
  }

  function end(replay) {
    var opts = { after: replay ? 0 : END_AFTER_MS }, w = g.winner;
    if (!replay) {
      stats.games++;
      if (g.n === 1) {
        if (g.results[0] === 0) stats.shut++;
        if (stats.best === null || g.results[0] < stats.best) stats.best = g.results[0];
      } else if (settings.mode === 'cpu') { if (w === 0) stats.a++; else if (w === 1) stats.b++; else stats.d++; }
      Play.save(STATS_KEY, stats);
    }
    if (g.n === 1) {
      opts.result = g.results[0] === 0 ? 'win' : 'over';
      opts.text = T(g.results[0] === 0 ? 'shutthebox.shutAll' : 'shutthebox.left', { n: g.results[0] });
      opts.stats = [[T('shutthebox.best'), Play.num(stats.best === null ? g.results[0] : stats.best)]];
    } else {
      opts.text = T('shutthebox.vs', { a: nameOf(0), x: Play.num(g.results[0]), b: nameOf(1), y: Play.num(g.results[1]) });
      if (w < 0) opts.result = 'draw';
      else if (settings.mode === 'cpu') opts.result = w === 0 ? 'win' : 'lose';
      else { opts.result = 'win'; opts.name = nameOf(w); }
    }
    line.say(opts.text); paint();
    ZimiShell.endSheet(opts);
  }

  // After the dice or the tiles change: what to say, then who moves next.
  function after() {
    picked = [];
    if (g.last && g.last.player !== undefined && !g.rolled) {
      var l = g.last, who = nameOf(l.player);
      note = l.shut ? T('shutthebox.shutBy', { name: who }) : T('shutthebox.stuck', { name: who, n: l.score });
    } else note = '';
    paint();
    if (g.over) return end();
    var turnEnded = g.last !== null;
    say();
    if (cpuSeat(g.turn)) timer = Play.later(cpuStep, turnEnded ? BLOCK_PAUSE_MS : CPU_DELAY_MS);
    else if (turnEnded && settings.mode === 'two') { /* the next person rolls */ }
  }
  function doRoll() {
    if (!roll(g)) return;
    tumble();
    after();
  }
  function cpuStep() {
    timer = null;
    if (g.over || !cpuSeat(g.turn)) return;
    if (!g.rolled) { doRoll(); return; }
    shut(g, aiMove(g, settings.level));
    after();
  }
  function tap(n) {
    if (g.over || cpuSeat(g.turn)) return;
    var b = tiles[n - 1];
    if (!g.rolled) { ZimiShell.shake(b); line.reason(T('shutthebox.rollFirst')); return; }
    if (!Z.set(g.open, n)) { ZimiShell.shake(b); line.reason(T('shutthebox.alreadyShut')); return; }
    var at = picked.indexOf(n);
    if (at >= 0) { picked.splice(at, 1); paint(); return; }
    if (pickedSum() + n > total(g)) { ZimiShell.shake(b); line.reason(T('shutthebox.tooMuch', { n: total(g) })); return; }
    picked.push(n);
    if (pickedSum() === total(g)) { shut(g, picked.slice()); after(); } else paint();
  }

  els.roll.addEventListener('click', function () { if (mine() && !g.rolled) doRoll(); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden])')) return;
    if (e.target && e.target.closest && e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === ' ' || e.key === 'r' || e.key === 'R') { e.preventDefault(); if (mine() && !g.rolled) doRoll(); }
    else if (e.key >= '1' && e.key <= '9') tap(+e.key);
  });

  function save() { Play.save(SETTINGS_KEY, settings); }
  function menuOptions() {
    var box = document.createElement('div');
    function fill() {
      box.textContent = '';
      box.appendChild(Play.optionRow(T('shutthebox.players'), [['solo', T('shelf.players.solo')], ['cpu', T('board.zimi')], ['two', T('noughts.friend')]], settings.mode, function (v) { settings.mode = v; save(); fill(); }));
      if (settings.mode === 'cpu') box.appendChild(Play.optionRow(T('board.level'), [['easy', T('board.level.easy')], ['hard', T('board.level.hard')]], settings.level, function (v) { settings.level = v; save(); }));
    }
    fill();
    return [box];
  }
  function begin() {
    if (timer) timer.cancel();
    timer = null; picked = []; note = '';
    g = createGame(players(), Play.randomSeed());
    paint(); say();
  }
  els.nu.addEventListener('click', begin);
  ZimiShell.game({
    table: '#st-table',
    inProgress: function () { return !g.over && (g.rolled || g.open !== FULL || g.results[0] !== null); },
    menu: function () { return { options: menuOptions() }; },
    stats: function () {
      var out = [];
      if (stats.games) { out.push([T('shutthebox.shutCount'), Play.num(stats.shut)]); if (stats.best !== null) out.push([T('shutthebox.best'), Play.num(stats.best)]); }
      if (stats.a + stats.b + stats.d) out.push([T('board.you'), Play.num(stats.a)], [T('board.zimi'), Play.num(stats.b)]);
      return out;
    }
  });

  // Leaving keeps the box, the dice, whose turn and the scores so far; the tiles being chosen are chosen again.
  function kept() {
    if (!g.rolled && g.open === FULL && g.results[0] === null) return null;
    return { g: Engine.snapshot(g), mode: settings.mode, level: settings.level };
  }
  function takeUp(d) {
    var s = d && d.g;
    if (!s || !Array.isArray(s.results) || typeof s.open !== 'number' || (d.mode !== 'solo' && d.mode !== 'cpu' && d.mode !== 'two')) return false;
    if (timer) timer.cancel();
    timer = null; picked = []; note = '';
    g = Engine.restore(s);
    settings.mode = d.mode; settings.level = d.level === 'easy' ? 'easy' : 'hard'; save();
    paint();
    if (g.over) { end(true); return true; }
    say();
    if (cpuSeat(g.turn)) timer = Play.later(cpuStep, CPU_DELAY_MS);
    return true;
  }
  build(); begin();
  ZimiShell.persist({ save: kept, load: takeUp });
  root.__shutthebox = { get g() { return g; } };
})(this);
