/* ZimiGames: Babel. One everyday word, shown in other languages, a clue at a time: French "eau", Russian "вода", Japanese
   "水". Name it in English. You start with two clues; a wrong guess or a tap on Another clue shows one more (up to five), and
   the sooner you get it the more you score (4, 3, 2 or 1). Five words a game. With an English Wiktionary in the library (Zimi
   or kiwix-serve) the languages are those its Translations section lists for the word, a different five every time;
   elsewhere they are the words of babel-data.js. The rules are pure functions (no DOM, so node can test them), then the
   page. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var ROUNDS = 5, CLUES = 5, START_CLUES = 2, MAX_LATIN = 2, PAGE_BYTES = 700000, WORD_MAX = 24, TOP_POINTS = CLUES + 1;
  var SCRIPTS = [['latin', /[A-Za-zÀ-ɏ]/], ['cyrillic', /[Ѐ-ӿ]/], ['greek', /[Ͱ-Ͽ]/], ['arabic', /[؀-ۿ]/], ['hebrew', /[֐-׿]/],
    ['devanagari', /[ऀ-ॿ]/], ['hangul', /[가-힯]/], ['kana', /[぀-ヿ]/], ['han', /[一-鿿]/]];

  function scriptOf(word) {
    for (var i = 0; i < SCRIPTS.length; i++) if (SCRIPTS[i][1].test(word)) return SCRIPTS[i][0];
    return 'other';
  }
  // The points for naming it when `shown` clues are showing: 4 for two, then 3, 2, 1.
  function pointsFor(shown) { return Math.max(1, TOP_POINTS - shown); }
  function plain(h) { return String(h).replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim(); }

  // The translations in an English Wiktionary page (or its /translations subpage): the first Translations table's lines, each
  // "Language: <span lang=xx><a>word</a></span> (<span class=tr>how it is said</span>)". [{code, name, word, tr}], one per language.
  function parseTranslations(html) {
    var src = String(html || ''), at = src.search(/class="[^"]*\btranslations\b[^"]*"/i);
    if (at < 0) return [];
    var rest = src.slice(at), end = rest.search(/<\/table>/i);
    if (end > 0) rest = rest.slice(0, end);
    var out = [], seen = {}, re = /<li[^>]*>([\s\S]*?)<\/li>/gi, m;
    while ((m = re.exec(rest))) {
      var item = m[1].replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<link[^>]*>/gi, ''), name = plain(item.split(':')[0]);
      var w = /<span[^>]*\blang="([a-z]{2,3})"[^>]*>\s*(?:<[^>]+>\s*)*([^<]+?)\s*<\/(?:a|span)>/i.exec(item);
      if (!w || !name || seen[w[1]] || /[()\/]/.test(w[2])) continue;
      var word = plain(w[2]);
      if (!word || word.length > WORD_MAX || /^[-–—]+$/.test(word)) continue;
      var tr = /<span[^>]*class="[^"]*\btr\b[^"]*"[^>]*>([^<]+)<\/span>/i.exec(item);
      seen[w[1]] = true; out.push({ code: w[1], name: name, word: word, tr: tr ? plain(tr[1]) : '' });
    }
    return out;
  }
  // Five clues from the languages a word has: at most two in Latin letters, so the scripts differ.
  function pickClues(entries, n, rng) {
    var out = [], latin = 0;
    Lib.shuffle(entries, rng).forEach(function (e) {
      var isLatin = scriptOf(e.word) === 'latin';
      if (out.length < n && !(isLatin && latin >= MAX_LATIN)) { out.push(e); if (isLatin) latin++; }
    });
    Lib.shuffle(entries, rng).forEach(function (e) { if (out.length < n && out.indexOf(e) < 0) out.push(e); });
    // The first clue is in Latin letters when there is one, so a game never opens on three scripts nobody can read.
    out = Lib.shuffle(out, rng);
    var at = out.map(function (e) { return scriptOf(e.word); }).indexOf('latin');
    if (at > 0) { var t = out[0]; out[0] = out[at]; out[at] = t; }
    return out;
  }
  // Is a guess the word? Case, accents, "the" and "a" before it, and a plural are not mistakes.
  function isRight(guess, answer) {
    var g = Lib.fold(guess).trim().replace(/^(the|a|an|to)\s+/, ''), a = Lib.fold(answer);
    return !!g && (g === a || g === a + 's' || g + 's' === a || g === a + 'es');
  }
  // A built-in word as entries.
  // (a word the same as the English one, like German "Gold" or Swedish "salt", would give the answer away: it is left out)
  function builtInEntries(row) {
    return row[1].map(function (e) { return { code: e[0], name: '', word: e[1], tr: e[2] || '' }; }).filter(function (e) { return Lib.fold(e.word) !== Lib.fold(row[0]); });
  }
  function miniRound(data, n, rng) {
    return Lib.sample(data, n, rng).map(function (row) { return { answer: row[0], clues: pickClues(builtInEntries(row), CLUES, rng), path: '' }; });
  }

  root.BabelEngine = { scriptOf: scriptOf, pointsFor: pointsFor, parseTranslations: parseTranslations, pickClues: pickClues, isRight: isRight, miniRound: miniRound, ROUNDS: ROUNDS, CLUES: CLUES, START_CLUES: START_CLUES };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  Play.applyTheme();
  var BEST_KEY = 'zimi.games.babel.best', MIN_LIBRARY = 5;
  var els = { n: $('bb-n'), how: $('bb-how'), clues: $('bb-clues'), form: $('bb-form'), field: $('bb-field'), guess: $('bb-guess'), msg: $('bb-msg'), more: $('bb-more'), read: $('bb-read'), next: $('bb-next'), score: $('bb-score'), newBtn: $('bb-new') };
  var status = Play.status(els.msg);
  var dict = '', g = null, building = false, done = false;
  els.field.placeholder = T('babel.placeholder');

  var el = root.ZimiUtil.el;
  function langName(c) {
    try { var n = new Intl.DisplayNames([Lib.uiLang()], { type: 'language' }).of(c.code); if (n && n !== c.code) return n; } catch (e) { /* no Intl names */ }
    return c.name || c.code;
  }
  function total() { return g.points.reduce(function (a, b) { return a + b; }, 0); }
  function paint() {
    els.n.textContent = g ? T('babel.round', { n: Math.min(g.round + 1, g.words.length), total: g.words.length }) : '';
    els.score.textContent = g ? T('round.score', { n: total() }) : '';
  }
  function drawClues(fresh) {
    var w = g.words[g.round], solved = g.phase === 'reveal';
    els.clues.innerHTML = '';
    w.clues.forEach(function (c, i) {
      var li = el('li', 'bb-clue' + (i >= g.shown ? ' hidden' : '') + (fresh && i === g.shown - 1 ? ' new' : ''));
      if (i < g.shown) {
        li.appendChild(el('span', 'bb-lang', langName(c)));
        var word = el('span', 'bb-word', c.word);
        if (c.tr && scriptOf(c.word) !== 'latin') word.appendChild(el('span', 'bb-tr', c.tr));
        li.appendChild(word);
      } else { li.appendChild(el('span', 'bb-lang', T('babel.hiddenClue', { n: i + 1 }))); }
      els.clues.appendChild(li);
    });
    void solved;
  }
  function show(fresh) {
    paint();
    var w = g.words[g.round], playing = g.phase === 'play';
    els.how.textContent = playing ? T('babel.how') : '';
    drawClues(fresh);
    els.form.hidden = !playing; els.more.hidden = !playing || g.shown >= w.clues.length;
    els.next.hidden = playing; els.read.hidden = playing || !dict || !w.path;
    if (!playing) {
      els.next.textContent = T(g.round + 1 >= g.words.length ? 'round.seeScore' : 'round.next');
      if (dict && w.path) Lib.wordLearn(els.read, T, { word: w.answer, zim: dict, path: w.path, readKey: 'babel.read' });
      els.next.focus();
    }
  }

  function guess(text) {
    if (g.phase !== 'play' || !text.trim()) return;
    var w = g.words[g.round];
    if (isRight(text, w.answer)) { g.points[g.round] = pointsFor(g.shown); return solve(true); }
    if (g.shown >= w.clues.length) { g.points[g.round] = 0; return solve(false); }
    g.shown++; els.field.value = ''; status.reason(T('babel.notThat', { word: Lib.iso(text.trim()) }));
    ZimiShell.shake(els.form); show(true);
  }
  function giveUp() { g.points[g.round] = 0; solve(false); }
  function solve(ok) {
    g.phase = 'reveal'; g.won = ok;
    var w = g.words[g.round];
    status.say(ok ? T('babel.right', { word: Lib.iso(w.answer), points: g.points[g.round] }) : T('babel.itWas', { word: Lib.iso(w.answer) }));
    show(false);
  }
  function next() {
    if (g.round + 1 >= g.words.length) return finish();
    g.round++; g.shown = START_CLUES; g.phase = 'play'; els.field.value = ''; status.say(''); show(true); els.field.focus();
  }
  function finish() {
    done = true; var best = Play.load(BEST_KEY, {}), key = dict ? 'library' : 'built-in', mine = best[key] || 0, score = total(), max = g.words.length * pointsFor(START_CLUES);
    if (score > mine) { best[key] = score; Play.save(BEST_KEY, best); }
    var line = T('round.verdict.' + Lib.verdict(score, max));
    status.say(line);
    ZimiShell.endSheet({ result: 'over', text: line, stats: [[T('play.score'), T('round.of', { n: score, total: max })], [T('play.best'), Play.num(Math.max(score, mine))]] });
  }

  // ── the words ──
  function libraryWord(row) {
    return Lib.pageHead(dict, [row[0] + '/translations', row[0]], PAGE_BYTES, 15000).then(function (got) {
      var found = got ? parseTranslations(got.html) : [];
      found = found.filter(function (e) { return Lib.fold(e.word) !== Lib.fold(row[0]); });
      return found.length >= MIN_LIBRARY ? { answer: row[0], clues: pickClues(found, CLUES, Math.random), path: row[0] } : null;
    }, function () { return null; });
  }
  function newGame() {
    if (building) return; building = true; done = false;
    status.say(T('babel.choosing')); els.how.textContent = ''; els.clues.innerHTML = ''; els.form.hidden = els.more.hidden = els.next.hidden = els.read.hidden = true;
    var rows = Lib.sample(root.BABEL_WORDS, ROUNDS, Math.random);
    var work = dict ? Promise.all(rows.map(libraryWord)) : Promise.resolve([]);
    work.then(function (found) {
      var words = rows.map(function (row, i) { return found[i] || { answer: row[0], clues: pickClues(builtInEntries(row), CLUES, Math.random), path: '' }; });
      if (dict && !found.some(Boolean)) dict = '';   // the Wiktionary had no translations for any of them: the built-in languages
      g = { zim: dict, words: words, round: 0, shown: START_CLUES, phase: 'play', points: [], won: false };
      building = false; status.say(''); show(true); els.field.focus();
    });
  }

  els.form.addEventListener('submit', function (e) { e.preventDefault(); var t = els.field.value; els.field.value = ''; guess(t); });
  els.more.addEventListener('click', function () { if (g.phase === 'play' && g.shown < g.words[g.round].clues.length) { g.shown++; show(true); els.field.focus(); } });
  els.next.addEventListener('click', next);
  els.newBtn.addEventListener('click', newGame);
  ZimiShell.game({
    about: function () { return Lib.note(T, 'words', dict); },
    inProgress: function () { return !!g && !done && (g.round > 0 || g.phase !== 'play' || g.shown > START_CLUES); },
    stats: function () { var b = Play.load(BEST_KEY, {}); return Object.keys(b).map(function (k) { return [k === 'library' ? T('babel.bestLibrary') : T('babel.bestBuiltIn'), Play.num(b[k])]; }); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden])')) return;
    if (g && g.phase === 'reveal' && (e.key === 'Enter' || e.key === ' ') && document.activeElement !== els.read) { e.preventDefault(); next(); }
  });

  Lib.library().then(function (list) {
    var w = (list || []).filter(function (z) { return z.project === 'wiktionary' && Lib.primaryLang(z.language) === 'en'; })[0];
    dict = w ? w.name : '';
    var kept = ZimiShell.saved();
    if (kept && kept.g && kept.g.words && kept.g.words.length) { g = kept.g; dict = g.zim || ''; show(false); if (g.phase === 'reveal') status.say(g.won ? T('babel.right', { word: Lib.iso(g.words[g.round].answer), points: g.points[g.round] }) : T('babel.itWas', { word: Lib.iso(g.words[g.round].answer) })); }
    else { if (kept) ZimiShell.forget(); newGame(); }
  });
  ZimiShell.persist({ save: function () { return g && !done ? { g: g } : null; } });
  root.__babel = { get g() { return g; }, get dict() { return dict; } };
})(this);
