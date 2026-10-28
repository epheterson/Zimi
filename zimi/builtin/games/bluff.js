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
  var STATS_KEY = 'zimi.games.bluff.stats', ASK_BATCH = 6, ASK_ROUNDS = 8, ASK_MS = 15000;
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
  // A batch of candidates from the Wiktionary: Zimi's random words, or random English pages of kiwix-serve's.
  function candidates() {
    if (Lib.modeNow() === 'zimi') {
      return Lib.json('/dictionary/random?langs=en', ASK_MS).then(function (r) {
        return ((r && r.words) || []).filter(function (x) { return x.zim === dict && plausibleWord(x.w); }).map(function (x) { return { word: x.w, path: x.w }; });
      }, function () { return []; });
    }
    var asks = [];
    for (var i = 0; i < ASK_BATCH; i++) asks.push(Lib.random(dict).then(function (r) { return plausibleWord(r.title) ? { word: r.title, path: r.path } : null; }, function () { return null; }));
    return Promise.all(asks).then(function (l) { return l.filter(Boolean); });
  }
  function drawWords(count) {
    var out = [], seen = {}, rounds = 0;
    return (function next() {
      if (out.length >= count || rounds++ >= ASK_ROUNDS) return Promise.resolve(out);
      return candidates().then(function (list) {
        return Promise.all(list.map(function (c) {
          if (seen[c.word]) return null;
          seen[c.word] = true;
          return Lib.article(dict, c.path, ASK_MS).then(function (html) { var def = realDefinition(html, c.word); return def ? { word: c.word, real: def, path: c.path } : null; }, function () { return null; });
        })).then(function (found) { found.filter(Boolean).forEach(function (w) { if (out.length < count) out.push(w); }); return next(); });
      });
    })();
  }
  function builtInWords(count) {
    return Lib.sample(root.BLUFF_WORDS, count, Math.random).map(function (w) { return { word: w[0], real: w[1], path: '' }; });
  }

  // ── phases ──
  function cover(p, next) { Pass.cover({ name: who(p), text: T('pass.only', { name: who(p) }), onReady: next }); }

  function startWriting() { g.phase = 'write'; g.turn = 0; g.fakes = []; g.options = null; g.votes = []; cover(0, renderWrite); }
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
  function scoreboard() {
    var top = Math.max.apply(null, g.totals), ul = el('ul', 'bl-board');
    g.totals.forEach(function (t, i) {
      var li = el('li', t === top && t > 0 ? 'lead' : ''), gain = g.round_points && g.round_points[i] ? ' +' + g.round_points[i] : '';
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
    reset(); paint(); els.card.appendChild(el('p', 'bl-label', T('bl.final'))); els.card.appendChild(scoreboard());
    var lead = Math.max.apply(null, g.totals);
    ZimiShell.endSheet(top.length === 1 ? { result: 'win', name: who(top[0]), stats: [[T('play.score'), Play.num(lead)]] } : { result: 'draw', stats: [[T('play.score'), Play.num(lead)]] });
  }

  function start(players) {
    if (building) return; building = true; done = false;
    g = { zim: dict, players: players, rounds: ROUNDS, round: 0, phase: 'load', turn: 0, words: [], fakes: [], options: null, votes: [], totals: [], voters: [], round_points: null };
    for (var i = 0; i < players; i++) g.totals.push(0);
    reset(); els.card.appendChild(el('p', 'bl-label', T('bl.choosing'))); els.card.classList.add('gl-loading');
    (dict ? drawWords(ROUNDS) : Promise.resolve([])).then(function (words) {
      if (words.length < ROUNDS) { dict = ''; g.zim = ''; words = builtInWords(ROUNDS); }
      g.words = words; building = false; els.card.classList.remove('gl-loading');
      reset(); startWriting();
    });
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
    var w = (list || []).filter(function (z) { return z.project === 'wiktionary' && Lib.primaryLang(z.language) === 'en'; })[0];
    dict = w ? w.name : '';
    var kept = ZimiShell.saved();
    // Back from leaving: a secret is never left on the screen for the wrong person, so every phase starts behind its cover.
    if (kept && kept.g && kept.g.words && kept.g.words.length && kept.g.phase !== 'done' && kept.g.phase !== 'load') {
      g = kept.g; dict = g.zim || ''; paint();
      if (g.phase === 'write') cover(g.turn, renderWrite); else if (g.phase === 'vote') cover(g.turn, renderVote); else reveal();
    } else { if (kept) ZimiShell.forget(); start(3); }
  });
  ZimiShell.persist({ save: function () { return g && !done && g.words.length && g.phase !== 'load' ? { g: g } : null; } });
  root.__bluff = { get g() { return g; }, get dict() { return dict; } };
})(this);
