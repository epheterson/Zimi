/* ZimiGames: Spelling Bee. Seven letters, one in the middle: make words of four letters or more, each using the middle
   letter (letters may repeat), and find the pangram that uses all seven. Daily (the same letters for everyone that day) and
   practice. The letters come from the sets in spellingbee-data.js, each with a common pangram; a word is good when it is in
   that set's lists or, with an English Wiktionary in the player's library (Zimi or kiwix-serve), when the Wiktionary has a
   page for it, so a real word the lists lack still counts. Ranks go by the points of the common words. The rules are pure
   functions (no DOM, so node can test them), then the page. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var MIN_LEN = 4, PANGRAM_BONUS = 7, CENTER_MIN = 20, CENTER_MAX = 70;
  // The ranks: the share of the possible points at which each begins (the id is bee.rank.<id>).
  var RANKS = [['beginner', 0], ['goodStart', 0.02], ['movingUp', 0.05], ['good', 0.08], ['solid', 0.15], ['nice', 0.25], ['great', 0.4], ['amazing', 0.5], ['genius', 0.7], ['queenBee', 1]];

  function wordsOf(entry) { return { common: entry[1].split(' '), extra: entry[2] ? entry[2].split(' ') : [] }; }
  function isPangram(word, letters) { return letters.every(function (l) { return word.indexOf(l) >= 0; }); }
  // A four-letter word is a point, a longer one its length, a pangram seven more.
  function points(word, letters) { return (word.length === MIN_LEN ? 1 : word.length) + (isPangram(word, letters) ? PANGRAM_BONUS : 0); }
  // The words of a set that use the middle letter.
  function withCenter(words, center) { return words.filter(function (w) { return w.indexOf(center) >= 0; }); }
  function maxPoints(entry, center) {
    var letters = entry[0].split('');
    return withCenter(wordsOf(entry).common, center).reduce(function (n, w) { return n + points(w, letters); }, 0);
  }
  // The middle letter: one that makes a puzzle neither bare nor huge, the same for the same random draw.
  function chooseCenter(entry, rng) {
    var common = wordsOf(entry).common, letters = entry[0].split('');
    var fit = letters.filter(function (l) { var n = withCenter(common, l).length; return n >= CENTER_MIN && n <= CENTER_MAX; });
    var pool = fit.length ? fit : letters;
    return pool[Math.floor(rng() * pool.length)];
  }
  // The day's puzzle: the same set and middle letter for everyone, whatever the date's neighbors were.
  function dailyPick(puzzles, dayKey) {
    var rng = Lib.rng(Lib.hash('bee|' + dayKey)), idx = Math.floor(rng() * puzzles.length);
    return { idx: idx, center: chooseCenter(puzzles[idx], rng) };
  }
  function practicePick(puzzles, rng) {
    var idx = Math.floor(rng() * puzzles.length);
    return { idx: idx, center: chooseCenter(puzzles[idx], rng) };
  }
  // Why a word cannot be tried: '' when it can. (Whether it is a word is asked after.)
  function refusal(word, letters, center, found) {
    if (word.length < MIN_LEN) return 'tooShort';
    for (var i = 0; i < word.length; i++) if (letters.indexOf(word.charAt(i)) < 0) return 'badLetters';
    if (word.indexOf(center) < 0) return 'noCenter';
    if (found.indexOf(word) >= 0) return 'already';
    return '';
  }
  function rankOf(pts, max) {
    var share = max ? pts / max : 0, id = RANKS[0][0];
    RANKS.forEach(function (r) { if (share >= r[1] - 1e-9) id = r[0]; });
    return id;
  }

  root.BeeEngine = { wordsOf: wordsOf, isPangram: isPangram, points: points, withCenter: withCenter, maxPoints: maxPoints, chooseCenter: chooseCenter, dailyPick: dailyPick, practicePick: practicePick, refusal: refusal, rankOf: rankOf, RANKS: RANKS, MIN_LEN: MIN_LEN };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  Play.applyTheme();
  var STATS_KEY = 'zimi.games.spellingbee.stats', HEX_W = 84, HEX_H = 76, GAP_SCALE = 1.04, HIVE = [[0, -1], [-0.75, -0.5], [0.75, -0.5], [-0.75, 0.5], [0.75, 0.5], [0, 1]];
  var SVGNS = 'http://www.w3.org/2000/svg', HEX_POINTS = '21,1 63,1 83,38 63,75 21,75 1,38';
  var PUZZLES = root.BEE_PUZZLES;
  var els = { points: $('bee-points'), rankname: $('bee-rankname'), track: $('bee-track'), fill: $('bee-fill'), input: $('bee-input'), msg: $('bee-msg'), hive: $('bee-hive'),
    del: $('bee-delete'), shuffle: $('bee-shuffle'), enter: $('bee-enter'), count: $('bee-count'), words: $('bee-words'), found: $('bee-found'), newBtn: $('bee-new') };
  var status = Play.status(els.msg);
  // The state kept: which set and middle letter, the outer letters as laid out, the words found (those the lists lack too).
  var g = null, typed = '', pendingMode = null, done = false, dict = '', asking = false, known = {};
  var today = Lib.dayKey(new Date());

  function entry() { return PUZZLES[g.idx]; }
  function letters() { return entry()[0].split(''); }
  function lists() { var w = wordsOf(entry()); return { common: w.common, all: w.common.concat(w.extra) }; }
  function score() { var l = letters(); return g.found.reduce(function (n, w) { return n + points(w, l); }, 0); }

  function fresh(mode) {
    var pick = mode === 'daily' ? dailyPick(PUZZLES, today) : practicePick(PUZZLES, Math.random);
    var rest = PUZZLES[pick.idx][0].split('').filter(function (l) { return l !== pick.center; });
    return { mode: mode, date: mode === 'daily' ? today : '', idx: pick.idx, center: pick.center, outer: Lib.shuffle(rest, Math.random), found: [], dict: dict };
  }

  // ── drawing ──
  function hex(letter, mid, x, y) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'bee-hex' + (mid ? ' mid' : ''); b.dataset.l = letter;
    b.style.setProperty('--x', (x * HEX_W * GAP_SCALE).toFixed(1)); b.style.setProperty('--y', (y * HEX_H * GAP_SCALE).toFixed(1));
    var svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 ' + HEX_W + ' ' + HEX_H); svg.setAttribute('aria-hidden', 'true');
    var poly = document.createElementNS(SVGNS, 'polygon'); poly.setAttribute('points', HEX_POINTS); svg.appendChild(poly);
    var s = document.createElement('span'); s.textContent = letter;
    b.appendChild(svg); b.appendChild(s);
    b.setAttribute('aria-label', mid ? T('bee.middleAria', { letter: letter.toUpperCase() }) : letter.toUpperCase());
    return b;
  }
  function paintHive() {
    els.hive.innerHTML = '';
    els.hive.appendChild(hex(g.center, true, 0, 0));
    g.outer.forEach(function (l, i) { els.hive.appendChild(hex(l, false, HIVE[i][0], HIVE[i][1])); });
  }
  function paintInput() {
    els.input.innerHTML = ''; els.input.classList.toggle('empty', !typed);
    typed.split('').forEach(function (c) {
      var s = document.createElement('span'); s.textContent = c;
      if (c === g.center) s.className = 'mid'; else if (letters().indexOf(c) < 0) s.className = 'off';
      els.input.appendChild(s);
    });
    var caret = document.createElement('span'); caret.className = 'caret'; caret.setAttribute('aria-hidden', 'true'); els.input.appendChild(caret);
    els.enter.setAttribute('aria-disabled', String(typed.length < MIN_LEN));
    els.del.setAttribute('aria-disabled', String(!typed));
  }
  function paintProgress() {
    var pts = score(), max = maxPoints(entry(), g.center), id = rankOf(pts, max), pct = Math.min(100, max ? Math.round(100 * pts / max) : 0);
    els.points.textContent = T('bee.points', { n: pts });
    els.rankname.textContent = T('bee.rank.' + id);
    els.fill.style.width = pct + '%'; els.track.setAttribute('aria-valuenow', String(pct));
    els.count.textContent = T('bee.found', { n: g.found.length });
    els.words.innerHTML = '';
    var l = letters();
    g.found.slice().sort().forEach(function (w) { var li = document.createElement('li'); li.textContent = w; if (isPangram(w, l)) li.className = 'pangram'; els.words.appendChild(li); });
  }
  function paintAll() { Lib.englishNote(T, 'lang.enWords', true); paintHive(); paintInput(); paintProgress(); }

  // ── playing ──
  function type(c) { if (done || asking) return; if (!typed) status.say(T('bee.go')); typed += c; paintInput(); }
  function erase() { if (done || asking) return; typed = typed.slice(0, -1); paintInput(); }
  function shuffle() { if (done) return; g.outer = Lib.shuffle(g.outer, Math.random); paintHive(); }
  // The word just found rises out of the input and fades, so the entry is felt, not only read in the line below.
  function ghost(word, pang) {
    if (Play.reducedMotion()) return;
    var s = document.createElement('span'); s.className = 'bee-ghost' + (pang ? ' pangram' : ''); s.textContent = word;
    els.input.appendChild(s);
  }
  function award(word) {
    var l = letters(), pts = points(word, l), pang = isPangram(word, l);
    g.found.push(word); typed = ''; paintInput(); paintProgress(); ghost(word, pang);
    status.reason(T(pang ? 'bee.pangramAdded' : 'bee.added', { word: word, n: pts }), 2500);
    if (rankOf(score(), maxPoints(entry(), g.center)) === 'queenBee') finish();
  }
  function ask(word) {
    var common = lists().all;
    if (common.indexOf(word) >= 0) return Promise.resolve(true);
    if (!dict) return Promise.resolve(false);
    if (known[word] !== undefined) return Promise.resolve(known[word]);
    return Lib.hasPage(dict, word).then(function (ok) { return ok ? true : Lib.hasPage(dict, 'A/' + word); }).then(function (ok) { return (known[word] = ok); });
  }
  function submit() {
    if (done || asking) return;
    var word = typed, why = refusal(word, letters(), g.center, g.found);
    if (why) { status.reason(T('bee.' + why)); ZimiShell.shake(els.input); if (why === 'badLetters' || why === 'already') { typed = ''; paintInput(); } return; }
    asking = true;
    ask(word).then(function (ok) {
      asking = false;
      if (ok) award(word); else { status.reason(T('bee.notWord')); ZimiShell.shake(els.input); }
    });
  }
  function finish() {
    done = true;
    var stats = Play.load(STATS_KEY, { queens: 0 });
    stats.queens = (stats.queens || 0) + 1; Play.save(STATS_KEY, stats);
    ZimiShell.endSheet({ result: 'win', text: T('bee.queen'), stats: [[T('bee.wordsLabel'), Play.num(g.found.length)], [T('play.score'), Play.num(score())]] });
  }
  function start(mode) {
    g = fresh(mode); typed = ''; done = false; known = {};
    paintAll(); status.say(T('bee.go'));
  }

  els.hive.addEventListener('click', function (e) { var b = e.target.closest('.bee-hex'); if (b) type(b.dataset.l); });
  els.del.addEventListener('click', erase);
  els.shuffle.addEventListener('click', shuffle);
  els.enter.addEventListener('click', submit);
  els.newBtn.addEventListener('click', function () {
    var m = pendingMode || (g && g.mode === 'daily' && done ? 'practice' : g ? g.mode : 'daily');
    pendingMode = null; start(m);
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden])')) return;
    if (e.target.closest && e.target.closest('button') && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Backspace') { e.preventDefault(); erase(); }
    else if (e.key === ' ') { e.preventDefault(); shuffle(); }
    else if (/^[a-zA-Z]$/.test(e.key)) type(e.key.toLowerCase());
  });
  ZimiShell.game({
    about: function () { return Lib.note(T, 'words', dict); },
    inProgress: function () { return !!g && !done && g.found.length > 0; },
    menu: function () {
      return { options: [Play.optionRow(T('bee.puzzle'), [['daily', T('play.daily')], ['practice', T('play.practice')]], pendingMode || g.mode, function (v) { pendingMode = v; })] };
    },
    stats: function () {
      var s = Play.load(STATS_KEY, { queens: 0 });
      return s.queens ? [[T('bee.queens'), Play.num(s.queens)]] : [];
    }
  });

  // The English Wiktionary of the library, if there is one: it judges words the lists lack.
  Lib.library().then(function (list) {
    var w = (list || []).filter(function (z) { return z.project === 'wiktionary' && Lib.primaryLang(z.language) === 'en'; })[0];
    dict = w ? w.name : '';
    var kept = ZimiShell.saved();
    if (kept && kept.g && PUZZLES[kept.g.idx] && (kept.g.mode !== 'daily' || kept.g.date === today)) {
      g = kept.g; typed = ''; paintAll(); status.say(T('bee.go'));
      if (rankOf(score(), maxPoints(entry(), g.center)) === 'queenBee') finish();
    } else { if (kept) ZimiShell.forget(); start('daily'); }
  });
  ZimiShell.persist({ save: function () { return g && g.found.length ? { g: g } : null; } });
  root.__bee = { get g() { return g; }, get dict() { return dict; }, get typed() { return typed; }, get asking() { return asking; } };
})(this);
