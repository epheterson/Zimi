/* ZimiGames: Five Letters (guess the word in six tries). Our own code, GPL-3.0.
   No network, no fonts, no modules. The rules (pure functions, no DOM, so node can test them)
   and the page (only when there is a document). The word lists are in fiveletters-words.js. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var LEN = 5, TRIES = 6;
  var DAILY_EPOCH = Date.UTC(2026, 0, 1), DAY_MS = 86400000;
  var RANK = { absent: 0, present: 1, correct: 2 };

  // Score a guess against the answer. Greens first; then each remaining letter of the guess
  // is yellow only while the answer still has an unmatched copy of it, so repeats count right:
  // guessing "allee" against "apple" gives one yellow l and one green e, not two of each.
  function scoreGuess(guess, answer) {
    var out = new Array(LEN).fill('absent'), left = {}, i;
    for (i = 0; i < LEN; i++) {
      if (guess[i] === answer[i]) out[i] = 'correct';
      else left[answer[i]] = (left[answer[i]] || 0) + 1;
    }
    for (i = 0; i < LEN; i++) {
      if (out[i] === 'correct') continue;
      if (left[guess[i]] > 0) { out[i] = 'present'; left[guess[i]]--; }
    }
    return out;
  }

  // What each letter of the keyboard shows: the best thing learned about it so far.
  function keyStates(guesses, answer) {
    var keys = {};
    guesses.forEach(function (gs) {
      scoreGuess(gs, answer).forEach(function (st, i) {
        var ch = gs[i];
        if (!(ch in keys) || RANK[st] > RANK[keys[ch]]) keys[ch] = st;
      });
    });
    return keys;
  }

  // The lists are space-separated strings; sets make the lookups quick.
  function makeWords(allowedText, answersText) {
    var answers = answersText.split(' ').filter(Boolean), allowed = {};
    allowedText.split(' ').forEach(function (w) { if (w) allowed[w] = true; });
    answers.forEach(function (w) { allowed[w] = true; });
    return { answers: answers, allowed: allowed };
  }
  function isWord(words, w) { return w.length === LEN && words.allowed[w] === true; }

  // The same word for everyone on the same calendar day (local), walking the answer list in order.
  function dayNumber(date) { return Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - DAILY_EPOCH) / DAY_MS); }
  function dailyAnswer(words, date) {
    var n = words.answers.length;
    return words.answers[((dayNumber(date) % n) + n) % n];
  }
  function dateKey(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  // The emoji squares people paste: one row a guess.
  var SQUARE = { correct: '🟩', present: '🟨', absent: '⬛' };
  function shareText(title, guesses, answer, won) {
    var rows = guesses.map(function (gs) { return scoreGuess(gs, answer).map(function (s) { return SQUARE[s]; }).join(''); });
    return title + ' ' + (won ? guesses.length : 'X') + '/' + TRIES + '\n' + rows.join('\n');
  }

  var Engine = {
    LEN: LEN, TRIES: TRIES, scoreGuess: scoreGuess, keyStates: keyStates, makeWords: makeWords, isWord: isWord,
    dayNumber: dayNumber, dailyAnswer: dailyAnswer, dateKey: dateKey, shareText: shareText
  };
  root.FiveLettersEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var FLIP_MS = 230, HOP_MS = 80, COPIED_MS = 1500, MAX_TILE = 62, GAP = 6, SIDE_PAD = 24, END_DELAY_MS = 500;       // each tile turns over 230 ms after the one before
  var STATE_KEY = 'zimi.games.fiveletters.state', STATS_KEY = 'zimi.games.fiveletters.stats', LANG_KEY = 'zimi.games.fiveletters.lang';
  var ROWS = ['qwertyuiop', 'asdfghjkl', '#zxcvbnm<'];
  Play.applyTheme();

  var words = makeWords(root.FIVE_ALLOWED, root.FIVE_ANSWERS);
  var els = { board: $('fl-board'), keys: $('fl-keys'), msg: $('fl-msg'), newBtn: $('fl-new'), actions: $('fl-actions'), share: $('fl-share'), mean: $('fl-mean'), learn: $('fl-learn') };
  var status = Play.status(els.msg);
  var keyEls = {}, tileEls = [];
  var stored = Play.load(STATE_KEY, {});
  var stats = null; // each word list keeps its own record (loadStats)
  var game = null, busy = false, today = dateKey(new Date());
  var pendingMode = null, pendingList;   // a choice made in the New game pane, taken when it starts

  // The word list: the shipped English one, or (inside Zimi) a Wiktionary of the player's library, whose
  // five-letter words and guesses come from /dictionary/five. cur is null for the shipped list, else
  // {zim, lang, title}. Words keep their accents in the Wiktionary and lose them here: the keyboard is a to z.
  var Lib = root.GamesLib, FIVE_API = '/dictionary/five';
  var cur = null, libOptions = [], libKnown = {};
  function statsKey() { return STATS_KEY + (cur ? ':' + cur.zim : ''); }
  function loadStats() { stats = Play.load(statsKey(), { played: 0, won: 0, streak: 0, max: 0, dist: [0, 0, 0, 0, 0, 0], last: '' }); }
  function skey(mode) { return mode + (cur ? ':' + cur.zim : ''); }

  function blank(mode) {
    if (cur) return null; // a library word is asked for (fetchWord)
    if (mode === 'daily') return { mode: 'daily', date: today, answer: dailyAnswer(words, new Date()), guesses: [], current: '', status: 'playing' };
    return { mode: 'practice', answer: words.answers[Math.floor(Math.random() * words.answers.length)], guesses: [], current: '', status: 'playing' };
  }
  function load(mode) {
    var s = stored[skey(mode)];
    if (cur) return s && s.answer && s.zim === cur.zim && (mode !== 'daily' || s.date === today) ? s : null;
    if (mode === 'daily' && s && s.date === today && s.answer === dailyAnswer(words, new Date())) return s;
    if (mode === 'practice' && s && s.answer && words.allowed[s.answer]) return s;
    return blank(mode);
  }
  function persist() { stored[skey(game.mode)] = game; Play.save(STATE_KEY, stored); }

  // A word from the Wiktionary: the day's for the daily (the same for everyone on this Zimi), else by chance.
  function fetchWord(mode) {
    var day = mode === 'daily' ? Lib.dayKey(new Date()) : 'chance';
    return Lib.json(FIVE_API + '?zim=' + encodeURIComponent(cur.zim) + '&day=' + day).then(function (w) {
      if (!w || !w.word) throw new Error('no word');
      libKnown[w.word] = true;
      var g = { mode: mode, zim: cur.zim, answer: w.word, title: w.title, blurb: w.blurb || '', guesses: [], current: '', status: 'playing' };
      if (mode === 'daily') g.date = today;
      return g;
    });
  }
  // Is this a word? The shipped list answers at once; a Wiktionary is asked (once per word).
  function checkWord(word) {
    if (!cur) return Promise.resolve(isWord(words, word));
    if (libKnown[word] !== undefined) return Promise.resolve(libKnown[word]);
    return Lib.json(FIVE_API + '?zim=' + encodeURIComponent(cur.zim) + '&check=' + word).then(function (r) { return (libKnown[word] = !!r.ok); }, function () { return false; });
  }

  function build() {
    for (var r = 0; r < TRIES; r++) {
      var row = document.createElement('div'); row.className = 'fl-row'; row.setAttribute('role', 'row');
      var tiles = [];
      for (var c = 0; c < LEN; c++) {
        var t = document.createElement('div'); t.className = 'fl-tile'; t.setAttribute('role', 'gridcell'); row.appendChild(t); tiles.push(t);
      }
      tileEls.push(tiles); els.board.appendChild(row);
    }
    ROWS.forEach(function (letters) {
      var row = document.createElement('div'); row.className = 'fl-krow';
      letters.split('').forEach(function (ch) {
        var b = document.createElement('button'); b.type = 'button';
        if (ch === '#') { b.className = 'fl-key wide'; b.textContent = T('fiveletters.enter'); b.dataset.k = 'Enter'; }
        else if (ch === '<') { b.className = 'fl-key wide'; b.innerHTML = '&#9003;'; b.dataset.k = 'Backspace'; b.setAttribute('aria-label', T('fiveletters.delete')); }
        else { b.className = 'fl-key'; b.textContent = ch; b.dataset.k = ch; keyEls[ch] = b; }
        row.appendChild(b);
      });
      els.keys.appendChild(row);
    });
  }
  function layout() {
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var byWidth = Math.floor((vw - SIDE_PAD - GAP * (LEN - 1)) / LEN), byHeight = Math.floor((vh - 52 - 250 - GAP * (TRIES - 1)) / TRIES);
    els.board.style.setProperty('--tile', Math.max(38, Math.min(MAX_TILE, byWidth, byHeight)) + 'px');
  }

  function tileLabel(ch, st) { return ch ? T('fiveletters.tile', { letter: ch, state: T('fiveletters.' + st) }) : T('fiveletters.empty'); }
  function paintRow(r, word, states) {
    for (var c = 0; c < LEN; c++) {
      var t = tileEls[r][c], ch = word[c] || '', st = states ? states[c] : '';
      t.className = 'fl-tile' + (ch ? ' filled' : '') + (st ? ' ' + st : '');
      t.textContent = ch;
      t.setAttribute('aria-label', ch && st ? tileLabel(ch, st) : (ch || T('fiveletters.empty')));
    }
  }
  function paintKeys() {
    var ks = keyStates(game.guesses, game.answer);
    Object.keys(keyEls).forEach(function (ch) { keyEls[ch].className = 'fl-key' + (ks[ch] ? ' ' + ks[ch] : ''); });
  }
  // The resting line says which word this is; a round that is over says how it went.
  function rest() {
    if (game.status === 'won') return praise();
    if (game.status === 'lost') return T('fiveletters.theWord', { word: shown() });
    // Words in English under another language's labels say so, in the player's language.
    var english = !cur && Lib.uiLang() !== 'en' ? 'En' : '';
    return T((game.mode === 'daily' ? 'fiveletters.daily' : 'fiveletters.practice') + english);
  }
  function paintAll() {
    for (var r = 0; r < TRIES; r++) {
      if (r < game.guesses.length) paintRow(r, game.guesses[r], scoreGuess(game.guesses[r], game.answer));
      else paintRow(r, r === game.guesses.length ? game.current : '', null);
    }
    paintKeys();
    status.say(rest());
    var over = game.status !== 'playing';
    els.actions.hidden = !over;
    els.mean.hidden = !(over && !game.blurb && !cur && enDict);
    els.mean.textContent = T('fiveletters.mean', { word: shown() });
    paintLearn();
  }
  // Inside Zimi with the Dictionary on, the round's word opens there (and the in-page meaning steps aside).
  function paintLearn() {
    els.learn.hidden = true;
    if (!game || game.status === 'playing') return;
    var g = game, w = game.title || game.answer;
    Lib.dictionaryOn().then(function (on) {
      if (!on || g !== game || game.status === 'playing') return;
      Lib.wordLink(els.learn, w); els.learn.textContent = T('learn.dictionary', { word: w }); els.learn.hidden = false; els.mean.hidden = true;
    });
  }
  // A win: the row hops tile by tile, as the end sheet is about to come up.
  function celebrate(r) {
    if (Play.reducedMotion()) return;
    tileEls[r].forEach(function (t, c) { t.style.animationDelay = c * HOP_MS + 'ms'; t.classList.add('hop'); });
  }
  function praise() { return T('fiveletters.praise.' + game.guesses.length); }

  function type(ch) {
    if (busy || game.status !== 'playing' || game.current.length >= LEN) return;
    game.current += ch; paintRow(game.guesses.length, game.current, null);
    var t = tileEls[game.guesses.length][game.current.length - 1];
    if (!Play.reducedMotion()) { t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop'); }
  }
  function erase() {
    if (busy || game.status !== 'playing' || !game.current) return;
    game.current = game.current.slice(0, -1); paintRow(game.guesses.length, game.current, null);
  }
  // An illegal word: the row shakes and the line says why for two seconds.
  function refuse(r, text) { ZimiShell.shake(els.board.children[r]); status.reason(text); }

  function submit() {
    if (busy || game.status !== 'playing') return;
    var r = game.guesses.length, word = game.current;
    if (word.length < LEN) return refuse(r, T('fiveletters.notEnough'));
    var g = game;
    busy = true;
    checkWord(word).then(function (ok) {
      busy = false;
      if (g !== game) return; // the list was switched while it was asked
      if (!ok) return refuse(r, T('fiveletters.notWord'));
      play(r, word);
    });
  }
  function play(r, word) {
    var states = scoreGuess(word, game.answer);
    game.guesses.push(word); game.current = '';
    if (word === game.answer) game.status = 'won'; else if (game.guesses.length >= TRIES) game.status = 'lost';
    persist();
    var done = function () {
      busy = false; paintKeys();
      if (game.status === 'won') celebrate(r);
      if (game.status === 'playing') return;
      status.say(rest()); els.actions.hidden = false;
      els.mean.hidden = !(!game.blurb && !cur && enDict); els.mean.textContent = T('fiveletters.mean', { word: shown() }); paintLearn();
      record(game.status === 'won');
      finish();
    };
    if (Play.reducedMotion()) { paintRow(r, word, states); return done(); }
    busy = true;
    states.forEach(function (st, c) {
      var t = tileEls[r][c];
      setTimeout(function () { t.classList.add('flip'); }, c * FLIP_MS);
      setTimeout(function () { t.classList.add(st); t.setAttribute('aria-label', tileLabel(word[c], st)); }, c * FLIP_MS + FLIP_MS / 2);
    });
    setTimeout(done, LEN * FLIP_MS + 100);
  }

  // The end of a round, on the shared end sheet: the result, the guesses used and, for the daily, the streak.
  function finish() {
    var won = game.status === 'won', chips = [[T('fiveletters.guesses'), T('fiveletters.guessesOf', { n: game.guesses.length, max: TRIES })]];
    if (game.mode === 'daily') chips.push([T('fiveletters.streak'), Play.num(stats.streak)]);
    var text = won ? '' : T('fiveletters.theWord', { word: shown() });
    if (game.blurb) text = (text ? text + ' ' : '') + T('fiveletters.gloss', { word: game.title, meaning: game.blurb });
    ZimiShell.endSheet({ result: won ? 'win' : 'lose', stats: chips, text: text || undefined, after: Play.reducedMotion() ? 0 : END_DELAY_MS });
  }

  // Only the daily counts toward the streak and the spread.
  function record(won) {
    if (game.mode !== 'daily' || game.counted) return;
    game.counted = true; persist();
    stats.played++;
    if (won) {
      stats.won++; stats.dist[game.guesses.length - 1]++;
      stats.streak = stats.last === yesterdayKey() ? stats.streak + 1 : 1;
      stats.max = Math.max(stats.max, stats.streak);
    } else stats.streak = 0;
    stats.last = today;
    Play.save(statsKey(), stats);
  }
  function yesterdayKey() { var d = new Date(); d.setDate(d.getDate() - 1); return dateKey(d); }

  // The answer as the player would write it (a Wiktionary's own spelling keeps its accents).
  function shown() { return (game.title || game.answer).toUpperCase(); }

  // The built-in list brings no meanings. Inside Zimi, a library with an English Wiktionary gives them: after a round
  // the word can be asked for its first sense (a library list, which already comes from a Wiktionary, shows it itself).
  var enDict = null;
  function askMeaning() {
    var word = game.answer;
    if (game.meaning) return status.say(T('fiveletters.gloss', { word: shown(), meaning: game.meaning }));
    els.mean.disabled = true;
    Lib.json(FIVE_API + '?zim=' + encodeURIComponent(enDict.name) + '&define=' + word).then(function (r) { return r && r.blurb; }, function () { return ''; }).then(function (meaning) {
      els.mean.disabled = false;
      if (meaning) { game.meaning = meaning; persist(); }
      status.say(meaning ? T('fiveletters.gloss', { word: shown(), meaning: meaning }) : T('fiveletters.noMeaning', { word: shown() }));
    });
  }

  els.keys.addEventListener('click', function (e) {
    var b = e.target.closest('.fl-key'); if (!b) return;
    var k = b.dataset.k;
    if (e.detail) b.blur(); // a tap or click: hand the keyboard back, so a physical Enter submits instead of re-pressing this key
    if (k === 'Enter') submit(); else if (k === 'Backspace') erase(); else type(k);
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden])')) return;
    if (e.target.closest && e.target.closest('button') && (e.key === 'Enter' || e.key === ' ')) return; // let a focused button do its own thing
    var k = e.key;
    if (k === 'Enter') { e.preventDefault(); submit(); }
    else if (k === 'Backspace') { e.preventDefault(); erase(); }
    else if (/^[a-zA-Z]$/.test(k)) type(k.toLowerCase());
  });
  els.mean.addEventListener('click', askMeaning);
  els.share.addEventListener('click', function () {
    var title = T('fiveletters.share', { lang: cur ? ' (' + cur.lang + ')' : '', date: game.mode === 'daily' ? ' ' + game.date : '' });
    var text = shareText(title, game.guesses, game.answer, game.status === 'won');
    // The answer shows on the button itself, where the finger is.
    var label = T('fiveletters.copy'), told = function (msg) { els.share.textContent = msg; setTimeout(function () { els.share.textContent = label; }, COPIED_MS); };
    try { navigator.clipboard.writeText(text).then(function () { told(T('fiveletters.copied')); }, function () { status.reason(text); }); } catch (e) { told(T('fiveletters.copyFail')); }
  });
  // Enter a mode of the current list. A library word may have to be fetched first.
  function switchTo(mode, fresh) {
    if (busy) return Promise.resolve();
    var have = fresh ? null : load(mode);
    if (!cur || have) { game = have || blank(mode); persist(); paintAll(); return Promise.resolve(); }
    busy = true; status.say(T('fiveletters.finding'));
    var asked = cur;
    return fetchWord(mode).then(function (g) {
      busy = false;
      if (asked !== cur) return;
      game = g; persist(); paintAll();
    }, function () {
      busy = false;
      if (asked !== cur) return;
      status.say(T('fiveletters.unreadable', { title: asked.title }));
      return setList(null, mode);
    });
  }
  // Choose the word list: null for the shipped English one.
  function setList(option, mode) {
    cur = option; libKnown = {}; loadStats();
    Play.save(LANG_KEY, option ? { zim: option.zim } : { zim: '' });
    var m = mode || (game && game.mode) || 'daily';
    return switchTo(m, false);
  }
  function offerLists(options) {
    libOptions = options;
    if (!options.length) return paintAll();
    var saved = Play.load(LANG_KEY, null), pick = null;
    if (saved && saved.zim) pick = options.filter(function (o) { return o.zim === saved.zim; })[0] || null;
    // The player's own language, when nothing has been guessed yet today and they have not chosen.
    else if (!saved && !game.guesses.length && !game.current) pick = options.filter(function (o) { return o.lang === Lib.uiLang(); })[0] || null;
    if (cur && pick && pick.zim === cur.zim) { cur = pick; paintAll(); }   // the round kept from before stays as it is
    else if (pick && pick !== cur) setList(pick, game.mode); else paintAll();
  }
  // Inside Zimi: which Wiktionaries has this library? (Kiwix and plain folders: none, and nothing is asked twice.)
  function findLists() {
    Lib.isZimi().then(function (yes) { return yes ? Lib.zims() : []; }).then(function (list) {
      var seen = {};
      enDict = list.filter(function (z) { return z.kind === 'wiki' && z.project === 'wiktionary' && Lib.primaryLang(z.language) === 'en'; })[0] || null;
      offerLists(list.filter(function (z) {
        return z.kind === 'wiki' && z.project === 'wiktionary' && Lib.primaryLang(z.language) !== 'en' && !seen[z.name] && (seen[z.name] = true);
      }).map(function (z) { return { zim: z.name, lang: Lib.primaryLang(z.language), title: z.title || z.name }; }));
    });
  }

  // New game: the word the New game pane chose, else the next one (after a finished daily, a practice word).
  els.newBtn.addEventListener('click', function () {
    var list = pendingList === undefined ? cur : pendingList, m = pendingMode || (game.mode === 'daily' && game.status !== 'playing' ? 'practice' : game.mode);
    pendingMode = null; pendingList = undefined;
    if (list !== cur) { cur = list; libKnown = {}; loadStats(); Play.save(LANG_KEY, { zim: cur ? cur.zim : '' }); }
    switchTo(m, m === 'practice');
  });
  ZimiShell.game({
    about: function () { return Lib.note(T, 'words', cur ? cur.zim : ''); },
    inProgress: function () { return !!game && game.status === 'playing' && (game.guesses.length > 0 || game.current.length > 0); },
    menu: function () {
      var rows = [Play.optionRow(T('fiveletters.word'), [['daily', T('play.daily')], ['practice', T('play.practice')]], pendingMode || game.mode, function (v) { pendingMode = v; })];
      if (libOptions.length) {
        var choices = [[null, T('fiveletters.english')]].concat(libOptions.map(function (o) { return [o, o.title]; }));
        rows.push(Play.optionRow(T('fiveletters.list'), choices, pendingList === undefined ? cur : pendingList, function (v) { pendingList = v; }));
      }
      return { options: rows };
    },
    stats: function () {
      if (!stats.played) return [];
      var pct = Math.round(100 * stats.won / stats.played);
      var lines = [[T('fiveletters.played'), Play.num(stats.played)], [T('fiveletters.wonPct'), pct + '%'], [T('fiveletters.streak'), Play.num(stats.streak)], [T('fiveletters.bestStreak'), Play.num(stats.max)]];
      stats.dist.forEach(function (n, i) { lines.push([T('fiveletters.wonIn', { n: i + 1 }), Play.num(n)]); });
      return lines;
    }
  });

  build();
  layout();
  window.addEventListener('resize', layout);
  loadStats();
  game = load('daily');
  paintAll();
  // Leaving and coming back keeps the position, the letters typed so far included. The day's word of an earlier
  // day is not kept; a Wiktionary's round keeps itself (state per list) and is asked for again.
  ZimiShell.persist({
    // A Wiktionary's round is kept whole (the list it came from, the word, the guesses), so a changed or unreachable library cannot alter it.
    save: function () { return game && (game.guesses.length || game.current) ? { game: game, list: cur } : null; },
    load: function (kept) {
      var g = kept && kept.game;
      if (!g || !g.answer || (g.mode === 'daily' && g.date !== today)) return false;
      if (kept.list) { cur = kept.list; libKnown = {}; libKnown[g.answer] = true; g.guesses.forEach(function (w) { libKnown[w] = true; }); loadStats(); }
      else if (!words.allowed[g.answer] || (g.mode === 'daily' && g.answer !== dailyAnswer(words, new Date()))) return false;
      game = g; paintAll();
      if (game.status !== 'playing') finish();
    }
  });
  findLists();
  // A read-only window onto the live game, for the browser tests.
  root.__five = { get game() { return game; }, get list() { return cur; }, get busy() { return busy; } };
})(this);
