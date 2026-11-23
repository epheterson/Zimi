/* ZimiGames: Memory. Our own code and our own pictures, GPL-3.0. No network, no fonts, no modules.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the pictures: pictures.js draws them; Memory plays with these two sets ──
  var SETS = { animals: root.ZimiPictures.sets.animals, shapes: root.ZimiPictures.sets.shapes };

  // ── the rules ────────────────────────────────────────────────────────────
  var SIZES = { small: 6, medium: 8, large: 10 }; // pairs
  var MISMATCH_MS = 950;

  var mulberry = root.ZimiUtil.mulberry32;

  // A shuffled deck: `pairs` different pictures, two cards of each.
  function createGame(pairs, seed) {
    var rng = mulberry(seed === undefined ? root.ZimiUtil.newSeed() : seed), ids = [], i;
    for (i = 0; i < pairs; i++) ids.push(i, i);
    for (i = ids.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)), t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
    return { cards: ids.map(function (id) { return { id: id, up: false, done: false }; }), first: -1, pending: null, moves: 0, pairs: pairs, found: 0, over: false };
  }

  // Turn card i over. Returns 'first' (one card up), 'match', 'mismatch' (two up, call resolve) or 'ignored'.
  function flip(g, i) {
    var c = g.cards[i];
    if (!c || g.over || c.up || c.done || g.pending) return 'ignored';
    c.up = true;
    if (g.first < 0) { g.first = i; return 'first'; }
    var a = g.cards[g.first];
    g.moves++;
    if (a.id === c.id) {
      a.done = c.done = true; g.first = -1; g.found++;
      if (g.found === g.pairs) g.over = true;
      return 'match';
    }
    g.pending = [g.first, i]; g.first = -1;
    return 'mismatch';
  }
  // Turn a mismatched pair back down.
  function resolve(g) {
    if (!g.pending) return false;
    g.pending.forEach(function (k) { g.cards[k].up = false; });
    g.pending = null;
    return true;
  }

  var Engine = { SETS: SETS, SIZES: SIZES, createGame: createGame, flip: flip, resolve: resolve };
  root.MemoryEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var SETTINGS_KEY = 'zimi.games.memory.settings', BEST_KEY = 'zimi.games.memory.best', MAX_PEOPLE = 4, END_AFTER_MS = 650;
  Play.applyTheme();

  var els = { grid: $('mm-grid'), moves: $('mm-moves'), pairs: $('mm-pairs'), best: $('mm-best'), msg: $('mm-msg'), who: $('mm-players'), nu: $('mm-new') };
  var status = Play.status(els.msg);
  var settings = Play.load(SETTINGS_KEY, { set: 'animals', size: 'medium', people: 1 }), best = Play.load(BEST_KEY, {});
  var g = null, timer = null, buttons = [], pics;
  // People sharing the screen take turns: a match keeps the turn, a miss passes it. Nothing is hidden.
  var seats = null, turn = 0, scores = [];
  function people() { return Math.max(1, Math.min(MAX_PEOPLE, settings.people || 1)); }
  function multi() { return seats && seats.hotseat(); }
  function newSeats() {
    var n = people();
    seats = root.ZimiSeats.create({ id: 'memory', seats: n });
    for (var i = 0; i < n; i++) if (!seats.person(i)) seats.setKind(i, 'person'); // everyone at the table is a person
    turn = 0; scores = []; for (i = 0; i < n; i++) scores.push(0);
  }
  function picName(c) { return T('memory.pic.' + pics[c.id][0].toLowerCase()); }
  function paintPlayers() {
    els.who.hidden = !multi();
    els.who.textContent = '';
    if (!multi()) return;
    scores.forEach(function (v, i) {
      var chip = document.createElement('span'), name = document.createElement('span'), n = document.createElement('b');
      chip.className = 'gs-chip'; name.textContent = seats.name(i); n.textContent = Play.num(v);
      if (i === turn && !g.over) chip.setAttribute('aria-current', 'true');
      chip.appendChild(name); chip.appendChild(n); els.who.appendChild(chip);
    });
  }
  function resolveNow() { if (resolve(g) && multi()) { turn = (turn + 1) % scores.length; if (!g.over) status.say(T('memory.turn', { name: seats.name(turn) })); } }
  // A daily is sixteen cards whatever size the player keeps for their own games, so its table, best and save all say medium.
  function isDaily() { return !!(root.ZimiShell && root.ZimiShell.daily); }
  function sizeNow() { return isDaily() ? 'medium' : settings.size; }
  function bestKey() { return settings.set + '.' + sizeNow(); }

  function cols(n) { return n <= 12 ? 3 : 4; }

  function build() {
    pics = SETS[settings.set].pics;
    els.grid.textContent = '';
    els.grid.style.setProperty('--cols', cols(g.cards.length));
    els.grid.classList.remove('won'); els.grid.classList.add('still');   // a fresh deal does not flip itself
    setTimeout(function () { els.grid.classList.remove('still'); }, 0);
    buttons = g.cards.map(function (c, i) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'mm-card'; b.style.setProperty('--k', i);
      b.innerHTML = '<span class="mm-inner"><span class="mm-back"></span><span class="mm-face"><svg viewBox="0 0 64 64" aria-hidden="true">' + pics[c.id][1] + '</svg></span></span>';
      b.addEventListener('click', function () { pick(i); });
      els.grid.appendChild(b);
      return b;
    });
    ZimiUtil.gridAria(els.grid, buttons, cols(buttons.length));
    ZimiUtil.gridRove(els.grid, buttons, cols(buttons.length));
    paint();
  }
  function paint() {
    g.cards.forEach(function (c, i) {
      var b = buttons[i];
      var up = String(c.up || c.done);
      if (b.dataset.up !== undefined && b.dataset.up !== up) b.dataset.flip = '1';   // only a card that turns animates
      b.dataset.up = up; b.dataset.done = String(c.done); b.dataset.miss = String(!!g.pending && g.pending.indexOf(i) >= 0);
      b.setAttribute('aria-label', c.up || c.done ? T(c.done ? 'memory.matched' : 'memory.faceUp', { pic: picName(c) }) : T('memory.faceDown', { n: i + 1 }));
      b.setAttribute('aria-disabled', String(c.done));   // not `disabled`: a matched card keeps the focus, so the arrow keys keep working
    });
    els.moves.textContent = Play.num(g.moves); els.pairs.textContent = T('memory.pairsOf', { found: g.found, pairs: g.pairs });
    els.best.textContent = multi() || !best[bestKey()] ? '-' : Play.num(best[bestKey()]);
    paintPlayers();
  }

  function settle() { // turn a mismatched pair back, now
    if (timer) { timer.cancel(); timer = null; }
    var had = !!g.pending; resolveNow(); if (had) paint();
  }
  function pick(i) {
    if (g.over) return;
    settle();
    var r = flip(g, i);
    if (r === 'ignored') return;
    paint();
    if (r === 'match') {
      if (multi()) scores[turn]++;
      status.say(multi() ? T('memory.matchBy', { name: seats.name(turn), pic: picName(g.cards[i]) }) : T('memory.match', { pic: picName(g.cards[i]) }));
      paint();
      if (g.over) finish();
    } else if (r === 'mismatch') {
      status.say(T('memory.miss'));
      timer = Play.later(function () { timer = null; resolveNow(); paint(); }, MISMATCH_MS);
    } else status.say('');
  }

  function finish() {
    var k = bestKey();
    paint();
    els.grid.classList.add('won');   // the whole table lifts in a wave before the sheet
    if (multi()) {
      var top = Math.max.apply(null, scores), win = seats.people().filter(function (s) { return scores[s] === top; });
      status.say(win.length > 1 ? T('memory.tie') : T('memory.wins', { name: seats.name(win[0]) }));
      ZimiShell.endSheet(win.length > 1 ? { result: 'draw', after: END_AFTER_MS, stats: [[T('memory.pairs'), Play.num(top)]] } : { result: 'win', name: seats.name(win[0]), after: END_AFTER_MS, stats: [[T('memory.pairs'), Play.num(top)]] });
      return;
    }
    if (!best[k] || g.moves < best[k]) { best[k] = g.moves; Play.save(BEST_KEY, best); }
    paint();
    status.say(T('memory.done', { n: g.moves }));
    ZimiShell.endSheet({ result: 'win', after: END_AFTER_MS, stats: [[T('memory.moves'), Play.num(g.moves)], [T('play.best'), Play.num(best[k])]] });
  }

  // What the game asks for is a real choice (pictures, cards, people), so it lives in the New game pane.
  function save() { Play.save(SETTINGS_KEY, settings); }
  function names() {
    var host = document.createElement('div'), n = people();
    host.className = 'mm-names';
    if (n < 2) return host;
    var sx = root.ZimiSeats.create({ id: 'memory', seats: n }), saved = root.ZimiSeats.loadNames(n);
    for (var i = 0; i < n; i++) (function (i) {
      var inp = document.createElement('input'); inp.type = 'text'; inp.className = 'mm-name'; inp.maxLength = 14; inp.value = saved[i]; inp.setAttribute('aria-label', T('memory.nameFor', { n: i + 1 }));
      inp.addEventListener('change', function () { sx.setName(i, inp.value); inp.value = root.ZimiSeats.loadNames(n)[i]; });
      host.appendChild(inp);
    })(i);
    return host;
  }
  function menuOptions() {
    var nameBox = names();
    function refreshNames() { var fresh = names(); nameBox.replaceWith(fresh); nameBox = fresh; }
    return [
      Play.optionRow(T('memory.pictures'), Object.keys(SETS).map(function (k) { return [k, T('memory.set.' + k)]; }), settings.set, function (v) { settings.set = v; save(); }),
      Play.optionRow(T('memory.cards'), [['small', Play.num(12)], ['medium', Play.num(16)], ['large', Play.num(20)]], settings.size, function (v) { settings.size = v; save(); }),
      Play.optionRow(T('memory.players'), [[1, T('memory.solo')], [2, Play.num(2)], [3, Play.num(3)], [4, Play.num(4)]], people(), function (v) { settings.people = v; save(); refreshNames(); }),
      nameBox
    ];
  }
  function begin() {
    if (timer) { timer.cancel(); timer = null; }
    g = createGame(SIZES[sizeNow()]); newSeats(); build();
    status.say(multi() ? T('memory.turn', { name: seats.name(turn) }) : T('memory.start'));
  }
  els.nu.addEventListener('click', begin);
  ZimiShell.game({
    inProgress: function () { return !!g && !g.over && g.moves > 0; },
    menu: function () { return { options: menuOptions() }; },
    stats: function () {
      var rows = [];
      Object.keys(SETS).forEach(function (k) { Object.keys(SIZES).forEach(function (z) { var v = best[k + '.' + z]; if (v) rows.push([T('memory.bestRow', { set: T('memory.set.' + k), cards: SIZES[z] * 2 }), T('memory.nMoves', { n: v })]); }); });
      return rows;
    }
  });

  // Leaving and coming back keeps the table: the deal, what is up, the turn and the scores (a mismatched pair is turned back first).
  function kept() {
    if (!g || (g.moves === 0 && g.first < 0)) return null;
    return { set: settings.set, size: sizeNow(), people: people(), cards: g.cards.map(function (c) { return [c.id, c.up && !(g.pending && g.pending.indexOf(g.cards.indexOf(c)) >= 0) ? 1 : 0, c.done ? 1 : 0]; }),
      first: g.first, moves: g.moves, found: g.found, over: g.over,
      turn: g.pending && multi() ? (turn + 1) % scores.length : turn, scores: scores };   // a miss waiting to turn back has already passed the turn
  }
  function takeUp(d) {
    if (!d || !SETS[d.set] || !SIZES[d.size] || !Array.isArray(d.cards) || d.cards.length !== SIZES[d.size] * 2) return false;
    settings.set = d.set; if (!isDaily()) settings.size = d.size; settings.people = d.people; save();
    g = createGame(SIZES[d.size]); newSeats();
    g.cards = d.cards.map(function (c) { return { id: c[0], up: !!c[1], done: !!c[2] }; });
    g.first = d.first; g.moves = d.moves; g.found = d.found; g.over = !!d.over; turn = d.turn || 0; scores = d.scores || scores;
    build();
    if (g.over) finish(); else status.say(multi() ? T('memory.turn', { name: seats.name(turn) }) : T('memory.start'));
    return true;
  }
  begin();
  if (root.ZimiShell.persist) root.ZimiShell.persist({ save: kept, load: takeUp });
  root.__memory = { get g() { return g; } };
})(this);
