/* ZimiGames: Yacht. Our own code, GPL-3.0. No network, no fonts, no modules.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var DICE = 5, ROLLS = 3, BONUS_AT = 63, BONUS = 35, STRAIGHT = 30, YACHT = 50;
  var CATS = [
    { id: 'ones', label: 'Ones', face: 1 }, { id: 'twos', label: 'Twos', face: 2 }, { id: 'threes', label: 'Threes', face: 3 },
    { id: 'fours', label: 'Fours', face: 4 }, { id: 'fives', label: 'Fives', face: 5 }, { id: 'sixes', label: 'Sixes', face: 6 },
    { id: 'three', label: 'Three of a kind' }, { id: 'four', label: 'Four of a kind' }, { id: 'house', label: 'Full house' },
    { id: 'little', label: 'Little straight (1-5)' }, { id: 'big', label: 'Big straight (2-6)' },
    { id: 'choice', label: 'Choice' }, { id: 'yacht', label: 'Yacht' }
  ];
  // What a row usually ends up worth for a player who is doing fine; the computer's yardstick.
  var PAR = { ones: 3, twos: 6, threes: 9, fours: 12, fives: 15, sixes: 18, three: 17, four: 12, house: 14, little: 12, big: 12, choice: 22, yacht: 8 };

  function sum(d) { return d.reduce(function (a, b) { return a + b; }, 0); }
  function counts(d) { var c = [0, 0, 0, 0, 0, 0, 0]; d.forEach(function (v) { c[v]++; }); return c; }

  // The score a set of five dice makes in a row.
  function score(cat, d) {
    var c = counts(d), top = Math.max.apply(null, c.slice(1)), i;
    for (i = 0; i < CATS.length; i++) if (CATS[i].id === cat && CATS[i].face) return CATS[i].face * c[CATS[i].face];
    switch (cat) {
      case 'three': return top >= 3 ? sum(d) : 0;
      case 'four': return top >= 4 ? sum(d) : 0;
      case 'house': return c.slice(1).filter(function (n) { return n === 3; }).length === 1 && c.slice(1).filter(function (n) { return n === 2; }).length === 1 ? sum(d) : 0;
      case 'little': return [1, 2, 3, 4, 5].every(function (v) { return c[v] === 1; }) ? STRAIGHT : 0;
      case 'big': return [2, 3, 4, 5, 6].every(function (v) { return c[v] === 1; }) ? STRAIGHT : 0;
      case 'choice': return sum(d);
      case 'yacht': return top === DICE ? YACHT : 0;
    }
    return 0;
  }

  function upper(card) { var t = 0; CATS.slice(0, 6).forEach(function (k) { if (card[k.id] !== undefined) t += card[k.id]; }); return t; }
  function bonus(card) { return upper(card) >= BONUS_AT ? BONUS : 0; }
  function total(card) { var t = bonus(card); CATS.forEach(function (k) { if (card[k.id] !== undefined) t += card[k.id]; }); return t; }
  function openCats(card) { return CATS.filter(function (k) { return card[k.id] === undefined; }).map(function (k) { return k.id; }); }

  function createGame(computers, seed) {
    var players = [{ name: 'You', ai: false, card: {} }], i;
    for (i = 0; i < computers; i++) players.push({ name: 'CPU ' + (i + 1), ai: true, card: {} });
    return { players: players, turn: 0, dice: [0, 0, 0, 0, 0], held: [false, false, false, false, false], rollsLeft: ROLLS, over: false, rng: root.ZimiUtil.counted(seed) };
  }

  function die(g) { return 1 + Math.floor(g.rng() * 6); }

  // Roll every die not held (all of them on the first roll). False when no roll is left.
  function roll(g) {
    if (g.over || g.rollsLeft <= 0) return false;
    for (var i = 0; i < DICE; i++) if (g.rollsLeft === ROLLS || !g.held[i]) g.dice[i] = die(g);
    g.rollsLeft--;
    return true;
  }
  function toggleHold(g, i) {
    if (g.rollsLeft === ROLLS || g.rollsLeft === 0 || i < 0 || i >= DICE) return false;
    g.held[i] = !g.held[i];
    return true;
  }
  // Score the current dice in a row for the player whose turn it is, and pass the turn.
  function choose(g, cat) {
    var p = g.players[g.turn];
    if (g.over || g.rollsLeft === ROLLS || p.card[cat] !== undefined || !CATS.some(function (k) { return k.id === cat; })) return false;
    p.card[cat] = score(cat, g.dice);
    g.turn = (g.turn + 1) % g.players.length;
    g.dice = [0, 0, 0, 0, 0]; g.held = [false, false, false, false, false]; g.rollsLeft = ROLLS;
    g.over = g.players.every(function (q) { return openCats(q.card).length === 0; });
    return true;
  }

  // The computer. How good a set of dice is to it: the best open row, measured against par.
  function worth(d, open) {
    var best = -99;
    for (var i = 0; i < open.length; i++) { var v = score(open[i], d) - PAR[open[i]]; if (v > best) best = v; }
    return best;
  }
  function bestRow(d, open) {
    var best = open[0], bv = -999;
    open.forEach(function (c) { var v = score(c, d) - PAR[c] + (score(c, d) === 0 ? -0.5 : 0); if (v > bv) { bv = v; best = c; } });
    return best;
  }
  // Which dice to keep: the mask whose average re-roll is worth most.
  function bestHold(d, open) {
    var bestMask = 0, bestV = -1e9;
    for (var mask = 0; mask < 32; mask++) {
      var free = [], base = d.slice(), i;
      for (i = 0; i < DICE; i++) if (!(mask & (1 << i))) free.push(i);
      var n = Math.pow(6, free.length), tot = 0, k, j, t;
      for (k = 0; k < n; k++) {
        t = k;
        for (j = 0; j < free.length; j++) { base[free[j]] = 1 + (t % 6); t = Math.floor(t / 6); }
        tot += worth(base, open);
      }
      var v = tot / n;
      if (v > bestV + 1e-9) { bestV = v; bestMask = mask; }
    }
    return [0, 1, 2, 3, 4].map(function (i) { return !!(bestMask & (1 << i)); });
  }

  var Engine = { CATS: CATS, DICE: DICE, ROLLS: ROLLS, BONUS_AT: BONUS_AT, BONUS: BONUS, score: score, upper: upper, bonus: bonus, total: total, openCats: openCats, createGame: createGame, roll: roll, toggleHold: toggleHold, choose: choose, bestHold: bestHold, bestRow: bestRow, snapshot: root.ZimiUtil.snapshot, restore: root.ZimiUtil.restore };
  root.YachtEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var SETTINGS_KEY = 'zimi.games.yacht.settings', BEST_KEY = 'zimi.games.yacht.best';
  var CPU_DELAY_MS = 650, CPU_HOLD_MS = 450, TUMBLE_MS = 320, FLASH_MS = 2000;
  Play.applyTheme();

  var els = { dice: $('yc-dice'), roll: $('yc-roll'), rolls: $('yc-rolls'), msg: $('yc-msg'), card: $('yc-card'), sheet: $('yc-sheet'), title: $('yc-sheet-title'), text: $('yc-sheet-text'), go: $('yc-go'), opp: $('yc-opp'), nu: $('yc-new') };
  var settings = Play.load(SETTINGS_KEY, { computers: 0 }), best = Play.load(BEST_KEY, {});
  var g, seats, timer = null, dieEls = [];
  // What the last row scored, for the score card to pulse and (when a computer scored it) for the status line to say.
  var fresh = null, note = '';
  function none() { return [false, false, false, false, false]; }
  function rowLabel(id) { return T(id === 'yacht' ? 'game.yacht.title' : 'yacht.row.' + id); }
  // Each seat is the Computer or a Person; people take turns at the same screen (nothing is hidden in Yacht).
  function seatPlayers(n) {
    seats = root.ZimiSeats.create({ id: 'yacht', seats: n });
    var cpu = 0;
    g.players.forEach(function (p, i) { p.ai = !seats.person(i); p.name = p.ai ? root.ZimiSeats.cpuName(cpu++) : seats.name(i); });
    if (n === 1) g.players[0].name = T('board.you');
  }
  function newTable() {
    g = createGame(settings.computers, Play.randomSeed());
    seatPlayers(settings.computers + 1);
    fresh = null; note = '';
  }
  newTable();

  function mine() { return !g.players[g.turn].ai && !g.over; }

  function buildDice() {
    els.dice.textContent = '';
    dieEls = [];
    for (var i = 0; i < DICE; i++) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'pl-die';
      (function (n) { b.addEventListener('click', function () { if (!mine()) return; if (toggleHold(g, n)) paint(); else flash(g.rollsLeft === ROLLS ? 'yacht.msg.rollFirst' : 'yacht.msg.noRolls'); }); })(i);
      els.dice.appendChild(b); dieEls.push(b);
    }
  }

  function paintDice() {
    var rolled = g.rollsLeft < ROLLS;
    dieEls.forEach(function (b, i) {
      Play.pips(b, g.dice[i]);
      b.setAttribute('aria-pressed', String(g.held[i]));
      b.setAttribute('aria-disabled', String(!mine() || !rolled || g.rollsLeft === 0));
      b.setAttribute('aria-label', rolled ? T(g.held[i] ? 'yacht.dieKept' : 'yacht.die', { n: i + 1, value: g.dice[i] }) : T('yacht.dieBlank', { n: i + 1 }));
    });
  }

  // The dice that were just thrown tumble for a moment; the held ones stay put. (Not under reduced motion.)
  function tumble(thrown) {
    if (Play.reducedMotion()) return;
    dieEls.forEach(function (b, i) {
      if (!thrown[i]) return;
      b.classList.remove('yc-tumble'); void b.offsetWidth; b.classList.add('yc-tumble');
      setTimeout(function () { b.classList.remove('yc-tumble'); }, TUMBLE_MS);
    });
  }
  // Roll the dice that are not held, and show them tumbling.
  function throwDice() {
    var thrown = g.held.map(function (h) { return !h || g.rollsLeft === ROLLS; });
    if (!roll(g)) return false;
    paint(); tumble(thrown);
    return true;
  }

  function paintCard() {
    var t = els.card, p, rolled = g.rollsLeft < ROLLS, human = mine();
    var cap = t.querySelector('caption');
    cap.textContent = T('yacht.card.aria');
    t.textContent = ''; t.appendChild(cap);
    var head = t.createTHead().insertRow(); head.appendChild(document.createElement('th'));
    g.players.forEach(function (pl, n) { var th = document.createElement('th'); th.scope = 'col'; th.textContent = pl.name; if (n === g.turn && !g.over) th.className = 'yc-turn'; head.appendChild(th); });
    var body = t.createTBody();
    function row(label, cls, cell) {
      var tr = body.insertRow(); if (cls) tr.className = cls;
      var th = document.createElement('th'); th.scope = 'row'; th.textContent = label; tr.appendChild(th);
      g.players.forEach(function (pl, n) { var td = tr.insertCell(); cell(td, pl, n); });
    }
    CATS.forEach(function (k, idx) {
      var label = rowLabel(k.id);
      row(label, '', function (td, pl, n) {
        var v = pl.card[k.id];
        if (v !== undefined) { td.textContent = Play.num(v); if (fresh && fresh.player === n && fresh.cat === k.id) td.className = 'yc-fresh'; return; }
        if (n === g.turn && human && rolled) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'yc-can';
          b.textContent = Play.num(score(k.id, g.dice));
          b.setAttribute('aria-label', T('yacht.rowAria', { row: label, n: score(k.id, g.dice) }));
          b.addEventListener('click', function () { pick(k.id); });
          td.className = 'yc-open'; td.appendChild(b);
        } else td.textContent = '';
      });
      if (idx === 5) {
        row(T('yacht.top', { at: BONUS_AT, bonus: BONUS }), 'yc-sum', function (td, pl) { td.textContent = Play.num(upper(pl.card)) + (bonus(pl.card) ? ' +' + Play.num(BONUS) : ''); });
      }
    });
    row(T('yacht.total'), 'yc-total', function (td, pl) { td.textContent = Play.num(total(pl.card)); });
  }

  // An answer to a tap that cannot do anything, for two seconds; then the line goes back to what is to do.
  var flashTimer = 0;
  function flash(key) {
    els.msg.textContent = T(key);
    root.clearTimeout(flashTimer);
    flashTimer = root.setTimeout(function () { if (!g.over) els.msg.textContent = statusLine(); }, FLASH_MS);
  }
  function statusLine() {
    var p = g.players[g.turn];
    if (!mine()) return T('yacht.msg.playing', { name: p.name });
    if (g.rollsLeft === 0) return T('yacht.msg.pick');
    if (g.rollsLeft < ROLLS) return T('yacht.msg.keep');
    if (note) return note;
    if (g.players.length === 1) return T('yacht.msg.roll');
    return seats.isYou(g.turn) ? T('yacht.msg.rollYou') : T('yacht.msg.rollName', { name: p.name });
  }

  function paint() {
    paintDice(); paintCard();
    els.rolls.textContent = g.over ? '' : T('yacht.rollsLeft', { n: g.rollsLeft });
    els.roll.disabled = !mine() || g.rollsLeft === 0;
    els.roll.textContent = T(g.rollsLeft === ROLLS ? 'backgammon.roll' : 'yacht.rollAgain');
    if (!g.over) els.msg.textContent = statusLine();
  }

  // Score a row for whoever's turn it is and say what it made.
  function scoreRow(cat) {
    var who = g.turn, p = g.players[who];
    if (!choose(g, cat)) return false;
    fresh = { player: who, cat: cat };
    note = p.ai ? T('yacht.msg.scored', { name: p.name, n: p.card[cat], row: rowLabel(cat) }) : '';
    return true;
  }
  function pick(cat) {
    if (!mine() || !scoreRow(cat)) return;
    afterTurn();
  }
  function afterTurn() {
    paint();
    if (g.over) return finish();
    if (g.players[g.turn].ai) cpuTurn();
  }

  // The computer rolls, shows the dice it keeps, rolls the rest, and scores: one visible step each, 650 ms apart.
  function cpuTurn() {
    var step = function () {
      if (g.over || !g.players[g.turn].ai) return;
      var open = openCats(g.players[g.turn].card);
      if (g.rollsLeft === ROLLS) { throwDice(); timer = Play.later(step, CPU_DELAY_MS); return; }
      if (g.rollsLeft > 0) {
        var hold = bestHold(g.dice, open);
        if (!hold.every(Boolean)) {
          g.held = hold; paint();
          timer = Play.later(function () { throwDice(); g.held = none(); timer = Play.later(step, CPU_DELAY_MS); }, CPU_HOLD_MS);
          return;
        }
      }
      scoreRow(bestRow(g.dice, open)); afterTurn();
    };
    timer = Play.later(step, CPU_DELAY_MS);
  }

  function finish() {
    var scores = g.players.map(function (p) { return total(p.card); }), top = Math.max.apply(null, scores);
    var key = String(g.players.length), text, title = T('shell.end.over');
    var me = seats.people()[0];
    if (g.players.length === 1) text = T('yacht.end.solo', { n: scores[0] });
    else {
      var winners = g.players.filter(function (p, i) { return scores[i] === top; }), w = g.players.indexOf(winners[0]);
      if (winners.length > 1) { title = T('shell.end.draw'); text = T('yacht.end.tie', { n: top }); }
      else if (seats.isYou(w)) { title = T('shell.end.win'); text = T('yacht.end.you', { n: top }); }
      else if (seats.hotseat()) { title = T('shell.end.wins', { name: winners[0].name }); text = T('yacht.end.other', { name: winners[0].name, n: top }); }
      else { title = T('shell.end.lose'); text = T('yacht.end.otherYou', { name: winners[0].name, n: top, me: scores[me] }); }
    }
    if (seats.hotseat()) text += ' ' + g.players.map(function (p, i) { return p.name + ' ' + Play.num(scores[i]); }).join(', ') + '.';
    else if (scores[me] > (best[key] || 0)) { best[key] = scores[me]; Play.save(BEST_KEY, best); text += ' ' + T('yacht.end.newBest'); }
    else text += ' ' + T('yacht.end.best', { n: best[key] });
    els.msg.textContent = text;
    showSheet(title, text, T('shell.menu.new'));
  }

  function paintOpp() {
    els.opp.textContent = '';
    [0, 1, 2, 3].forEach(function (n) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = n === 0 ? T('shelf.players.solo') : Play.num(n + 1);
      b.setAttribute('aria-pressed', String(settings.computers === n));
      b.addEventListener('click', function () { settings.computers = n; Play.save(SETTINGS_KEY, settings); paintOpp(); });
      b.setAttribute('aria-label', n === 0 ? T('shelf.players.solo') : T('yacht.nPlayers', { n: n + 1 }));
      els.opp.appendChild(b);
    });
  }
  function showSheet(title, text, label) {
    els.title.textContent = title; els.text.textContent = text; els.go.textContent = label; paintOpp();
    var host = $('yc-seats'); host.textContent = '';
    if (settings.computers > 0) host.appendChild(root.ZimiSeats.create({ id: 'yacht', seats: settings.computers + 1 }).block());
    Play.openSheet(els.sheet, '#yc-go');
  }
  function begin() {
    if (timer) timer.cancel();
    newTable();
    Play.closeSheet(els.sheet); els.msg.textContent = ''; paint();
    if (g.players[g.turn].ai) cpuTurn();
  }
  els.card.addEventListener('click', function (e) {
    var td = e.target.closest && e.target.closest('td');
    if (!td || !mine() || td.parentNode.className.indexOf('yc-') === 0 || td.cellIndex !== g.turn + 1 || td.querySelector('button')) return;
    flash(td.textContent.trim() ? 'yacht.msg.used' : 'yacht.msg.rollFirst');
  });
  function humanRoll() { if (mine() && g.rollsLeft > 0) { note = ''; throwDice(); } }
  els.go.addEventListener('click', begin);
  els.nu.addEventListener('click', function () { if (timer) timer.cancel(); showSheet(T('shell.menu.new'), T('yacht.new'), T('shell.start')); });
  els.roll.addEventListener('click', humanRoll);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !els.sheet.hidden) return;
    if (e.target && e.target.closest && e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === ' ' || e.key === 'r' || e.key === 'R') { e.preventDefault(); humanRoll(); }
    else if (e.key >= '1' && e.key <= '5') { if (mine() && toggleHold(g, +e.key - 1)) paint(); }
  });

  buildDice();
  paint();
  showSheet(T('game.yacht.title'), T('yacht.intro'), T('shell.start'));
  // Never lose a game: the card, the dice and where the dice generator stood, so the next roll is the roll that was next.
  // Nothing is kept until the first roll.
  ZimiShell.persist({
    save: function () { return g.rollsLeft < ROLLS || g.players.some(function (p) { return Object.keys(p.card).length; }) ? { g: Engine.snapshot(g) } : null; },
    load: function (data) {
      var saved = data && data.g;
      if (!saved || !Array.isArray(saved.players) || !saved.players.length || !Array.isArray(saved.dice) || saved.dice.length !== DICE) return false;
      g = Engine.restore(saved);
      seatPlayers(g.players.length);
      Play.closeSheet(els.sheet); els.msg.textContent = ''; paint();
      if (g.over) finish(); else if (g.players[g.turn].ai) cpuTurn();
      return true;
    }
  });
  root.__yacht = { get g() { return g; } };
})(this);
