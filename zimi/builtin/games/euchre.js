/* ZimiGames: Euchre. You (south) and North against West and East, with a
   24-card deck (9 to ace). Five cards each and one turned up. Starting left
   of the dealer each player may order the turned-up card's suit as trump (the
   dealer picks it up and discards); if all pass, each may name a different
   suit, and the dealer must (stick the dealer). The jack of trump is the
   right bower, the other jack of the same colour the left bower: it counts
   as trump, not its printed suit. A caller may go alone: the partner sits
   out. Makers who take 3 or 4 tricks score 1, all 5 score 2 (4 alone);
   makers who take fewer are euchred and the other team scores 2. First to
   10 wins.

   State: hands[4], upcard, dealer, phase ('order1' | 'order2' | 'discard' |
   'play' | 'handEnd' | 'over'), turn, passes, trump (null until called),
   maker, alone, sitting (seat sitting out, or -1), turnedDown, trick
   [{seat, id}], leader, tricks[4], played (ids of finished tricks), scores[2],
   handNo, result. Seats clockwise: 0 you, 1 west, 2 north, 3 east; 0 and 2 are
   a team. Pure functions; the page wiring at the bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, TX = Z.T;

  var SEATS = 4, HAND = 5, NAMES = [TX('cards.you'), TX('cards.seat.west'), TX('cards.seat.north'), TX('cards.seat.east')], TEAMS = [TX('cards.team.us'), TX('cards.team.them')], END_SCORE = 10;
  var RANKS = [9, 10, 11, 12, 13, 1]; // 9 10 J Q K A
  var LEFT_OF = [3, 2, 1, 0]; // the suit of the same colour: clubs-spades, diamonds-hearts
  var GLYPH = T.SUIT_GLYPH, SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'];
  var team = function (seat) { return seat % 2; }, partnerOf = function (seat) { return (seat + 2) % SEATS; };
  var JACK = 11, RIGHT_POWER = 100, LEFT_POWER = 99, TRUMP_POWER = 50;
  var ORDER_BASE = 5.5, CALL_BASE = 5.0, ALONE_BASE = 8.6;

  // ── Cards ───────────────────────────────────────────────────────────────
  function deck() {
    var out = [];
    [0, 1, 2, 3].forEach(function (s) { RANKS.forEach(function (r) { out.push(Z.make(r, s)); }); });
    return out;
  }
  var DECK = deck();
  var face = function (id) { return Z.rank(id) === 1 ? 14 : Z.rank(id); };
  // The suit a card counts as: the left bower belongs to trump.
  function effSuit(id, trump) {
    return trump !== null && trump !== undefined && face(id) === JACK && Z.suit(id) === LEFT_OF[trump] ? trump : Z.suit(id);
  }
  function power(id, trump) {
    if (trump === null || trump === undefined) return face(id);
    if (face(id) === JACK && Z.suit(id) === trump) return RIGHT_POWER;
    if (face(id) === JACK && Z.suit(id) === LEFT_OF[trump]) return LEFT_POWER;
    return (Z.suit(id) === trump ? TRUMP_POWER : 0) + face(id);
  }
  // Hand order: effective suits grouped, strongest first within one.
  function arrange(ids, trump) {
    return ids.slice().sort(function (a, b) {
      var sa = effSuit(a, trump), sb = effSuit(b, trump);
      if (trump !== null && trump !== undefined && (sa === trump) !== (sb === trump)) return sa === trump ? -1 : 1;
      return sa - sb || power(b, trump) - power(a, trump);
    });
  }

  // ── Rules ───────────────────────────────────────────────────────────────
  function dealHand(order, handNo, scores, dealer) {
    // `order` is a shuffled 52-card list: keep its order for the 24 we use.
    var hands = [], s, cards = order.filter(function (c) { return DECK.indexOf(c) >= 0; });
    for (s = 0; s < SEATS; s++) hands.push(arrange(cards.slice(s * HAND, (s + 1) * HAND), null));
    return {
      hands: hands, upcard: cards[SEATS * HAND], dealer: dealer, phase: 'order1', turn: (dealer + 1) % SEATS, passes: 0, trump: null,
      maker: -1, alone: false, sitting: -1, turnedDown: null, trick: [], leader: 0, tricks: [0, 0, 0, 0], played: [], scores: scores.slice(),
      handNo: handNo, result: null, moves: 0
    };
  }
  function freshGame(order, dealer) { return dealHand(order, 0, [0, 0], dealer === undefined ? 3 : dealer); }
  function nextHand(st, order) { return dealHand(order, st.handNo + 1, st.scores, (st.dealer + 1) % SEATS); }

  function nextSeat(st, seat) { var s = (seat + 1) % SEATS; return s === st.sitting ? (s + 1) % SEATS : s; }
  var trickSize = function (st) { return st.sitting >= 0 ? SEATS - 1 : SEATS; };

  function startPlay(s) {
    s.phase = 'play';
    s.leader = s.turn = (s.dealer + 1) % SEATS === s.sitting ? (s.dealer + 2) % SEATS : (s.dealer + 1) % SEATS;
    s.hands = s.hands.map(function (h) { return arrange(h, s.trump); });
  }
  function setTrump(s, seat, suit, alone) {
    s.trump = suit; s.maker = seat; s.alone = !!alone; s.sitting = alone ? partnerOf(seat) : -1;
  }
  // Round 1: the turned-up suit becomes trump and the dealer picks it up.
  function orderUp(st, seat, alone) {
    var s = Z.clone(st);
    setTrump(s, seat, Z.suit(s.upcard), alone); s.moves++;
    if (s.sitting === s.dealer) { s.hands[s.dealer] = arrange(s.hands[s.dealer], s.trump); startPlay(s); return s; }
    s.hands[s.dealer] = arrange(s.hands[s.dealer].concat([s.upcard]), s.trump);
    s.phase = 'discard'; s.turn = s.dealer;
    return s;
  }
  function discard(st, id) {
    var s = Z.clone(st), h = s.hands[s.dealer];
    h.splice(h.indexOf(id), 1); s.moves++;
    startPlay(s);
    return s;
  }
  function pass(st) {
    var s = Z.clone(st); s.moves++;
    if (s.phase === 'order2' && s.turn === s.dealer) return s; // stuck: the dealer cannot pass
    s.passes++;
    if (s.passes === SEATS && s.phase === 'order1') { s.phase = 'order2'; s.passes = 0; s.turnedDown = Z.suit(s.upcard); s.turn = (s.dealer + 1) % SEATS; } else s.turn = (s.turn + 1) % SEATS;
    return s;
  }
  function canPass(st) { return st.phase === 'order1' || (st.phase === 'order2' && st.turn !== st.dealer); }
  // Round 2: name any suit but the one turned down.
  function nameTrump(st, seat, suit, alone) {
    var s = Z.clone(st);
    if (suit === s.turnedDown) return s;
    setTrump(s, seat, suit, alone); s.moves++;
    startPlay(s);
    return s;
  }

  function legalPlays(st, seat) {
    var hand = st.hands[seat], trick = st.trick;
    if (!trick.length) return hand.slice();
    var lead = effSuit(trick[0].id, st.trump), follow = hand.filter(function (c) { return effSuit(c, st.trump) === lead; });
    return follow.length ? follow : hand.slice();
  }
  function whyNot(st) { return TX('cards.follow', { suit: TX('cards.suit.' + SUIT_NAMES[effSuit(st.trick[0].id, st.trump)]) }); }
  function isLegal(st, seat, id) { return st.phase === 'play' && st.trick.length < trickSize(st) && st.turn === seat && legalPlays(st, seat).indexOf(id) >= 0; }

  function playCard(st, seat, id) {
    var s = Z.clone(st);
    s.hands[seat].splice(s.hands[seat].indexOf(id), 1);
    s.trick.push({ seat: seat, id: id }); s.moves++;
    if (s.trick.length < trickSize(s)) s.turn = nextSeat(s, seat);
    return s;
  }
  // Does card `a` beat `b` in a trick led in effective suit `lead`?
  function beats(a, b, lead, trump) {
    var sa = effSuit(a, trump), sb = effSuit(b, trump);
    if (sa === sb) return power(a, trump) > power(b, trump);
    return sa === trump || (sb !== trump && sa === lead);
  }
  function trickWinner(trick, trump) {
    var lead = effSuit(trick[0].id, trump), best = trick[0];
    trick.forEach(function (t) { if (beats(t.id, best.id, lead, trump)) best = t; });
    return best.seat;
  }
  // What a hand is worth: { team, points, euchred }.
  function scoreHand(makerTeam, makerTricks, alone) {
    if (makerTricks < 3) return { team: 1 - makerTeam, points: 2, euchred: true };
    return { team: makerTeam, points: makerTricks === 5 ? (alone ? 4 : 2) : 1, euchred: false };
  }
  function resolveTrick(st) {
    var s = Z.clone(st), w = trickWinner(s.trick, s.trump);
    s.tricks[w]++;
    s.played = s.played.concat(s.trick.map(function (t) { return t.id; }));
    s.trick = []; s.leader = s.turn = w;
    if (s.tricks.reduce(function (a, b) { return a + b; }, 0) === HAND) {
      var mt = team(s.maker), got = s.tricks[mt] + s.tricks[mt + 2], r = scoreHand(mt, got, s.alone);
      r.makerTeam = mt; r.got = got; s.result = r; s.scores[r.team] += r.points;
      s.phase = s.scores[r.team] >= END_SCORE ? 'over' : 'handEnd';
    }
    return s;
  }
  var winnerTeam = function (scores) { return scores[0] >= END_SCORE ? 0 : scores[1] >= END_SCORE ? 1 : -1; };

  // ── The computer players ────────────────────────────────────────────────
  var HONOUR = { 14: 2, 13: 1.5, 12: 1.1, 10: 0.8, 9: 0.5 };
  // How strong a hand is with `trump` as trump.
  function strength(hand, trump) {
    return hand.reduce(function (n, c) {
      var p = power(c, trump);
      if (p === RIGHT_POWER) return n + 3.2;
      if (p === LEFT_POWER) return n + 2.6;
      if (effSuit(c, trump) === trump) return n + (HONOUR[face(c)] || 0.5);
      return n + (face(c) === 14 ? 1 : 0);
    }, 0);
  }
  function weakest(hand, trump) {
    var suitCount = function (c) { return hand.filter(function (x) { return effSuit(x, trump) === effSuit(c, trump); }).length; };
    return T.minBy(hand, function (c) { return power(c, trump) + (effSuit(c, trump) === trump ? 40 : 0) - (suitCount(c) === 1 && face(c) !== 14 ? 3 : 0); });
  }
  // The turned-up card is picked up by the dealer: that hand is what counts.
  function aiOrder(st, seat) {
    var suit = Z.suit(st.upcard), hand = st.hands[seat], bonus = 0, s;
    if (seat === st.dealer) { var h = hand.concat([st.upcard]); h.splice(h.indexOf(weakest(h, suit)), 1); s = strength(h, suit); }
    else { s = strength(hand, suit); bonus = st.dealer === partnerOf(seat) ? 1 : -1.2; }
    s += bonus;
    return s >= ORDER_BASE ? { call: true, suit: suit, alone: s >= ALONE_BASE } : { call: false };
  }
  function aiName(st, seat) {
    var hand = st.hands[seat], best = null, bs = -1;
    [0, 1, 2, 3].forEach(function (suit) {
      if (suit === st.turnedDown) return;
      var s = strength(hand, suit);
      if (s > bs) { bs = s; best = suit; }
    });
    if (bs >= CALL_BASE || seat === st.dealer) return { call: true, suit: best, alone: bs >= ALONE_BASE };
    return { call: false };
  }
  function aiDiscard(st) { return weakest(st.hands[st.dealer], st.trump); }

  function aiPick(st, seat) {
    var legal = legalPlays(st, seat);
    if (legal.length === 1) return legal[0];
    var trump = st.trump, trick = st.trick, partner = partnerOf(seat), makers = team(seat) === team(st.maker);
    var pw = function (c) { return power(c, trump); };
    var low = T.minBy(legal, function (c) { return pw(c); });
    if (!trick.length) {
      var trumps = legal.filter(function (c) { return effSuit(c, trump) === trump; }), offAces = legal.filter(function (c) { return effSuit(c, trump) !== trump && face(c) === 14; });
      if (makers && trumps.length >= 2) return T.maxBy(trumps, pw);
      if (makers && trumps.length === 1 && pw(trumps[0]) >= LEFT_POWER) return trumps[0];
      if (offAces.length) return offAces[0];
      var off = legal.filter(function (c) { return effSuit(c, trump) !== trump; });
      return off.length ? T.minBy(off, pw) : low;
    }
    var lead = effSuit(trick[0].id, trump);
    var win = trick.reduce(function (b, t) { return beats(t.id, b.id, lead, trump) ? t : b; }, trick[0]);
    var winners = legal.filter(function (c) { return beats(c, win.id, lead, trump); });
    var cheapest = winners.length ? T.minBy(winners, pw) : null;
    var rest = trickSize(st) - trick.length - 1; // players still to play after me
    if (win.seat === partner && (pw(win.id) >= TRUMP_POWER || face(win.id) === 14 || rest === 0)) return low;
    if (cheapest !== null) return cheapest;
    return T.minBy(legal, function (c) { return pw(c) + (effSuit(c, trump) === trump ? 40 : 0); });
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  function geo(m, st) { return T.geometry(m, T.rowsFor(m, st.hands[0].length)); }
  function place(st, m, view) {
    var g = geo(m, st), slots = T.feltSlots(g), cards = [], size = trickSize(st), full = st.trick.length === size;
    var sweep = view && full ? view.sweep : null;
    var L = T.looking(view), V = L.V, up = L.up, rel = function (seat) { return (seat - V + SEATS) % SEATS; };
    var myTurn = st.phase === 'play' && st.turn === V && !full, picking = st.phase === 'discard' && st.dealer === V;
    var hand = T.handCards(g, st.hands[V], function (id) { return { up: up, dim: up && myTurn && !isLegal(st, V, id), glow: up && picking && id === st.upcard, label: Z.cardName(id) + (picking && id === st.upcard ? TX('euchre.aria.pickedUp') : '') }; },
      function (a, b) { return effSuit(a, st.trump) !== effSuit(b, st.trump); });
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    [1, 2, 3].forEach(function (pos) { var seat = (V + pos) % SEATS; if (seat !== st.sitting) cards = cards.concat(T.fan(g, pos, st.hands[seat], false)); });
    if (st.phase === 'order1' || st.phase === 'order2') cards.push({ id: st.upcard, pile: 'up', idx: 0, x: Math.round(g.cx - g.cw / 2), y: Math.round(g.cy - g.ch / 2), up: st.phase === 'order1' });
    return { height: m.H, slots: slots, cards: cards.concat(T.trickCards(g, st.trick, sweep, rel, view && view.win)) };
  }

  var api = {
    NAMES: NAMES, END_SCORE: END_SCORE, DECK: DECK, effSuit: effSuit, power: power, arrange: arrange,
    dealHand: dealHand, newGame: freshGame, nextHand: nextHand, orderUp: orderUp, discard: discard, pass: pass, canPass: canPass, nameTrump: nameTrump,
    legalPlays: legalPlays, whyNot: whyNot, isLegal: isLegal, playCard: playCard, trickWinner: trickWinner, resolveTrick: resolveTrick,
    scoreHand: scoreHand, winnerTeam: winnerTeam, strength: strength, aiOrder: aiOrder, aiName: aiName, aiDiscard: aiDiscard, aiPick: aiPick, geo: geo, place: place
  };
  root.ZimiEuchre = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 620, HOLD_MS = 1000, SWEEP_MS = 380;
  function boot() {
    var t, board, session, view = { sweep: null, flash: '', alone: false, note: '' }, tg, seats, mine, teamLabel, viewTeam;
    var glyph = function (s) { return GLYPH[s]; };
    var suitWord = function (s) { return TX('cards.suit.' + SUIT_NAMES[s]); };
    function who(seat) { return seats.name(seat); }
    // The seat acting now (the dealer while discarding).
    var actor = function (st) { return st.phase === 'discard' ? st.dealer : st.turn; };
    function handLines(st) {
      var r = st.result, mk = teamLabel(r.makerTeam);
      return [TX(st.alone ? 'euchre.line.calledAlone' : 'euchre.line.called', { team: mk, suit: suitWord(st.trump), got: r.got }),
        r.euchred ? TX('euchre.line.euchred', { team: teamLabel(r.team), maker: mk, points: r.points }) : TX('euchre.line.score', { team: teamLabel(r.team), points: r.points }),
        TX('euchre.line.scores', { a: st.scores[viewTeam()], b: st.scores[1 - viewTeam()] })];
    }
    function hud(st) {
      var size = trickSize(st), full = st.trick.length === size;
      var chips = tg.order().map(function (seat) {
        var name = seats.name(seat), text = seat === st.sitting ? TX('euchre.out') : st.phase === 'play' || st.phase === 'handEnd' ? String(st.tricks[seat]) : '';
        if (st.maker === seat) text += ' ★';
        return { name: name, text: text, dealer: seat === st.dealer, turn: st.turn === seat && !full && (st.phase === 'order1' || st.phase === 'order2' || st.phase === 'play') };
      });
      var out = { chips: chips, text: '', trump: st.trump };
      if (st.phase === 'order1') {
        out.text = (view.note ? view.note + ' ' : '') + (mine(st.turn) ? TX(seats.hotseat() ? 'euchre.orderUp.name' : 'euchre.orderUp', { name: who(st.turn), suit: suitWord(Z.suit(st.upcard)) }) : seats.person(st.turn) ? TX('euchre.deciding', { name: who(st.turn) }) : TX('cards.thinking', { name: who(st.turn) }));
        if (mine(st.turn)) out.choices = [{ label: TX('euchre.orderUpBtn'), onclick: function () { callRound1(false); } }, { label: TX('euchre.alone'), onclick: function () { callRound1(true); } }, { label: TX('cards.pass'), onclick: passNow }];
      } else if (st.phase === 'order2') {
        out.text = (view.note ? view.note + ' ' : '') + (mine(st.turn) ? TX(seats.hotseat() ? 'euchre.name.name' : 'euchre.name', { name: who(st.turn), suit: suitWord(st.turnedDown) }) + (st.dealer === st.turn ? ' ' + TX('euchre.mustName') : '') : seats.person(st.turn) ? TX('euchre.deciding', { name: who(st.turn) }) : TX('cards.thinking', { name: who(st.turn) }));
        if (mine(st.turn)) {
          out.choices = [0, 1, 2, 3].filter(function (s) { return s !== st.turnedDown; }).map(function (s) {
            return { label: glyph(s), aria: suitWord(s), cls: s === 1 || s === 2 ? 'ct-red' : '', onclick: function () { callRound2(s); } };
          });
          out.choices.push({ label: TX('euchre.alone'), pressed: view.alone, onclick: function () { view.alone = !view.alone; t.paint(); } });
          if (canPass(st)) out.choices.push({ label: TX('cards.pass'), onclick: passNow });
        }
      } else if (st.phase === 'discard') out.text = mine(st.dealer) ? TX(seats.isYou(st.dealer) ? 'euchre.pickUp.you' : 'euchre.pickUp.name', { name: who(st.dealer), card: Z.cardName(st.upcard) }) : TX('euchre.picksUpDiscards', { name: who(st.dealer) });
      else if (st.phase === 'handEnd') { out.text = TX('cards.handEnd'); out.label = TX('cards.nextHand'); out.action = tg.startNextHand; }
      else if (st.phase === 'over') { out.text = TX('shell.end.over'); out.label = TX('shell.menu.new'); out.action = newGame; }
      else if (full) out.text = tg.trickText(trickWinner(st.trick, st.trump));
      else out.text = tg.turnText(st.turn);
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'order1' || st.phase === 'order2') { if (seats.person(st.turn)) seats.ensure(st.turn, tg.repaint); else session.later(aiCall, AI_MS); return; }
      if (st.phase === 'discard') { if (seats.person(st.dealer)) seats.ensure(st.dealer, tg.repaint); else session.later(aiDiscardTurn, AI_MS); return; }
      tg.turn(st);
    }
    function calledNote(st, seat) { return TX(st.alone ? 'euchre.called.alone' : 'euchre.called', { name: who(seat), suit: suitWord(st.trump) }); }
    function aiCall() {
      var st = session.state, seat = st.turn, d1 = st.phase === 'order1';
      if ((!d1 && st.phase !== 'order2') || seats.person(seat)) return;
      var c = d1 ? aiOrder(st, seat) : aiName(st, seat);
      if (!c.call) { view.note = TX('euchre.passed', { name: who(seat) }); session.follow(pass(st)); drive(); return; }
      var ns = d1 ? orderUp(st, seat, c.alone) : nameTrump(st, seat, c.suit, c.alone);
      view.note = calledNote(ns, seat) + '.'; view.flash = ''; session.follow(ns); if (!(ns.phase === 'discard' && mine(ns.dealer))) t.flash(calledNote(ns, seat)); drive();   // not over the dealer's instruction to discard
    }
    function aiDiscardTurn() {
      var st = session.state;
      if (st.phase !== 'discard' || seats.person(st.dealer)) return;
      session.follow(discard(st, aiDiscard(st)));
      drive();
    }
    function handOver() { tg.handSheet(handLines(session.state)); }
    function gameOver() { var st = session.state; tg.teamGameOver(winnerTeam(st.scores), st.scores, handLines(st)); }
    function callRound1(alone) { var st = session.state; if (st.phase !== 'order1' || !mine(st.turn)) return; view.note = ''; session.commit(orderUp(st, st.turn, alone)); drive(); }
    function callRound2(suit) {
      var st = session.state; if (st.phase !== 'order2' || !mine(st.turn)) return;
      view.note = ''; var alone = view.alone; view.alone = false; session.commit(nameTrump(st, st.turn, suit, alone)); drive();
    }
    function passNow() { var st = session.state; if (!canPass(st) || !mine(st.turn)) return; view.note = ''; session.commit(pass(st)); drive(); }
    function newGame() { tg.restart(freshGame(Z.shuffled(Math.random), Math.floor(Math.random() * SEATS))); }

    tg = T.trickGame({
      id: 'euchre', n: SEATS, view: view, ms: { ai: AI_MS, hold: HOLD_MS, sweep: SWEEP_MS }, drive: drive, handEnd: 'handEnd', actor: actor, control: function (st) { return st.turn; },
      size: trickSize, winner: function (st) { return trickWinner(st.trick, st.trump); }, resolve: resolveTrick, nextHand: nextHand, handOver: handOver, gameOver: gameOver,
      legal: isLegal, why: whyNot, play: playCard, aiPlay: aiPick, clear: function () { view.note = ''; view.alone = false; },
      pretap: function (st, id) {
        if (st.phase === 'discard' && mine(st.dealer)) { session.commit(discard(st, id)); drive(); return true; }
      }
    });
    seats = tg.seats; mine = tg.mine; viewTeam = tg.viewTeam; teamLabel = tg.teamLabel;
    t = tg.create({
      name: 'Euchre', geo: geo, place: place, hud: hud, newGame: newGame, cols: 6, heightShare: 0.13,
      cascadeOrder: function (st) { return st.played.map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return handLines(st).concat([TX('cards.result.you', { a: st.scores[viewTeam()], b: st.scores[1 - viewTeam()] })]); },
      rules: TX('euchre.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    newGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
