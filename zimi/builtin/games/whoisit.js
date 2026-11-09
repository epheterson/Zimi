/* ZimiGames: Who Is It. Our own code and our own drawn faces (whoisit-art.js), GPL-3.0. No network, no modules.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document).
   Twenty-four faces. Each side secretly has one. Take turns asking whether the face has a feature; every answer flips down the faces
   it rules out. Guess a face to win; a wrong guess flips that face down and ends the turn. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var FACES = 24, COLS = 6;
  var STYLES = ['short', 'long', 'curly', 'bald'], STYLE_ODDS = [0.38, 0.24, 0.2, 0.18];
  var HAIRS = ['black', 'brown', 'blond', 'red', 'gray'], HAIR_ODDS = [0.28, 0.28, 0.2, 0.12, 0.12];
  var ODDS = { glasses: 0.3, hat: 0.25, mustache: 0.2, beard: 0.17, earrings: 0.22, freckles: 0.25, open: 0.42 };
  var MIN_SHOWN = 3;   // a feature that fewer faces than this have (or lack) is no question to ask
  var DRAWS = 400;     // tries at a set of faces that tells every question and every face apart

  // The questions, in the order they are shown. test(face) is whether the face has it.
  var FEATURES = [
    { id: 'glasses', test: function (f) { return !!f.glasses; } },
    { id: 'hat', test: function (f) { return f.hat !== false; } },
    { id: 'mustache', test: function (f) { return !!f.mustache; } },
    { id: 'beard', test: function (f) { return !!f.beard; } },
    { id: 'bald', test: function (f) { return f.style === 'bald'; } },
    { id: 'blond', test: function (f) { return f.style !== 'bald' && f.hair === 'blond'; } },
    { id: 'red', test: function (f) { return f.style !== 'bald' && f.hair === 'red'; } },
    { id: 'black', test: function (f) { return f.style !== 'bald' && f.hair === 'black'; } },
    { id: 'brown', test: function (f) { return f.style !== 'bald' && f.hair === 'brown'; } },
    { id: 'gray', test: function (f) { return f.style !== 'bald' && f.hair === 'gray'; } },
    { id: 'long', test: function (f) { return f.style === 'long'; } },
    { id: 'curly', test: function (f) { return f.style === 'curly'; } },
    { id: 'earrings', test: function (f) { return !!f.earrings; } },
    { id: 'freckles', test: function (f) { return !!f.freckles; } },
    { id: 'open', test: function (f) { return !!f.open; } }
  ];
  var BY_ID = {};
  FEATURES.forEach(function (x) { BY_ID[x.id] = x; });

  function pickWeighted(list, odds, rnd) {
    var r = rnd(), acc = 0, i;
    for (i = 0; i < list.length; i++) { acc += odds[i]; if (r < acc) return list[i]; }
    return list[list.length - 1];
  }
  function randomFace(rnd) {
    var f = { skin: Math.floor(rnd() * 5), eyes: Math.floor(rnd() * 3), hair: pickWeighted(HAIRS, HAIR_ODDS, rnd), style: pickWeighted(STYLES, STYLE_ODDS, rnd), hat: false };
    Object.keys(ODDS).forEach(function (k) { var on = rnd() < ODDS[k]; f[k] = on; });
    f.hat = f.hat ? Math.floor(rnd() * 5) : false;
    return f;
  }
  // Everything a question can tell apart: two faces with the same signature could never be told apart, so no set has two.
  function signature(f) {
    return [f.style === 'bald' ? '-' : f.hair, f.style, f.glasses ? 1 : 0, f.hat !== false ? 1 : 0, f.mustache ? 1 : 0, f.beard ? 1 : 0, f.earrings ? 1 : 0, f.freckles ? 1 : 0, f.open ? 1 : 0].join('');
  }
  function count(faces, id) { return faces.filter(BY_ID[id].test).length; }
  // A set of faces in which every face is different and every question is worth asking.
  function makeFaces(rnd) {
    var tries, faces, seen, f, ok;
    for (tries = 0; tries < DRAWS; tries++) {
      faces = []; seen = {};
      while (faces.length < FACES) {
        f = randomFace(rnd);
        if (!seen[signature(f)]) { seen[signature(f)] = true; faces.push(f); }
      }
      ok = FEATURES.every(function (x) { var n = count(faces, x.id); return n >= MIN_SHOWN && FACES - n >= MIN_SHOWN; });
      if (ok) return faces;
    }
    return faces;   // (never reached in practice: the odds above make a good set one try in a few)
  }
  function all() { var a = []; for (var i = 0; i < FACES; i++) a.push(i); return a; }

  // secret[0] is the face you look for (Zimi's); secret[1] is the face Zimi looks for (yours). cands[side] are the faces still in play for that side.
  function createGame(seed, level) {
    var rng = root.ZimiUtil.counted(seed), faces = makeFaces(rng), a = Math.floor(rng() * FACES), b = Math.floor(rng() * FACES);
    return { faces: faces, secret: [a, b], cands: [all(), all()], asked: [[], []], answers: [{}, {}], turn: 0, level: level === 'easy' ? 'easy' : 'hard', over: false, winner: -1, last: null, rng: rng };
  }
  // Side `who` asks whether its target has the feature. The faces that answer the other way flip down. Returns the answer.
  function ask(g, who, id) {
    if (g.over || g.turn !== who || !BY_ID[id] || g.asked[who].indexOf(id) >= 0) return null;
    var answer = BY_ID[id].test(g.faces[g.secret[who]]);
    g.cands[who] = g.cands[who].filter(function (i) { return BY_ID[id].test(g.faces[i]) === answer; });
    g.asked[who].push(id); g.answers[who][id] = answer;
    g.last = { who: who, kind: 'ask', id: id, answer: answer };
    g.turn = 1 - who;
    return answer;
  }
  // Side `who` guesses a face. Right wins; wrong flips that face down and ends the turn. Returns true or false (null: not allowed).
  function guess(g, who, i) {
    if (g.over || g.turn !== who || g.cands[who].indexOf(i) < 0) return null;
    var right = g.secret[who] === i;
    g.last = { who: who, kind: 'guess', index: i, right: right };
    if (right) { g.over = true; g.winner = who; return true; }
    g.cands[who] = g.cands[who].filter(function (j) { return j !== i; });
    g.turn = 1 - who;
    return false;
  }

  // How a question divides the faces still in play: { yes, no }.
  function divide(g, cands, id) {
    var yes = 0, t = BY_ID[id].test;
    cands.forEach(function (i) { if (t(g.faces[i])) yes++; });
    return { yes: yes, no: cands.length - yes };
  }
  // Zimi's move (side `who`, Zimi by default): { kind: 'ask', id } or { kind: 'guess', index }. Hard asks the question that divides the faces left most evenly and guesses
  // with two left (a coin flip now beats a turn spent); Easy asks any question that divides them, and guesses only when one is left.
  function zimiMove(g, who) {
    who = who === 0 ? 0 : 1;
    var cands = g.cands[who], pool, best, bestGap = Infinity, rnd = g.rng;
    if (cands.length === 1 || (g.level === 'hard' && cands.length <= 2)) return { kind: 'guess', index: cands[Math.floor(rnd() * cands.length)] };
    pool = FEATURES.filter(function (x) { var d = divide(g, cands, x.id); return g.asked[who].indexOf(x.id) < 0 && d.yes > 0 && d.no > 0; });
    if (!pool.length) return { kind: 'guess', index: cands[Math.floor(rnd() * cands.length)] };
    if (g.level === 'easy') return { kind: 'ask', id: pool[Math.floor(rnd() * pool.length)].id };
    pool.forEach(function (x) {
      var d = divide(g, cands, x.id), gap = Math.abs(d.yes - d.no) + rnd() * 0.5;   // the half-point breaks ties a different way each game
      if (gap < bestGap) { bestGap = gap; best = x.id; }
    });
    return { kind: 'ask', id: best };
  }

  var Engine = { FACES: FACES, COLS: COLS, FEATURES: FEATURES, makeFaces: makeFaces, signature: signature, createGame: createGame, ask: ask, guess: guess, divide: divide, zimiMove: zimiMove, has: function (face, id) { return BY_ID[id].test(face); }, snapshot: root.ZimiUtil.snapshot, restore: root.ZimiUtil.restore };
  root.WhoIsItEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, Art = root.WhoIsItArt, $ = Play.$, T = Play.T;
  var SETTINGS_KEY = 'zimi.games.whoisit.settings', STATS_KEY = 'zimi.games.whoisit.stats';
  var CPU_DELAY_MS = 900, CPU_SHOW_MS = 900, END_AFTER_MS = 900;
  Play.applyTheme();

  var els = { msg: $('wi-msg'), grid: $('wi-grid'), tray: $('wi-tray'), guess: $('wi-guess'), mine: $('wi-mine'), youLeft: $('wi-you-left'), zimiLeft: $('wi-zimi-left'), nu: $('wi-new') };
  var line = Play.status(els.msg);
  var settings = Play.load(SETTINGS_KEY, { level: 'hard' }), stats = Play.load(STATS_KEY, { a: 0, b: 0 });
  var g, timer = null, cells = [], chips = [], selected = -1;

  function featureName(id) { return T('whoisit.f.' + id); }
  function answerWord(yes) { return T(yes ? 'whoisit.yes' : 'whoisit.no'); }
  function mine() { return !g.over && g.turn === 0 && !timer; }
  function traits(face) { return FEATURES.filter(function (x) { return x.test(face); }).map(function (x) { return featureName(x.id); }).join(', '); }

  function build() {
    els.grid.textContent = ''; els.tray.textContent = '';
    cells = []; chips = [];
    for (var i = 0; i < FACES; i++) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'wi-face';
      (function (n) { b.addEventListener('click', function () { tapFace(n); }); })(i);
      els.grid.appendChild(b); cells.push(b);
    }
    root.ZimiUtil.gridAria(els.grid, cells, COLS);
    root.ZimiUtil.gridRove(els.grid, cells, COLS);
    FEATURES.forEach(function (x) {
      var q = document.createElement('button'); q.type = 'button'; q.className = 'wi-q'; q.dataset.f = x.id;
      q.innerHTML = Art.iconSvg(x.id, 34) + '<i class="wi-a" aria-hidden="true"></i>';   // our own drawing, a fixed string
      q.addEventListener('click', function () { tapQuestion(x.id); });
      els.tray.appendChild(q); chips.push(q);
    });
  }

  function paint() {
    var cand = g.cands[0], left = cand.length;
    cells.forEach(function (b, i) {
      var out = cand.indexOf(i) < 0, face = g.faces[i], mark = g.over && g.secret[0] === i;
      if (b.dataset.face !== String(i) + (out ? 'x' : 'o')) { b.innerHTML = out ? '' : Art.faceSvg(face); b.dataset.face = String(i) + (out ? 'x' : 'o'); }   // a fixed string we drew
      b.classList.toggle('wi-down', out); b.classList.toggle('wi-sel', i === selected); b.classList.toggle('wi-reveal', mark);
      b.setAttribute('aria-disabled', String(out || !mine()));
      b.setAttribute('aria-selected', String(i === selected));
      b.setAttribute('aria-label', out ? T('whoisit.faceOut', { n: i + 1 }) : T('whoisit.face', { n: i + 1, traits: traits(face) }));
    });
    chips.forEach(function (q) {
      var id = q.dataset.f, was = g.answers[0][id], asked = was !== undefined;
      q.classList.toggle('wi-asked', asked); q.dataset.a = asked ? (was ? 'yes' : 'no') : '';
      q.querySelector('.wi-a').textContent = asked ? (was ? '✓' : '✕') : '';
      q.setAttribute('aria-disabled', String(asked || !mine()));
      q.setAttribute('aria-label', asked ? T('whoisit.askedAria', { feature: featureName(id), answer: answerWord(was) }) : T('whoisit.askAria', { feature: featureName(id) }));
      q.title = featureName(id);
    });
    els.youLeft.textContent = Play.num(left); els.zimiLeft.textContent = Play.num(g.cands[1].length);
    els.mine.innerHTML = Art.faceSvg(g.faces[g.secret[1]]);   // our own drawing
    els.guess.disabled = !(mine() && selected >= 0); els.guess.setAttribute('aria-disabled', String(els.guess.disabled));
  }

  // What the line says: the last thing that happened, then what to do.
  function lastLine() {
    var l = g.last;
    if (!l) return '';
    if (l.kind === 'ask') return T(l.who === 0 ? 'whoisit.youAsked' : 'whoisit.zimiAsked', { feature: featureName(l.id), answer: answerWord(l.answer) });
    return l.right ? '' : T(l.who === 0 ? 'whoisit.youWrong' : 'whoisit.zimiWrong');
  }
  function say() {
    if (g.over) return;
    var base = g.turn === 1 ? T('shell.thinking') : selected >= 0 ? T('whoisit.sure') : g.cands[0].length === 1 ? T('whoisit.lastOne') : T('whoisit.yourTurn');
    line.say((lastLine() ? lastLine() + ' ' : '') + base);
  }

  function end(replay) {
    var opts = { after: replay ? 0 : END_AFTER_MS }, w = g.winner;
    if (!replay) { stats[w === 0 ? 'a' : 'b']++; Play.save(STATS_KEY, stats); }
    opts.result = w === 0 ? 'win' : 'lose';
    opts.text = T(w === 0 ? 'whoisit.youWin' : 'whoisit.zimiWin');
    // Zimi's face is shown whoever won: the one you were looking for.
    var wrap = document.createElement('div'); wrap.className = 'wi-reveal-face';
    var cap = document.createElement('small'); cap.textContent = T('whoisit.itWas');
    var pic = document.createElement('span'); pic.innerHTML = Art.faceSvg(g.faces[g.secret[0]], 84);   // our own drawing
    wrap.appendChild(pic); wrap.appendChild(cap);
    opts.extra = [wrap];
    line.say(opts.text); paint();
    ZimiShell.endSheet(opts);
  }

  function tapFace(i) {
    if (g.over) return;
    if (g.turn !== 0 || timer) { ZimiShell.shake(cells[i]); line.reason(T('shell.thinking')); return; }
    if (g.cands[0].indexOf(i) < 0) { ZimiShell.shake(cells[i]); line.reason(T('whoisit.out')); return; }
    selected = selected === i ? -1 : i;
    paint(); say();
  }
  function tapQuestion(id) {
    if (g.over) return;
    var q = chips[FEATURES.map(function (x) { return x.id; }).indexOf(id)];
    if (g.turn !== 0 || timer) { ZimiShell.shake(q); return; }
    if (g.asked[0].indexOf(id) >= 0) { ZimiShell.shake(q); line.reason(T('whoisit.alreadyAsked')); return; }
    selected = -1;
    ask(g, 0, id);
    afterTurn();
  }
  function doGuess() {
    if (!mine() || selected < 0) { ZimiShell.shake(els.guess); return; }
    var i = selected; selected = -1;
    guess(g, 0, i);
    afterTurn();
  }
  function afterTurn() {
    paint();
    if (g.over) return end();
    if (g.cands[0].length === 1) selected = g.cands[0][0];   // one face is left: it is the answer, and only needs the Guess
    if (g.turn === 1) timer = Play.later(zimiTurn, CPU_DELAY_MS);
    paint(); say();
  }
  function zimiTurn() {
    var m = zimiMove(g);
    if (m.kind === 'ask') ask(g, 1, m.id); else guess(g, 1, m.index);
    timer = null;
    paint();
    if (g.over) { line.say(T('whoisit.zimiWin')); timer = Play.later(function () { timer = null; end(); }, CPU_SHOW_MS); return; }
    if (g.cands[0].length === 1) selected = g.cands[0][0];
    paint(); say();
  }

  els.guess.addEventListener('click', doGuess);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden])')) return;
    if (e.target && e.target.closest && e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === 'g' || e.key === 'G') doGuess();
  });

  function save() { Play.save(SETTINGS_KEY, settings); }
  function menuOptions() {
    var box = document.createElement('div');
    box.appendChild(Play.optionRow(T('board.level'), [['easy', T('board.level.easy')], ['hard', T('board.level.hard')]], settings.level, function (v) { settings.level = v; save(); }));
    return [box];
  }
  function begin() {
    if (timer) timer.cancel();
    timer = null; selected = -1;
    g = createGame(Play.randomSeed(), settings.level);
    paint(); say();
  }
  els.nu.addEventListener('click', begin);
  ZimiShell.game({
    table: '#wi-grid',
    inProgress: function () { return !g.over && (g.asked[0].length + g.asked[1].length > 0 || g.cands[0].length < FACES || g.cands[1].length < FACES); },
    menu: function () { return { options: menuOptions() }; },
    stats: function () { return stats.a + stats.b ? [[T('board.you'), Play.num(stats.a)], [T('board.zimi'), Play.num(stats.b)]] : []; }
  });

  // Leaving keeps both sides' faces and what has been asked; a finished game comes back to its end sheet.
  function kept() {
    if (!g.asked[0].length && !g.asked[1].length && g.cands[0].length === FACES && g.cands[1].length === FACES) return null;
    return { g: Engine.snapshot(g) };
  }
  function takeUp(d) {
    var s = d && d.g;
    if (!s || !Array.isArray(s.faces) || s.faces.length !== FACES || !Array.isArray(s.cands) || s.cands.length !== 2 || !Array.isArray(s.secret)) return false;
    if (s.secret.some(function (i) { return !(i >= 0 && i < FACES); })) return false;
    if (timer) timer.cancel();
    timer = null; selected = -1;
    g = Engine.restore(s); settings.level = g.level; save();
    paint();
    if (g.over) { end(true); return true; }
    if (g.cands[0].length === 1) selected = g.cands[0][0];
    if (g.turn === 1) timer = Play.later(zimiTurn, CPU_DELAY_MS);
    paint(); say();
    return true;
  }
  build(); begin();
  ZimiShell.persist({ save: kept, load: takeUp });
  root.__whoisit = { get g() { return g; }, get selected() { return selected; }, get mine() { return mine(); } };
})(this);
