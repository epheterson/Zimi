/* ZimiGames: Go Fish, two to four players: you (south) against the computer players. Seven cards each (five with three or
   four players). On your turn ask any player for a rank you hold: they hand over every card of it and you ask again. With
   none, "go fish": you draw the top of the stock, and if it is the rank you asked for you ask again, else the turn passes.
   Four of a rank is a book and is laid down. A hand that runs out draws five more at once. The game ends when all thirteen books
   are made or no one else has cards to ask for; the most books wins.

   State: players, hands[n], stock, books[n] (the ranks each has laid down), known[n] (ranks others have seen that seat ask for,
   so it must hold them: what the computer remembers), turn, phase ('play' | 'over'), last (the latest ask and what came of it),
   result, moves. Pure functions; the page wiring only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var BOOK = 4, RANKS = 13, REFILL = 5, DEAL_TWO = 7, DEAL_MORE = 5, PLAYERS_KEY = 'gofish.players', DEFAULT_PLAYERS = 2;
  var rankOf = function (id) { return Z.rank(id); };
  var dealSize = function (players) { return players === 2 ? DEAL_TWO : DEAL_MORE; };
  var SUIT_ORDER = [0, 1, 3, 2];
  // A hand grouped by rank, suits in the table's usual order within a rank.
  function sorted(ids) { return ids.slice().sort(function (a, b) { return rankOf(a) - rankOf(b) || SUIT_ORDER.indexOf(Z.suit(a)) - SUIT_ORDER.indexOf(Z.suit(b)); }); }
  var count = function (hand, rank) { return hand.filter(function (c) { return rankOf(c) === rank; }).length; };
  var ranksIn = function (hand) { return sorted(hand).map(rankOf).filter(function (r, i, a) { return a.indexOf(r) === i; }); };
  var bookTotal = function (st) { return st.books.reduce(function (n, b) { return n + b.length; }, 0); };

  // ── Rules ───────────────────────────────────────────────────────────────
  // The order is a shuffled 52. The books a deal happens to make are laid down at once.
  function deal(order, players, first) {
    var n = dealSize(players), hands = [], s;
    for (s = 0; s < players; s++) hands.push(sorted(order.slice(s * n, (s + 1) * n)));
    var st = { players: players, hands: hands, stock: order.slice(players * n), books: hands.map(function () { return []; }), known: hands.map(function () { return []; }),
      turn: first || 0, phase: 'play', last: null, result: null, moves: 0 };
    settle(st);
    return st;
  }
  // Every complete book in every hand goes down.
  function layBooks(s) {
    var laid = [];
    s.hands.forEach(function (hand, seat) {
      ranksIn(hand).forEach(function (r) {
        if (count(hand, r) !== BOOK) return;
        s.hands[seat] = s.hands[seat].filter(function (c) { return rankOf(c) !== r; });
        s.books[seat].push(r); laid.push({ seat: seat, rank: r });
        s.known.forEach(function (k) { var i = k.indexOf(r); if (i >= 0) k.splice(i, 1); });
        hand = s.hands[seat];
      });
    });
    return laid;
  }
  var holders = function (s) { return s.hands.filter(function (h) { return h.length; }).length; };
  // After a move: books down, every hand that has run dry draws five (while the stock lasts), a turn that falls to a player with no
  // cards is passed on, and the end is called. `s` is a copy.
  function settle(s) {
    var laid = [], guard = 0, i, again;
    while (guard++ < 60) {
      laid = laid.concat(layBooks(s));
      if (bookTotal(s) === RANKS) break;
      again = false;
      for (i = 0; i < s.players; i++) {
        var seat = (s.turn + i) % s.players;
        if (s.hands[seat].length || !s.stock.length) continue;
        s.hands[seat] = sorted(s.hands[seat].concat(s.stock.splice(Math.max(0, s.stock.length - REFILL), REFILL)));
        again = true;
      }
      if (again) continue;
      if (s.stock.length === 0 && holders(s) <= 1) break;   // no one left to ask
      if (s.hands[s.turn].length) break;
      for (i = 1; i <= s.players; i++) if (s.hands[(s.turn + i) % s.players].length) { s.turn = (s.turn + i) % s.players; break; }
    }
    if (bookTotal(s) === RANKS || (s.stock.length === 0 && holders(s) <= 1)) { s.phase = 'over'; s.result = outcome(s); }
    return laid;
  }
  // Most books wins; the seats tied at the top share it.
  function outcome(s) {
    var most = Math.max.apply(null, s.books.map(function (b) { return b.length; }));
    return { most: most, winners: s.books.map(function (b, i) { return b.length === most ? i : -1; }).filter(function (i) { return i >= 0; }) };
  }
  var targets = function (st, seat) { return st.hands.map(function (h, i) { return i; }).filter(function (i) { return i !== seat && st.hands[i].length; }); };
  function canAsk(st, seat, target, rank) {
    return st.phase === 'play' && st.turn === seat && target !== seat && target >= 0 && target < st.players && st.hands[target].length > 0 && count(st.hands[seat], rank) > 0;
  }
  // `seat` asks `target` for `rank`. Their cards of it come over (and the asker asks again); else the asker draws and asks again
  // only if the drawn card is the one named.
  function ask(st, seat, target, rank) {
    var s = Z.clone(st), last = { seat: seat, target: target, rank: rank, got: 0, fished: false, lucky: false, empty: false, books: [] };
    var give = s.hands[target].filter(function (c) { return rankOf(c) === rank; });
    if (give.length) {
      s.hands[target] = s.hands[target].filter(function (c) { return rankOf(c) !== rank; });
      s.hands[seat] = sorted(s.hands[seat].concat(give));
      last.got = give.length;
      var ki = s.known[target].indexOf(rank); if (ki >= 0) s.known[target].splice(ki, 1);
    } else if (s.stock.length) {
      var drawn = s.stock.pop();
      s.hands[seat] = sorted(s.hands[seat].concat([drawn]));
      last.fished = true; last.lucky = rankOf(drawn) === rank;
      if (!last.lucky) s.turn = (seat + 1) % s.players;
    } else { last.empty = true; s.turn = (seat + 1) % s.players; }
    if (s.known[seat].indexOf(rank) < 0) s.known[seat].push(rank);
    last.books = layBooks(s);
    s.last = last; s.moves++;
    last.books = last.books.concat(settle(s));
    return s;
  }

  // ── The computer players ────────────────────────────────────────────────
  // {target, rank}: a rank another player is known to hold if I hold it too; else the rank I have most of, from the player with
  // the most cards. A little noise keeps it from asking the same thing every game.
  function aiAsk(st, seat, rng) {
    rng = rng || Math.random;
    var hand = st.hands[seat], best = null, bestScore = -1;
    targets(st, seat).forEach(function (t) {
      ranksIn(hand).forEach(function (r) {
        var score = count(hand, r) * 6 + st.hands[t].length * 0.5 + rng() * 2;
        if (st.known[t].indexOf(r) >= 0) score += 40;
        if (score > bestScore) { bestScore = score; best = { target: t, rank: r }; }
      });
    });
    return best;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var BOOK_STEP = 0.42, SHOW_STOCK = 2, COUNT_RISE = 26;
  function geo(m, st) { return T.geometry(m, T.rowsFor(m, st.hands[0].length)); }
  function piles(g) {
    var y = Math.round(g.cy - g.ch / 2);
    return { stock: { x: Math.round(g.cx - g.cw * 1.45), y: y }, books: { x: Math.round(g.cx - g.cw * 0.05), y: y } };
  }
  function place(st, m, view) {
    var g = geo(m, st), p = piles(g), slots = [], cards = [], V = (view && view.viewer) || 0, up = !(view && view.hideHand);
    var pend = view && view.pending !== undefined && view.pending !== null ? view.pending : null;
    slots.push({ id: 'stock', x: p.stock.x, y: p.stock.y, w: g.cw, h: g.ch, label: TX('gin.stock', { cards: Z.plural(st.stock.length, 'card') }) });
    var hand = T.handCards(g, st.hands[V], function (id) { return { up: up, raise: up && pend !== null && rankOf(id) === pend, mark: up && pend !== null && rankOf(id) === pend }; },
      function (a, b) { return rankOf(a) !== rankOf(b); });
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    for (var r = 1; r < st.players; r++) cards = cards.concat(T.fan(g, T.SEAT_POS[st.players][r], st.hands[(V + r) % st.players], false));
    st.stock.forEach(function (id, k) { cards.push({ id: id, pile: 'stock', idx: k, x: p.stock.x, y: p.stock.y, up: false, hidden: k < st.stock.length - SHOW_STOCK }); });
    // Your books, face up and overlapping: the ace of clubs stands for a book of aces, and so on.
    var step = Math.min(g.cw * BOOK_STEP, (g.W - g.pad - p.books.x - g.cw) / Math.max(1, st.books[V].length - 1));
    st.books[V].forEach(function (rank, k) {
      cards.push({ id: Z.make(rank, 0), pile: 'book', idx: k, x: Math.round(p.books.x + k * step), y: p.books.y, up: true });
    });
    return { height: m.H, slots: slots, cards: cards };
  }

  var api = {
    BOOK: BOOK, REFILL: REFILL, dealSize: dealSize, newGame: deal, canAsk: canAsk, ask: ask, aiAsk: aiAsk, targets: targets, outcome: outcome, count: count, ranksIn: ranksIn,
    bookTotal: bookTotal, geo: geo, place: place
  };
  root.ZimiGoFish = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 900, THEN_MS = 700;
  function boot() {
    var t, board, session, view = { flash: '', pending: null, viewer: 0 }, players = DEFAULT_PLAYERS, seats = {};
    function buildSeats(n) {
      var cur = Seats.create({ id: 'gofish', seats: n, onChange: function () { if (t) t.paint(); if (board) board.refresh(); } });
      Object.keys(cur).forEach(function (k) { seats[k] = cur[k]; });
    }
    buildSeats(players);
    var count = Z.h('div', { class: 'gf-count' });
    Z.pageEls().table.appendChild(count);
    var name = function (seat) { return seats.name(seat); };
    function syncView(st) { view.viewer = seats.view(); view.hideHand = seats.hotseat() && st.turn !== view.viewer; }
    function repaint() { board.refresh(); t.paint(); }
    var rankWord = function (r) { return TX('cards.rank.' + r); };
    var cardsOf = function (n) { return Z.plural(n, 'card'); };

    // What the last ask came to, as the status line says it: the ask, what came of it, and any book it finished.
    function said(st) {
      var l = st.last;
      if (!l) return '';
      var me = seats.view(), you = seats.isYou(l.seat), asked = l.target === me && !seats.hotseat();
      var ask = TX(you ? 'gofish.ask.you' : asked ? 'gofish.ask.ofYou' : 'gofish.ask', { name: name(l.seat), target: name(l.target), rank: rankWord(l.rank) });
      var result = l.got ? TX('gofish.handed', { cards: cardsOf(l.got) }) : l.empty ? TX('gofish.none') : TX(l.lucky ? 'gofish.lucky' : 'gofish.fish');
      var out = you && !seats.hotseat() ? result : TX('cards.then', { first: ask, then: result });
      l.books.forEach(function (b) { out = TX('cards.then', { first: out, then: TX(seats.isYou(b.seat) ? 'gofish.book.you' : 'gofish.book', { name: name(b.seat), rank: rankWord(b.rank) }) }); });
      return out;
    }
    // The stock's count sits above the pile, where the eye is when it is time to fish.
    function paintCount(st) {
      var m = board.metrics();
      if (!m) return;
      var g = geo(m, st), p = piles(g);
      count.style.left = Math.round(p.stock.x + g.cw / 2) + 'px'; count.style.top = Math.round(p.stock.y - COUNT_RISE) + 'px';
      count.textContent = String(st.stock.length);
      count.setAttribute('aria-label', TX('gin.stock', { cards: cardsOf(st.stock.length) }));
    }
    function hud(st) {
      paintCount(st);
      var chips = st.hands.map(function (h, seat) { return { name: name(seat), text: String(st.books[seat].length), turn: st.phase === 'play' && st.turn === seat }; });
      var out = { chips: chips, text: '' };
      var note = said(st), lead = function (text) { return note ? TX('cards.then', { first: note, then: text }) : text; };
      if (st.phase === 'over') { out.text = TX('shell.end.over'); out.label = TX('shell.menu.new'); out.action = newGame; return out; }
      if (!seats.person(st.turn)) { out.text = lead(TX('cards.thinking', { name: name(st.turn) })); return out; }
      if (st.turn !== seats.view()) { out.text = lead(TX('cards.turn.name', { name: name(st.turn) })); return out; }
      if (view.pending !== null) {
        out.text = TX('gofish.whom', { rank: rankWord(view.pending) });
        out.choices = targets(st, st.turn).map(function (tg) { return { label: name(tg), onclick: function () { askNow(tg); } }; });
        out.choices.push({ label: TX('shell.cancel'), onclick: function () { view.pending = null; repaint(); } });
        return out;
      }
      out.text = note ? lead(TX(seats.isYou(st.turn) ? 'cards.turn.you' : 'cards.turn.name', { name: name(st.turn) })) : TX(seats.isYou(st.turn) ? 'gofish.pick' : 'gofish.pick.name', { name: name(st.turn) });
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'over') { gameOver(); return; }
      if (!seats.person(st.turn)) session.later(aiTurn, AI_MS);
      else seats.ensure(st.turn, repaint);
    }
    function aiTurn() {
      var st = session.state;
      if (st.phase !== 'play' || seats.person(st.turn)) return;
      var mv = aiAsk(st, st.turn);
      if (!mv) return;
      session.follow(ask(st, st.turn, mv.target, mv.rank));
      drive();
    }
    function gameOver() {
      var st = session.state, r = st.result, me = seats.view(), hot = seats.hotseat();
      var mine = st.books[me].length, lines = [TX('gofish.final', { list: st.books.map(function (b, s) { return name(s) + ' ' + b.length; }).join(' · ') })];
      var iWon = r.winners.indexOf(me) >= 0, tied = r.winners.length > 1;
      if (iWon && !tied && !hot) session.win(mine);
      else if (tied) session.lose('draw', [TX('gofish.tied', { names: r.winners.map(name).join(' · ') })].concat(lines), mine);
      else session.lose(hot ? { name: name(r.winners[0]) } : '', [TX('gofish.won', { name: name(r.winners[0]), n: r.most })].concat(lines), mine);
    }
    function askNow(target) {
      var st = session.state, rank = view.pending;
      if (rank === null || !canAsk(st, seats.view(), target, rank)) return false;
      view.pending = null;
      session.commit(ask(st, seats.view(), target, rank));
      drive();
      return true;
    }
    function tapHand(id) {
      var st = session.state, me = seats.view();
      if (st.phase !== 'play') return false;
      if (st.turn !== me) { t.flash(TX('cards.wait.turn')); return false; }
      var rank = rankOf(id), opp = targets(st, me);
      if (!opp.length) return false;
      if (opp.length === 1) { view.pending = rank; return askNow(opp[0]); }
      view.pending = view.pending === rank ? null : rank;
      repaint();
      return true;
    }
    function tapOpponent(pile) {
      var st = session.state, me = seats.view(), pos = parseInt(pile.slice(1), 10), seat = -1, r;
      for (r = 1; r < st.players; r++) if (T.SEAT_POS[st.players][r] === pos) seat = (me + r) % st.players;
      if (seat < 0 || st.phase !== 'play' || st.turn !== me) return false;
      if (view.pending === null) { t.flash(TX('gofish.pickFirst')); return false; }
      return askNow(seat);
    }
    function tap(pile) {
      if (pile.charAt(0) === 'h') { var id = parseInt(pile.slice(1), 10); return isNaN(id) ? false : tapHand(id); }
      if (/^p\d$/.test(pile)) return tapOpponent(pile);
      return false;
    }
    function newGame() {
      players = Z.store.get(PLAYERS_KEY, DEFAULT_PLAYERS);
      if (players !== 2 && players !== 3 && players !== 4) players = DEFAULT_PLAYERS;
      buildSeats(players);
      view.flash = ''; view.pending = null;
      session.reset(deal(Z.shuffled(Math.random), players, Math.floor(Math.random() * players)));
      seats.begin(function () { repaint(); drive(); }, session.state.turn);
    }
    t = T.create({
      id: 'gofish', name: 'Go Fish', seats: seats, view: view, geo: geo, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: newGame, tap: tap,
      slotTap: function (pile) { if (pile === 'stock') t.flash(TX('gofish.stockTap')); },
      canPick: function () { return false; },
      stat: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.books[seats.view()].length; },
      cascadeOrder: function (st) { return st.books[seats.view()].map(function (r) { return { id: Z.make(r, 0) }; }); },
      winLines: function (sec, st) { return [TX('gofish.final', { list: st.books.map(function (b, s) { return name(s) + ' ' + b.length; }).join(' · ') })]; },
      menuExtra: function () {
        return [T.choiceRow(TX('cards.seatsAtTable'), PLAYERS_KEY, [{ value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }], DEFAULT_PLAYERS, function () {}),
          Z.h('p', { class: 'zc-note', text: TX('ce.seatsNote') })];
      },
      rules: TX('gofish.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    newGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
