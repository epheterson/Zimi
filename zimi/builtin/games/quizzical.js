/* ZimiGames: Quizzical. Multiple choice, made from the player's own library: "Which article does this sentence
   describe?", "Which article is this picture from?" and, with a Wiktionary, "Which word means this?". Each round
   asks Zimi for a handful of random articles (one call each, 4 at a time) and makes every question on this page,
   with the other choices taken from the same handful. In Kiwix or from a folder it asks the built-in questions
   in quizzical-data.js. Our own code, GPL-3.0.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var QUESTIONS = 8, CHOICES = 4, WIKI_POOL = 11, WORD_POOL = 6, CONCURRENCY = 4;
  var BLURB_MIN = 30, BLURB_MAX = 230, MASK = '_____';
  // Words that end the noun phrase after "is a ..." ("a small mammal of the order...").
  var STOP = /^(of|in|on|at|from|by|that|which|who|whose|for|with|to|and|or|located|found|known|used|between|within|during|where|when)$/i;
  var KIND_FROM = /\b(?:is|was|are|were)\s+(?:an?|the)\s+((?:[\p{L}-]+\s+){0,5}[\p{L}-]+)/iu;

  function same(a, b) { return Lib.fold(a).replace(/\s+/g, ' ').trim() === Lib.fold(b).replace(/\s+/g, ' ').trim(); }

  // What sort of thing a sentence says its subject is: the last word of "is a small carnivorous mammal", else ''.
  function kindOf(blurb) {
    var m = KIND_FROM.exec(blurb || '');
    if (!m) return '';
    var words = m[1].split(/\s+/), keep = [];
    for (var i = 0; i < words.length; i++) { if (STOP.test(words[i])) break; keep.push(words[i]); }
    return keep.length ? Lib.fold(keep[keep.length - 1]) : '';
  }

  // The sentence with its subject taken out (the title, and each long word of it), or '' when too little is left.
  function maskTitle(blurb, title) {
    var text = String(blurb || '').replace(/\s+/g, ' ').trim();
    var parts = [title].concat(String(title).split(/[\s,()]+/).filter(function (w) { return w.length >= 4; }));
    parts.sort(function (a, b) { return b.length - a.length; });
    parts.forEach(function (p) { text = text.replace(new RegExp('(?<![\\p{L}\\p{N}])' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'giu'), MASK); });
    text = text.replace(/(_{5}[\s,;:.]*){2,}/g, MASK + ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
    if (text.length > BLURB_MAX) text = text.slice(0, BLURB_MAX).replace(/\s\S*$/, '') + '...';
    return text.replace(new RegExp(MASK, 'g'), '').trim().length >= BLURB_MIN ? text : '';
  }

  // Other choices for an answer, never equal to it nor to one another: first those of the same kind, then any.
  function distractors(items, answer, n, rng, key) {
    var out = [], seen = [answer.title];
    var ok = function (it) { return !seen.some(function (t) { return same(t, it.title); }); };
    var sameKind = key ? Lib.shuffle(items.filter(function (it) { return ok(it) && key(it) && key(it) === key(answer); }), rng) : [];
    var rest = Lib.shuffle(items.filter(ok), rng);
    sameKind.concat(rest).forEach(function (it) {
      if (out.length < n && ok(it)) { out.push(it); seen.push(it.title); }
    });
    return out;
  }

  // A question: {kind, prompt, picture?, answer, choices:[...shuffled titles], path?, zim?}
  function question(kind, item, items, rng, key) {
    var others = distractors(items, item, CHOICES - 1, rng, key);
    if (others.length < CHOICES - 1) return null;
    var choices = Lib.shuffle([item.title].concat(others.map(function (o) { return o.title; })), rng);
    var q = { kind: kind, answer: item.title, choices: choices, zim: item.zim, path: item.path };
    if (kind === 'picture') q.picture = item.thumbnail; else q.prompt = kind === 'word' ? item.blurb : item.masked;
    return q;
  }

  // The round: pictures where the library has them, sentences otherwise, words when there is a Wiktionary.
  function makeRound(articles, words, count, rng) {
    var good = articles.filter(function (a) { return a.title && a.blurb; }).map(function (a) { return Object.assign({}, a, { masked: maskTitle(a.blurb, a.title) }); });
    var withText = good.filter(function (a) { return a.masked; });
    var withPic = good.filter(function (a) { return a.thumbnail; });
    var wordItems = (words || []).filter(function (w) { return w.title && w.blurb; });
    var plan = [], i;
    var wantWords = wordItems.length >= CHOICES ? Math.min(Math.round(count / 3), wordItems.length) : 0;
    var wantPics = withPic.length >= CHOICES ? Math.round((count - wantWords) / 2) : 0;
    for (i = 0; i < wantWords; i++) plan.push('word');
    for (i = 0; i < wantPics; i++) plan.push('picture');
    while (plan.length < count) plan.push('sentence');
    plan = Lib.shuffle(plan, rng);
    var used = {}, qs = [];
    plan.forEach(function (kind) {
      var src = kind === 'word' ? wordItems : kind === 'picture' ? withPic : withText;
      var pool = Lib.shuffle(src.filter(function (it) { return !used[kind + it.title]; }), rng);
      for (var k = 0; k < pool.length; k++) {
        var q = question(kind, pool[k], kind === 'word' ? wordItems : good, rng, kind === 'word' ? function (it) { return it.pos || ''; } : function (it) { return kindOf(it.blurb); });
        if (q) { used[kind + pool[k].title] = true; qs.push(q); return; }
      }
    });
    return qs.slice(0, count);
  }

  // The built-in questions as the same shape: answer first in the data, choices shuffled.
  function miniRound(data, count, rng) {
    return Lib.sample(data, count, rng).map(function (d) {
      return { kind: 'fact', prompt: d[0], answer: d[1], choices: Lib.shuffle(d.slice(1), rng) };
    });
  }

  // How a round went, as the id of the sentence the page says (quizzical.verdict.<id>).
  function verdict(score, total) {
    var r = total ? score / total : 0;
    return r === 1 ? 'flawless' : r >= 0.75 ? 'veryGood' : r >= 0.5 ? 'good' : 'keepGoing';
  }

  var Engine = { kindOf: kindOf, maskTitle: maskTitle, distractors: distractors, question: question, makeRound: makeRound, miniRound: miniRound, verdict: verdict, same: same, QUESTIONS: QUESTIONS, CHOICES: CHOICES };
  root.QuizzicalEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  Play.applyTheme();
  var BEST_KEY = 'zimi.games.quizzical.best';
  var els = { n: $('qz-n'), score: $('qz-score'), card: $('qz-card'), prompt: $('qz-prompt'), pic: $('qz-pic'), kind: $('qz-kind'), choices: $('qz-choices'), msg: $('qz-msg'),
    next: $('qz-next'), read: $('qz-read'), newBtn: $('qz-new') };
  var status = Play.status(els.msg);
  var wikiZim = null, wiktZim = null, round = [], at = 0, score = 0, answered = false, building = false, picked = -1;

  function kindLabel(kind) { return T('quizzical.kind.' + kind); }

  var el = root.ZimiUtil.el;

  // Up to `n` random entries of a ZIM, `CONCURRENCY` at a time (each one call: title, first sentence, picture).
  function drawPool(zim, n) {
    var out = [], seen = {}, asked = 0, failed = 0;
    function one() {
      return Lib.random(zim, { thumb: true }).then(function (r) {
        if (r && r.title && r.blurb && !seen[Lib.fold(r.title)] && r.path !== 'Main_Page') { seen[Lib.fold(r.title)] = true; out.push({ title: r.title, blurb: r.blurb, thumbnail: r.thumbnail || '', path: r.path, zim: zim, pos: Lib.fold(r.part_of_speech || '') }); }
      }, function () { failed++; });
    }
    function lane() {
      if (asked >= n * 2 || out.length >= n || failed > 4) return Promise.resolve();
      asked++;
      return one().then(lane);
    }
    var lanes = [];
    for (var i = 0; i < CONCURRENCY; i++) lanes.push(lane());
    return Promise.all(lanes).then(function () { return out; });
  }

  // The bar's one stat is the score; the caption above the card says where in the round you are.
  function paintScore() {
    els.n.textContent = round.length ? T('quizzical.question', { n: at + 1, total: round.length }) : '';
    els.score.textContent = T('quizzical.score', { n: score });
  }

  function showQuestion() {
    var q = round[at]; answered = false;
    els.kind.textContent = kindLabel(q.kind);
    els.prompt.textContent = q.prompt || ''; els.prompt.dir = 'auto';
    els.prompt.hidden = !q.prompt;
    els.pic.hidden = !q.picture;
    if (q.picture) { els.pic.removeAttribute('src'); els.pic.src = q.picture; els.pic.alt = T('quizzical.pictureAlt'); }
    els.choices.innerHTML = '';
    q.choices.forEach(function (c, i) {
      var b = el('button', 'qz-choice'); b.type = 'button'; b.dataset.i = i;
      b.appendChild(el('span', 'qz-num', Play.num(i + 1))); b.appendChild(el('span', 'qz-text', c)); b.lastChild.dir = 'auto';
      els.choices.appendChild(b);
    });
    status.say(''); els.next.hidden = true; els.read.hidden = true;
    Lib.englishNote(T, 'lang.enQuestions', !q.zim);   // a question from the library is in the library's language
    paintScore();
  }
  function answer(i, byKey) {
    if (answered || !round.length) return;
    picked = i;
    var q = round[at], btns = els.choices.children, right = q.choices.indexOf(q.answer);
    answered = true;
    for (var k = 0; k < btns.length; k++) { btns[k].disabled = true; if (k === right) btns[k].classList.add('right'); }
    if (i === right) { score++; Lib.bump(els.score); status.say(T('quizzical.right')); } else { btns[i].classList.add('wrong'); status.say(T('quizzical.itWas', { answer: Lib.iso(q.answer) })); }
    if (q.picture) els.prompt.textContent = '';
    if (q.path && q.zim) { els.read.hidden = false; Lib.articleLink(els.read, q.zim, q.path); els.read.textContent = T('quizzical.read', { answer: Lib.iso(q.answer) }); }
    els.next.hidden = false; els.next.textContent = T(at + 1 >= round.length ? 'quizzical.seeScore' : 'quizzical.next');
    if (byKey) els.next.focus();   // a tap leaves no focus ring on Next
    paintScore();
  }
  function advance() {
    if (!answered) return;
    if (at + 1 >= round.length) return finish();
    at++; showQuestion();
  }
  // The end of a round: a score game with no win state, so "Game over" with the score and the best here.
  function finish() {
    var best = Play.load(BEST_KEY, {}), key = wikiZim || 'mini', mine = best[key] || 0;
    if (score > mine) { best[key] = score; Play.save(BEST_KEY, best); }
    status.say(T('quizzical.verdict.' + verdict(score, round.length)));
    ZimiShell.endSheet({
      result: 'over', text: T('quizzical.verdict.' + verdict(score, round.length)),
      stats: [[T('play.score'), T('quizzical.of', { n: score, total: round.length })], [T('play.best'), Play.num(Math.max(score, mine))]]
    });
    done = true;
  }
  var done = false;

  function say(t) {
    els.card.classList.toggle('busy', !!t);
    if (t) { els.kind.textContent = t; els.prompt.textContent = ''; els.prompt.hidden = true; els.pic.hidden = true; els.choices.innerHTML = ''; status.say(''); els.next.hidden = true; els.read.hidden = true; els.n.textContent = ''; }
  }

  function newRound() {
    if (building) return; building = true; at = 0; score = 0; round = []; done = false;
    say(T('quizzical.choosing'));
    els.kind.classList.add('gl-loading');
    var work;
    if (wikiZim) {
      work = Promise.all([drawPool(wikiZim, WIKI_POOL), wiktZim ? drawPool(wiktZim, WORD_POOL) : Promise.resolve([])]).then(function (p) {
        var qs = makeRound(p[0], p[1], QUESTIONS, Math.random);
        return qs.length >= 4 ? qs : null;
      });
    } else work = Promise.resolve(null);
    work.then(function (qs) {
      building = false; els.kind.classList.remove('gl-loading');
      round = qs || miniRound(root.QUIZZICAL_MINI, QUESTIONS, Math.random);
      els.card.classList.remove('busy'); showQuestion();
      if (!qs && wikiZim) status.reason(T('quizzical.builtIn'), 4000);
    });
  }

  els.choices.addEventListener('click', function (e) { var b = e.target.closest('.qz-choice'); if (b) answer(+b.dataset.i); });
  els.next.addEventListener('click', advance);
  els.newBtn.addEventListener('click', newRound);
  ZimiShell.game({
    about: function () { return Lib.note(T, 'questions', wikiZim); },
    inProgress: function () { return !done && !building && (at > 0 || answered); },
    stats: function () {
      var best = Play.load(BEST_KEY, {}), keys = Object.keys(best);
      return keys.length ? [[T('play.best'), Play.num(Math.max.apply(null, keys.map(function (k) { return best[k]; })))]] : [];
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden])')) return;
    if (/^[1-4]$/.test(e.key)) answer(+e.key - 1, true);
    else if ((e.key === 'Enter' || e.key === ' ') && answered && document.activeElement !== els.read) { e.preventDefault(); advance(); }
  });

  Lib.library().then(function (list) {
    var a = Lib.pickZim(list, 'wikipedia', Lib.uiLang()), w = Lib.pickZim(list, 'wiktionary', Lib.uiLang());
    wikiZim = a ? a.zim.name : null; wiktZim = w && w.exact ? w.zim.name : (w && a && Lib.primaryLang(w.zim.language) === Lib.primaryLang(a.zim.language) ? w.zim.name : null);
    // Leaving and coming back keeps the round: its questions, where you are, the score and the answer just given.
    var kept = ZimiShell.saved();
    if (kept && kept.round && kept.round.length) {
      round = kept.round; at = kept.at; score = kept.score; showQuestion();
      if (kept.picked >= 0) { score -= kept.picked === round[at].choices.indexOf(round[at].answer) ? 1 : 0; answer(kept.picked); }
      if (kept.done) advance();
    } else { if (kept) ZimiShell.forget(); newRound(); }
  });
  ZimiShell.persist({
    save: function () { return round.length && (at > 0 || answered) ? { zim: wikiZim, round: round, at: at, score: score, picked: answered ? picked : -1, done: done } : null; }
  });
  root.__quiz = { get round() { return round; }, get zim() { return wikiZim; }, get at() { return at; } };
})(this);
