/* ZimiGames: Dictionary Bluff, for two to six people and one phone. A rare real word is shown with no meaning. Everyone in
   turn writes a believable fake definition in private; the real one is mixed in; everyone in turn votes for the one they think
   is real. You score 2 for finding the real meaning and 1 for each person your fake fooled. With an English Wiktionary in the
   library (Zimi or kiwix-serve) the word and its real definition are a random entry of it; elsewhere they come from
   bluff-data.js. The rules are pure functions (no DOM, so node can test them), then the page. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var ROUNDS = 3, PLAYER_CHOICES = [2, 3, 4, 5, 6], MIN_FAKE = 8, MAX_FAKE = 140, CLOSE = 0.6;
  var DEF_MIN = 25, DEF_MAX = 170, WORD_MIN = 7, WORD_MAX = 16, REAL_POINTS = 2, FOOL_POINTS = 1;
  var NOT_A_MEANING = /^(?:plural|past|present|third[- ]person|simple past|alternative|obsolete|archaic|misspelling|nonstandard|eye dialect|initialism|abbreviation|comparative|superlative|gerund|inflection|form of|variant|synonym|diminutive|feminine|masculine)\b/i;

  // A definition and a fake read alike: no capital to start, no full stop to end.
  function normalize(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
    return /^[A-Z](?=[a-z\s]|$)/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
  }
  function wordSet(text) { return Lib.fold(text).split(/[^\p{L}\p{N}]+/u).filter(function (w) { return w.length > 2; }); }
  // Does a fake say nearly what another text says? (the share of words they have in common)
  function tooClose(a, b) {
    var x = wordSet(a), y = wordSet(b);
    if (!x.length || !y.length) return false;
    var common = x.filter(function (w) { return y.indexOf(w) >= 0; }).length;
    return common / Math.min(x.length, y.length) >= CLOSE;
  }
  // Why a fake cannot be used, or ''. `others` are the fakes already written this round.
  function problem(text, word, real, others) {
    var t = normalize(text);
    if (t.length < MIN_FAKE) return 'short';
    if (t.length > MAX_FAKE) return 'long';
    if (Lib.fold(t).indexOf(Lib.fold(word)) >= 0) return 'word';
    if (tooClose(t, real)) return 'close';
    for (var i = 0; i < others.length; i++) if (others[i] && Lib.fold(others[i]) === Lib.fold(t)) return 'same';
    return '';
  }
  // The definitions to vote on, the real one among them in no fixed place: [{text, by}] (by is a player, or -1 for the real).
  function makeOptions(real, fakes, rng) {
    var opts = [{ text: normalize(real), by: -1 }];
    fakes.forEach(function (f, i) { opts.push({ text: normalize(f), by: i }); });
    return Lib.shuffle(opts, rng);
  }
  // Who scores what: votes[p] is the option player p chose. {points: [per player], voters: [[players] per option]}.
  function tally(options, votes, players) {
    var points = [], voters = options.map(function () { return []; }), p;
    for (p = 0; p < players; p++) points.push(0);
    votes.forEach(function (o, voter) {
      if (o < 0 || !options[o]) return;
      voters[o].push(voter);
      if (options[o].by === -1) points[voter] += REAL_POINTS;
      else if (options[o].by !== voter) points[options[o].by] += FOOL_POINTS;
    });
    return { points: points, voters: voters };
  }
  function winners(totals) {
    var top = Math.max.apply(null, totals);
    return totals.map(function (t, i) { return t === top ? i : -1; }).filter(function (i) { return i >= 0; });
  }

  // From a Wiktionary page: the English section, and its first definition cleaned into one a game can show. '' if none fits.
  function englishSection(html) {
    var src = String(html || ''), at = src.search(/<h2[^>]*id="English"/i);
    if (at < 0) return '';
    var rest = src.slice(at + 1), next = rest.search(/<h2[\s>]/i);
    return next < 0 ? rest : rest.slice(0, next);
  }
  function realDefinition(html, word) {
    var def = Lib.firstDefinition(englishSection(html)).replace(/^\s*(?:\([^)]*\)\s*)+/, '').replace(/^[:;,.\s]+/, '').trim();
    if (!def || NOT_A_MEANING.test(def) || def.length < DEF_MIN || def.length > DEF_MAX) return '';
    if (Lib.fold(def).indexOf(Lib.fold(word)) >= 0) return '';
    return def;
  }
  function plausibleWord(w) { return new RegExp('^[a-z]{' + WORD_MIN + ',' + WORD_MAX + '}$').test(w); }

  root.BluffEngine = { normalize: normalize, tooClose: tooClose, problem: problem, makeOptions: makeOptions, tally: tally, winners: winners, englishSection: englishSection, realDefinition: realDefinition, plausibleWord: plausibleWord, ROUNDS: ROUNDS, PLAYER_CHOICES: PLAYER_CHOICES };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T, Pass = root.GamesPass;
  Play.applyTheme();
  var STATS_KEY = 'zimi.games.bluff.stats', ASK_MS = 15000;
  var els = { n: $('bl-n'), card: $('bl-card'), msg: $('bl-msg'), actions: $('bl-actions'), newBtn: $('bl-new') };
  var status = Play.status(els.msg);
  var dict = '', g = null, pendingPlayers = null, building = false, done = false;

  var el = root.ZimiUtil.el;
  function who(i) { return Pass.name(T, i); }
  function reset() { els.card.innerHTML = ''; els.actions.innerHTML = ''; status.say(''); }
  function button(label, primary, fn, disabled) {
    var b = el('button', 'ar-btn' + (primary ? ' gm-play' : ''), label); b.type = 'button';
    if (disabled) b.setAttribute('aria-disabled', 'true'); else b.addEventListener('click', fn);
    els.actions.appendChild(b); return b;
  }
  function paint() { Lib.englishNote(T, 'lang.enWords', true); els.n.textContent = g ? T('bl.round', { n: Math.min(g.round + 1, g.rounds), total: g.rounds }) : ''; }

  // ── words ──
  // Words from the library's English Wiktionary come through a small pool kept for the session, filled in the idle time:
  // one burst when the page opens and one as each round starts (while the players write). A deal never waits for it: it takes
  // what the pool holds and fills up with built-in words, and a later round of the same game takes a library word in place of a
  // built-in one as the pool fills. A burst asks the server at most BURST_ASKS times: one list of candidates, then their pages
  // one at a time until the pool holds POOL_WANT. The list is Zimi's /dictionary/random (English words) inside Zimi; in
  // kiwix-serve its title suggestions for a prefix that starts many long English words (a random page of a Wiktionary is
  // seldom an English word of seven letters with a meaning of its own: 67 of them gave fewer than three).
  var POOL_WANT = 6, BURST_ASKS = 12, SUGGEST_COUNT = 40, POOL_KEY = 'zimi.games.bluff.pool:';
  // Stems of rare English words: a suggestion list for one starts mostly with real English words and their kin (measured on
  // the full English Wiktionary: about one candidate in four had an English meaning of its own; four-letter prefixes gave one in eight).
  var PREFIXES = ['perspic', 'loquac', 'querul', 'garrul', 'recalci', 'sycoph', 'obsequ', 'pusilla', 'magnani', 'perfidi', 'pelluc',
    'ebulli', 'effulg', 'evanesc', 'fastidi', 'grandil', 'hirsut', 'impecun', 'imperturb', 'incorrig', 'indefat', 'ineffab', 'inexor',
    'insouc', 'irasc', 'laconi', 'lachrym', 'lugubr', 'mendaci', 'mellifl', 'nefari', 'obfusc', 'obstrep', 'ostenta', 'parsimon',
    'pernici', 'petulan', 'platitud', 'prevaric', 'propinq', 'pugnaci', 'quixot', 'recondit', 'refulg', 'sagaci', 'soporif',
    'supercil', 'taciturn', 'temerit', 'truculen', 'unctuo', 'vacill', 'veraci', 'vicissit', 'vitupera', 'voraci', 'zealot'];
  var ENGLISH_END = /(?:ous|ity|ness|ive|ant|ent|ance|ence|ancy|ency|ion|ism|ist|ize|ise|ate|ful|less|ly|ic|al|ary|ory)$/;
  var STEM = 6;   // two words of one pool never share their first STEM letters (garrulous and garrulity are one word to a player)
  var pool = [], seen = {}, filling = false;
  function poolKey() { return POOL_KEY + dict; }
  function loadPool() { try { var p = JSON.parse(root.sessionStorage.getItem(poolKey())); pool = Array.isArray(p) ? p : []; } catch (e) { pool = []; } }
  function savePool() { try { root.sessionStorage.setItem(poolKey(), JSON.stringify(pool)); } catch (e) { /* no storage: the pool lives for the page */ } }
  function kin(word) {
    var stem = word.slice(0, STEM), near = function (w) { return w.word.slice(0, STEM) === stem; };
    return pool.some(near) || !!(g && g.words && g.words.some(near));
  }
  function builtIn(word) { return (root.BLUFF_WORDS || []).some(function (w) { return w[0] === word; }); }
  // One list of candidates, {word, path}: words that could be a game's (seven letters or more, lower case, not built in, not seen).
  function candidates() {
    var fresh = function (c) { return plausibleWord(c.word) && !seen[c.word] && !builtIn(c.word) && !kin(c.word); };
    if (Lib.modeNow() === 'zimi') {
      return Lib.json('/dictionary/random?langs=en', ASK_MS).then(function (r) {
        return ((r && r.words) || []).filter(function (x) { return x.zim === dict; }).map(function (x) { return { word: x.w, path: x.w }; }).filter(fresh);
      }, function () { return []; });
    }
    var prefix = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
    return Lib.search(dict, prefix, SUGGEST_COUNT).then(function (rows) {
      // The suggestions mix languages (perspicacia, perspicaz): an English ending is tried first, the rest after, in a random order.
      var list = Lib.shuffle(rows.map(function (r) { return { word: r.title, path: r.path }; }).filter(fresh), Math.random);
      return list.filter(function (c) { return ENGLISH_END.test(c.word); }).concat(list.filter(function (c) { return !ENGLISH_END.test(c.word); }));
    });
  }
  // One burst: a list, its pages one at a time, then another list while asks remain: BURST_ASKS asks in all, lists included.
  function fillPool() {
    if (!dict || filling || pool.length >= POOL_WANT) return Promise.resolve();
    filling = true;
    var asks = 0;
    function more() {
      if (asks >= BURST_ASKS || pool.length >= POOL_WANT) return null;
      asks++;
      return candidates().then(function (list) {
        return (function next(i) {
          if (asks >= BURST_ASKS || pool.length >= POOL_WANT) return null;
          if (i >= list.length) return list.length ? more() : null;   // an empty list ends the burst: the library has no more
          var c = list[i]; seen[c.word] = true;
          if (kin(c.word)) return next(i + 1);
          asks++;
          return Lib.article(dict, c.path, ASK_MS).then(function (html) {
            var def = realDefinition(html, c.word);
            if (def) { pool.push({ word: c.word, real: def, path: c.path }); savePool(); swapIn(); }
          }, function () { /* a page that does not come is skipped */ }).then(function () { return next(i + 1); });
        })(0);
      });
    }
    return Promise.resolve(more()).then(function () { filling = false; }, function () { filling = false; });
  }
  // A built-in word of a round not yet begun gives way to a library word from the pool.
  function swapIn() {
    if (!g || done || !g.words.length) return;
    for (var i = g.round + 1; i < g.words.length && pool.length; i++) {
      if (!g.words[i].path) { g.words[i] = pool.shift(); g.zim = dict; }
    }
    savePool();
  }
  function builtInWords(count) {
    return Lib.sample(root.BLUFF_WORDS, count, Math.random).map(function (w) { return { word: w[0], real: w[1], path: '' }; });
  }

  // ── phases ──
  function cover(p, next) { Pass.cover({ name: who(p), text: T('pass.only', { name: who(p) }), onReady: next }); }

  function startWriting() { g.phase = 'write'; g.turn = 0; g.fakes = []; g.options = null; g.votes = []; cover(0, renderWrite); fillPool(); }
  function renderWrite() {
    reset(); paint();
    var p = g.turn, w = g.words[g.round], c = els.card;
    c.appendChild(el('p', 'bl-label', T('bl.writeFor', { name: who(p) })));
    c.appendChild(el('p', 'bl-word', w.word));
    var field = el('textarea', 'bl-field'); field.id = 'bl-fake'; field.maxLength = MAX_FAKE; field.setAttribute('aria-label', T('bl.fakeLabel')); field.placeholder = T('bl.fakePlaceholder', { word: w.word });
    var counter = el('p', 'bl-counter', T('bl.counter', { n: 0, max: MAX_FAKE }));
    field.addEventListener('input', function () { counter.textContent = T('bl.counter', { n: field.value.length, max: MAX_FAKE }); });
    c.appendChild(field); c.appendChild(counter);
    button(T(p + 1 < g.players ? 'bl.nextPlayer' : 'bl.vote'), true, function () {
      var why = problem(field.value, w.word, w.real, g.fakes);
      if (why) { status.reason(T('bl.problem.' + why)); ZimiShell.shake(field); return; }
      g.fakes[p] = normalize(field.value);
      if (p + 1 < g.players) { g.turn++; reset(); cover(g.turn, renderWrite); }
      else { g.options = makeOptions(w.real, g.fakes, Math.random); g.phase = 'vote'; g.turn = 0; reset(); cover(0, renderVote); }
    });
    field.focus();
  }

  function renderVote() {
    reset(); paint();
    var p = g.turn, w = g.words[g.round], c = els.card;
    c.appendChild(el('p', 'bl-label', T('bl.voteFor', { name: who(p) })));
    c.appendChild(el('p', 'bl-word', w.word));
    var list = el('ul', 'bl-options');
    g.options.forEach(function (o, i) {
      if (o.by === p) return;   // your own is not yours to pick
      var li = el('li'), b = el('button', 'bl-option', o.text); b.type = 'button'; b.dataset.i = i;
      b.addEventListener('click', function () { vote(i); });
      li.appendChild(b); list.appendChild(li);
    });
    c.appendChild(list);
  }
  function vote(i) {
    if (g.phase !== 'vote') return;
    g.votes[g.turn] = i;
    if (g.turn + 1 < g.players) { g.turn++; reset(); cover(g.turn, renderVote); return; }
    var t = tally(g.options, g.votes, g.players);
    g.round_points = t.points; g.voters = t.voters;
    t.points.forEach(function (pts, k) { g.totals[k] += pts; });
    g.phase = 'reveal'; reveal();
  }

  function reveal() {
    reset(); paint();
    var w = g.words[g.round], c = els.card;
    c.appendChild(el('p', 'bl-label', T('bl.reveal')));
    c.appendChild(el('p', 'bl-word', w.word));
    var list = el('ul', 'bl-options');
    g.options.forEach(function (o, i) {
      var li = el('li'), b = el('button', 'bl-option' + (o.by === -1 ? ' real' : ''), o.text); b.type = 'button'; b.disabled = true;
      var by = el('span', 'bl-by'), who2 = o.by === -1 ? T('bl.real') : T('bl.wroteBy', { name: who(o.by) });
      var voters = (g.voters[i] || []).map(who).join(', ');
      by.appendChild(el('b', null, who2)); by.appendChild(document.createTextNode(voters ? ' · ' + T('bl.votedBy', { names: voters }) : ' · ' + T('bl.noVotes')));
      b.appendChild(by); li.appendChild(b); list.appendChild(li);
    });
    c.appendChild(list);
    c.appendChild(scoreboard());
    if (dict && w.path) els.actions.appendChild(Lib.wordLearn(el('a', 'ar-btn'), T, { word: w.word, zim: dict, path: w.path, readKey: 'bl.read' }));
    button(T(g.round + 1 >= g.rounds ? 'round.seeScore' : 'round.next'), true, nextRound);
  }
  function scoreboard(final) {
    var top = Math.max.apply(null, g.totals), ul = el('ul', 'bl-board');
    g.totals.forEach(function (t, i) {
      var li = el('li', t === top && t > 0 ? 'lead' : ''), gain = !final && g.round_points && g.round_points[i] ? ' +' + g.round_points[i] : '';
      li.appendChild(el('span', null, who(i) + gain)); li.appendChild(el('b', null, Play.num(t))); ul.appendChild(li);
    });
    return ul;
  }
  function nextRound() {
    if (g.round + 1 >= g.rounds) return finish();
    g.round++; startWriting();
  }
  function finish() {
    done = true; g.phase = 'done';
    var top = winners(g.totals), stats = Play.load(STATS_KEY, { games: 0 });
    stats.games++; Play.save(STATS_KEY, stats);
    reset(); paint(); els.card.appendChild(el('p', 'bl-label', T('bl.final'))); els.card.appendChild(scoreboard(true));
    var lead = Math.max.apply(null, g.totals);
    ZimiShell.endSheet(top.length === 1 ? { result: 'win', name: who(top[0]), stats: [[T('play.score'), Play.num(lead)]] } : { result: 'draw', stats: [[T('play.score'), Play.num(lead)]] });
  }

  function start(players) {
    if (building) return; building = true; done = false;
    g = { zim: dict, players: players, rounds: ROUNDS, round: 0, phase: 'load', turn: 0, words: [], fakes: [], options: null, votes: [], totals: [], voters: [], round_points: null };
    for (var i = 0; i < players; i++) g.totals.push(0);
    // The deal does not wait: the pool's words first, built-in ones for the rest (swapped for library words as they come).
    var words = pool.splice(0, ROUNDS);
    words.forEach(function (w) { seen[w.word] = true; });
    savePool();
    var mine = builtInWords(ROUNDS).filter(function (w) { return !words.some(function (x) { return x.word === w.word; }); });
    while (words.length < ROUNDS) words.push(mine.shift());
    g.words = words; g.zim = words.some(function (w) { return w.path; }) ? dict : '';
    building = false; reset(); startWriting();
  }

  els.newBtn.addEventListener('click', function () { var n = pendingPlayers || (g ? g.players : 3); pendingPlayers = null; start(n); });
  ZimiShell.game({
    about: function () { return Lib.note(T, 'words', dict); },
    inProgress: function () { return !!g && !done && (g.round > 0 || g.phase !== 'write' || g.turn > 0 || g.fakes.length > 0); },
    menu: function () {
      return { options: [Play.optionRow(T('bl.players'), PLAYER_CHOICES.map(function (n) { return [n, Play.num(n)]; }), pendingPlayers || (g ? g.players : 3), function (v) { pendingPlayers = v; })] };
    },
    stats: function () { var s = Play.load(STATS_KEY, { games: 0 }); return s.games ? [[T('bl.played'), Play.num(s.games)]] : []; }
  });

  Lib.library().then(function (list) {
    var w = Lib.englishWiktionary(list);
    dict = w ? w.name : '';
    loadPool();
    var kept = ZimiShell.saved();
    // Back from leaving: a secret is never left on the screen for the wrong person, so every phase starts behind its cover.
    if (kept && kept.g && kept.g.words && kept.g.words.length && kept.g.phase !== 'done' && kept.g.phase !== 'load') {
      g = kept.g; dict = g.zim || ''; paint();
      if (g.phase === 'write') cover(g.turn, renderWrite); else if (g.phase === 'vote') cover(g.turn, renderVote); else reveal();
    } else { if (kept) ZimiShell.forget(); start(3); }
  });
  ZimiShell.persist({ save: function () { return g && !done && g.words.length && g.phase !== 'load' ? { g: g } : null; } });
  root.__bluff = { get g() { return g; }, get dict() { return dict; }, get pool() { return pool; }, fill: fillPool };
})(this);
