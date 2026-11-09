/* ZimiGames: Courtier. Our own code, GPL-3.0. No network, no fonts, no modules.
   Sixteen cards in eight ranks of the court. You hold one, draw one, play one. A played card does its work: name a card and
   throw a rival out, peek, compare, shelter, make someone start over, swap hands. When the deck runs out the highest card left
   wins the round; rounds give favors, and the first to enough favors wins. The rules and the computer (pure functions, no DOM,
   so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var SCOUT = 1, HERALD = 2, CHAMPION = 3, SENTINEL = 4, MAGISTER = 5, ENVOY = 6, DOWAGER = 7, HEIR = 8;
  var COUNTS = [0, 5, 2, 2, 2, 2, 1, 1, 1];   // how many of each rank, indexed by rank
  var MIN_PLAYERS = 2, MAX_PLAYERS = 4, SET_ASIDE_FACE_UP = 3;
  var FAVORS_TO_WIN = { 2: 5, 3: 4, 4: 3 };
  var LOG_KEEP = 24;
  var NO_PLAY = -10;                            // a move the computer will not make

  function fullDeck() {
    var d = [];
    for (var r = 1; r <= HEIR; r++) for (var k = 0; k < COUNTS[r]; k++) d.push(r);
    return d;
  }
  function shuffle(a, rng) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function createGame(n, seed, cpuFlags) {
    n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n || 3));
    var rng = root.ZimiUtil.counted(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed);
    var players = [];
    for (var i = 0; i < n; i++) {
      // Each computer has a temperament: how much it varies from the plain best play.
      players.push({ name: '', ai: cpuFlags ? !!cpuFlags[i] : i > 0, hand: [], played: [], out: false, shield: false, favors: 0, known: {}, not: {}, vary: 0.02 + rng() * 0.08 });
    }
    var g = { n: n, players: players, goal: FAVORS_TO_WIN[n], deck: [], aside: 0, faceUp: [], turn: 0, round: 0, over: false, winner: -1, roundEnd: null, last: null, log: [], rng: rng };
    startRound(g, 0);
    return g;
  }

  function startRound(g, starter) {
    g.round++;
    g.roundEnd = null; g.last = null; g.log = [];
    g.deck = shuffle(fullDeck(), g.rng);
    g.aside = g.deck.pop();
    g.faceUp = [];
    if (g.n === 2) for (var k = 0; k < SET_ASIDE_FACE_UP; k++) g.faceUp.push(g.deck.pop());
    g.players.forEach(function (p) { p.hand = [g.deck.pop()]; p.played = []; p.out = false; p.shield = false; p.known = {}; p.not = {}; });
    g.turn = starter;
    beginTurn(g);
  }
  function beginTurn(g) {
    var p = g.players[g.turn];
    p.shield = false;
    p.hand.push(g.deck.pop());
  }
  function active(g) { return g.players.map(function (p, i) { return i; }).filter(function (i) { return !g.players[i].out; }); }
  function nextActive(g, i) { var k = i; do { k = (k + 1) % g.n; } while (g.players[k].out); return k; }

  // The Dowager must be played when it is held with the Magister or the Envoy.
  function forcedIndex(hand) {
    if (hand.length !== 2) return -1;
    var has = function (r) { return hand.indexOf(r) >= 0; };
    return has(DOWAGER) && (has(MAGISTER) || has(ENVOY)) ? hand.indexOf(DOWAGER) : -1;
  }
  function canPlay(g, idx) {
    if (g.over || g.roundEnd) return false;
    var hand = g.players[g.turn].hand;
    if (idx < 0 || idx >= hand.length) return false;
    var f = forcedIndex(hand);
    return f < 0 || f === idx;
  }
  // Who a rank can be played on: rivals still in and not sheltered (the Magister may also be played on yourself).
  function targets(g, rank, by) {
    var out = [];
    if (rank === SENTINEL || rank === DOWAGER || rank === HEIR) return out;
    g.players.forEach(function (p, i) {
      if (p.out) return;
      if (i === by) { if (rank === MAGISTER) out.push(i); return; }
      if (!p.shield) out.push(i);
    });
    return out;
  }
  function needsTarget(rank) { return rank === SCOUT || rank === HERALD || rank === CHAMPION || rank === MAGISTER || rank === ENVOY; }

  function knockOut(g, i) {
    var p = g.players[i];
    p.played = p.played.concat(p.hand);
    p.hand = [];
    p.out = true;
    g.players.forEach(function (q) { delete q.known[i]; delete q.not[i]; });
  }

  // What each card does when played: (game, event, the player, the rival or null, the named card).
  var EFFECTS = {};
  EFFECTS[SCOUT] = function (g, ev, p, q, guess) {
    if (q.hand[0] === guess) { ev.out.push(ev.target); knockOut(g, ev.target); }
    else g.players.forEach(function (o) { o.not[ev.target] = (o.not[ev.target] || []).concat(guess); });
  };
  EFFECTS[HERALD] = function (g, ev, p, q) { ev.peek = q.hand[0]; p.known[ev.target] = q.hand[0]; };
  EFFECTS[CHAMPION] = function (g, ev, p, q) {
    var mine = p.hand[0], theirs = q.hand[0];
    if (mine > theirs) { ev.out.push(ev.target); knockOut(g, ev.target); }
    else if (mine < theirs) { ev.out.push(ev.by); knockOut(g, ev.by); }
    else { ev.tie = true; p.known[ev.target] = theirs; q.known[ev.by] = mine; }
  };
  EFFECTS[SENTINEL] = function (g, ev, p) { p.shield = true; };
  EFFECTS[MAGISTER] = function (g, ev, p, q) {
    var t = ev.target, dropped = q.hand[0];
    ev.discard = dropped; ev.redraw = true;
    g.players.forEach(function (o) { delete o.known[t]; delete o.not[t]; });
    if (dropped === HEIR) { ev.out.push(t); knockOut(g, t); }
    else { q.played.push(dropped); q.hand = [g.deck.length ? g.deck.pop() : g.aside]; }
  };
  EFFECTS[ENVOY] = function (g, ev, p, q) {
    var by = ev.by, t = ev.target, mineBefore = p.hand[0], theirsBefore = q.hand[0];
    p.hand = [theirsBefore]; q.hand = [mineBefore];
    ev.swapped = true;
    // Whoever held either card knows where it went; everyone else's notes on the two seats trade places.
    var kb = g.players.map(function (o) { return [o.known[by], o.known[t]]; });
    var nb = g.players.map(function (o) { return [o.not[by], o.not[t]]; });
    g.players.forEach(function (o, oi) {
      delete o.known[by]; delete o.known[t]; delete o.not[by]; delete o.not[t];
      if (oi === by || oi === t) return;
      if (kb[oi][1] !== undefined) o.known[by] = kb[oi][1];
      if (kb[oi][0] !== undefined) o.known[t] = kb[oi][0];
      if (nb[oi][1]) o.not[by] = nb[oi][1];
      if (nb[oi][0]) o.not[t] = nb[oi][0];
    });
    p.known[t] = mineBefore; q.known[by] = theirsBefore;
  };
  EFFECTS[HEIR] = function (g, ev) { ev.out.push(ev.by); knockOut(g, ev.by); };

  // Play the card at idx. target: a seat or -1; guess: a rank (the Scout). Returns the event, or false when the move is not legal.
  function play(g, idx, target, guess) {
    if (!canPlay(g, idx)) return false;
    var by = g.turn, p = g.players[by], rank = p.hand[idx];
    var legal = targets(g, rank, by), need = needsTarget(rank);
    if (need && legal.length && legal.indexOf(target) < 0) return false;
    if (rank === SCOUT && legal.length && (guess < 2 || guess > HEIR || guess !== Math.floor(guess))) return false;
    var t = need && legal.length ? target : -1;
    p.hand.splice(idx, 1);
    p.played.push(rank);
    var ev = { by: by, rank: rank, target: t, guess: rank === SCOUT && t >= 0 ? guess : 0, out: [], peek: 0, tie: false, swapped: false, redraw: false, discard: 0 };
    var q = t >= 0 ? g.players[t] : null;
    // What the table can learn first: a card played that the player had been known to hold is no longer known.
    g.players.forEach(function (o) { if (o.known[by] === rank) delete o.known[by]; delete o.not[by]; });
    var effect = EFFECTS[rank];
    if (effect && (q || !needsTarget(rank))) effect(g, ev, p, q, guess);
    g.last = ev;
    g.log.push(ev); if (g.log.length > LOG_KEEP) g.log.shift();
    finishPlay(g);
    return ev;
  }

  function finishPlay(g) {
    var alive = active(g);
    if (alive.length === 1) return endRound(g, 'last');
    if (!g.deck.length) return endRound(g, 'deck');
    g.turn = nextActive(g, g.turn);
    beginTurn(g);
  }

  function playedSum(p) { return p.played.reduce(function (a, r) { return a + r; }, 0); }
  function endRound(g, why) {
    var alive = active(g), best = -1, winners = [];
    if (alive.length === 1) winners = alive;
    else {
      alive.forEach(function (i) { best = Math.max(best, g.players[i].hand[0]); });
      winners = alive.filter(function (i) { return g.players[i].hand[0] === best; });
      var most = Math.max.apply(null, winners.map(function (i) { return playedSum(g.players[i]); }));
      winners = winners.filter(function (i) { return playedSum(g.players[i]) === most; });
    }
    winners.forEach(function (i) { g.players[i].favors++; });
    g.roundEnd = { why: why, winners: winners, hands: g.players.map(function (p) { return p.hand.slice(); }), aside: g.aside };
    var top = Math.max.apply(null, g.players.map(function (p) { return p.favors; }));
    if (top >= g.goal) {
      g.over = true;
      g.winner = g.players.map(function (p, i) { return i; }).filter(function (i) { return g.players[i].favors === top; })[0];
    }
  }
  function nextRound(g) {
    if (g.over || !g.roundEnd) return false;
    startRound(g, g.roundEnd.winners[0]);
    return true;
  }

  // ── the computer ─────────────────────────────────────────────────────────
  // It knows what everyone can see (every card played, the face-up cards), its own hand, and what it has learned: a peek, a
  // swap, a wrong guess. Cards it cannot place are spread over the rest in proportion to how many are left.
  function unseen(g, me) {
    var left = COUNTS.slice();
    g.players.forEach(function (p) { p.played.forEach(function (r) { left[r]--; }); });
    g.faceUp.forEach(function (r) { left[r]--; });
    g.players[me].hand.forEach(function (r) { left[r]--; });
    return left;
  }
  // How likely each rank is to be the card seat t holds, as the computer sees it.
  function guessDist(g, me, t, left) {
    var o = g.players[me], dist = [0, 0, 0, 0, 0, 0, 0, 0, 0], total = 0, r;
    if (o.known[t]) { dist[o.known[t]] = 1; return dist; }
    var bar = o.not[t] || [];
    for (r = 1; r <= HEIR; r++) { if (left[r] > 0 && bar.indexOf(r) < 0) { dist[r] = left[r]; total += left[r]; } }
    if (!total) for (r = 1; r <= HEIR; r++) { if (left[r] > 0) { dist[r] = left[r]; total += left[r]; } }
    if (total) for (r = 1; r <= HEIR; r++) dist[r] /= total;
    return dist;
  }
  function expected(dist) { var e = 0; for (var r = 1; r <= HEIR; r++) e += dist[r] * r; return e; }

  function expectedLeft(left) {
    var n = 0, e = 0;
    for (var r = 1; r <= HEIR; r++) { n += Math.max(left[r], 0); e += Math.max(left[r], 0) * r; }
    return n ? e / n : 4;
  }

  var HOLD_WEIGHT = 0.08, HEIR_HOLD_BONUS = 0.12, WIN_VALUE = 1.1, LOSS_VALUE = 1.3;
  // The worth of playing `rank` and keeping `kept`: the best target and guess, and that worth.
  function appraise(g, me, rank, kept, left) {
    var legal = targets(g, rank, me), best, r, d;
    var rivals = legal.filter(function (x) { return x !== me; });
    best = { score: -Infinity, target: -1, guess: 0 };
    function take(score, target, guess) { if (score > best.score) best = { score: score, target: target, guess: guess || 0 }; }
    if (rank === HEIR) return { score: NO_PLAY, target: -1, guess: 0 };
    if (rank === SCOUT) {
      if (!rivals.length) take(0.02, -1, 0);
      rivals.forEach(function (t) {
        d = guessDist(g, me, t, left);
        var gr = 0, gp = -1;
        for (r = 2; r <= HEIR; r++) if (d[r] > gp) { gp = d[r]; gr = r; }
        take(WIN_VALUE * Math.max(gp, 0) + 0.05, t, gr || 2);
      });
    } else if (rank === HERALD) {
      if (!rivals.length) take(0.02, -1, 0);
      rivals.forEach(function (t) { take(g.players[me].known[t] ? 0.04 : 0.22 + 0.01 * (HEIR - Math.min(g.deck.length, 8)), t, 0); });
    } else if (rank === CHAMPION) {
      if (!rivals.length) take(0.02, -1, 0);
      rivals.forEach(function (t) {
        d = guessDist(g, me, t, left);
        var s = 0;
        for (r = 1; r <= HEIR; r++) s += d[r] * (kept > r ? WIN_VALUE : kept < r ? -LOSS_VALUE : 0);
        take(s, t, 0);
      });
    } else if (rank === SENTINEL) {
      take(0.28 + 0.04 * kept, -1, 0);
    } else if (rank === MAGISTER) {
      legal.forEach(function (t) {
        if (t === me) {
          if (kept === HEIR) return take(NO_PLAY, t, 0);   // forced to give up the Heir, or to play it: out either way
          var e = expectedLeft(left);
          take(0.18 * (e - kept) / HEIR * 2 + (kept <= 2 ? 0.12 : 0) - (kept >= 6 ? 0.25 : 0), t, 0);
        } else {
          d = guessDist(g, me, t, left);
          take(WIN_VALUE * d[HEIR] + 0.06 + 0.03 * (expected(d) - 4), t, 0);
        }
      });
    } else if (rank === ENVOY) {
      if (!rivals.length) take(0.02, -1, 0);
      rivals.forEach(function (t) {
        d = guessDist(g, me, t, left);
        take(0.5 * (expected(d) - kept) / HEIR + (kept === HEIR ? NO_PLAY : 0), t, 0);
      });
    } else if (rank === DOWAGER) {
      take(0.06, -1, 0);
    }
    return best;
  }

  function aiMove(g) {
    var me = g.turn, p = g.players[me], hand = p.hand, left = unseen(g, me), best = null;
    for (var idx = 0; idx < hand.length; idx++) {
      if (!canPlay(g, idx)) continue;
      var kept = hand[1 - idx], a = appraise(g, me, hand[idx], kept, left);
      var score = a.score + HOLD_WEIGHT * kept / HEIR + (kept === HEIR ? HEIR_HOLD_BONUS : 0) + (g.rng() - 0.5) * 2 * p.vary;
      if (!best || score > best.score) best = { score: score, idx: idx, target: a.target, guess: a.guess };
    }
    return { idx: best.idx, target: best.target, guess: best.guess };
  }

  // A random player that follows the rules and nothing else (the yardstick the tests measure the computer against).
  function randomMove(g, rng) {
    var me = g.turn, hand = g.players[me].hand, choices = [], idx;
    for (idx = 0; idx < hand.length; idx++) if (canPlay(g, idx)) choices.push(idx);
    idx = choices[Math.floor(rng() * choices.length)];
    var legal = targets(g, hand[idx], me), t = needsTarget(hand[idx]) && legal.length ? legal[Math.floor(rng() * legal.length)] : -1;
    return { idx: idx, target: t, guess: 2 + Math.floor(rng() * 7) };
  }

  var Engine = { COUNTS: COUNTS, FAVORS_TO_WIN: FAVORS_TO_WIN, MIN_PLAYERS: MIN_PLAYERS, MAX_PLAYERS: MAX_PLAYERS, SCOUT: SCOUT, HERALD: HERALD, CHAMPION: CHAMPION, SENTINEL: SENTINEL, MAGISTER: MAGISTER, ENVOY: ENVOY, DOWAGER: DOWAGER, HEIR: HEIR,
    createGame: createGame, fullDeck: fullDeck, startRound: startRound, nextRound: nextRound, canPlay: canPlay, forcedIndex: forcedIndex, targets: targets, needsTarget: needsTarget, play: play,
    active: active, unseen: unseen, guessDist: guessDist, aiMove: aiMove, randomMove: randomMove, snapshot: root.ZimiUtil.snapshot, restore: root.ZimiUtil.restore };
  root.CourtierEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var SETTINGS_KEY = 'zimi.games.courtier.settings', STATS_KEY = 'zimi.games.courtier.stats';
  var AI_DELAY_MS = 950, FLASH_MS = 2200;
  Play.applyTheme();

  var els = { msg: $('cr-msg'), seats: $('cr-seats'), deck: $('cr-deck'), log: $('cr-log'), hand: $('cr-hand'), play: $('cr-play'), guide: $('cr-guide'), nu: $('cr-new'),
    guess: $('cr-guess'), guessText: $('cr-guess-text'), ranks: $('cr-ranks'), guessCancel: $('cr-guess-cancel'),
    peek: $('cr-peek'), peekText: $('cr-peek-text'), peekCard: $('cr-peekcard'), peekOk: $('cr-peek-ok'),
    round: $('cr-round'), roundTitle: $('cr-round-title'), roundText: $('cr-round-text'), reveal: $('cr-reveal'), roundNext: $('cr-round-next'),
    cards: $('cr-cards'), list: $('cr-list'), cardsClose: $('cr-cards-close'),
    sheet: $('cr-sheet'), n: $('cr-n'), go: $('cr-go') };
  var settings = Play.load(SETTINGS_KEY, { players: 3 }), stats = Play.load(STATS_KEY, { played: 0, won: 0 });
  var g, seats, timer = null, sel = -1, choosing = false, counted = false, flashTimer = 0, lastLog = '';

  // One drawing for each rank, in a 40 by 40 box. Colour never carries the rank alone: the number, the name and the shape do too.
  var EMBLEM = {
    1: '<path d="M4 20Q20 6 36 20Q20 34 4 20Z"/><circle cx="20" cy="20" r="5"/>',
    2: '<path d="M6 16L22 10V30L6 24Z"/><path d="M26 13Q35 20 26 27"/><path d="M9 25L11 33"/>',
    3: '<path d="M20 3L24 22H16Z"/><path d="M10 25H30"/><path d="M20 25V36"/>',
    4: '<path d="M8 7H32V20Q32 31 20 37Q8 31 8 20Z"/><path d="M20 11V30"/>',
    5: '<path d="M20 3L24 16L37 20L24 24L20 37L16 24L3 20L16 16Z"/>',
    6: '<path d="M6 14H31M25 8L32 14L25 20"/><path d="M34 27H9M15 21L8 27L15 33"/>',
    7: '<path d="M20 35L5 14A22 22 0 0 1 35 14Z"/><path d="M20 35V10M20 35L12 11M20 35L28 11"/>',
    8: '<path d="M6 31L8 12L15 21L20 8L25 21L32 12L34 31Z"/><path d="M6 35H34"/>'
  };
  function rankName(r) { return T('courtier.rank.' + r); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function cardEl(rank, tag) {
    var c = el(tag || 'div', 'cr-card');
    c.dataset.rank = rank;
    c.innerHTML = '<span class="cr-num"></span><svg class="cr-emblem" viewBox="0 0 40 40" aria-hidden="true">' + EMBLEM[rank] + '</svg><span class="cr-name"></span>';
    c.firstChild.textContent = Play.num(rank);
    c.lastChild.textContent = rankName(rank);
    return c;
  }
  function backEl(cls) { var b = el('div', 'cr-card cr-backcard' + (cls ? ' ' + cls : '')); b.setAttribute('aria-hidden', 'true'); b.innerHTML = '<span class="cr-z">Z</span>'; return b; }
  // A card already played, small: its number in its colour, its name for a screen reader.
  function miniEl(rank) {
    var m = el('span', 'cr-mini', Play.num(rank)); m.dataset.rank = rank;
    m.setAttribute('role', 'img'); m.setAttribute('aria-label', rankName(rank));
    return m;
  }
  function pipsEl(p) {
    var pips = el('span', 'cr-pips');
    for (var k = 0; k < g.goal; k++) pips.appendChild(el('i', k < p.favors ? 'cr-on' : ''));
    pips.setAttribute('role', 'img'); pips.setAttribute('aria-label', T('courtier.favors', { n: p.favors, goal: g.goal }));
    return pips;
  }

  function seatPlayers(n) {
    seats = root.ZimiSeats.create({ id: 'courtier', seats: n, onChange: function () { paint(); } });
    var cpu = 0;
    g.players.forEach(function (p, i) {
      p.ai = !seats.person(i);
      p.name = seats.person(i) ? seats.name(i) : (n === 2 ? root.ZimiSeats.ZIMI : root.ZimiSeats.cpuName(cpu++));
    });
  }
  function newTable() {
    var kinds = root.ZimiSeats.create({ id: 'courtier', seats: settings.players }).kinds();
    g = createGame(settings.players, undefined, kinds.map(function (k) { return k === 'cpu'; }));
    seatPlayers(settings.players);
    counted = false;
  }
  function nm(i) { return seats.isYou(i) ? T('board.you') : g.players[i].name; }
  function myTurn() { return !g.over && !g.roundEnd && seats.person(g.turn) && (!seats.hotseat() || seats.view() === g.turn); }
  function curRank() { return sel >= 0 ? g.players[g.turn].hand[sel] : 0; }

  function paintSeats() {
    els.seats.textContent = '';
    var pickable = choosing && sel >= 0 ? targets(g, curRank(), g.turn) : [];
    g.players.forEach(function (p, i) {
      var row = el('div', 'cr-seat' + (i === g.turn && !g.roundEnd && !g.over ? ' cr-turn' : '') + (p.out ? ' cr-outseat' : ''));
      row.setAttribute('role', 'listitem');
      var head = el('div', 'cr-seathead');
      head.appendChild(el('b', null, nm(i)));
      head.appendChild(pipsEl(p));
      if (p.out) head.appendChild(el('span', 'cr-tag cr-tag-out', T('courtier.out')));
      else if (p.shield) head.appendChild(el('span', 'cr-tag cr-tag-safe', T('courtier.safe')));
      row.appendChild(head);
      var played = el('div', 'cr-played');
      p.played.forEach(function (r) { played.appendChild(miniEl(r)); });
      if (!p.out) played.appendChild(backEl('cr-miniback'));
      row.appendChild(played);
      row.setAttribute('aria-label', p.out ? T('courtier.seat.out', { name: nm(i) }) : T('courtier.seat.ok', { name: nm(i), n: p.played.length }));
      if (pickable.indexOf(i) >= 0) {
        row.classList.add('cr-pick'); row.setAttribute('role', 'button'); row.tabIndex = 0;
        row.setAttribute('aria-label', T('courtier.chooseSeat', { name: nm(i) }));
        row.addEventListener('click', function () { chooseTarget(i); });
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseTarget(i); } });
      }
      els.seats.appendChild(row);
    });
  }
  function paintDeck() {
    els.deck.textContent = T('courtier.deck', { n: g.deck.length });
    if (g.faceUp.length) {
      var tail = el('span', 'cr-faceup', ' · ' + T('courtier.faceUp') + ' ');
      g.faceUp.forEach(function (r) { tail.appendChild(miniEl(r)); });
      els.deck.appendChild(tail);
    }
  }
  function paintHand() {
    els.hand.textContent = '';
    var V = seats.view(), me = g.players[V], hide = seats.hotseat() && (seats.viewer < 0 || g.turn !== V);
    if (!me || me.out) { els.hand.appendChild(el('p', 'cr-handnote', T('courtier.youOut'))); return; }
    me.hand.forEach(function (r, i) {
      if (hide) { els.hand.appendChild(backEl()); return; }
      var b = cardEl(r, 'button'), live = myTurn();
      b.type = 'button';
      b.setAttribute('aria-pressed', String(live && sel === i));
      b.setAttribute('aria-label', Play.num(r) + ', ' + rankName(r) + '. ' + T('courtier.power.' + r));
      b.setAttribute('aria-disabled', String(!live || !canPlay(g, i)));
      b.addEventListener('click', function () { tapCard(i); });
      els.hand.appendChild(b);
    });
  }
  function paintStatus() {
    if (g.over || g.roundEnd) return;
    if (myTurn()) els.msg.textContent = choosing ? T('courtier.chooseTarget') : sel >= 0 ? T('courtier.power.' + curRank()) : T(seats.isYou(g.turn) ? 'courtier.turn.you' : 'courtier.turn.name', { name: nm(g.turn) });
    else els.msg.textContent = g.players[g.turn].ai ? T('courtier.thinking', { name: nm(g.turn) }) : T('seats.passTo', { name: nm(g.turn) });
  }
  function paint() {
    paintSeats(); paintDeck(); paintHand(); paintStatus();
    els.log.textContent = lastLog;
    var live = myTurn();
    els.play.setAttribute('aria-disabled', String(!live || sel < 0));
    els.play.hidden = !live;
  }

  // A tap that cannot do anything says why for a moment, then the line goes back to what is to do.
  function flash(text, thing) {
    els.msg.textContent = text;
    if (thing) ZimiShell.shake(thing);
    root.clearTimeout(flashTimer);
    flashTimer = root.setTimeout(function () { if (!g.over && !g.roundEnd) paintStatus(); }, FLASH_MS);
  }

  function tapCard(i) {
    if (!myTurn()) { flash(T('courtier.why.wait'), els.hand); return; }
    if (!canPlay(g, i)) { flash(T('courtier.why.dowager'), els.hand.children[i]); return; }
    if (sel === i && !choosing) { confirmPlay(); return; }
    sel = i; choosing = false; paint();
  }
  function confirmPlay() {
    if (!myTurn()) return;
    if (sel < 0) { flash(T('courtier.why.pick'), els.hand); return; }
    var rank = curRank(), legal = targets(g, rank, g.turn);
    if (needsTarget(rank) && legal.length > 1) { choosing = true; paint(); return; }
    chooseTarget(needsTarget(rank) && legal.length ? legal[0] : -1);
  }
  function chooseTarget(t) {
    if (curRank() === SCOUT && t >= 0) { openGuess(t); return; }
    doPlay(t, 0);
  }
  function openGuess(t) {
    els.guessText.textContent = T('courtier.guess.text', { name: nm(t) });
    els.ranks.textContent = '';
    for (var r = 2; r <= HEIR; r++) {
      var b = cardEl(r, 'button');
      b.type = 'button'; b.classList.add('cr-smallcard');
      b.setAttribute('aria-label', Play.num(r) + ', ' + rankName(r));
      (function (rank) { b.addEventListener('click', function () { Play.closeSheet(els.guess); doPlay(t, rank); }); })(r);
      els.ranks.appendChild(b);
    }
    Play.openSheet(els.guess, '.cr-card');
  }
  els.guessCancel.addEventListener('click', function () { Play.closeSheet(els.guess); });

  // The play goes to the rules; the table, the line and (for a peek) the sheet follow.
  function doPlay(t, guess) {
    var ev = play(g, sel, t, guess), mine = seats.person(ev ? ev.by : g.turn);
    if (!ev) return false;
    sel = -1; choosing = false;
    lastLog = evText(ev);
    if (ev.peek && mine) return showPeek(ev);
    afterPlay();
    return true;
  }
  function evText(ev) {
    var by = nm(ev.by), parts = [];
    parts.push(T(ev.target >= 0 ? 'courtier.ev.on' : 'courtier.ev.play', { name: by, card: rankName(ev.rank), target: ev.target >= 0 ? nm(ev.target) : '' }));
    if (ev.guess) parts.push(T('courtier.ev.named', { card: rankName(ev.guess) }));
    if (ev.rank === SCOUT && ev.target >= 0 && !ev.out.length) parts.push(T('courtier.res.wrong'));
    if (ev.redraw) parts.push(T('courtier.res.discard', { name: nm(ev.target), card: rankName(ev.discard) }));
    ev.out.forEach(function (i) { parts.push(T('courtier.res.out', { name: nm(i) })); });
    if (ev.tie) parts.push(T('courtier.res.tie'));
    if (ev.rank === SENTINEL) parts.push(T('courtier.res.safe', { name: by }));
    if (ev.swapped) parts.push(T('courtier.res.swap'));
    if (needsTarget(ev.rank) && ev.target < 0) parts.push(T('courtier.res.nobody'));
    return parts.join(' ');
  }
  function showPeek(ev) {
    els.peekText.textContent = T('courtier.peek.text', { name: nm(ev.target) });
    els.peekCard.textContent = '';
    els.peekCard.appendChild(cardEl(ev.peek));
    paint();
    Play.openSheet(els.peek, '#cr-peek-ok');
    return true;
  }
  els.peekOk.addEventListener('click', function () { Play.closeSheet(els.peek); afterPlay(); });

  function afterPlay() {
    paint();
    if (timer) timer.cancel();
    if (g.roundEnd) { timer = Play.later(showRound, AI_DELAY_MS / 2); return; }
    schedule();
  }
  function schedule() {
    if (timer) timer.cancel();
    if (g.over || g.roundEnd) return;
    if (g.players[g.turn].ai) { timer = Play.later(aiStep, AI_DELAY_MS); return; }
    if (seats.hotseat()) seats.ensure(g.turn, paint, T('courtier.passNote')); else paint();
  }
  function aiStep() {
    if (g.over || g.roundEnd || !g.players[g.turn].ai) return;
    var m = aiMove(g), ev = play(g, m.idx, m.target, m.guess);
    if (!ev) return;
    lastLog = evText(ev);
    afterPlay();
  }

  function showRound() {
    var re = g.roundEnd;
    if (!re) return;
    var names = re.winners.map(nm).join(', ');
    els.roundTitle.textContent = re.winners.length > 1 ? T('courtier.round.tie', { names: names }) : seats.isYou(re.winners[0]) ? T('courtier.round.you') : T('courtier.round.wins', { name: names });
    els.roundText.textContent = T(re.why === 'last' ? 'courtier.round.last' : 'courtier.round.deck');
    els.reveal.textContent = '';
    g.players.forEach(function (p, i) {
      var row = el('div', 'cr-revrow' + (re.winners.indexOf(i) >= 0 ? ' cr-won' : ''));
      row.appendChild(el('b', null, nm(i)));
      row.appendChild(re.hands[i].length ? miniEl(re.hands[i][0]) : el('span', 'cr-tag cr-tag-out', T('courtier.out')));
      row.appendChild(pipsEl(p));
      els.reveal.appendChild(row);
    });
    els.roundNext.textContent = T(g.over ? 'courtier.result' : 'courtier.nextRound');
    Play.openSheet(els.round, '#cr-round-next');
  }
  els.roundNext.addEventListener('click', function () {
    Play.closeSheet(els.round);
    if (g.over) return finish(counted);
    nextRound(g); sel = -1; choosing = false; lastLog = '';
    paint(); seats.begin(function () { paint(); schedule(); }, g.turn);
  });

  function finish(already) {
    var text, title, won;
    if (seats.hotseat()) { won = true; text = T('courtier.end.hot', { name: nm(g.winner) }); title = T('shell.end.wins', { name: nm(g.winner) }); }
    else {
      won = seats.person(g.winner);
      if (!already) { stats.played++; if (won) stats.won++; Play.save(STATS_KEY, stats); counted = true; }
      text = T(won ? 'courtier.end.win' : 'courtier.end.wins', { name: g.players[g.winner].name }) + ' ' + T('courtier.end.record', { won: stats.won, played: stats.played });
      title = T(won ? 'shell.end.win' : 'shell.end.lose');
    }
    els.msg.textContent = text;
    ZimiShell.endSheet({ title: title, result: won ? 'win' : 'lose', text: text, onNew: begin, after: already ? 0 : undefined });
  }

  els.play.addEventListener('click', function () { if (myTurn()) confirmPlay(); });
  els.guide.addEventListener('click', function () {
    els.list.textContent = '';
    for (var r = 1; r <= HEIR; r++) {
      var li = el('li', 'cr-guideitem'), box = el('div');
      li.appendChild(miniEl(r));
      box.appendChild(el('b', null, rankName(r) + ' ×' + Play.num(COUNTS[r])));
      box.appendChild(el('span', null, T('courtier.power.' + r)));
      li.appendChild(box); els.list.appendChild(li);
    }
    Play.openSheet(els.cards, '#cr-cards-close');
  });
  els.cardsClose.addEventListener('click', function () { Play.closeSheet(els.cards); });

  function paintN() {
    els.n.textContent = '';
    for (var n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
      var b = el('button', null, Play.num(n));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(settings.players === n));
      (function (k) { b.addEventListener('click', function () { settings.players = k; Play.save(SETTINGS_KEY, settings); paintN(); }); })(n);
      els.n.appendChild(b);
    }
    var host = $('cr-seatsblock');
    host.textContent = '';
    host.appendChild(root.ZimiSeats.create({ id: 'courtier', seats: settings.players }).block());
  }
  function showSheet() { paintN(); Play.openSheet(els.sheet, '#cr-go'); }
  function begin() {
    if (timer) timer.cancel();
    newTable(); sel = -1; choosing = false; lastLog = '';
    Play.closeSheet(els.sheet); paint(); seats.begin(function () { paint(); schedule(); }, g.turn);
  }
  els.go.addEventListener('click', begin);
  els.nu.addEventListener('click', function () { if (timer) timer.cancel(); showSheet(); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !els.sheet.hidden || !els.round.hidden || !els.guess.hidden || !els.peek.hidden || !myTurn()) return;
    if (e.key === '1' || e.key === '2') { var i = +e.key - 1; if (i < g.players[g.turn].hand.length) { e.preventDefault(); tapCard(i); } }
    else if (e.key === 'Escape' && choosing) { choosing = false; paint(); }
  });

  function started() { return g.round > 1 || g.players.some(function (p) { return p.played.length > 0; }); }
  newTable(); paint();
  ZimiShell.game({
    table: '#cr-table',
    inProgress: function () { return !g.over && started(); },
    stats: function () { return stats.played ? [[T('cards.stats.played'), Play.num(stats.played)], [T('cards.stats.won'), Play.num(stats.won)]] : []; }
  });
  showSheet();
  // Never lose a game: the table (every card, who is out, the favors, where the generator stood) and whether the game was counted.
  ZimiShell.persist({
    save: function () { return started() ? { g: Engine.snapshot(g), counted: counted, log: lastLog } : null; },
    load: function (data) {
      var saved = data && data.g;
      if (!saved || !Array.isArray(saved.players) || saved.players.length < MIN_PLAYERS || !saved.deck) return false;
      g = Engine.restore(saved);
      seatPlayers(g.players.length);
      counted = !!data.counted; lastLog = typeof data.log === 'string' ? data.log : '';
      sel = -1; choosing = false;
      Play.closeSheet(els.sheet);
      paint();
      if (g.roundEnd) { showRound(); return true; }
      seats.begin(function () { paint(); schedule(); }, g.turn);
      return true;
    }
  });
  root.__courtier = { get g() { return g; }, refresh: paint };
})(this);
