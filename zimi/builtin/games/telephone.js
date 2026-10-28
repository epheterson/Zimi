/* ZimiGames: Wikipedia Telephone, for two people and one phone. One of you is shown a real article and writes a clue for
   it in your own words (the clue may not use the article's name); you pass the phone, and the other has to find the
   article using only the library's search, in three guesses. You swap roles each round and score together: 3 points for
   finding it at the first guess, 2 at the second, 1 at the third. With a Wikipedia in the library (Zimi or kiwix-serve) the
   articles are random pages of it and the search is its own; elsewhere they are the articles of wikirace-data.js and the
   search runs over their titles. The rules are pure functions (no DOM, so node can test them), then the page.
   Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var GUESSES = 3, CLUE_MIN = 8, CLUE_MAX = 120, TITLE_WORD_MIN = 4, BLURB_MIN = 40, BLURB_CAP = 280, SWAPS = 2, FOUND_MAX = 8;
  var ROUND_CHOICES = [4, 6, 8];

  // Why a clue cannot be given, or '': too short or long, or it says the article's name (the whole name, or any word of it
  // of four letters or more, in any case or accent).
  function clueProblem(clue, title) {
    var c = String(clue || '').replace(/\s+/g, ' ').trim();
    if (c.length < CLUE_MIN) return 'short';
    if (c.length > CLUE_MAX) return 'long';
    var f = ' ' + Lib.fold(c).replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';
    var words = Lib.fold(title).split(/[^\p{L}\p{N}]+/u).filter(function (w) { return w.length >= TITLE_WORD_MIN; });
    for (var i = 0; i < words.length; i++) if (f.indexOf(' ' + words[i]) >= 0) return 'name';
    return '';
  }
  // A point for each guess left: 3, 2 or 1.
  function pointsFor(guessNumber) { return GUESSES + 1 - guessNumber; }
  function giverOf(round) { return round % 2; }
  function isRight(hit, secret) {
    return !!hit && (hit.path === secret.path || Lib.fold(hit.title) === Lib.fold(secret.title));
  }

  // The built-in articles: title and the first sentences, from wikirace-data.js's [[links]] markup.
  function miniArticles(data) {
    return (data || []).map(function (a) {
      var text = String(a[1]).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (m, t, shown) { return shown || t; });
      return { title: a[0], path: a[0], blurb: text.length > BLURB_CAP ? text.slice(0, BLURB_CAP).replace(/\s\S*$/, '') + '…' : text };
    });
  }
  // The titles a typed word finds: those that start with it first, then those with a word that does, then any that has it.
  function searchMini(list, q, n) {
    var f = Lib.fold(q).trim();
    if (!f) return [];
    var rank = function (a) {
      var t = Lib.fold(a.title);
      return t.indexOf(f) === 0 ? 0 : (' ' + t).indexOf(' ' + f) >= 0 ? 1 : t.indexOf(f) >= 0 ? 2 : 3;
    };
    return list.filter(function (a) { return rank(a) < 3; }).sort(function (a, b) { return rank(a) - rank(b) || (a.title < b.title ? -1 : 1); }).slice(0, n || FOUND_MAX);
  }
  // Is a random page fit to be a secret: a real article with a sentence to read and a name to say.
  function fit(page) {
    return !!page && !!page.title && !!page.blurb && page.blurb.length >= BLURB_MIN && page.title.indexOf(':') < 0 && !/^(List of|Main Page)/i.test(page.title);
  }

  root.TelephoneEngine = { clueProblem: clueProblem, pointsFor: pointsFor, giverOf: giverOf, isRight: isRight, miniArticles: miniArticles, searchMini: searchMini, fit: fit, GUESSES: GUESSES, ROUND_CHOICES: ROUND_CHOICES };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T, Pass = root.GamesPass;
  Play.applyTheme();
  var BEST_KEY = 'zimi.games.telephone.best', SEARCH_MS = 250, SECRET_TRIES = 8;
  var els = { n: $('tp-n'), score: $('tp-score'), card: $('tp-card'), msg: $('tp-msg'), actions: $('tp-actions'), newBtn: $('tp-new') };
  var status = Play.status(els.msg);
  var zim = '', mini = miniArticles(root.WIKIRACE_MINI), g = null, pendingRounds = null, building = false, swaps = 0, timer = 0, done = false;

  var el = root.ZimiUtil.el;
  function who(i) { return Pass.name(T, i); }
  function total() { return g.points.reduce(function (a, b) { return a + b; }, 0); }
  function paint() {
    els.n.textContent = g ? T('tp.round', { n: Math.min(g.round + 1, g.rounds), total: g.rounds }) : '';
    els.score.textContent = g ? T('tp.score', { n: total() }) : '';
  }
  function button(label, primary, fn, disabled) {
    var b = el('button', 'ar-btn' + (primary ? ' gm-play' : ''), label); b.type = 'button';
    if (disabled) b.setAttribute('aria-disabled', 'true'); else b.addEventListener('click', fn);
    els.actions.appendChild(b); return b;
  }
  function reset() { els.card.innerHTML = ''; els.actions.innerHTML = ''; status.say(''); clearTimeout(timer); }

  // ── a secret article ──
  function pickSecret() {
    if (zim) {
      var tries = 0;
      return (function next() {
        if (tries++ >= SECRET_TRIES) return Promise.resolve(null);
        return Lib.random(zim, { thumb: true }).then(function (r) {
          var page = { title: r.title, path: r.path, blurb: String(r.blurb || '').slice(0, BLURB_CAP) };
          return fit(page) && g.used.indexOf(page.title) < 0 ? page : next();
        }, next);
      })();
    }
    var left = mini.filter(function (a) { return g.used.indexOf(a.title) < 0; });
    return Promise.resolve(Lib.sample(left.length ? left : mini, 1, Math.random)[0]);
  }
  function newSecret() {
    return pickSecret().then(function (s) {
      if (!s) { zim = ''; return pickSecret(); }   // the library gave nothing fit: the built-in articles
      return s;
    }).then(function (s) { g.secret = s; g.used.push(s.title); });
  }

  // ── the phases ──
  function giveCover() { Pass.cover({ name: who(giverOf(g.round)), onReady: renderGive }); }
  function guessCover() { Pass.cover({ name: who(1 - giverOf(g.round)), onReady: renderGuess }); }

  function renderGive() {
    reset(); paint();
    var c = els.card;
    c.appendChild(el('p', 'tp-label', T('tp.giveFor', { name: who(giverOf(g.round)) })));
    c.appendChild(el('p', 'tp-secret', g.secret.title));
    c.appendChild(el('p', 'tp-blurb', g.secret.blurb));
    var field = el('textarea', 'tp-field'); field.id = 'tp-clue'; field.maxLength = CLUE_MAX; field.value = g.clue || '';
    field.setAttribute('aria-label', T('tp.clueLabel')); field.placeholder = T('tp.cluePlaceholder');
    var counter = el('p', 'tp-counter', T('tp.counter', { n: field.value.length, max: CLUE_MAX }));
    field.addEventListener('input', function () { g.clue = field.value; counter.textContent = T('tp.counter', { n: field.value.length, max: CLUE_MAX }); });
    c.appendChild(field); c.appendChild(counter); c.appendChild(el('p', 'tp-blurb', T('tp.how')));
    button(T('tp.another'), false, function () {
      if (swaps >= SWAPS) return;
      swaps++; newSecret().then(renderGive);
    }, swaps >= SWAPS);
    button(T('tp.pass'), true, function () {
      var why = clueProblem(field.value, g.secret.title);
      if (why) { status.reason(T('tp.clue.' + why)); ZimiShell.shake(field); return; }
      g.clue = field.value.trim(); g.phase = 'guess'; g.tries = [];
      reset(); guessCover();
    });
    field.focus();
  }

  function renderGuess() {
    reset(); paint();
    var c = els.card, who2 = who(1 - giverOf(g.round));
    c.appendChild(el('p', 'tp-label', T('tp.theClue', { name: who(giverOf(g.round)) })));
    c.appendChild(el('p', 'tp-clue', g.clue));
    var tries = el('div', 'tp-tries');
    g.tries.forEach(function (t) { tries.appendChild(el('span', 'tp-try', t)); });
    c.appendChild(el('p', 'tp-label', T('tp.guessesLeft', { n: GUESSES - g.tries.length, name: who2 })));
    c.appendChild(tries);
    var field = el('input', 'tp-field'); field.type = 'search'; field.id = 'tp-search'; field.autocomplete = 'off'; field.setAttribute('aria-label', T('tp.searchLabel')); field.placeholder = T('tp.searchPlaceholder');
    var list = el('ul', 'tp-results'); list.id = 'tp-results'; list.setAttribute('aria-live', 'polite');
    c.appendChild(field); c.appendChild(list);
    function show(hits) {
      list.innerHTML = '';
      hits.forEach(function (h) {
        var li = el('li'), b = el('button', null, h.title); b.type = 'button';
        b.addEventListener('click', function () { guess(h); });
        li.appendChild(b); list.appendChild(li);
      });
      if (!hits.length && field.value.trim()) list.appendChild(el('li', 'tp-blurb', T('tp.noResults')));
    }
    field.addEventListener('input', function () {
      clearTimeout(timer);
      var q = field.value.trim();
      if (!q) return show([]);
      timer = setTimeout(function () {
        (zim ? Lib.search(zim, q, FOUND_MAX) : Promise.resolve(searchMini(mini, q, FOUND_MAX))).then(function (hits) { if (field.value.trim() === q) show(hits.filter(function (h) { return g.tries.indexOf(h.title) < 0; })); });
      }, SEARCH_MS);
    });
    field.focus();
  }
  function guess(hit) {
    if (g.phase !== 'guess') return;
    if (isRight(hit, g.secret)) { g.points[g.round] = pointsFor(g.tries.length + 1); g.found = true; return reveal(); }
    g.tries.push(hit.title);
    if (g.tries.length >= GUESSES) { g.points[g.round] = 0; g.found = false; return reveal(); }
    status.reason(T('tp.notThat', { title: hit.title }));
    renderGuess();
  }

  function reveal() {
    g.phase = 'reveal'; reset(); paint();
    var c = els.card, pts = g.points[g.round];
    c.appendChild(el('p', 'tp-label', T(pts ? 'tp.found' : 'tp.missed', { n: g.tries.length + (pts ? 1 : 0), points: pts })));
    c.appendChild(el('p', 'tp-secret tp-answer', g.secret.title));
    c.appendChild(el('p', 'tp-blurb', g.secret.blurb));
    c.appendChild(el('p', 'tp-clue', g.clue));
    if (zim && g.secret.path) {
      var a = el('a', 'ar-btn', T('tp.read', { title: g.secret.title })); Lib.articleLink(a, zim, g.secret.path); els.actions.appendChild(a);
    }
    button(T(g.round + 1 >= g.rounds ? 'round.seeScore' : 'round.next'), true, nextRound);
    status.say(T('tp.together', { n: total(), max: GUESSES * (g.round + 1) }));
  }
  function nextRound() {
    if (g.round + 1 >= g.rounds) return finish();
    g.round++; g.clue = ''; g.tries = []; g.phase = 'give'; swaps = 0;
    newSecret().then(function () { reset(); giveCover(); });
  }
  function finish() {
    done = true; g.phase = 'done';
    var best = Play.load(BEST_KEY, {}), key = String(g.rounds), mine = best[key] || 0, score = total();
    if (score > mine) { best[key] = score; Play.save(BEST_KEY, best); }
    reset(); paint();
    var line = T('round.verdict.' + Lib.verdict(score, GUESSES * g.rounds));
    els.card.appendChild(el('p', 'tp-secret', T('tp.together', { n: score, max: GUESSES * g.rounds })));
    els.card.appendChild(el('p', 'tp-blurb', line));
    ZimiShell.endSheet({ result: 'over', text: line, stats: [[T('tp.togetherLabel'), T('round.of', { n: score, total: GUESSES * g.rounds })], [T('play.best'), Play.num(Math.max(score, mine))]] });
  }

  function start(rounds) {
    if (building) return; building = true; done = false; swaps = 0;
    g = { zim: zim, rounds: rounds, round: 0, phase: 'give', secret: null, clue: '', tries: [], points: [], used: [], found: false };
    reset(); els.card.appendChild(el('p', 'tp-blurb', T('tp.choosing'))); els.card.classList.add('gl-loading');
    newSecret().then(function () { building = false; els.card.classList.remove('gl-loading'); reset(); giveCover(); });
  }

  els.newBtn.addEventListener('click', function () { var r = pendingRounds || (g ? g.rounds : ROUND_CHOICES[0]); pendingRounds = null; start(r); });
  ZimiShell.game({
    about: function () { return Lib.note(T, 'articles', zim); },
    inProgress: function () { return !!g && !done && (g.round > 0 || g.phase !== 'give' || !!g.clue); },
    menu: function () {
      return { options: [Play.optionRow(T('tp.rounds'), ROUND_CHOICES.map(function (n) { return [n, Play.num(n)]; }), pendingRounds || (g ? g.rounds : ROUND_CHOICES[0]), function (v) { pendingRounds = v; })] };
    },
    stats: function () {
      var best = Play.load(BEST_KEY, {});
      return Object.keys(best).sort().map(function (k) { return [T('tp.bestOf', { n: +k }), T('round.of', { n: best[k], total: GUESSES * +k })]; });
    }
  });

  Lib.library().then(function (list) {
    var a = Lib.pickZim(list, 'wikipedia', Lib.uiLang());
    zim = a ? a.zim.name : '';
    var kept = ZimiShell.saved();
    // Leaving and coming back never shows a secret to the wrong person: the phase is kept, and the screen starts behind its cover.
    if (kept && kept.g && kept.g.secret && kept.g.phase !== 'done') {
      g = kept.g; zim = kept.g.zim || ''; swaps = kept.swaps || 0; paint();
      if (g.phase === 'give') giveCover(); else if (g.phase === 'guess') guessCover(); else reveal();
    } else { if (kept) ZimiShell.forget(); start(ROUND_CHOICES[0]); }
  });
  ZimiShell.persist({ save: function () { return g && !done && g.secret ? { g: g, swaps: swaps } : null; } });
  root.__tp = { get g() { return g; }, get zim() { return zim; } };
})(this);
