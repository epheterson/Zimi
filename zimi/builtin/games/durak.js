/* ZimiGames: Durak, the Russian game of the fool. 36 cards (6 to ace), two to
   four players, six cards each; the card turned at the bottom of the stock
   names the trump suit and is drawn last. The one holding the lowest trump
   attacks first. The attacker lays a card, the defender beats it with a higher
   card of the same suit or with any trump (a trump only with a higher trump),
   or takes. Podkidnoy: once it is beaten, the attacker and the other
   players may add cards of any rank already on the table, so long as there
   are no more than six attacks (five in the first bout) and no more than the
   defender held when the bout began. Beat everything and the cards are
   discarded, everyone draws up to six (attacker first, defender last) and the
   defender attacks next. If the defender takes, the others may throw in more
   first; the defender then picks everything up and the next player attacks.
   When the stock is gone, a player with no cards is out. The last one still
   holding cards is the durak, the fool.

   State: n, hands[n], stock (drawn from the end; stock[0] is the trump card),
   trump (suit), table [{a, d}], discard, attacker, defender, throwers (who
   may attack, in turn), tIdx, passes, defCap, bouts, phase ('attack' |
   'defend' | 'throw' | 'clear' | 'over'), turn, taken (the bout ends with a
   take), out, durak (-1 = nobody), last. Seats run clockwise: 0 you. Pure
   functions; the page wiring at the bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var HAND = 6, FIRST_CAP = 5, CAP = 6, ACE_HIGH = 14, LOW_RANK = 6, MIN_PLAYERS = 2, MAX_PLAYERS = 4, DEFAULT_PLAYERS = 3;
  var POS_NAMES = [TX('cards.you'), TX('cards.seat.west'), TX('cards.seat.north'), TX('cards.seat.east')];
  var hi = function (id) { return Z.rank(id) === 1 ? ACE_HIGH : Z.rank(id); };
  var DECK = (function () { var d = [], i; for (i = 0; i < Z.DECK; i++) if (Z.rank(i) === 1 || Z.rank(i) >= LOW_RANK) d.push(i); return d; })();
  var isTrump = function (st, id) { return Z.suit(id) === st.trump; };
  var seatName = function (seat, n) { return POS_NAMES[T.posOf(seat, n)]; };
  var unbeaten = function (st) { for (var i = st.table.length - 1; i >= 0; i--) if (st.table[i].d === null) return st.table[i]; return null; };

  // ── Rules ───────────────────────────────────────────────────────────────
  // Does `def` beat `atk`? Higher of the suit, or a trump over a non-trump.
  function beats(st, def, atk) {
    if (Z.suit(def) === Z.suit(atk)) return hi(def) > hi(atk);
    return isTrump(st, def) && !isTrump(st, atk);
  }
  var tableCards = function (st) { return st.table.reduce(function (l, p) { return l.concat(p.d === null ? [p.a] : [p.a, p.d]); }, []); };
  var sortHand = function (st, ids) {
    return ids.slice().sort(function (a, b) { return (isTrump(st, a) - isTrump(st, b)) || (Z.suit(a) - Z.suit(b)) || hi(a) - hi(b); });
  };

  function nextActive(st, seat) {
    for (var k = 1; k <= st.n; k++) { var c = (seat + k) % st.n; if (st.out.indexOf(c) < 0) return c; }
    return seat;
  }
  function startBout(s, attacker) {
    var list = [attacker], k, seat;
    s.attacker = attacker; s.defender = nextActive(s, attacker);
    for (k = 1; k < s.n; k++) { seat = (attacker + k) % s.n; if (seat !== s.defender && s.out.indexOf(seat) < 0) list.push(seat); }
    s.throwers = list; s.tIdx = 0; s.passes = 0; s.table = []; s.taken = false;
    s.defCap = Math.min(s.bouts === 0 ? FIRST_CAP : CAP, s.hands[s.defender].length);
    s.phase = 'attack'; s.turn = attacker;
  }
  function deal(order, n) {
    var hands = [], i;
    for (i = 0; i < n; i++) hands.push(order.slice(i * HAND, (i + 1) * HAND));
    var stock = order.slice(n * HAND), s = { n: n, hands: hands, stock: stock, trump: Z.suit(stock[0]), table: [], discard: [], bouts: 0, out: [], durak: -1, last: null, moves: 0, taken: false };
    s.hands = hands.map(function (h) { return sortHand(s, h); });
    var lowest = null, first = 0;
    s.hands.forEach(function (h, seat) { h.forEach(function (c) { if (isTrump(s, c) && (lowest === null || hi(c) < hi(lowest))) { lowest = c; first = seat; } }); });
    startBout(s, first);
    return s;
  }
  var newGame = function (rng, n) { return deal(T.shuffleOf(DECK, rng), n); };

  // Cards `seat` may lay now as an attack or a throw-in.
  function legalThrows(st, seat) {
    if ((st.phase !== 'attack' && st.phase !== 'throw') || st.turn !== seat || st.table.length >= st.defCap) return [];
    var hand = st.hands[seat];
    if (!st.table.length) return seat === st.attacker ? hand.slice() : [];
    var ranks = tableCards(st).map(Z.rank);
    return hand.filter(function (c) { return ranks.indexOf(Z.rank(c)) >= 0; });
  }
  function legalDefences(st, seat) {
    var u = unbeaten(st);
    if (st.phase !== 'defend' || seat !== st.defender || st.turn !== seat || !u) return [];
    return st.hands[seat].filter(function (c) { return beats(st, c, u.a); });
  }
  function whyNotThrow(st, seat, id) {
    if (st.table.length >= st.defCap) return TX('durak.cap', { n: st.defCap });
    if (!st.table.length) return seat === st.attacker ? '' : TX('durak.onlyAttacker');
    return TX('durak.addRank');
  }
  function whyNotDefend(st, id) {
    var u = unbeaten(st);
    return u && isTrump(st, u.a) ? TX('durak.higherTrump') : TX('durak.beatIt');
  }

  // The rest of a bout: skip throwers with nothing to add; when all have passed the bout is over.
  function toClear(s, taken) { s.phase = 'clear'; s.taken = taken; }
  function settleBout(s) {
    var guard = 0;
    while ((s.phase === 'attack' || s.phase === 'throw') && guard++ < 24) {
      if (s.passes >= s.throwers.length) { toClear(s, s.phase === 'throw'); return; }
      if (legalThrows(s, s.turn).length) return;
      s.passes++; s.tIdx = (s.tIdx + 1) % s.throwers.length; s.turn = s.throwers[s.tIdx];
    }
  }

  function attackCard(st, id) {
    var s = Z.clone(st), seat = s.turn;
    s.hands[seat].splice(s.hands[seat].indexOf(id), 1);
    s.table.push({ a: id, d: null }); s.passes = 0; s.moves++;
    s.last = { seat: seat, act: s.table.length === 1 ? 'attack' : 'throw', id: id };
    if (s.phase === 'attack') { s.phase = 'defend'; s.turn = s.defender; } else settleBout(s);
    return s;
  }
  function defendCard(st, id) {
    var s = Z.clone(st), u = unbeaten(s), seat = s.defender;
    u.d = id; s.hands[seat].splice(s.hands[seat].indexOf(id), 1); s.moves++;
    s.last = { seat: seat, act: 'defend', id: id };
    s.phase = 'attack'; s.tIdx = 0; s.turn = s.throwers[0]; s.passes = 0;
    if (!s.hands[seat].length || s.table.length >= s.defCap) toClear(s, false); else settleBout(s);
    return s;
  }
  function take(st) {
    var s = Z.clone(st);
    s.phase = 'throw'; s.tIdx = 0; s.turn = s.throwers[0]; s.passes = 0; s.moves++;
    s.last = { seat: s.defender, act: 'take' };
    settleBout(s);
    return s;
  }
  function pass(st) {
    var s = Z.clone(st);
    s.last = { seat: s.turn, act: 'pass' }; s.moves++;
    s.passes++; s.tIdx = (s.tIdx + 1) % s.throwers.length; s.turn = s.throwers[s.tIdx];
    settleBout(s);
    return s;
  }
  function canPass(st, seat) { return (st.phase === 'attack' || st.phase === 'throw') && st.turn === seat && st.table.length > 0; }

  // The bout is over: cards go to the defender or the discard, everyone draws, the next bout starts.
  function finishBout(st) {
    var s = Z.clone(st), cards = tableCards(s), order = s.throwers.concat([s.defender]);
    if (s.taken) s.hands[s.defender] = sortHand(s, s.hands[s.defender].concat(cards)); else s.discard = s.discard.concat(cards);
    s.table = [];
    order.forEach(function (seat) {
      while (s.hands[seat].length < HAND && s.stock.length) s.hands[seat].push(s.stock.pop());
      s.hands[seat] = sortHand(s, s.hands[seat]);
    });
    s.hands.forEach(function (h, seat) { if (!h.length && !s.stock.length && s.out.indexOf(seat) < 0) s.out.push(seat); });
    var active = s.hands.map(function (h, i) { return i; }).filter(function (i) { return s.out.indexOf(i) < 0; });
    s.bouts++;
    if (active.length <= 1) { s.phase = 'over'; s.durak = active.length ? active[0] : -1; s.last = { seat: s.durak, act: 'over' }; return s; }
    startBout(s, s.taken || s.out.indexOf(s.defender) >= 0 ? nextActive(s, s.defender) : s.defender);
    return s;
  }

  // ── The computer players ────────────────────────────────────────────────
  var count = function (hand, f) { return hand.filter(f).length; };
  function aiDefend(st, seat) {
    var u = unbeaten(st), hand = st.hands[seat], opts = legalDefences(st, seat);
    if (!opts.length) return null;
    var plain = opts.filter(function (c) { return !isTrump(st, c); });
    if (plain.length) return T.minBy(plain, hi);
    var cheap = T.minBy(opts, hi), trumps = count(hand, function (c) { return isTrump(st, c); });
    // Spending a trump on a low card early is how games are lost; late it is the only way.
    if (!st.stock.length || hi(u.a) >= 11 || trumps >= 3 || hand.length <= 3 || isTrump(st, u.a) || st.table.length >= 3) return cheap;
    return null;
  }
  function aiThrow(st, seat) {
    var opts = legalThrows(st, seat);
    if (!opts.length) return null;
    if (!st.table.length) {
      var ranks = st.hands[seat].map(Z.rank);
      return T.minBy(opts, function (c) { return (isTrump(st, c) ? 100 : 0) + hi(c) - (count(ranks, function (r) { return r === Z.rank(c); }) > 1 ? 3 : 0); });
    }
    var plain = opts.filter(function (c) { return !isTrump(st, c) && (st.phase === 'throw' || hi(c) <= 11); });
    return plain.length ? T.minBy(plain, hi) : null;
  }
  // One move for whoever is to act, by the computer's rules.
  function aiStep(st) {
    var seat = st.turn;
    if (st.phase === 'defend') { var d = aiDefend(st, seat); return d === null ? take(st) : defendCard(st, d); }
    var c = aiThrow(st, seat);
    return c === null ? pass(st) : attackCard(st, c);
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var PAIR_STEP_SHARE = 1.25, DEFENCE_DX = 0.3, DEFENCE_DY = 0.2, STOCK_PEEK = 0.55, STOCK_DROP = 0.85;
  function geo(m, st) { return T.geometry(m, T.rowsFor(m, st.hands[0].length)); }
  function tableSpots(g, count) {
    var pitch = Math.min(g.cw * PAIR_STEP_SHARE, count > 1 ? (g.W - 2 * g.pad - g.cw * (1 + DEFENCE_DX)) / (count - 1) : 0);
    var x0 = (g.W - (pitch * (count - 1) + g.cw * (1 + DEFENCE_DX))) / 2, y = g.cy - g.ch / 2 - g.ch * 0.2;
    return { x0: x0, pitch: pitch, y: y };
  }
  function place(st, m, view) {
    var g = geo(m, st), cards = [], slots = [], sx = Math.round(g.pad + 4), sy = Math.round(g.cy + g.ch * STOCK_DROP);
    var V = (view && view.viewer) || 0, up = !(view && view.hideHand);
    var myTurn = st.turn === V && st.phase !== 'clear' && st.phase !== 'over', legal = [];
    if (myTurn) legal = st.phase === 'defend' ? legalDefences(st, V) : legalThrows(st, V);
    slots.push({ id: 'stock', x: sx, y: sy, w: g.cw, h: g.ch, label: TX('durak.stockLabel', { cards: Z.plural(st.stock.length, 'card'), suit: TX('cards.suit.' + Z.SUITS[st.trump]) }) });
    slots.push({ id: 'table', x: Math.round(g.pad), y: Math.round(g.cy - g.ch * 1.1), w: g.W - 2 * g.pad, h: g.ch * 1.7, quiet: true, label: TX('cards.slot.table') });
    st.stock.forEach(function (id, k) {
      var trumpCard = k === 0;
      cards.push({ id: id, pile: 'stock', idx: k, x: trumpCard ? sx : sx + Math.round(g.cw * STOCK_PEEK), y: sy, up: trumpCard });
    });
    var hand = T.handCards(g, st.hands[V], function (id) {
      return { up: up, dim: up && myTurn && legal.indexOf(id) < 0 };
    }, null);
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    for (var r = 1; r < st.n; r++) cards = cards.concat(T.fan(g, T.posOf(r, st.n), st.hands[(V + r) % st.n], false));
    var spots = tableSpots(g, Math.max(1, st.table.length)), off = view && view.sweep === 'off', to = view && typeof view.sweep === 'number' ? T.seatSpot(g, view.sweep) : null;
    st.table.forEach(function (p, k) {
      var x = spots.x0 + k * spots.pitch, y = spots.y;
      var put = function (id, dx, dy, idx) {
        var cx = to ? to.x : off ? g.W + g.cw : x + dx, cy = to ? to.y : y + dy;
        cards.push({ id: id, pile: 'table', idx: idx, x: Math.round(cx), y: Math.round(cy), up: true });
      };
      put(p.a, 0, 0, k * 2);
      if (p.d !== null) put(p.d, g.cw * DEFENCE_DX, g.ch * DEFENCE_DY, k * 2 + 1);
    });
    return { height: m.H, slots: slots, cards: cards };
  }

  var api = {
    DECK: DECK, HAND: HAND, hi: hi, beats: beats, deal: deal, newGame: newGame, nextActive: nextActive, legalThrows: legalThrows, legalDefences: legalDefences,
    attackCard: attackCard, defendCard: defendCard, take: take, pass: pass, canPass: canPass, finishBout: finishBout, aiStep: aiStep, aiDefend: aiDefend, aiThrow: aiThrow,
    unbeaten: unbeaten, tableCards: tableCards, whyNotThrow: whyNotThrow, whyNotDefend: whyNotDefend, seatName: seatName, geo: geo, place: place
  };
  root.ZimiDurak = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 650, HOLD_MS = 1000, SWEEP_MS = 420, PLAYERS_KEY = 'durak.players';
  function boot() {
    var t, board, session, view = { sweep: null, flash: '' };
    var savedPlayers = function () { var v = Z.store.get(PLAYERS_KEY, DEFAULT_PLAYERS); return v >= MIN_PLAYERS && v <= MAX_PLAYERS ? v : DEFAULT_PLAYERS; };
    // Seats are the Computer or a Person; the seat count follows the table size, so each new game
    // builds a fresh ZimiSeats and the facade below hands out its methods.
    var seats = {};
    function buildSeats(n) {
      var cur = Seats.create({ id: 'durak', seats: n, onChange: function () { if (t) t.paint(); if (board) board.refresh(); } });
      Object.keys(cur).forEach(function (k) { seats[k] = cur[k]; });
    }
    buildSeats(DEFAULT_PLAYERS);
    var nm = function (st, seat) { return seats.name(seat); };
    var mine = function (seat) { return seats.person(seat) && seat === seats.view(); };
    function syncView(st) { view.viewer = seats.view(); view.hideHand = seats.hotseat() && st.turn !== view.viewer; }
    function repaint() { board.refresh(); t.paint(); }
    function noteOf(st) {
      var l = st.last;
      if (!l || seats.isYou(l.seat)) return '';
      var who = nm(st, l.seat);
      return { attack: TX('durak.note.attack', { name: who, card: T.short(l.id) }), throw: TX('durak.note.throw', { name: who, card: T.short(l.id) }), defend: TX('durak.note.defend', { name: who, card: T.short(l.id) }),
        take: TX('durak.note.take', { name: who }), pass: '' }[l.act] || '';
    }
    function hud(st) {
      var n = st.n, note = noteOf(st), out = { text: '', trump: st.trump, fact: TX('durak.fact', { n: st.stock.length }) };
      out.chips = st.hands.map(function (h, seat) {
        var role = st.phase === 'over' ? '' : seat === st.attacker ? ' ' + TX('durak.atk') : seat === st.defender ? ' ' + TX('durak.def') : '';
        return { name: nm(st, seat), text: st.out.indexOf(seat) >= 0 ? TX('euchre.out') : h.length + role, turn: st.phase !== 'clear' && st.phase !== 'over' && st.turn === seat };
      });
      var u = unbeaten(st);
      if (st.phase === 'over') { out.text = st.durak < 0 ? TX('durak.nobodyFool') : TX(seats.isYou(st.durak) ? 'durak.youDurak' : 'durak.isDurak', { name: nm(st, st.durak) }); out.label = TX('shell.menu.new'); out.action = newGame; return out; }
      if (st.phase === 'clear') { out.text = st.taken ? TX(seats.isYou(st.defender) ? 'durak.youTake' : 'durak.takes', { name: nm(st, st.defender) }) : TX('durak.beaten'); return out; }
      if (!mine(st.turn)) {
        out.text = (note ? note + ' ' : '') + (st.phase === 'throw' ? TX('durak.mayThrow', { name: nm(st, st.turn) }) : TX('cards.thinking', { name: nm(st, st.turn) }));
        if (seats.person(st.turn)) out.text = (note ? note + ' ' : '') + TX('durak.isUp', { name: nm(st, st.turn) });
        if (st.phase === 'throw' && seats.person(st.defender)) out.text = (note ? note + ' ' : '') + TX(seats.isYou(st.defender) ? 'durak.youTakeThrow' : 'durak.takesThrow', { name: nm(st, st.defender) });
        return out;
      }
      if (st.phase === 'defend') { out.text = (note ? note + ' ' : '') + TX('durak.beatOrTake', { card: T.short(u.a) }); out.choices = [{ label: TX('durak.take'), onclick: takeNow }]; }
      else if (!st.table.length) out.text = TX(seats.isYou(st.turn) ? 'durak.yourAttack' : 'durak.attacks', { name: nm(st, st.turn) });
      else { out.text = st.phase === 'throw' ? TX('durak.takesAdd', { name: nm(st, st.defender) }) : (note ? note + ' ' : '') + TX('durak.addRank.q'); out.choices = [{ label: TX('durak.done'), primary: true, onclick: doneNow }]; }
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'over') { gameOver(); return; }
      if (st.phase === 'clear') { session.later(clearOut, HOLD_MS); return; }
      if (seats.person(st.turn)) seats.ensure(st.turn, repaint); else session.later(aiTurn, AI_MS);
    }
    function clearOut() {
      var st = session.state;
      if (st.phase !== 'clear') return;
      view.sweep = st.taken ? T.posOf((st.defender - seats.view() + st.n) % st.n, st.n) : 'off';
      board.refresh();
      session.later(function () { view.sweep = null; session.follow(finishBout(session.state)); drive(); }, SWEEP_MS);
    }
    function aiTurn() {
      var st = session.state;
      if (seats.person(st.turn) || st.phase === 'clear' || st.phase === 'over') return;
      session.follow(aiStep(st));
      drive();
    }
    function gameOver() {
      var st = session.state, fool = st.durak, hot = seats.hotseat();
      if (hot || fool < 0) {
        session.lose(fool < 0 ? 'draw' : '', [fool < 0 ? TX('durak.nobodyLeft') : TX('durak.lastHolding', { name: nm(st, fool) })], undefined);
        return;
      }
      if (seats.isYou(fool)) session.lose('', [TX('durak.youLast')], undefined); else session.win();
    }
    function act(next) { session.commit(next); drive(); return true; }
    function takeNow() { var st = session.state; if (st.phase === 'defend' && mine(st.turn)) act(take(st)); }
    function doneNow() { var st = session.state; if (mine(st.turn) && canPass(st, st.turn)) act(pass(st)); }
    function play(id) {
      var st = session.state;
      if (st.turn !== seats.view() || st.phase === 'clear' || st.phase === 'over') { t.flash(st.phase === 'clear' ? TX('durak.waitBout') : TX('cards.wait.turn')); return false; }
      if (st.phase === 'defend') {
        if (legalDefences(st, st.turn).indexOf(id) < 0) { t.flash(whyNotDefend(st, id)); return false; }
        return act(defendCard(st, id));
      }
      if (legalThrows(st, st.turn).indexOf(id) < 0) { t.flash(whyNotThrow(st, st.turn, id)); return false; }
      return act(attackCard(st, id));
    }
    var idOf = function (pile) { return parseInt(pile.slice(1), 10); };
    function tap(pile) { return pile.charAt(0) === 'h' && !isNaN(idOf(pile)) ? play(idOf(pile)) : false; }
    function newGame() {
      buildSeats(savedPlayers());
      view.sweep = null; view.flash = '';
      session.reset(newGameState());
      startDeal();
    }
    // A fresh deal: nobody has seen it, so a table of people starts at a handoff.
    function startDeal() { seats.begin(function () { repaint(); drive(); }, session.state.turn); }
    function newGameState() { return deal(T.shuffleOf(DECK, Math.random), savedPlayers()); }

    t = T.create({
      id: 'durak', name: 'Durak', seats: seats, view: view, geo: geo, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: newGame, tap: tap, cols: 7, heightShare: 0.11,
      canPick: function (st, pile) { return st.turn === seats.view() && pile.charAt(0) === 'h' && (st.phase === 'defend' ? legalDefences(st, st.turn) : legalThrows(st, st.turn)).indexOf(idOf(pile)) >= 0; },
      move: function (pile, idx, to) { return (to === 'table' || to === 'stock') && pile.charAt(0) === 'h' ? play(idOf(pile)) : false; },
      // The scores are on the table; a clock that only counts a match has no place in the bar.
      stat: function () { return ''; },
      winLines: function (sec, st) { return [st.durak < 0 ? TX('durak.nobodyLeft') : TX('durak.isDurak.dot', { name: nm(st, st.durak) }), TX('durak.youWin')]; },
      menuExtra: function () {
        return [T.choiceRow(TX('cards.seatsAtTable'), PLAYERS_KEY, [{ value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }], DEFAULT_PLAYERS, function () { newGame(); })];
      },
      rules: TX('durak.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    newGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
