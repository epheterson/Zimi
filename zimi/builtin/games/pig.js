/* ZimiGames: Pig. Our own code, GPL-3.0. No network, no fonts, no modules.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document).
   Roll one die as often as you dare; the rolls add up for the turn. A 1 loses the turn's total. Hold to keep it.
   First to the goal wins. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var GOAL = 100, SIDES = 6, BUST = 1;
  // How far the computer rolls before it holds: Easy keeps a small total, Hard follows the well-known play (about 20),
  // goes for the finish when it is near, and takes more risk when the other side is about to win.
  var HOLD_EASY = 8, HOLD_HARD = 20, FINISH_RANGE = 25, DANGER_SCORE = 75, DANGER_HOLD = 32;

  function createGame(seed, goal) {
    return { goal: goal || GOAL, scores: [0, 0], turn: 0, pot: 0, die: 0, over: false, winner: -1, rng: root.ZimiUtil.counted(seed) };
  }
  function other(i) { return 1 - i; }

  // Bank the turn's total for whoever's turn it is; the goal ends the game, otherwise the turn passes.
  function bank(g) {
    var me = g.turn;
    g.scores[me] += g.pot; g.pot = 0;
    if (g.scores[me] >= g.goal) { g.over = true; g.winner = me; } else g.turn = other(me);
  }
  // Roll the die. Returns the face (0 when the game is over). A 1 loses the total and passes the turn; reaching the goal wins at once.
  function roll(g) {
    if (g.over) return 0;
    var d = 1 + Math.floor(g.rng() * SIDES);
    g.die = d;
    if (d === BUST) { g.pot = 0; g.turn = other(g.turn); return d; }
    g.pot += d;
    if (g.scores[g.turn] + g.pot >= g.goal) bank(g);
    return d;
  }
  // Keep the turn's total. False when there is none to keep.
  function hold(g) {
    if (g.over || g.pot <= 0) return false;
    bank(g);
    return true;
  }

  // The computer: 'roll' or 'hold'.
  function decide(g, level) {
    if (g.pot <= 0) return 'roll';
    var me = g.scores[g.turn], them = g.scores[other(g.turn)], need = g.goal - me, at;
    if (level === 'easy') at = Math.min(HOLD_EASY, need);
    else if (need <= FINISH_RANGE) at = need;
    else if (them >= DANGER_SCORE && me < them) at = Math.min(need, DANGER_HOLD);
    else at = HOLD_HARD;
    return g.pot >= at ? 'hold' : 'roll';
  }

  var Engine = { GOAL: GOAL, createGame: createGame, roll: roll, hold: hold, decide: decide, other: other, snapshot: root.ZimiUtil.snapshot, restore: root.ZimiUtil.restore };
  root.PigEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var SETTINGS_KEY = 'zimi.games.pig.settings', STATS_KEY = 'zimi.games.pig.stats';
  var CPU_DELAY_MS = 700, TUMBLE_MS = 320, END_AFTER_MS = 900;
  Play.applyTheme();

  var els = { msg: $('pg-msg'), roll: $('pg-roll'), hold: $('pg-hold'), die: $('pg-die'), pot: $('pg-pot'), nu: $('pg-new'), table: $('pg-table'),
    name: [$('pg-a-name'), $('pg-b-name')], score: [$('pg-a-score'), $('pg-b-score')], side: [$('pg-a'), $('pg-b')], bank: [$('pg-a-bank'), $('pg-b-bank')], pend: [$('pg-a-pend'), $('pg-b-pend')] };
  var line = Play.status(els.msg);
  var settings = Play.load(SETTINGS_KEY, { opp: 'cpu', level: 'hard' }), stats = Play.load(STATS_KEY, { a: 0, b: 0 });
  var g = createGame(Play.randomSeed()), timer = null, note = '';

  function cpuSeat(i) { return settings.opp === 'cpu' && i === 1; }
  function nameOf(i) { return settings.opp === 'cpu' ? T(i === 0 ? 'board.you' : 'board.zimi') : T('pig.player', { n: i + 1 }); }
  function mine() { return !g.over && !cpuSeat(g.turn); }

  function base() {
    if (g.over) return '';
    if (cpuSeat(g.turn)) return T('shell.thinking');
    if (g.pot > 0) return T('pig.again');
    return settings.opp === 'cpu' ? T('board.yourTurn') : T('pig.toRoll', { name: nameOf(g.turn) });
  }
  function say() { if (!g.over) line.say((note ? note + ' ' : '') + base()); }

  function paint() {
    var pct = function (n) { return Math.min(100, Math.round(100 * n / g.goal)) + '%'; };
    for (var i = 0; i < 2; i++) {
      els.name[i].textContent = nameOf(i);
      els.score[i].textContent = Play.num(g.scores[i]);
      els.side[i].classList.toggle('pg-turn', !g.over && g.turn === i);
      els.side[i].setAttribute('aria-current', String(!g.over && g.turn === i));
      els.bank[i].style.width = pct(g.scores[i]);
      els.pend[i].style.width = g.turn === i && !g.over ? pct(Math.min(g.pot, g.goal - g.scores[i])) : '0%';
      els.pend[i].style.left = pct(g.scores[i]);
    }
    els.pot.textContent = Play.num(g.pot);
    Play.pips(els.die, g.die);
    els.die.classList.toggle('pg-bust', g.die === BUST);
    els.die.setAttribute('aria-label', g.die ? T('pig.die', { n: g.die }) : T('pig.dieBlank'));
    els.roll.disabled = !mine(); els.hold.disabled = !mine() || g.pot <= 0;
    els.roll.setAttribute('aria-disabled', String(els.roll.disabled)); els.hold.setAttribute('aria-disabled', String(els.hold.disabled));
  }
  function tumble() {
    if (Play.reducedMotion()) return;
    els.die.classList.remove('pg-tumble'); void els.die.offsetWidth; els.die.classList.add('pg-tumble');
    setTimeout(function () { els.die.classList.remove('pg-tumble'); }, TUMBLE_MS);
  }

  function end(replay) {
    var w = g.winner, opts = { after: replay ? 0 : END_AFTER_MS };
    if (!replay) { stats[w === 0 ? 'a' : 'b']++; Play.save(STATS_KEY, stats); }
    if (settings.opp === 'cpu') { opts.result = w === 0 ? 'win' : 'lose'; line.say(T(w === 0 ? 'shell.end.win' : 'shell.end.lose')); }
    else { opts.result = 'win'; opts.name = nameOf(w); line.say(T('shell.end.wins', { name: opts.name })); }
    paint();
    ZimiShell.endSheet(opts);
  }

  // After any roll or hold: say what happened, then hand over to the computer if it is its turn.
  function afterAction(who, face, banked) {
    paint();
    if (g.over) return end();
    if (face === BUST) note = T(cpuSeat(who) || settings.opp === 'two' ? 'pig.bustName' : 'pig.bustYou', { name: nameOf(who) });
    else if (banked) note = cpuSeat(who) || settings.opp === 'two' ? T('pig.held', { name: nameOf(who), n: banked }) : '';
    else note = '';
    say();
    if (cpuSeat(g.turn)) timer = Play.later(cpuStep, CPU_DELAY_MS);
  }
  function doRoll() {
    var who = g.turn, d = roll(g);
    tumble();
    afterAction(who, d, 0);
  }
  function doHold() {
    var who = g.turn, n = g.pot;
    if (hold(g)) afterAction(who, 0, n);
  }
  function cpuStep() {
    if (g.over || !cpuSeat(g.turn)) return;
    if (decide(g, settings.level) === 'hold') doHold(); else doRoll();
  }

  els.roll.addEventListener('click', function () { if (mine()) doRoll(); else ZimiShell.shake(els.roll); });
  els.hold.addEventListener('click', function () {
    if (!mine()) return;
    if (g.pot <= 0) { ZimiShell.shake(els.hold); line.reason(T('pig.nothing')); return; }
    doHold();
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden]), .gs-sheet')) return;
    if (e.target && e.target.closest && e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === ' ' || e.key === 'r' || e.key === 'R') { e.preventDefault(); if (mine()) doRoll(); }
    else if (e.key === 'h' || e.key === 'H') { if (mine() && g.pot > 0) doHold(); }
  });

  function save() { Play.save(SETTINGS_KEY, settings); }
  function menuOptions() {
    var box = document.createElement('div');
    function fill() {
      box.textContent = '';
      box.appendChild(Play.optionRow(T('noughts.opponent'), [['cpu', T('board.zimi')], ['two', T('noughts.friend')]], settings.opp, function (v) { settings.opp = v; save(); fill(); }));
      if (settings.opp === 'cpu') box.appendChild(Play.optionRow(T('board.level'), [['easy', T('board.level.easy')], ['hard', T('board.level.hard')]], settings.level, function (v) { settings.level = v; save(); }));
    }
    fill();
    return [box];
  }
  function begin() {
    if (timer) timer.cancel();
    g = createGame(Play.randomSeed()); note = '';
    paint(); say();
  }
  els.nu.addEventListener('click', begin);
  ZimiShell.game({
    table: '#pg-table',
    inProgress: function () { return !g.over && (g.scores[0] + g.scores[1] + g.pot > 0 || g.die > 0); },
    menu: function () { return { options: menuOptions() }; },
    stats: function () { return stats.a + stats.b ? [[T('board.you'), Play.num(stats.a)], [settings.opp === 'cpu' ? T('board.zimi') : T('pig.player', { n: 2 }), Play.num(stats.b)]] : []; }
  });

  // Leaving keeps the scores, the turn's total, the die and where the dice generator stood; a finished game comes back to its end sheet.
  function kept() {
    if (!g.scores[0] && !g.scores[1] && !g.pot && !g.die) return null;
    return { g: Engine.snapshot(g), opp: settings.opp, level: settings.level };
  }
  function takeUp(d) {
    var s = d && d.g;
    if (!s || !Array.isArray(s.scores) || s.scores.length !== 2 || (d.opp !== 'cpu' && d.opp !== 'two')) return false;
    if (timer) timer.cancel();
    g = Engine.restore(s);
    settings.opp = d.opp; settings.level = d.level === 'easy' ? 'easy' : 'hard'; save(); note = '';
    paint();
    if (g.over) { end(true); return true; }
    say();
    if (cpuSeat(g.turn)) timer = Play.later(cpuStep, CPU_DELAY_MS);
    return true;
  }
  begin();
  ZimiShell.persist({ save: kept, load: takeUp });
  root.__pig = { get g() { return g; } };
})(this);
