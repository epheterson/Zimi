/* ZimiGames: Odd One Out. Our own code, GPL-3.0. No network, no fonts, no modules.
   A party game for three to eight people and one phone. Everyone but one player is shown the same secret picture; the odd one
   is shown a question mark. In turn each says one word about the picture, then everyone votes in secret. If the odd one is
   caught they get one guess at the picture. Pictures come from pictures.js, so the game needs no word lists and plays in any
   language. The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var MIN_PLAYERS = 3, MAX_PLAYERS = 8, GUESS_CHOICES = 6, ROUND_CHOICES = [3, 5, 8], TIMER_CHOICES = [0, 15, 30];
  var POINTS = { group: 1, odd: 2 };               // each player who found the odd one / the odd one who got away
  var RECENT_PICTURES = 12;                         // pictures not shown again until this many others have been
  var ALL = 'all';

  function categories() { return Object.keys(root.ZimiPictures.sets); }
  function picsOf(cat) { return root.ZimiPictures.sets[cat].pics; }
  // Every picture that can be dealt for a category choice (a key or 'all') as { cat, i } ids.
  function pool(cat) {
    var keys = cat === ALL ? categories() : [cat], out = [];
    keys.forEach(function (k) { if (root.ZimiPictures.sets[k]) picsOf(k).forEach(function (p, i) { out.push({ cat: k, i: i }); }); });
    return out;
  }
  var same = function (a, b) { return a.cat === b.cat && a.i === b.i; };
  function shuffle(a, rng) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // A new round: the picture, who is odd, the order of speaking and the pictures the odd one may guess from.
  // recent: pictures dealt lately (not repeated while others remain); lastOdd: the previous odd player (not again, with four or more).
  function newRound(n, cat, seed, recent, lastOdd) {
    n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
    var rng = root.ZimiUtil.mulberry32(seed === undefined ? root.ZimiUtil.newSeed() : seed);
    var fresh = pool(cat).filter(function (p) { return !(recent || []).some(function (r) { return same(r, p); }); });
    if (!fresh.length) fresh = pool(cat);
    var pic = fresh[Math.floor(rng() * fresh.length)];
    var seats = [];
    for (var i = 0; i < n; i++) if (n < 4 || i !== lastOdd) seats.push(i);
    var odd = seats[Math.floor(rng() * seats.length)];
    var others = picsOf(pic.cat).map(function (p, i) { return { cat: pic.cat, i: i }; }).filter(function (p) { return !same(p, pic); });
    var options = shuffle(shuffle(others, rng).slice(0, GUESS_CHOICES - 1).concat([pic]), rng);
    var order = shuffle(Array.apply(null, Array(n)).map(function (_, k) { return k; }), rng);
    return { n: n, cat: pic.cat, pic: pic, odd: odd, order: order, options: options, votes: [], accused: -2, guess: null, outcome: null };
  }

  // Cast the vote of `voter` for `target`: nobody votes for themselves.
  function canVote(round, voter, target) {
    return voter >= 0 && voter < round.n && target >= 0 && target < round.n && voter !== target && round.votes[voter] === undefined;
  }
  function vote(round, voter, target) {
    if (!canVote(round, voter, target)) return false;
    round.votes[voter] = target;
    return true;
  }
  function allVoted(round) { for (var i = 0; i < round.n; i++) if (round.votes[i] === undefined) return false; return true; }
  function tally(round) {
    var counts = Array.apply(null, Array(round.n)).map(function () { return 0; });
    round.votes.forEach(function (t) { if (t !== undefined && t >= 0) counts[t]++; });
    return counts;
  }
  // The accused: the player with the most votes, or -1 when two or more share the top (the odd one escapes).
  function accused(round) {
    var counts = tally(round), top = Math.max.apply(null, counts), who = [];
    counts.forEach(function (c, i) { if (c === top) who.push(i); });
    return top > 0 && who.length === 1 ? who[0] : -1;
  }

  // The end of a round. guess: the picture the caught odd one named ({cat, i}) or null.
  // caught: the group named the odd one. The odd one wins by escaping, or by naming the picture after being caught.
  function settle(round, guess) {
    var acc = round.accused === -2 ? accused(round) : round.accused;
    var caught = acc === round.odd, guessed = caught && !!guess, right = guessed && same(guess, round.pic);
    var oddWins = !caught || right;
    var points = Array.apply(null, Array(round.n)).map(function () { return 0; });
    if (oddWins) points[round.odd] = POINTS.odd;
    else for (var i = 0; i < round.n; i++) if (i !== round.odd) points[i] = POINTS.group;
    return { accused: acc, caught: caught, guessed: guessed, right: right, oddWins: oddWins, points: points };
  }

  // The leaders after a game: every player on the top score.
  function leaders(scores) {
    var top = Math.max.apply(null, scores), out = [];
    scores.forEach(function (s, i) { if (s === top) out.push(i); });
    return out;
  }

  var Engine = { MIN_PLAYERS: MIN_PLAYERS, MAX_PLAYERS: MAX_PLAYERS, GUESS_CHOICES: GUESS_CHOICES, ROUND_CHOICES: ROUND_CHOICES, TIMER_CHOICES: TIMER_CHOICES, POINTS: POINTS, ALL: ALL, RECENT_PICTURES: RECENT_PICTURES,
    categories: categories, pool: pool, picsOf: picsOf, newRound: newRound, canVote: canVote, vote: vote, allVoted: allVoted, tally: tally, accused: accused, settle: settle, leaders: leaders };
  root.OddOneOutEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T, Pass = root.GamesPass;
  var SETTINGS_KEY = 'zimi.games.oddone.settings', STATS_KEY = 'zimi.games.oddone.stats';
  var TICK_MS = 1000, WARN_SECONDS = 5, SNAP_W = 320, SNAP_H = 180;
  Play.applyTheme();

  var els = { msg: $('oo-msg'), main: $('oo-main'), nu: $('oo-new'), sheet: $('oo-sheet'), go: $('oo-go'), body: $('oo-setup') };
  var settings = Play.load(SETTINGS_KEY, { players: 4, cat: ALL, rounds: 3, timer: 0 });
  var S = { phase: 'setup', names: [], n: 4, round: 1, rounds: 3, cat: ALL, timer: 0, scores: [], r: null, k: 0, spoke: 0, laps: 1, history: [], lastOdd: -1 };
  var peeking = false, ticker = null, left = 0;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function nm(i) { return S.names[i]; }
  function slug(name) { return name.toLowerCase().replace(/[^a-z]/g, ''); }
  function picName(p) { var cat = p.cat, name = picsOf(cat)[p.i][0]; return T((cat === 'animals' || cat === 'shapes' ? 'memory.pic.' : 'oddone.pic.') + slug(name)); }
  function catName(k) { return k === ALL ? T('oddone.cat.all') : T(k === 'animals' || k === 'shapes' ? 'memory.set.' + k : 'oddone.cat.' + k); }
  function picEl(p, cls) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 64 64'); s.setAttribute('class', 'oo-pic' + (cls ? ' ' + cls : ''));
    s.setAttribute('role', 'img'); s.setAttribute('aria-label', picName(p));
    s.innerHTML = picsOf(p.cat)[p.i][1];
    return s;
  }
  function stopTicker() { if (ticker) { ticker.cancel(); ticker = null; } }
  function say(text) { els.msg.textContent = text; }
  function clear() { els.main.textContent = ''; }
  function button(text, cls, fn) { var b = el('button', 'ar-btn' + (cls ? ' ' + cls : ''), text); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function roundLine() { return T('oddone.round', { n: S.round, total: S.rounds }); }

  // ── names, kept for the next game (shared with the other games for several people) ──
  function readNames(count) { return root.ZimiSeats.loadNames(count); }
  function writeNames(list) { try { root.localStorage.setItem(root.ZimiSeats.NAMES_KEY, JSON.stringify(list)); } catch (e) { /* play on */ } }

  // ── the setup sheet ──
  var nameInputs = [];
  function paintSetup() {
    els.body.textContent = '';
    var names = readNames(MAX_PLAYERS);
    els.body.appendChild(Play.optionRow(T('seats.players'), range(MIN_PLAYERS, MAX_PLAYERS).map(function (n) { return [n, Play.num(n)]; }), settings.players, function (v) { settings.players = v; Play.save(SETTINGS_KEY, settings); paintNames(); }, 'pl-grid'));
    var box = el('div', 'oo-names'); box.id = 'oo-names'; els.body.appendChild(box);
    var cats = [[ALL, catName(ALL)]].concat(categories().map(function (k) { return [k, catName(k)]; }));
    els.body.appendChild(Play.optionRow(T('oddone.pictures'), cats, settings.cat, function (v) { settings.cat = v; Play.save(SETTINGS_KEY, settings); }, 'pl-grid'));
    els.body.appendChild(Play.optionRow(T('oddone.rounds'), ROUND_CHOICES.map(function (n) { return [n, Play.num(n)]; }), settings.rounds, function (v) { settings.rounds = v; Play.save(SETTINGS_KEY, settings); }));
    els.body.appendChild(Play.optionRow(T('oddone.timer'), TIMER_CHOICES.map(function (n) { return [n, n ? T('oddone.seconds', { n: n }) : T('shell.off')]; }), settings.timer, function (v) { settings.timer = v; Play.save(SETTINGS_KEY, settings); }));
    paintNames(names);
  }
  function range(a, b) { var out = []; for (var i = a; i <= b; i++) out.push(i); return out; }
  function paintNames(names) {
    names = names || nameInputs.map(function (i) { return i.value; }).concat(readNames(MAX_PLAYERS)).slice(0, MAX_PLAYERS);
    var box = $('oo-names');
    box.textContent = '';
    nameInputs = [];
    for (var i = 0; i < settings.players; i++) {
      var input = el('input', 'gs-seat-name');
      input.type = 'text'; input.maxLength = 14; input.value = root.ZimiSeats.cleanName(names[i], i);
      input.setAttribute('aria-label', T('oddone.nameFor', { n: i + 1 }));
      input.addEventListener('change', saveNames);
      box.appendChild(input); nameInputs.push(input);
    }
  }
  function saveNames() {
    var list = readNames(MAX_PLAYERS);
    nameInputs.forEach(function (input, i) { list[i] = root.ZimiSeats.cleanName(input.value, i); input.value = list[i]; });
    writeNames(list);
  }
  function showSetup() { stopTicker(); S.phase = 'setup'; paintSetup(); Play.openSheet(els.sheet, '#oo-go'); }

  function start() {
    saveNames();
    var list = nameInputs.map(function (i) { return i.value; });
    Play.closeSheet(els.sheet);
    S = { phase: 'reveal', names: list, n: settings.players, round: 1, rounds: settings.rounds, cat: settings.cat, timer: settings.timer, scores: list.map(function () { return 0; }), r: null, k: 0, spoke: 0, laps: 1, history: [], lastOdd: -1 };
    dealRound();
  }
  function dealRound() {
    S.r = newRound(S.n, S.cat, undefined, S.history, S.lastOdd);
    S.history = S.history.concat([S.r.pic]).slice(-RECENT_PICTURES);
    S.lastOdd = S.r.odd; S.phase = 'reveal'; S.k = 0; S.spoke = 0; S.laps = 1; peeking = false;
    render();
  }

  // ── the phases ──
  function render() {
    stopTicker(); clear();
    if (S.phase === 'reveal') return renderReveal();
    if (S.phase === 'talk') return renderTalk();
    if (S.phase === 'vote') return renderVote();
    if (S.phase === 'guess') return renderGuess();
    if (S.phase === 'result') return renderResult();
  }

  // Each player in turn looks at the secret and hides it again.
  function renderReveal() {
    say(roundLine());
    if (!peeking) { Pass.cover({ name: nm(S.k), text: T('oddone.cover.reveal', { name: nm(S.k) }), onReady: function () { peeking = true; render(); } }); return; }
    var odd = S.k === S.r.odd, card = el('section', 'oo-secret');
    card.setAttribute('aria-live', 'polite');
    card.appendChild(el('p', 'oo-cat', T('oddone.category', { name: catName(S.r.cat) })));
    if (odd) {
      card.appendChild(el('div', 'oo-qmark', '?'));
      card.appendChild(el('h2', null, T('oddone.you.odd')));
      card.appendChild(el('p', null, T('oddone.you.oddText')));
    } else {
      card.appendChild(picEl(S.r.pic, 'oo-big'));
      card.appendChild(el('h2', null, picName(S.r.pic)));
      card.appendChild(el('p', null, T('oddone.you.text')));
    }
    els.main.appendChild(card);
    els.main.appendChild(button(T('oddone.hide'), 'gs-primary oo-wide', function () {
      peeking = false; S.k++;
      if (S.k >= S.n) { S.phase = 'talk'; S.spoke = 0; }
      render();
    }));
  }

  // Each says one word aloud, in the order the phone shows.
  function renderTalk() {
    say(roundLine());
    var card = el('section', 'oo-talk');
    card.appendChild(el('p', 'oo-cat', T('oddone.category', { name: catName(S.r.cat) })));
    var done = S.spoke >= S.n;
    card.appendChild(el('h2', null, done ? T('oddone.talk.done') : T('oddone.talk.turn', { name: nm(S.r.order[S.spoke]) })));
    var list = el('ol', 'oo-order');
    S.r.order.forEach(function (p, i) {
      var li = el('li', i < S.spoke ? 'oo-spoken' : i === S.spoke ? 'oo-now' : '', nm(p));
      if (i === S.spoke) li.setAttribute('aria-current', 'step');
      list.appendChild(li);
    });
    card.appendChild(list);
    var clock = el('p', 'oo-clock'); clock.id = 'oo-clock';
    clock.hidden = !S.timer || done;
    card.appendChild(clock);
    els.main.appendChild(card);
    var actions = el('div', 'gs-actionrow oo-actions');
    if (!done) actions.appendChild(button(T('oddone.next'), 'gs-primary', nextSpeaker));
    else {
      actions.appendChild(button(T('oddone.vote'), 'gs-primary', startVote));
      actions.appendChild(button(T('oddone.again'), '', function () { S.spoke = 0; S.laps++; render(); }));
    }
    els.main.appendChild(actions);
    if (!done && S.timer) { left = S.timer; tickClock(); }
  }
  function nextSpeaker() { S.spoke++; render(); }
  function tickClock() {
    var c = $('oo-clock');
    if (!c) return;
    c.textContent = T('oddone.seconds', { n: left });
    c.classList.toggle('oo-low', left <= WARN_SECONDS);
    if (left <= 0) { nextSpeaker(); return; }
    ticker = Play.later(function () { left--; tickClock(); }, TICK_MS);
  }

  // Everyone votes in secret, one after another behind the cover.
  function startVote() { S.phase = 'vote'; S.k = 0; S.r.votes = []; peeking = false; render(); }
  function renderVote() {
    say(roundLine());
    if (!peeking) { Pass.cover({ name: nm(S.k), text: T('oddone.cover.vote', { name: nm(S.k) }), onReady: function () { peeking = true; render(); } }); return; }
    var card = el('section', 'oo-vote'), picked = -1, ok;
    card.appendChild(el('h2', null, T('oddone.vote.title', { name: nm(S.k) })));
    var list = el('div', 'oo-choices'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', T('oddone.vote.pick'));
    for (var i = 0; i < S.n; i++) {
      if (i === S.k) continue;
      var b = button(nm(i), 'oo-choice', null);
      b.setAttribute('aria-pressed', 'false');
      (function (who, btn) {
        btn.addEventListener('click', function () {
          picked = who;
          Array.prototype.forEach.call(list.children, function (x) { x.setAttribute('aria-pressed', String(x === btn)); });
          ok.setAttribute('aria-disabled', 'false');
        });
      })(i, b);
      list.appendChild(b);
    }
    card.appendChild(list);
    els.main.appendChild(card);
    ok = button(T('oddone.vote.confirm'), 'gs-primary oo-wide', function () {
      if (picked < 0) { say(T('oddone.vote.pick')); ZimiShell.shake(list); return; }
      vote(S.r, S.k, picked);
      peeking = false; S.k++;
      if (S.k >= S.n) return endVote();
      render();
    });
    ok.setAttribute('aria-disabled', 'true');
    els.main.appendChild(ok);
  }
  function endVote() {
    S.r.accused = accused(S.r);
    if (S.r.accused === S.r.odd) { S.phase = 'guess'; peeking = false; render(); } else finishRound(null);
  }

  // A caught odd one has one guess at the picture.
  function renderGuess() {
    say(roundLine());
    if (!peeking) { Pass.cover({ name: nm(S.r.odd), text: T('oddone.cover.guess', { name: nm(S.r.odd) }), onReady: function () { peeking = true; render(); } }); return; }
    var card = el('section', 'oo-guess');
    card.appendChild(el('p', 'oo-cat', T('oddone.category', { name: catName(S.r.cat) })));
    card.appendChild(el('h2', null, T('oddone.guess.title')));
    var grid = el('div', 'oo-options');
    S.r.options.forEach(function (o) {
      var b = el('button', 'oo-option'); b.type = 'button';
      b.appendChild(picEl(o));
      b.setAttribute('aria-label', picName(o));
      b.addEventListener('click', function () { finishRound(o); });
      grid.appendChild(b);
    });
    card.appendChild(grid);
    els.main.appendChild(card);
  }

  function finishRound(guess) {
    var out = settle(S.r, guess);
    S.r.guess = guess; S.r.outcome = out;
    out.points.forEach(function (p, i) { S.scores[i] += p; });
    S.phase = 'result'; peeking = false;
    render();
  }

  function renderResult() {
    var r = S.r, out = r.outcome;
    say(roundLine());
    var card = el('section', 'oo-result');
    card.appendChild(el('h2', null, out.caught ? T('oddone.result.caught', { name: nm(r.odd) }) : out.accused < 0 ? T('oddone.result.tie') : T('oddone.result.wrong', { name: nm(out.accused) })));
    card.appendChild(el('p', null, T('oddone.result.odd', { name: nm(r.odd) })));
    var pic = el('div', 'oo-reveal'); pic.appendChild(picEl(r.pic, 'oo-mid')); pic.appendChild(el('span', null, picName(r.pic))); card.appendChild(pic);
    if (out.guessed) card.appendChild(el('p', null, T(out.right ? 'oddone.guess.right' : 'oddone.guess.wrong', { name: nm(r.odd), pic: picName(r.guess) })));
    card.appendChild(el('p', 'oo-win', out.oddWins ? T('oddone.win.odd', { name: nm(r.odd) }) : T('oddone.win.group')));
    var counts = tally(r), table = el('ul', 'oo-scores');
    for (var i = 0; i < S.n; i++) {
      var li = el('li', i === r.odd ? 'oo-oddrow' : '');
      li.appendChild(el('b', null, nm(i)));
      li.appendChild(el('span', 'oo-votes', T('oddone.votes', { n: counts[i] })));
      li.appendChild(el('span', 'oo-pts', '+' + Play.num(out.points[i])));
      li.appendChild(el('span', 'oo-total', Play.num(S.scores[i])));
      li.setAttribute('aria-label', T('oddone.scoreRow', { name: nm(i), votes: counts[i], points: out.points[i], total: S.scores[i] }));
      table.appendChild(li);
    }
    card.appendChild(table);
    els.main.appendChild(card);
    var last = S.round >= S.rounds;
    els.main.appendChild(button(T(last ? 'oddone.final' : 'oddone.nextRound'), 'gs-primary oo-wide', function () {
      if (last) return finish();
      S.round++; dealRound();
    }));
  }

  var stats = Play.load(STATS_KEY, { games: 0 });
  function finish() {
    var lead = leaders(S.scores);
    S.phase = 'final'; stopTicker();
    stats.games++; Play.save(STATS_KEY, stats);
    var names = lead.map(nm).join(', ');
    clear();
    say(lead.length === 1 ? T('shell.end.wins', { name: names }) : T('oddone.final.tie', { names: names }));
    ZimiShell.endSheet({
      result: lead.length === 1 ? 'win' : 'draw', name: lead.length === 1 ? names : undefined, title: lead.length === 1 ? undefined : T('oddone.final.tie', { names: names }),
      stats: [[T('oddone.score'), Play.num(S.scores[lead[0]])], [T('oddone.rounds'), Play.num(S.rounds)]],
      onNew: showSetup
    });
  }

  // The tile and the game table show the group, never the picture or who is odd.
  function neutralPicture() {
    var n = S.n || 4, out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + SNAP_W + ' ' + SNAP_H + '"><rect width="' + SNAP_W + '" height="' + SNAP_H + '" fill="#1d2433"/>', gap = SNAP_W / (n + 1);
    for (var i = 0; i < n; i++) out += '<circle cx="' + Math.round(gap * (i + 1)) + '" cy="118" r="14" fill="#2b3550" stroke="#7c8698" stroke-width="2"/>';
    return out + '<text x="160" y="84" font-size="64" font-weight="800" text-anchor="middle" fill="#e8c26a" font-family="sans-serif">?</text></svg>';
  }

  els.go.addEventListener('click', start);
  els.nu.addEventListener('click', showSetup);
  ZimiShell.game({
    snapshot: neutralPicture,
    inProgress: function () { return S.phase !== 'setup' && S.phase !== 'final'; },
    stats: function () { return stats.games ? [[T('oddone.stat.games'), Play.num(stats.games)]] : []; }
  });
  showSetup();
  // Never lose a game: the round (picture, who is odd, votes), the scores and where in the round it was. A phone put down
  // between players comes back to the cover, not to a secret.
  ZimiShell.persist({
    save: function () { return S.phase === 'setup' || S.phase === 'final' || !S.r ? null : { S: S }; },
    load: function (d) {
      var s = d && d.S;
      if (!s || !s.r || !Array.isArray(s.names) || s.names.length < MIN_PLAYERS || ['reveal', 'talk', 'vote', 'guess', 'result'].indexOf(s.phase) < 0) return false;
      S = s; peeking = false;
      Play.closeSheet(els.sheet);
      render();
      return true;
    }
  });
  root.__oddone = { get S() { return S; } };
})(this);
