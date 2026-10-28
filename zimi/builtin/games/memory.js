/* ZimiGames: Memory. Our own code and our own pictures, GPL-3.0. No network, no fonts, no modules.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the pictures: drawn here, 64 x 64, flat colours ──────────────────────
  var SETS = {
    animals: { label: 'Animals', pics: [
      ['Cat', '<path d="M11 30 13 7l16 11zM53 30 51 7 35 18z" fill="#e8923a"/><circle cx="32" cy="37" r="21" fill="#f0a04b"/><circle cx="24" cy="33" r="3.2" fill="#222"/><circle cx="40" cy="33" r="3.2" fill="#222"/><path d="M29.5 39h5L32 42.5z" fill="#d9626f"/><path d="M12 38l12 2M12 45l12-3M52 38l-12 2M52 45l-12-3" stroke="#6b4a2a" stroke-width="1.6" fill="none" stroke-linecap="round"/>'],
      ['Dog', '<ellipse cx="13" cy="32" rx="7" ry="15" fill="#7a5230" transform="rotate(12 13 32)"/><ellipse cx="51" cy="32" rx="7" ry="15" fill="#7a5230" transform="rotate(-12 51 32)"/><ellipse cx="32" cy="35" rx="18" ry="20" fill="#d2a87a"/><ellipse cx="32" cy="43" rx="10" ry="8" fill="#f1dcc0"/><circle cx="24" cy="30" r="3" fill="#222"/><circle cx="40" cy="30" r="3" fill="#222"/><ellipse cx="32" cy="38" rx="4.5" ry="3.2" fill="#222"/><path d="M32 41v4M27 46q5 4 10 0" stroke="#222" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M29 47q3 8 6 0z" fill="#e5707e"/>'],
      ['Fish', '<path d="M44 32 60 18v28z" fill="#2f86b5"/><ellipse cx="28" cy="32" rx="22" ry="14" fill="#3fa7d6"/><path d="M24 20q6-8 14-4-4 6-6 8z" fill="#2f86b5"/><circle cx="16" cy="29" r="3.6" fill="#fff"/><circle cx="15.2" cy="29" r="1.8" fill="#222"/><path d="M26 22q4 10 0 20M34 23q4 9 0 18" stroke="#2f86b5" stroke-width="2" fill="none"/>'],
      ['Bird', '<path d="M10 44 2 52M14 48 8 58" stroke="#2f6fc0" stroke-width="4" stroke-linecap="round"/><ellipse cx="30" cy="38" rx="20" ry="16" fill="#4f8fe0"/><circle cx="43" cy="26" r="11" fill="#4f8fe0"/><path d="M52 24l10 4-10 5z" fill="#f2a516"/><circle cx="45" cy="24" r="2.6" fill="#fff"/><circle cx="45.6" cy="24" r="1.3" fill="#222"/><path d="M14 36q10-10 22 2-8 8-20 4z" fill="#2f6fc0"/><path d="M26 54v6M34 54v6" stroke="#f2a516" stroke-width="2.4" stroke-linecap="round"/>'],
      ['Frog', '<ellipse cx="32" cy="40" rx="25" ry="17" fill="#58b85f"/><circle cx="20" cy="24" r="10" fill="#58b85f"/><circle cx="44" cy="24" r="10" fill="#58b85f"/><circle cx="20" cy="24" r="6" fill="#fff"/><circle cx="44" cy="24" r="6" fill="#fff"/><circle cx="21" cy="25" r="3" fill="#222"/><circle cx="43" cy="25" r="3" fill="#222"/><path d="M18 44q14 12 28 0" stroke="#2b6b30" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="27" cy="38" r="1.2" fill="#2b6b30"/><circle cx="37" cy="38" r="1.2" fill="#2b6b30"/>'],
      ['Rabbit', '<ellipse cx="23" cy="17" rx="6.5" ry="16" fill="#ece8e2" stroke="#bbb4ab"/><ellipse cx="41" cy="17" rx="6.5" ry="16" fill="#ece8e2" stroke="#bbb4ab"/><ellipse cx="23" cy="18" rx="3" ry="11" fill="#f4b6c2"/><ellipse cx="41" cy="18" rx="3" ry="11" fill="#f4b6c2"/><circle cx="32" cy="42" r="17" fill="#ece8e2" stroke="#bbb4ab"/><circle cx="25" cy="40" r="2.8" fill="#222"/><circle cx="39" cy="40" r="2.8" fill="#222"/><path d="M29.5 46h5L32 49z" fill="#e5707e"/><path d="M32 49v3M28 53q4 2 4-1 0 3 4 1" stroke="#555" stroke-width="1.4" fill="none"/>'],
      ['Owl', '<path d="M14 18 20 8 26 16zM50 18 44 8 38 16z" fill="#7a5a3a"/><ellipse cx="32" cy="36" rx="21" ry="24" fill="#8b6b4a"/><ellipse cx="32" cy="44" rx="12" ry="14" fill="#d8bd96"/><circle cx="22" cy="28" r="9" fill="#fff"/><circle cx="42" cy="28" r="9" fill="#fff"/><circle cx="22" cy="28" r="4.2" fill="#222"/><circle cx="42" cy="28" r="4.2" fill="#222"/><path d="M28 33h8l-4 7z" fill="#f2a516"/><path d="M24 46q4 3 8 0M32 46q4 3 8 0M26 52q3 2 6 0M32 52q3 2 6 0" stroke="#a98962" stroke-width="1.6" fill="none"/>'],
      ['Turtle', '<path d="M8 41q0-25 26-25t26 25z" fill="#3d9a4a"/><path d="M34 16v25M20 22l8 19M48 22l-8 19" stroke="#2b6b30" stroke-width="2" fill="none"/><circle cx="56" cy="38" r="7" fill="#8fcf8a"/><circle cx="58" cy="36" r="1.6" fill="#222"/><rect x="14" y="41" width="9" height="10" rx="4" fill="#8fcf8a"/><rect x="40" y="41" width="9" height="10" rx="4" fill="#8fcf8a"/><path d="M8 41 2 46 9 45z" fill="#8fcf8a"/><path d="M6 41h54v4q-27 5-54 0z" fill="#2b6b30"/>'],
      ['Bee', '<ellipse cx="22" cy="20" rx="9" ry="13" fill="#bfe3f5" stroke="#7fb4d0" transform="rotate(-25 22 20)"/><ellipse cx="38" cy="18" rx="9" ry="13" fill="#bfe3f5" stroke="#7fb4d0" transform="rotate(25 38 18)"/><ellipse cx="32" cy="40" rx="20" ry="15" fill="#f4c22b"/><path d="M26 27q-4 13 0 26M34 26q-4 14 0 28M42 29q-4 11 0 22" stroke="#222" stroke-width="5" fill="none"/><circle cx="14" cy="38" r="2.4" fill="#222"/><path d="M12 31 8 26M17 29 16 23" stroke="#222" stroke-width="1.6" stroke-linecap="round"/><path d="M52 40l8 2-8 2z" fill="#222"/>'],
      ['Penguin', '<ellipse cx="32" cy="36" rx="19" ry="24" fill="#2b3340"/><ellipse cx="32" cy="41" rx="12" ry="17" fill="#f4f6f8"/><circle cx="25" cy="25" r="3.6" fill="#fff"/><circle cx="39" cy="25" r="3.6" fill="#fff"/><circle cx="26" cy="25.5" r="1.7" fill="#222"/><circle cx="38" cy="25.5" r="1.7" fill="#222"/><path d="M27 30h10l-5 6z" fill="#f2a516"/><path d="M14 42 6 54l10-4zM50 42l8 12-10-4z" fill="#2b3340"/><ellipse cx="25" cy="59" rx="7" ry="3" fill="#f2a516"/><ellipse cx="39" cy="59" rx="7" ry="3" fill="#f2a516"/>']
    ] },
    shapes: { label: 'Shapes', pics: [
      ['Circle', '<circle cx="32" cy="32" r="22" fill="#e8574a" stroke="#2b3340" stroke-width="2.5"/>'],
      ['Square', '<rect x="10" y="10" width="44" height="44" rx="4" fill="#3a63c9" stroke="#2b3340" stroke-width="2.5"/>'],
      ['Triangle', '<path d="M32 8 58 54H6z" fill="#f2c12e" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Star', '<path d="M32 6l7.4 16.2 17.7 2-13.2 12 3.7 17.5L32 44.6 16.4 53.7l3.7-17.5-13.2-12 17.7-2z" fill="#f2a516" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Heart', '<path d="M32 56C10 40 8 22 20 15c6-3 11 0 12 6 1-6 6-9 12-6 12 7 10 25-12 41z" fill="#e0457b" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Moon', '<path d="M40 8a24 24 0 1 0 0 48 19 19 0 1 1 0-48z" fill="#7a6bd6" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Diamond', '<path d="M32 6 54 32 32 58 10 32z" fill="#3fc1e8" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Hexagon', '<path d="M18 10h28l14 22-14 22H18L4 32z" fill="#58b85f" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Plus', '<path d="M24 8h16v16h16v16H40v16H24V40H8V24h16z" fill="#8a55c9" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>'],
      ['Drop', '<path d="M32 6C44 22 52 32 52 42a20 20 0 0 1-40 0C12 32 20 22 32 6z" fill="#3a8fd6" stroke="#2b3340" stroke-width="2.5" stroke-linejoin="round"/>']
    ] }
  };
  // the tenth shape: a ring, so a set of ten pairs is always there
  SETS.shapes.pics.push(['Ring', '<circle cx="32" cy="32" r="20" fill="none" stroke="#d1473f" stroke-width="10"/><circle cx="32" cy="32" r="25" fill="none" stroke="#2b3340" stroke-width="2"/><circle cx="32" cy="32" r="15" fill="none" stroke="#2b3340" stroke-width="2"/>']);

  // ── the rules ────────────────────────────────────────────────────────────
  var SIZES = { small: 6, medium: 8, large: 10 }; // pairs
  var MISMATCH_MS = 950;

  var mulberry = root.ZimiUtil.mulberry32;

  // A shuffled deck: `pairs` different pictures, two cards of each.
  function createGame(pairs, seed) {
    var rng = mulberry(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed), ids = [], i;
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
  function bestKey() { return settings.set + '.' + settings.size; }

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
    paint();
  }
  function paint() {
    g.cards.forEach(function (c, i) {
      var b = buttons[i];
      b.dataset.up = String(c.up || c.done); b.dataset.done = String(c.done); b.dataset.miss = String(!!g.pending && g.pending.indexOf(i) >= 0);
      b.setAttribute('aria-label', c.up || c.done ? T(c.done ? 'memory.matched' : 'memory.faceUp', { pic: picName(c) }) : T('memory.faceDown', { n: i + 1 }));
      b.disabled = c.done;
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
    g = createGame(SIZES[settings.size]); newSeats(); build();
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

  // Arrow keys move between cards; the browser's own Tab and Enter work as well.
  els.grid.addEventListener('keydown', function (e) {
    var i = buttons.indexOf(document.activeElement); if (i < 0) return;
    var n = cols(buttons.length), d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -n, ArrowDown: n }[e.key];
    if (!d) return;
    e.preventDefault();
    var k = i + d; if (k >= 0 && k < buttons.length) buttons[k].focus();
  });

  // Leaving and coming back keeps the table: the deal, what is up, the turn and the scores (a mismatched pair is turned back first).
  function kept() {
    if (!g || (g.moves === 0 && g.first < 0)) return null;
    return { set: settings.set, size: settings.size, people: people(), cards: g.cards.map(function (c) { return [c.id, c.up && !(g.pending && g.pending.indexOf(g.cards.indexOf(c)) >= 0) ? 1 : 0, c.done ? 1 : 0]; }),
      first: g.first, moves: g.moves, found: g.found, over: g.over, turn: turn, scores: scores };
  }
  function takeUp(d) {
    if (!d || !SETS[d.set] || !SIZES[d.size] || !Array.isArray(d.cards) || d.cards.length !== SIZES[d.size] * 2) return false;
    settings.set = d.set; settings.size = d.size; settings.people = d.people; save();
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
