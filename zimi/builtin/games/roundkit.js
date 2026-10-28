/* ZimiGames: the round the multiple-choice library games share (First Lines, Flags, Higher or Lower). Our own code, GPL-3.0.
   A round is a handful of questions, each a card (a line of text, a picture or both) and choices to tap; the score is the
   bar's one stat, and the end is a score game's "Game over" with the score and the best. A game gives RoundKit.run its
   id, a builder that makes a round from the player's library (or from what the game ships) and a few words; the page,
   the keys (1 to 4), the saved round and the end sheet are here once.
   A question: {kind, prompt?, quote?, picture?, choices: [text], answer: text, path?, zim?, detail?}.
   `kind` names the line above the card: cfg.kinds[kind] is its string id. `detail` is a line shown once the player has answered. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  var Kit = {};
  root.RoundKit = Kit;
  if (typeof document === 'undefined') return;

  Kit.run = function (cfg) {
    var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
    Play.applyTheme();
    var BEST_KEY = 'zimi.games.' + cfg.id + '.best';
    var els = { n: $('rk-n'), score: $('rk-score'), card: $('rk-card'), prompt: $('rk-prompt'), quote: $('rk-quote'), pic: $('rk-pic'), kind: $('rk-kind'),
      choices: $('rk-choices'), msg: $('rk-msg'), detail: $('rk-detail'), next: $('rk-next'), read: $('rk-read'), newBtn: $('rk-new') };
    var status = Play.status(els.msg);
    var zim = '', round = [], at = 0, score = 0, answered = false, building = false, picked = -1, done = false;

    var el = root.ZimiUtil.el, label = cfg.label || function (c) { return c; };   // a game may show a choice in the player's language
    function paintScore() {
      els.n.textContent = round.length ? T('round.question', { n: at + 1, total: round.length }) : '';
      els.score.textContent = T('round.score', { n: score });
    }
    function showQuestion() {
      var q = round[at]; answered = false;
      els.kind.textContent = T(cfg.kinds[q.kind]);
      els.prompt.textContent = q.prompt || ''; els.prompt.hidden = !q.prompt; els.prompt.dir = 'auto';
      els.quote.textContent = q.quote || ''; els.quote.hidden = !q.quote; els.quote.dir = 'auto';
      els.pic.hidden = !q.picture;
      if (q.picture) { els.pic.removeAttribute('src'); els.pic.src = q.picture; els.pic.alt = T(cfg.text.alt); }
      els.choices.innerHTML = '';
      els.choices.classList.toggle('pair', q.choices.length === 2);
      q.choices.forEach(function (c, i) {
        var b = el('button', 'rk-choice'); b.type = 'button'; b.dataset.i = i;
        b.appendChild(el('span', 'rk-num', Play.num(i + 1))); b.appendChild(el('span', 'rk-text', label(c, q))); b.lastChild.dir = 'auto';
        els.choices.appendChild(b);
      });
      status.say(''); els.detail.hidden = true; els.next.hidden = true; els.read.hidden = true;
      if (cfg.english) { var note = typeof cfg.english === 'function' ? cfg.english(q) : cfg.english; Lib.englishNote(T, note, !zim && !!note); }
      paintScore();
    }
    function answer(i, byKey) {
      if (answered || !round.length || done) return;
      var q = round[at], btns = els.choices.children, right = q.choices.indexOf(q.answer);
      picked = i; answered = true;
      for (var k = 0; k < btns.length; k++) { btns[k].disabled = true; if (k === right) btns[k].classList.add('right'); }
      if (i === right) { score++; Lib.bump(els.score); status.say(T('round.right')); } else { btns[i].classList.add('wrong'); status.say(T('round.itWas', { answer: Lib.iso(label(q.answer, q)) })); }
      if (q.detail) { els.detail.textContent = q.detail; els.detail.hidden = false; els.detail.dir = 'auto'; }
      if (q.path && q.zim) {   // only once the ZIM is known to hold the page (a list links to articles a smaller ZIM leaves out)
        var asked = at;
        Lib.hasPage(q.zim, q.path).then(function (has) {
          if (!has || asked !== at || !answered) return;
          els.read.hidden = false; Lib.articleLink(els.read, q.zim, q.path); els.read.textContent = T('round.read', { answer: Lib.iso(label(q.answer, q)) });
        });
      }
      els.next.hidden = false; els.next.textContent = T(at + 1 >= round.length ? 'round.seeScore' : 'round.next');
      if (byKey) els.next.focus();   // a tap leaves no focus ring on Next; the keyboard player needs the focus there
      paintScore();
    }
    function advance() {
      if (!answered) return;
      if (at + 1 >= round.length) return finish();
      at++; showQuestion();
    }
    function finish() {
      var best = Play.load(BEST_KEY, {}), key = zim || 'built-in', mine = best[key] || 0;
      if (score > mine) { best[key] = score; Play.save(BEST_KEY, best); }
      var line = T('round.verdict.' + Lib.verdict(score, round.length));
      status.say(line); done = true;
      ZimiShell.endSheet({
        result: 'over', text: line,
        stats: [[T('play.score'), T('round.of', { n: score, total: round.length })], [T('play.best'), Play.num(Math.max(score, mine))]]
      });
    }
    function busy(t) {
      els.card.classList.toggle('busy', !!t);
      if (!t) return;
      els.kind.textContent = t; els.prompt.hidden = true; els.quote.hidden = true; els.pic.hidden = true; els.choices.innerHTML = '';
      status.say(''); els.detail.hidden = true; els.next.hidden = true; els.read.hidden = true; els.n.textContent = '';
    }
    function newRound() {
      if (building) return; building = true; at = 0; score = 0; round = []; done = false; picked = -1;
      busy(T(cfg.text.choosing)); els.kind.classList.add('gl-loading');
      cfg.build().then(function (got) { return got; }, function () { return null; }).then(function (got) {
        building = false; els.kind.classList.remove('gl-loading');
        zim = (got && got.zim) || ''; round = (got && got.round && got.round.length ? got.round : cfg.builtIn());
        if (!got || !got.round || !got.round.length) zim = '';
        els.card.classList.remove('busy'); showQuestion();
      });
    }

    els.choices.addEventListener('click', function (e) { var b = e.target.closest('.rk-choice'); if (b) answer(+b.dataset.i); });
    els.next.addEventListener('click', advance);
    els.newBtn.addEventListener('click', newRound);
    ZimiShell.game({
      about: function () { return Lib.note(T, cfg.what, zim); },
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
    // Leaving and coming back keeps the round: its questions, where you are, the score and the answer just given.
    Lib.library().then(function (list) {
      cfg.init(list);
      var kept = ZimiShell.saved();
      if (kept && kept.round && kept.round.length) {
        round = kept.round; at = kept.at; score = kept.score; zim = kept.zim || ''; showQuestion();
        if (kept.picked >= 0) { score -= kept.picked === round[at].choices.indexOf(round[at].answer) ? 1 : 0; answer(kept.picked); }
        if (kept.done) advance();
      } else { if (kept) ZimiShell.forget(); newRound(); }
    });
    ZimiShell.persist({
      save: function () { return round.length && (at > 0 || answered) ? { zim: zim, round: round, at: at, score: score, picked: answered ? picked : -1, done: done } : null; }
    });
    root.__round = { get round() { return round; }, get zim() { return zim; }, get score() { return score; }, get at() { return at; } };
  };
})(this);
