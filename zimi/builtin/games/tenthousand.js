/* ZimiGames: Ten Thousand. Our own code, GPL-3.0. No network, no fonts, no modules.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document).
   Six dice. Roll, set aside the dice that score, then bank the turn's points or roll the rest. A roll with nothing that
   scores loses the turn's points. All six scored: roll all six again. First to the goal; the other side gets one last turn. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var DICE = 6, SIDES = 6, GOAL = 10000, GOAL_SHORT = 5000;
  var SINGLE = { 1: 100, 5: 50 };                                          // a lone 1 or 5
  var TRIPLE = { 1: 1000, 2: 200, 3: 300, 4: 400, 5: 500, 6: 600 };       // three of a face; each die more doubles it
    var STRAIGHT = 1500, THREE_PAIRS = 1500;                                 // 1 to 6; three different pairs
  
  function counts(vals) { var c = [0, 0, 0, 0, 0, 0, 0]; vals.forEach(function (v) { c[v]++; }); return c; }
  // The most that c dice of one face can score when every one of them counts, or -1 when they cannot.
  function faceScore(face, c) {
    if (c === 0) return 0;
    var best = -1, single = SINGLE[face] || 0, k, v;
    if (single) best = c * single;
    for (k = 3; k <= c; k++) {
      if (c - k > 0 && !single) continue;
      v = (TRIPLE[face] * Math.pow(2, k - 3)) + (c - k) * single;
      if (v > best) best = v;
    }
    return best;
  }
  // What these dice score when every one of them counts (0 when one does not score: a selection must be all scoring dice).
  function score(vals) {
    if (!vals.length) return 0;
    var c = counts(vals), total = 0, face, f, best;
    for (face = 1; face <= SIDES; face++) {
      f = faceScore(face, c[face]);
      if (f < 0) { total = -1; break; }
      total += f;
    }
    best = total > 0 ? total : 0;
    if (vals.length === DICE) {
      if (c.slice(1).every(function (n) { return n === 1; })) best = Math.max(best, STRAIGHT);
      else if (c.slice(1).filter(function (n) { return n === 2; }).length === 3) best = Math.max(best, THREE_PAIRS);
    }
    return best;
  }
  // Does anything in this roll score?
  function scores(vals) {
    var c = counts(vals);
    if (c[1] || c[5]) return true;
    for (var f = 2; f <= SIDES; f++) if (c[f] >= 3) return true;
    return vals.length === DICE && score(vals) > 0;
  }
  // The most any set of dice can score by setting aside every die that counts (what a player who takes all of it gets).
  function bestTake(vals) {
    var c = counts(vals), total = 0, face, f;
    for (face = 1; face <= SIDES; face++) {
      f = faceScore(face, c[face]);
      if (f > 0 && (SINGLE[face] || c[face] >= 3)) total += f;
    }
    if (vals.length === DICE && (c.slice(1).every(function (n) { return n === 1; }) || c.slice(1).filter(function (n) { return n === 2; }).length === 3)) total = Math.max(total, STRAIGHT);
    return total;
  }
  // Every way to set aside some of these dice (indices into vals) that scores: [{ idx, score }].
  function selections(vals) {
    var out = [], n = vals.length, m, idx, i, s;
    for (m = 1; m < (1 << n); m++) {
      idx = []; for (i = 0; i < n; i++) if (m & (1 << i)) idx.push(i);
      s = score(idx.map(function (j) { return vals[j]; }));
      if (s > 0) out.push({ idx: idx, score: s });
    }
    return out;
  }

  function createGame(seed, goal) {
    return { goal: goal || GOAL, scores: [0, 0], turn: 0, dice: [0, 0, 0, 0, 0, 0], locked: [false, false, false, false, false, false],
      pot: 0, phase: 'roll', farkle: false, final: -1, over: false, winner: -1, banked: 0, rng: root.ZimiUtil.counted(seed) };
  }
  function other(i) { return 1 - i; }
  function free(g) { var out = []; g.dice.forEach(function (v, i) { if (!g.locked[i]) out.push(i); }); return out; }
  function freeValues(g) { return free(g).map(function (i) { return g.dice[i]; }); }

  // The turn is over (banked or lost): the other side plays, unless this was the last turn of the game.
  function endTurn(g, keepDice) {
    var next = other(g.turn);
    g.pot = 0; g.locked = [false, false, false, false, false, false]; g.phase = 'roll';
    if (!keepDice) g.dice = [0, 0, 0, 0, 0, 0];     // a farkle leaves the dead roll on the table for a moment
    if (g.final >= 0 && next === g.final) {
      g.over = true;
      g.winner = g.scores[0] === g.scores[1] ? -1 : (g.scores[0] > g.scores[1] ? 0 : 1);
      return;
    }
    g.turn = next;
  }
  // Roll the dice that are not set aside (all six after all six scored). Nothing that scores is a farkle: the turn's points are lost.
  function roll(g) {
    if (g.over || g.phase !== 'roll') return false;
    if (free(g).length === 0) g.locked = [false, false, false, false, false, false];   // hot dice
    g.farkle = false; g.banked = 0;
    free(g).forEach(function (i) { g.dice[i] = 1 + Math.floor(g.rng() * SIDES); });
    if (!scores(freeValues(g))) { g.farkle = true; endTurn(g, true); return true; }
    g.phase = 'pick';
    return true;
  }
  // The score of setting aside these dice (indices into g.dice, all of them free); 0 when they do not all score.
  function pickScore(g, idx) {
    if (g.phase !== 'pick' || !idx.length) return 0;
    var seen = {}, i;
    for (i = 0; i < idx.length; i++) { if (g.locked[idx[i]] || seen[idx[i]] || idx[i] < 0 || idx[i] >= DICE) return 0; seen[idx[i]] = true; }
    return score(idx.map(function (j) { return g.dice[j]; }));
  }
  // Set the dice aside; bank the turn's points or go on to roll the rest. False when the pick does not score.
  function keep(g, idx, bank) {
    var s = pickScore(g, idx);
    if (g.over || s <= 0) return false;
    idx.forEach(function (i) { g.locked[i] = true; });
    g.pot += s;
    if (!bank) { g.phase = 'roll'; return true; }
    g.scores[g.turn] += g.pot; g.banked = g.pot;
    if (g.scores[g.turn] >= g.goal && g.final < 0) g.final = g.turn;
    endTurn(g);
    return true;
  }

  // The computer's sums: for k dice rolled, the chance that nothing scores, and what a scoring roll is worth taking at once.
  var odds = null;
  function oddsTable() {
    if (odds) return odds;
    odds = [null];
    for (var k = 1; k <= DICE; k++) {
      var n = Math.pow(SIDES, k), dead = 0, gain = 0, o, t, j, vals;
      for (o = 0; o < n; o++) {
        vals = []; t = o; for (j = 0; j < k; j++) { vals.push(1 + (t % SIDES)); t = Math.floor(t / SIDES); }
        if (!scores(vals)) { dead++; continue; }
        gain += bestTake(vals);
      }
      odds.push({ dead: dead / n, gain: gain / (n - dead) });
    }
    return odds;
  }
  var EASY_BANK_AT = 300;
  // What the computer does with a roll: the dice to set aside and whether to bank. Hard weighs each way of setting dice aside by what
  // it is worth to bank now or to roll what is left once (the chance of a farkle against the points a roll adds).
  function plan(g, level) {
    var vals = freeValues(g), idxFree = free(g), sels = selections(vals), me = g.scores[g.turn], them = g.scores[other(g.turn)];
    var t = oddsTable(), best = null, bv = -Infinity, bankNow = false;
    sels.forEach(function (s) {
      var P = g.pot + s.score, left = vals.length - s.idx.length, kk = left === 0 ? DICE : left, o = t[kk];
      var rollV = (1 - o.dead) * (P + o.gain), bank = P, v, wantsBank;
      if (level === 'easy') { v = s.idx.length * 1e6 + s.score; wantsBank = P >= EASY_BANK_AT; }
      else {
        wantsBank = bank >= rollV;
        if (left === 0) wantsBank = false;                                      // all six scored: roll them all again
        if (g.final >= 0) wantsBank = me + P > them;                            // the last turn: only a winning bank will do
        else if (me + P >= g.goal) wantsBank = true;                            // reaching the goal ends the race for this side
        v = wantsBank ? bank : rollV;
        if (g.final >= 0 && !wantsBank) v = rollV - 1e5;
      }
      if (v > bv) { bv = v; best = s; bankNow = wantsBank; }
    });
    return { idx: best.idx.map(function (j) { return idxFree[j]; }), bank: bankNow };
  }

  var Engine = { DICE: DICE, GOAL: GOAL, GOAL_SHORT: GOAL_SHORT, score: score, scores: scores, selections: selections, createGame: createGame, roll: roll, pickScore: pickScore, keep: keep, plan: plan, free: free, oddsTable: oddsTable, snapshot: root.ZimiUtil.snapshot, restore: root.ZimiUtil.restore };
  root.TenThousandEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var SETTINGS_KEY = 'zimi.games.tenthousand.settings', STATS_KEY = 'zimi.games.tenthousand.stats';
  var CPU_DELAY_MS = 800, CPU_PICK_MS = 900, TUMBLE_MS = 320, END_AFTER_MS = 900;
  Play.applyTheme();

  var els = { msg: $('tt-msg'), roll: $('tt-roll'), bank: $('tt-bank'), dice: $('tt-dice'), pick: $('tt-pick'), pot: $('tt-pot'), goal: $('tt-goal'), nu: $('tt-new'),
    name: [$('tt-a-name'), $('tt-b-name')], score: [$('tt-a-score'), $('tt-b-score')], side: [$('tt-a'), $('tt-b')], meter: [$('tt-a-bank'), $('tt-b-bank')] };
  var line = Play.status(els.msg);
  var settings = Play.load(SETTINGS_KEY, { opp: 'cpu', level: 'hard', goal: GOAL }), stats = Play.load(STATS_KEY, { a: 0, b: 0, d: 0 });
  if (settings.goal !== GOAL_SHORT) settings.goal = GOAL;
  var g, timer = null, dieEls = [], picked = [], note = '';

  function cpuSeat(i) { return settings.opp === 'cpu' && i === 1; }
  function nameOf(i) { return settings.opp === 'cpu' ? T(i === 0 ? 'board.you' : 'board.zimi') : T('pig.player', { n: i + 1 }); }
  function mine() { return !g.over && !cpuSeat(g.turn) && !timer; }
  function pickValue() { return pickScore(g, picked); }

  function build() {
    els.dice.textContent = '';
    dieEls = [];
    for (var i = 0; i < DICE; i++) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'pl-die tt-die';
      (function (n) { b.addEventListener('click', function () { tap(n); }); })(i);
      els.dice.appendChild(b); dieEls.push(b);
    }
  }
  function base() {
    if (g.over) return '';
    if (cpuSeat(g.turn)) return T('shell.thinking');
    if (g.phase === 'roll') return g.pot > 0 && free(g).length === 0 ? T('tenthousand.hot') : T(g.pot > 0 ? 'tenthousand.rollMore' : 'tenthousand.roll');
    if (picked.length && !pickValue()) return T('tenthousand.badPick');
    return picked.length ? T('tenthousand.choose', { n: g.pot + pickValue() }) : T('tenthousand.pick');
  }
  function say() { if (!g.over) line.say((note ? note + ' ' : '') + base()); }

  function paint() {
    var pct = function (n) { return Math.min(100, Math.round(100 * n / g.goal)) + '%'; };
    for (var i = 0; i < 2; i++) {
      els.name[i].textContent = nameOf(i);
      els.score[i].textContent = Play.num(g.scores[i]);
      els.side[i].classList.toggle('tt-turn', !g.over && g.turn === i);
      els.side[i].setAttribute('aria-current', String(!g.over && g.turn === i));
      els.meter[i].style.width = pct(g.scores[i]);
    }
    els.goal.textContent = T('tenthousand.goal', { n: Play.num(g.goal) });
    var rolled = g.phase === 'pick' || g.dice.some(Boolean);
    dieEls.forEach(function (b, i) {
      var v = g.dice[i], sel = picked.indexOf(i) >= 0, locked = g.locked[i];
      Play.pips(b, v);
      b.classList.toggle('tt-locked', locked);
      b.classList.toggle('tt-dead', g.farkle && g.phase === 'roll');
      b.setAttribute('aria-pressed', String(sel));
      b.setAttribute('aria-disabled', String(!mine() || locked || g.phase !== 'pick'));
      b.setAttribute('aria-label', !rolled || !v ? T('tenthousand.dieBlank', { n: i + 1 }) : T(locked ? 'tenthousand.dieAside' : sel ? 'tenthousand.dieChosen' : 'tenthousand.die', { n: i + 1, value: v }));
    });
    var pv = pickValue();
    els.pick.textContent = picked.length ? (pv ? '+' + Play.num(pv) : '–') : '0';
    els.pot.textContent = Play.num(g.pot);
    var canRoll = mine() && (g.phase === 'roll' || pv > 0), canBank = mine() && g.phase === 'pick' && pv > 0;
    els.roll.disabled = !canRoll; els.bank.disabled = !canBank;
    els.roll.setAttribute('aria-disabled', String(!canRoll)); els.bank.setAttribute('aria-disabled', String(!canBank));
  }
  function tumble(was) {
    if (Play.reducedMotion()) return;
    dieEls.forEach(function (b, i) {
      if (was[i]) return;
      b.classList.remove('tt-tumble'); void b.offsetWidth; b.classList.add('tt-tumble');
      setTimeout(function () { b.classList.remove('tt-tumble'); }, TUMBLE_MS);
    });
  }

  function end(replay) {
    var opts = { after: replay ? 0 : END_AFTER_MS }, w = g.winner;
    if (!replay) {
      if (settings.opp === 'cpu') { if (w === 0) stats.a++; else if (w === 1) stats.b++; else stats.d++; }
      Play.save(STATS_KEY, stats);
    }
    opts.text = T('tenthousand.final', { a: nameOf(0), x: Play.num(g.scores[0]), b: nameOf(1), y: Play.num(g.scores[1]) });
    if (w < 0) opts.result = 'draw';
    else if (settings.opp === 'cpu') opts.result = w === 0 ? 'win' : 'lose';
    else { opts.result = 'win'; opts.name = nameOf(w); }
    line.say(opts.text); paint();
    ZimiShell.endSheet(opts);
  }

  function afterRoll(wasFarkle, who, lost) {
    picked = [];
    if (wasFarkle) note = T('tenthousand.farkle', { name: nameOf(who) });
    else note = '';
    paint();
    if (g.over) return end();
    say();
    if (cpuSeat(g.turn)) timer = Play.later(g.phase === 'pick' ? cpuPick : cpuRoll, wasFarkle ? CPU_PICK_MS : CPU_PICK_MS);
  }
  function doRoll() {
    var who = g.turn, was = g.locked.slice();
    if (!roll(g)) return;
    if (!g.farkle) tumble(was);
    afterRoll(g.farkle, who);
  }
  function cpuRoll() { timer = null; if (!g.over && cpuSeat(g.turn)) doRoll(); }
  function cpuPick() {
    timer = null;
    if (g.over || !cpuSeat(g.turn) || g.phase !== 'pick') return;
    var p = plan(g, settings.level), who = g.turn;
    picked = p.idx.slice(); paint();                                             // show the dice it sets aside first
    timer = Play.later(function () {
      timer = null;
      var pot = g.pot + pickValue();
      keep(g, picked.slice(), p.bank);
      picked = [];
      note = p.bank ? T('tenthousand.banks', { name: nameOf(who), n: Play.num(pot) }) : '';
      paint();
      if (g.over) return end();
      if (p.bank) { note += (g.final >= 0 && g.turn !== g.final ? ' ' + T('tenthousand.lastTurn', { name: nameOf(g.final), n: Play.num(g.goal) }) : ''); say(); if (cpuSeat(g.turn)) timer = Play.later(cpuRoll, CPU_DELAY_MS); return; }
      say();
      timer = Play.later(cpuRoll, CPU_DELAY_MS);
    }, CPU_DELAY_MS);
  }
  function humanKeep(bank) {
    if (!mine() || g.phase !== 'pick') return;
    var who = g.turn, pot = g.pot + pickValue();
    if (!keep(g, picked.slice(), bank)) { ZimiShell.shake(bank ? els.bank : els.roll); line.reason(T('tenthousand.badPick')); return; }
    picked = [];
    if (bank) {
      note = T(settings.opp === 'cpu' ? 'tenthousand.youBank' : 'tenthousand.banks', { name: nameOf(who), n: Play.num(pot) });
      if (g.final >= 0 && !g.over) note += ' ' + T('tenthousand.lastTurn', { name: nameOf(g.final), n: Play.num(g.goal) });
      paint();
      if (g.over) return end();
      say();
      if (cpuSeat(g.turn)) timer = Play.later(cpuRoll, CPU_DELAY_MS);
    } else { note = ''; paint(); doRoll(); }
  }
  function tap(i) {
    if (g.over || cpuSeat(g.turn)) return;
    if (g.phase !== 'pick') { ZimiShell.shake(dieEls[i]); line.reason(T('tenthousand.rollFirst')); return; }
    if (g.locked[i]) { ZimiShell.shake(dieEls[i]); line.reason(T('tenthousand.aside')); return; }
    var at = picked.indexOf(i);
    if (at >= 0) picked.splice(at, 1); else picked.push(i);
    note = ''; paint(); say();
  }

  els.roll.addEventListener('click', function () { if (!mine()) return; if (g.phase === 'roll') { note = ''; doRoll(); } else humanKeep(false); });
  els.bank.addEventListener('click', function () { humanKeep(true); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden])')) return;
    if (e.target && e.target.closest && e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === ' ' || e.key === 'r' || e.key === 'R') { e.preventDefault(); els.roll.click(); }
    else if (e.key === 'b' || e.key === 'B') els.bank.click();
    else if (e.key >= '1' && e.key <= '6') tap(+e.key - 1);
  });

  function save() { Play.save(SETTINGS_KEY, settings); }
  function menuOptions() {
    var box = document.createElement('div');
    function fill() {
      box.textContent = '';
      box.appendChild(Play.optionRow(T('noughts.opponent'), [['cpu', T('board.zimi')], ['two', T('noughts.friend')]], settings.opp, function (v) { settings.opp = v; save(); fill(); }));
      if (settings.opp === 'cpu') box.appendChild(Play.optionRow(T('board.level'), [['easy', T('board.level.easy')], ['hard', T('board.level.hard')]], settings.level, function (v) { settings.level = v; save(); }));
      box.appendChild(Play.optionRow(T('tenthousand.race'), [[GOAL_SHORT, Play.num(GOAL_SHORT)], [GOAL, Play.num(GOAL)]], settings.goal, function (v) { settings.goal = v; save(); }));
    }
    fill();
    return [box];
  }
  function begin() {
    if (timer) timer.cancel();
    timer = null; picked = []; note = '';
    g = createGame(Play.randomSeed(), settings.goal);
    paint(); say();
  }
  els.nu.addEventListener('click', begin);
  ZimiShell.game({
    table: '#tt-table',
    inProgress: function () { return !g.over && (g.scores[0] + g.scores[1] + g.pot > 0 || g.phase === 'pick'); },
    menu: function () { return { options: menuOptions() }; },
    stats: function () { return stats.a + stats.b + stats.d ? [[T('board.you'), Play.num(stats.a)], [T('noughts.draws'), Play.num(stats.d)], [T('board.zimi'), Play.num(stats.b)]] : []; }
  });

  // Leaving keeps the scores, the dice on the table with those set aside, and where the dice generator stood.
  function kept() {
    if (!g.scores[0] && !g.scores[1] && !g.pot && g.phase === 'roll') return null;
    return { g: Engine.snapshot(g), opp: settings.opp, level: settings.level };
  }
  function takeUp(d) {
    var s = d && d.g;
    if (!s || !Array.isArray(s.dice) || s.dice.length !== DICE || !Array.isArray(s.locked) || (d.opp !== 'cpu' && d.opp !== 'two')) return false;
    if (timer) timer.cancel();
    timer = null; picked = []; note = '';
    g = Engine.restore(s);
    settings.opp = d.opp; settings.level = d.level === 'easy' ? 'easy' : 'hard'; settings.goal = g.goal === GOAL_SHORT ? GOAL_SHORT : GOAL; save();
    paint();
    if (g.over) { end(true); return true; }
    say();
    if (cpuSeat(g.turn)) timer = Play.later(g.phase === 'pick' ? cpuPick : cpuRoll, CPU_DELAY_MS);
    return true;
  }
  build(); begin();
  ZimiShell.persist({ save: kept, load: takeUp });
  root.__tenthousand = { get g() { return g; } };
})(this);
