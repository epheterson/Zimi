/* ZimiGames: Belote, the French partnership trick game. You and North
   against West and East, with the 32-card piquet deck (7 to ace) from the
   Zimi French deck. Five cards each and one turned up. Starting left of the
   dealer each player may take the turned-up card's suit as trump (and picks
   the card up); if all pass, each may name a different suit; if all pass
   again the hand is dealt again. Everyone then has eight cards. Trump ranks
   jack (20), nine (14), ace (11), ten (10), king (4), queen (3), eight, seven;
   other suits ace (11), ten (10), king (4), queen (3), jack (2), nine, eight,
   seven. You must follow suit; if you cannot, you must trump unless your
   partner is winning the trick; a trump must beat the best trump already in
   the trick if you can. The king and queen of trump held together are
   belote and rebelote, 20 points. The last trick is worth 10 (dix de der).
   The takers need 82 of the 162 points (belote counted); if they fall short
   the other side scores all 162 and the takers keep only a belote. Winning
   all eight tricks (capot) is worth 252. First to the target score wins.

   State: hands[4], upcard, deck (cards not yet dealt), dealer, phase ('bid1' |
   'bid2' | 'play' | 'handEnd' | 'over' | 'redeal'), turn, passes, trump,
   taker, trick [{seat, id}], leader, won[4] (cards each seat's side has taken,
   as ids), tricksWon[2], belote {seat, shown}, scores[2], target, handNo,
   result, played, moves. Seats clockwise: 0 you, 1 west, 2 north, 3 east; 0 and
   2 are a team. Pure functions; the page wiring at the bottom only runs in a
   browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, TX = Z.T;

  var SEATS = 4, FIRST_DEAL = 5, HAND = 8, NAMES = [TX('cards.you'), TX('cards.seat.west'), TX('cards.seat.north'), TX('cards.seat.east')], TEAMS = [TX('cards.team.us'), TX('cards.team.them')];
  var GLYPH = T.SUIT_GLYPH, SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'];
  var RANKS = [7, 8, 9, 10, 11, 12, 13, 1];
  var team = function (seat) { return seat % 2; }, partnerOf = function (seat) { return (seat + 2) % SEATS; };
  var DIX_DE_DER = 10, BELOTE = 20, MAKE_AT = 82, HAND_TOTAL = 162, CAPOT_TOTAL = 252;
  // Card points and strength: [rank] -> value. Trump: J 20, 9 14. Plain: J 2, 9 0.
  var VALUE_PLAIN = { 1: 11, 10: 10, 13: 4, 12: 3, 11: 2, 9: 0, 8: 0, 7: 0 }, VALUE_TRUMP = { 11: 20, 9: 14, 1: 11, 10: 10, 13: 4, 12: 3, 8: 0, 7: 0 };
  var ORDER_PLAIN = [7, 8, 9, 11, 12, 13, 10, 1], ORDER_TRUMP = [7, 8, 12, 13, 10, 1, 9, 11];
  var DECK = (function () { var o = []; [0, 1, 2, 3].forEach(function (s) { RANKS.forEach(function (r) { o.push(Z.make(r, s)); }); }); return o; })();
  var rankOf = Z.rank, suitOf = Z.suit;
  var isTrump = function (id, trump) { return trump !== null && trump !== undefined && suitOf(id) === trump; };
  var points = function (id, trump) { return (isTrump(id, trump) ? VALUE_TRUMP : VALUE_PLAIN)[rankOf(id)]; };
  // Strength within a suit; trumps beat everything.
  var power = function (id, trump) { return isTrump(id, trump) ? 100 + ORDER_TRUMP.indexOf(rankOf(id)) : ORDER_PLAIN.indexOf(rankOf(id)); };
  var cardName = function (id) { return Z.cardName(id); };
  var SUIT_ORDER = [0, 1, 3, 2]; // clubs, diamonds, spades, hearts: alternating colours
  // Hand order: trump first, then the other suits, strongest first within a suit.
  function arrange(ids, trump) {
    var key = function (c) { return (isTrump(c, trump) ? 0 : 1 + SUIT_ORDER.indexOf(suitOf(c))) * 1000 - (power(c, trump) % 100); };
    return ids.slice().sort(function (a, b) { return key(a) - key(b); });
  }

  // ── Rules ───────────────────────────────────────────────────────────────
  function dealHand(order, handNo, scores, dealer, target) {
    var cards = order.filter(function (c) { return DECK.indexOf(c) >= 0; }), hands = [], s;
    for (s = 0; s < SEATS; s++) hands.push(arrange(cards.slice(s * FIRST_DEAL, (s + 1) * FIRST_DEAL), null));
    return {
      hands: hands, upcard: cards[SEATS * FIRST_DEAL], deck: cards.slice(SEATS * FIRST_DEAL + 1), dealer: dealer, phase: 'bid1', turn: (dealer + 1) % SEATS, passes: 0, trump: null, taker: -1,
      trick: [], leader: 0, won: [[], [], [], []], tricksWon: [0, 0], belote: { seat: -1, shown: 0 }, scores: scores.slice(), target: target, handNo: handNo, result: null, played: [], moves: 0
    };
  }
  function newGame(order, dealer, target) { return dealHand(order, 0, [0, 0], dealer === undefined ? 3 : dealer, target || 501); }
  function nextHand(st, order) { return dealHand(order, st.handNo + 1, st.scores, (st.dealer + 1) % SEATS, st.target); }

  // The taker has the upcard, and everyone is dealt up to eight.
  function startPlay(s, seat, suit) {
    var i = 0;
    s.trump = suit; s.taker = seat;
    for (var k = 0; k < SEATS; k++) {
      var p = (s.dealer + 1 + k) % SEATS, n = p === seat ? 2 : 3;
      s.hands[p] = s.hands[p].concat(s.deck.slice(i, i + n)); i += n;
    }
    s.hands[seat].push(s.upcard);
    s.deck = [];
    s.hands = s.hands.map(function (h) { return arrange(h, suit); });
    var holder = -1;
    s.hands.forEach(function (h, p) { var K = Z.make(13, suit), Q = Z.make(12, suit); if (h.indexOf(K) >= 0 && h.indexOf(Q) >= 0) holder = p; });
    s.belote = { seat: holder, shown: 0 };
    s.phase = 'play'; s.leader = s.turn = (s.dealer + 1) % SEATS;
  }
  function take(st, seat, suit) {
    var s = Z.clone(st);
    if (s.phase === 'bid1') suit = suitOf(s.upcard); else if (s.phase !== 'bid2' || suit === suitOf(s.upcard)) return st;
    if (s.turn !== seat) return st;
    s.moves++;
    startPlay(s, seat, suit);
    return s;
  }
  function pass(st, seat) {
    var s = Z.clone(st);
    if ((s.phase !== 'bid1' && s.phase !== 'bid2') || s.turn !== seat) return st;
    s.moves++; s.passes++;
    if (s.passes === SEATS) {
      if (s.phase === 'bid1') { s.phase = 'bid2'; s.passes = 0; s.turn = (s.dealer + 1) % SEATS; } else s.phase = 'redeal';
    } else s.turn = (s.turn + 1) % SEATS;
    return s;
  }

  var trumpsIn = function (cards, trump) { return cards.filter(function (c) { return isTrump(c, trump); }); };
  function currentWinner(trick, trump) {
    var lead = suitOf(trick[0].id), best = trick[0];
    trick.forEach(function (t) { if (beats(t.id, best.id, lead, trump)) best = t; });
    return best;
  }
  function beats(a, b, lead, trump) {
    var ta = isTrump(a, trump), tb = isTrump(b, trump);
    if (ta !== tb) return ta;
    if (suitOf(a) === suitOf(b)) return power(a, trump) > power(b, trump);
    return suitOf(a) === lead && suitOf(b) !== lead;
  }
  // What `seat` may play: follow suit; else trump unless the partner is winning; a trump must beat the best one played if it can.
  function legalPlays(st, seat) {
    var hand = st.hands[seat], trick = st.trick, trump = st.trump;
    if (!trick.length) return hand.slice();
    var lead = suitOf(trick[0].id), follow = hand.filter(function (c) { return suitOf(c) === lead; });
    var out = trumpsIn(trick.map(function (t) { return t.id; }), trump).map(function (c) { return power(c, trump); });
    var top = out.length ? Math.max.apply(null, out) : -1;
    var above = function (cards) { var up = cards.filter(function (c) { return power(c, trump) > top; }); return up.length ? up : cards; };
    if (lead === trump) return follow.length ? above(follow) : hand.slice();
    if (follow.length) return follow;
    if (currentWinner(trick, trump).seat === partnerOf(seat)) return hand.slice();
    var mine = trumpsIn(hand, trump);
    return mine.length ? above(mine) : hand.slice();
  }
  function whyNot(st, seat) {
    var lead = suitOf(st.trick[0].id);
    return st.hands[seat || 0].some(function (c) { return suitOf(c) === lead; }) ? TX(lead === st.trump ? 'belote.followHigher' : 'cards.follow', { suit: TX('cards.suit.' + SUIT_NAMES[lead]) }) : TX('belote.mustTrump');
  }
  function isLegal(st, seat, id) { return st.phase === 'play' && st.trick.length < SEATS && st.turn === seat && legalPlays(st, seat).indexOf(id) >= 0; }

  // Playing the king or queen of trump from a belote hand: announced ('belote', then 'rebelote').
  function announcement(st, seat, id) {
    if (st.belote.seat !== seat || !isTrump(id, st.trump) || (rankOf(id) !== 13 && rankOf(id) !== 12)) return '';
    return st.belote.shown === 0 ? TX('belote.belote') : st.belote.shown === 1 ? TX('belote.rebelote') : '';
  }
  function playCard(st, seat, id) {
    var s = Z.clone(st), say = announcement(s, seat, id);
    s.hands[seat].splice(s.hands[seat].indexOf(id), 1);
    if (say) s.belote.shown++;
    s.trick.push({ seat: seat, id: id }); s.moves++;
    if (s.trick.length < SEATS) s.turn = (seat + 1) % SEATS;
    return s;
  }
  var cardPoints = function (ids, trump) { return ids.reduce(function (n, c) { return n + points(c, trump); }, 0); };
  // The takers' and the others' totals for a hand: { pts, belote, capot, made }.
  function scoreHand(st) {
    var tk = team(st.taker), pts = [0, 0], teamCards = [[], []];
    st.won.forEach(function (w, seat) { teamCards[team(seat)] = teamCards[team(seat)].concat(w); });
    pts[0] = cardPoints(teamCards[0], st.trump); pts[1] = cardPoints(teamCards[1], st.trump);
    pts[st.lastWinner >= 0 ? team(st.lastWinner) : 0] += DIX_DE_DER;
    var capot = st.tricksWon[0] === HAND ? 0 : st.tricksWon[1] === HAND ? 1 : -1;
    var bel = st.belote.seat >= 0 && st.belote.shown >= 2 ? team(st.belote.seat) : -1;
    var totals = pts.slice();
    if (bel >= 0) totals[bel] += BELOTE;
    var made = totals[tk] >= MAKE_AT, add = [0, 0];
    if (capot >= 0) { add[capot] = CAPOT_TOTAL; }
    else if (made) { add[0] = pts[0]; add[1] = pts[1]; }
    else add[1 - tk] = HAND_TOTAL;
    if (bel >= 0) add[bel] += BELOTE;
    return { takerTeam: tk, pts: pts, totals: totals, belote: bel, capot: capot, made: made && (capot < 0 || capot === tk), add: add };
  }
  function resolveTrick(st) {
    var s = Z.clone(st), w = currentWinner(s.trick, s.trump);
    s.won[w.seat] = s.won[w.seat].concat(s.trick.map(function (t) { return t.id; }));
    s.tricksWon[team(w.seat)]++;
    s.played = s.played.concat(s.trick.map(function (t) { return t.id; }));
    s.trick = []; s.leader = s.turn = w.seat; s.lastWinner = w.seat;
    if (!s.hands[0].length) {
      var r = scoreHand(s);
      s.result = r; s.scores = [s.scores[0] + r.add[0], s.scores[1] + r.add[1]];
      s.phase = s.scores[0] >= s.target || s.scores[1] >= s.target ? 'over' : 'handEnd';
    }
    return s;
  }
  function gameWinner(scores, target) {
    if (scores[0] < target && scores[1] < target) return -1;
    return scores[0] === scores[1] ? -1 : scores[0] > scores[1] ? 0 : 1;
  }

  // ── The computer players ────────────────────────────────────────────────
  // How good a hand is with `trump` as trump (the taker's extra cards included).
  var TAKE_FIRST = 44, TAKE_SECOND = 40;
  function strength(hand, trump) {
    var tr = trumpsIn(hand, trump), s = cardPoints(tr, trump);
    s += Math.max(0, tr.length - 2) * 6;
    hand.forEach(function (c) { if (!isTrump(c, trump) && rankOf(c) === 1) s += 7; });
    if (tr.some(function (c) { return rankOf(c) === 13; }) && tr.some(function (c) { return rankOf(c) === 12; })) s += 8;
    return s;
  }
  function aiBid(st, seat) {
    var hand = st.hands[seat];
    if (st.phase === 'bid1') {
      var suit = suitOf(st.upcard), h = hand.concat([st.upcard]), bonus = seat === partnerOf(st.dealer) ? 0 : 0;
      return strength(h, suit) + bonus >= TAKE_FIRST ? { take: true, suit: suit } : { take: false };
    }
    var best = null, bs = -1;
    [0, 1, 2, 3].forEach(function (s2) { if (s2 === suitOf(st.upcard)) return; var v = strength(hand, s2); if (v > bs) { bs = v; best = s2; } });
    return bs >= TAKE_SECOND ? { take: true, suit: best } : { take: false };
  }
  function aiPick(st, seat) {
    var legal = legalPlays(st, seat), trump = st.trump;
    if (legal.length === 1) return legal[0];
    var pw = function (c) { return power(c, trump); }, val = function (c) { return points(c, trump); };
    var low = T.minBy(legal, function (c) { return val(c) * 10 + pw(c) % 100; });
    var tk = team(st.taker) === team(seat);
    // Belote: play king then queen of trump when they are the ones to play.
    if (!st.trick.length) {
      var topTrump = legal.filter(function (c) { return isTrump(c, trump) && (rankOf(c) === 11 || rankOf(c) === 9); });
      if (tk && topTrump.length) return T.maxBy(topTrump, pw);
      var aces = legal.filter(function (c) { return !isTrump(c, trump) && rankOf(c) === 1; });
      if (aces.length) return aces[0];
      var plain = legal.filter(function (c) { return !isTrump(c, trump); });
      return plain.length ? T.minBy(plain, function (c) { return val(c) * 10 + pw(c); }) : T.minBy(legal, pw);
    }
    var lead = suitOf(st.trick[0].id), win = currentWinner(st.trick, trump), last = st.trick.length === SEATS - 1;
    var winners = legal.filter(function (c) { return beats(c, win.id, lead, trump); }), cheapest = winners.length ? T.minBy(winners, pw) : null;
    if (win.seat === partnerOf(seat) && (last || power(win.id, trump) >= 100 + ORDER_TRUMP.indexOf(9) || (rankOf(win.id) === 1 && !isTrump(win.id, trump)))) return T.maxBy(legal, function (c) { return val(c) * 1000 - pw(c); });
    if (cheapest !== null) return cheapest;
    return low;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  function geo(m, st) { return T.geometry(m, T.rowsFor(m, st.hands[0].length)); }
  function place(st, m, view) {
    var g = geo(m, st), slots = T.feltSlots(g), cards = [], full = st.trick.length === SEATS, sweep = view && full ? view.sweep : null;
    var L = T.looking(view), V = L.V, up = L.up, rel = function (seat) { return (seat - V + SEATS) % SEATS; };
    var myTurn = st.phase === 'play' && st.turn === V && !full;
    var hand = T.handCards(g, st.hands[V], function (id) { return { up: up, dim: up && myTurn && !isLegal(st, V, id), label: cardName(id) }; }, function (a, b) { return suitOf(a) !== suitOf(b); });
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    [1, 2, 3].forEach(function (pos) { cards = cards.concat(T.fan(g, pos, st.hands[(V + pos) % SEATS], false)); });
    if (st.phase === 'bid1' || st.phase === 'bid2') cards.push({ id: st.upcard, pile: 'up', idx: 0, x: Math.round(g.cx - g.cw / 2), y: Math.round(g.cy - g.ch / 2), up: st.phase === 'bid1' });
    return { height: m.H, slots: slots, cards: cards.concat(T.trickCards(g, st.trick, sweep, rel, view && view.win)) };
  }

  var api = {
    NAMES: NAMES, DECK: DECK, points: points, power: power, isTrump: isTrump, arrange: arrange, dealHand: dealHand, newGame: newGame, nextHand: nextHand, take: take, pass: pass,
    legalPlays: legalPlays, isLegal: isLegal, whyNot: whyNot, playCard: playCard, announcement: announcement, currentWinner: currentWinner, resolveTrick: resolveTrick, scoreHand: scoreHand,
    gameWinner: gameWinner, strength: strength, aiBid: aiBid, aiPick: aiPick, geo: geo, place: place
  };
  root.ZimiBelote = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 620, HOLD_MS = 1000, SWEEP_MS = 380, TARGET_KEY = 'belote.target', TARGETS = [301, 501];
  function boot() {
    var t, board, session, view = { sweep: null, flash: '', note: '' }, tg, seats, who, mine, viewTeam, teamLabel;
    var suitWord = function (s) { return TX('cards.suit.' + SUIT_NAMES[s]); };
    function handLines(st) {
      var r = st.result, tk = teamLabel(r.takerTeam), lines = [];
      lines.push(TX(r.made ? 'belote.line.made' : 'belote.line.short', { team: tk, suit: suitWord(st.trump), got: r.totals[r.takerTeam], of: HAND_TOTAL, belote: r.belote === r.takerTeam ? TX('belote.withBelote') : '', need: MAKE_AT }));
      if (r.capot >= 0) lines.push(TX('belote.line.capot', { team: teamLabel(r.capot), points: CAPOT_TOTAL }));
      else if (!r.made) lines.push(TX(r.belote >= 0 ? 'belote.line.scoreKeep' : 'belote.line.score', { team: teamLabel(1 - r.takerTeam), points: HAND_TOTAL, keeper: r.belote >= 0 ? teamLabel(r.belote) : '' }));
      var vt = viewTeam(); lines.push(TX('belote.line.hand', { a: r.add[vt], b: r.add[1 - vt], sa: st.scores[vt], sb: st.scores[1 - vt] }));
      return lines;
    }
    function hud(st) {
      var full = st.trick.length === SEATS, bidding = st.phase === 'bid1' || st.phase === 'bid2';
      var chips = tg.order().map(function (seat) {
        var name = seats.name(seat), text = st.phase === 'play' || st.phase === 'handEnd' ? String(st.won[seat].length / 4) : '';
        if (st.taker === seat) text += ' ★';
        return { name: name, text: text, dealer: seat === st.dealer, turn: st.turn === seat && !full && (bidding || st.phase === 'play') };
      });
      var out = { chips: chips, text: '', trump: st.trump, fact: TX('belote.fact', { target: st.target }) };
      if (bidding) {
        var up = suitOf(st.upcard);
        out.text = (view.note ? view.note + ' ' : '') + (mine(st.turn) ? (seats.hotseat() ? who(st.turn) + ': ' : '') + TX(st.phase === 'bid1' ? 'belote.take' : 'belote.name', { suit: suitWord(up) }) : seats.person(st.turn) ? TX('euchre.deciding', { name: who(st.turn) }) : TX('cards.thinking', { name: who(st.turn) }));
        if (mine(st.turn)) {
          if (st.phase === 'bid1') out.choices = [{ label: TX('belote.takeBtn', { glyph: GLYPH[up] }), aria: TX('belote.takeAria', { suit: suitWord(up) }), cls: up === 1 || up === 2 ? 'ct-red' : '', onclick: function () { takeNow(up); } }, { label: TX('cards.pass'), onclick: passNow }];
          else out.choices = [0, 1, 2, 3].filter(function (s) { return s !== up; }).map(function (s) { return { label: GLYPH[s], aria: suitWord(s), cls: s === 1 || s === 2 ? 'ct-red' : '', onclick: function () { takeNow(s); } }; }).concat([{ label: TX('cards.pass'), onclick: passNow }]);
        }
      } else if (st.phase === 'handEnd') { out.text = TX('cards.handEnd'); out.label = TX('cards.nextHand'); out.action = tg.startNextHand; }
      else if (st.phase === 'over') out.text = TX('shell.end.over');
      else if (st.phase === 'redeal') out.text = TX('belote.redeal');
      else if (full) out.text = tg.trickText(currentWinner(st.trick, st.trump).seat);
      else out.text = (view.note ? view.note + ' ' : '') + tg.turnText(st.turn);
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'redeal') { session.later(function () { view.note = ''; session.follow(nextHand(st, Z.shuffled(Math.random))); tg.deal(); }, 1100); return; }
      if (st.phase === 'bid1' || st.phase === 'bid2') { if (seats.person(st.turn)) seats.ensure(st.turn, tg.repaint); else session.later(aiBidTurn, AI_MS); return; }
      tg.turn(st);
    }
    function aiBidTurn() {
      var st = session.state, seat = st.turn;
      if ((st.phase !== 'bid1' && st.phase !== 'bid2') || seats.person(seat)) return;
      var b = aiBid(st, seat);
      if (!b.take) { view.note = TX('euchre.passed', { name: who(seat) }); session.follow(pass(st, seat)); drive(); return; }
      var ns = take(st, seat, b.suit);
      view.note = TX('belote.tookSuit', { name: who(seat), suit: TX('cards.suit.' + SUIT_NAMES[ns.trump]) }) + '.'; session.follow(ns); t.flash(TX('belote.takesSuit', { name: who(seat), suit: TX('cards.suit.' + SUIT_NAMES[ns.trump]) })); drive();
    }
    // A meld or the belote declared as its card is played.
    function say(st, seat, id) { var a = announcement(st, seat, id); if (a) t.flash(who(seat) + ': ' + a); }
    function handOver() { tg.handSheet(handLines(session.state)); }
    function gameOver() { var st = session.state; tg.teamGameOver(gameWinner(st.scores, st.target), st.scores, handLines(st)); }
    function takeNow(suit) { var st = session.state; if ((st.phase !== 'bid1' && st.phase !== 'bid2') || !mine(st.turn)) return; view.note = ''; session.commit(take(st, st.turn, suit)); drive(); }
    function passNow() { var st = session.state; if ((st.phase !== 'bid1' && st.phase !== 'bid2') || !mine(st.turn)) return; view.note = ''; session.commit(pass(st, st.turn)); drive(); }
    function newGameNow() {
      var target = Z.store.get(TARGET_KEY, 501);
      tg.restart(newGame(Z.shuffled(Math.random), Math.floor(Math.random() * SEATS), TARGETS.indexOf(target) >= 0 ? target : 501));
    }

    tg = T.trickGame({
      id: 'belote', n: SEATS, view: view, ms: { ai: AI_MS, hold: HOLD_MS, sweep: SWEEP_MS }, drive: drive, handEnd: 'handEnd',
      winner: function (st) { return currentWinner(st.trick, st.trump).seat; }, resolve: resolveTrick, nextHand: nextHand, handOver: handOver, gameOver: gameOver,
      legal: isLegal, why: function (st) { return whyNot(st, st.turn); }, play: playCard, aiPlay: aiPick, clear: function () { view.note = ''; },
      before: say, after: function (human) { if (human) view.note = ''; }
    });
    seats = tg.seats; mine = tg.mine; viewTeam = tg.viewTeam; teamLabel = tg.teamLabel; who = seats.name;
    t = tg.create({
      name: 'Belote', geo: geo, place: place, hud: hud, newGame: newGameNow, heightShare: 0.13,
      cascadeOrder: function (st) { return st.played.slice(0, 24).map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return handLines(st).concat([TX('cards.result.you', { a: st.scores[viewTeam()], b: st.scores[1 - viewTeam()] })]); },
      menuExtra: function () { return [T.choiceRow(TX('belote.playTo'), TARGET_KEY, TARGETS.map(function (n) { return { value: n, label: String(n) }; }), 501, function () {}), Z.h('p', { class: 'zc-note', text: TX('belote.targetNote') })]; },
      rules: TX('belote.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    newGameNow();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
