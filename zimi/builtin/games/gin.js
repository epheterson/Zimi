/* ZimiGames: Gin Rummy. You (south) against North. Ten cards each. Melds are
   sets (three or four of a rank) and runs (three or more of a suit in a row,
   ace low). Every turn: draw from the stock or take the top discard, then
   discard one card. Unmatched cards are deadwood (ace 1, face cards 10, the
   rest their number). When your deadwood is 10 or less you may knock; with
   none you go gin. The other side lays off cards on the knocker's melds
   (not against gin) and counts what is left. The knocker scores the
   difference; if the other side has as little or less, that is an undercut:
   they score the difference plus 25. Gin scores 25 plus the other side's
   deadwood. If the stock is down to two cards after a discard the hand is
   a draw. First to 100 wins, with 100 for the game and 25 for every hand won.

   State: hands[2], stock, discard (top is last), dealer, turn, phase ('offer'
   | 'draw' | 'discard' | 'show'), offerStep (0 non-dealer, 1 dealer), upLocked
   (after two passes the first draw is from the stock), scores[2], boxes[2],
   handNo, picked[2] (cards each took from the discard this hand), drawn (the
   card the player to act just took from the discard: it cannot go straight
   back), last (what just happened), result (set when the hand ends), final
   (set when the game ends). Seats: 0 you, 1 North. Pure functions; the page
   wiring at the bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var HAND = 10, KNOCK_MAX = 10, GIN_BONUS = 25, UNDERCUT_BONUS = 25, GAME_END = 100, GAME_BONUS = 100, BOX_BONUS = 25, MIN_STOCK = 2;
  var NAMES = [TX('cards.you'), root.ZimiText.ZIMI], FACE_VALUE = 10, SET_MAX = 4, RUN_MIN = 3;
  var AI_KNOCK_EARLY = 6, AI_KNOCK_LATE = 10, LATE_STOCK = 12;
  var val = function (id) { return Math.min(FACE_VALUE, Z.rank(id)); };
  var sumVal = function (ids) { return ids.reduce(function (n, c) { return n + val(c); }, 0); };
  var rankOrder = function (a, b) { return Z.rank(a) - Z.rank(b) || Z.suit(a) - Z.suit(b); };

  // ── Melds ───────────────────────────────────────────────────────────────
  // Every possible meld among `cards`, as bit masks over their positions.
  function meldMasks(cards) {
    var masks = [], byRank = {}, bySuit = {}, a, b, c;
    cards.forEach(function (id, i) {
      (byRank[Z.rank(id)] = byRank[Z.rank(id)] || []).push(i);
      (bySuit[Z.suit(id)] = bySuit[Z.suit(id)] || []).push(i);
    });
    Object.keys(byRank).forEach(function (r) {
      var g = byRank[r];
      if (g.length < 3) return;
      for (a = 0; a < g.length; a++) for (b = a + 1; b < g.length; b++) for (c = b + 1; c < g.length; c++) masks.push((1 << g[a]) | (1 << g[b]) | (1 << g[c]));
      if (g.length === SET_MAX) masks.push(g.reduce(function (m, i) { return m | (1 << i); }, 0));
    });
    Object.keys(bySuit).forEach(function (s) {
      var g = bySuit[s].sort(function (x, y) { return Z.rank(cards[x]) - Z.rank(cards[y]); }), i, j;
      for (i = 0; i < g.length; i++) {
        var m = 1 << g[i], len = 1;
        for (j = i + 1; j < g.length && Z.rank(cards[g[j]]) === Z.rank(cards[g[j - 1]]) + 1; j++) { m |= 1 << g[j]; len++; if (len >= RUN_MIN) masks.push(m); }
      }
    });
    return masks;
  }
  // The meld partition with the least deadwood: { melds: [[ids]], dead: [ids], dw }.
  function bestMelds(cards) {
    var n = cards.length, masks = meldMasks(cards), full = (1 << n) - 1, memo = {};
    function go(used) {
      if (used === full) return { dw: 0, melds: [] };
      if (memo[used]) return memo[used];
      var i = 0;
      while (used & (1 << i)) i++;
      var rest = go(used | (1 << i)), best = { dw: rest.dw + val(cards[i]), melds: rest.melds };
      masks.forEach(function (m) {
        if (((m >> i) & 1) && !(m & used)) { var r = go(used | m); if (r.dw < best.dw) best = { dw: r.dw, melds: r.melds.concat([m]) }; }
      });
      memo[used] = best;
      return best;
    }
    var res = go(0), inMeld = 0;
    var melds = res.melds.map(function (m) {
      inMeld |= m;
      return cards.filter(function (c, i) { return (m >> i) & 1; }).sort(rankOrder);
    }).sort(function (x, y) { return rankOrder(x[0], y[0]); });
    var dead = cards.filter(function (c, i) { return !((inMeld >> i) & 1); }).sort(rankOrder);
    return { melds: melds, dead: dead, dw: res.dw };
  }
  var deadwood = function (cards) { return bestMelds(cards).dw; };

  // Can `c` join this meld? A set of three takes the fourth; a run either end.
  function canExtend(meld, c) {
    var rs = meld.map(Z.rank), r = Z.rank(c);
    if (rs.every(function (x) { return x === rs[0]; })) return meld.length < SET_MAX && r === rs[0];
    if (Z.suit(c) !== Z.suit(meld[0])) return false;
    return r === Math.min.apply(null, rs) - 1 || r === Math.max.apply(null, rs) + 1;
  }
  // Lay `cards` off on `melds` as far as they go: { melds (grown), laid, rest }.
  function layOff(melds, cards) {
    var m = melds.map(function (x) { return x.slice(); }), rest = cards.slice(), laid = [], moved = true;
    while (moved) {
      moved = false;
      for (var i = 0; i < rest.length && !moved; i++) {
        for (var k = 0; k < m.length && !moved; k++) {
          if (canExtend(m[k], rest[i])) { m[k].push(rest[i]); m[k].sort(rankOrder); laid.push(rest[i]); rest.splice(i, 1); moved = true; }
        }
      }
    }
    return { melds: m, laid: laid, rest: rest };
  }

  // The show: the knocker's ten cards against the other side's ten.
  function showdown(knock, other) {
    var k = bestMelds(knock), o = bestMelds(other), gin = k.dw === 0, off = gin ? { melds: k.melds, laid: [], rest: o.dead } : layOff(k.melds, o.dead);
    var oDw = sumVal(off.rest), r = { gin: gin, kDw: k.dw, oDw: oDw, oDwBefore: o.dw, kMelds: off.melds, kDead: k.dead, oMelds: o.melds, laid: off.laid, oRest: off.rest, undercut: false };
    if (gin) { r.winner = 'knocker'; r.points = GIN_BONUS + oDw; } else if (k.dw < oDw) { r.winner = 'knocker'; r.points = oDw - k.dw; } else { r.winner = 'other'; r.undercut = true; r.points = k.dw - oDw + UNDERCUT_BONUS; }
    return r;
  }

  // ── Rules ───────────────────────────────────────────────────────────────
  function dealHand(order, handNo, scores, boxes, dealer) {
    var up = order[2 * HAND];
    return {
      hands: [order.slice(0, HAND), order.slice(HAND, 2 * HAND)], stock: order.slice(2 * HAND + 1), discard: [up], dealer: dealer, turn: 1 - dealer, phase: 'offer', offerStep: 0,
      upLocked: false, scores: scores.slice(), boxes: boxes.slice(), handNo: handNo, picked: [[], []], drawn: null, last: null, result: null, final: null, moves: 0
    };
  }
  function freshGame(order, dealer) { return dealHand(order, 0, [0, 0], [0, 0], dealer === undefined ? 1 : dealer); }
  function nextHand(st, order) { return dealHand(order, st.handNo + 1, st.scores, st.boxes, 1 - st.dealer); }

  var other = function (seat) { return 1 - seat; };
  function takeUp(st) {
    var s = Z.clone(st), seat = s.turn, c = s.discard.pop();
    s.hands[seat].push(c); s.picked[seat].push(c); s.phase = 'discard'; s.drawn = c; s.offerStep = 0; s.moves++;
    s.last = { seat: seat, act: 'took', id: c };
    return s;
  }
  function passUp(st) {
    var s = Z.clone(st);
    s.last = { seat: s.turn, act: 'passed' }; s.moves++;
    if (s.offerStep === 0) { s.offerStep = 1; s.turn = other(s.turn); } else { s.phase = 'draw'; s.turn = 1 - s.dealer; s.upLocked = true; }
    return s;
  }
  function canDraw(st, fromDiscard) {
    if (st.phase !== 'draw') return false;
    return fromDiscard ? !st.upLocked && st.discard.length > 0 : st.stock.length > 0;
  }
  function drawCard(st, fromDiscard) {
    var s = Z.clone(st), seat = s.turn, c = fromDiscard ? s.discard.pop() : s.stock.pop();
    s.hands[seat].push(c); s.phase = 'discard'; s.drawn = fromDiscard ? c : null; s.upLocked = false; s.moves++;
    if (fromDiscard) s.picked[seat].push(c);
    s.last = { seat: seat, act: fromDiscard ? 'took' : 'drew', id: c };
    return s;
  }
  function canDiscard(st, id) { return st.phase === 'discard' && st.hands[st.turn].indexOf(id) >= 0 && st.drawn !== id; }
  function discardCard(st, id) {
    var s = Z.clone(st), seat = s.turn;
    s.hands[seat].splice(s.hands[seat].indexOf(id), 1);
    s.discard.push(id); s.drawn = null; s.moves++;
    s.last = { seat: seat, act: 'discarded', id: id };
    if (s.stock.length <= MIN_STOCK) { s.phase = 'show'; s.result = { draw: true, display: [arrange(s.hands[0]), arrange(s.hands[1])], laid: [] }; return s; }
    s.phase = 'draw'; s.turn = other(seat);
    return s;
  }
  // Knocking: the card goes down and the hands are shown. Deadwood after it must be 10 or less.
  function canKnock(st, id) { return canDiscard(st, id) && deadwood(st.hands[st.turn].filter(function (c) { return c !== id; })) <= KNOCK_MAX; }
  function knock(st, id) {
    var s = Z.clone(st), k = s.turn, o = other(k);
    s.hands[k].splice(s.hands[k].indexOf(id), 1);
    s.discard.push(id); s.drawn = null; s.moves++;
    var r = showdown(s.hands[k], s.hands[o]), w = r.winner === 'knocker' ? k : o;
    r.knocker = k; r.scorer = w;
    // What the table shows: each side's melds (the knocker's grown by the laid-off cards), then the deadwood.
    var kGroups = r.kMelds.concat(r.kDead.length ? [r.kDead] : []);
    var oGroups = r.oMelds.concat(r.oRest.length ? [r.oRest] : []);
    r.display = k === 0 ? [kGroups, oGroups] : [oGroups, kGroups];
    s.result = r;
    s.scores[w] += r.points; s.boxes[w]++;
    s.last = { seat: k, act: r.gin ? 'gin' : 'knocked', id: id };
    s.phase = 'show';
    finishGame(s);
    return s;
  }
  // The game ends at 100: the 100 for the game and 25 a hand won are added up.
  function finishGame(s) {
    var top = s.scores.map(function (v) { return v >= GAME_END; });
    if (!top[0] && !top[1]) return;
    var w = top[0] && top[1] ? (s.scores[0] >= s.scores[1] ? 0 : 1) : top[0] ? 0 : 1;
    var totals = s.scores.map(function (v, i) { return v + s.boxes[i] * BOX_BONUS + (i === w ? GAME_BONUS : 0); });
    s.final = { winner: w, totals: totals };
  }

  // The hand as the table shows it: melds first, deadwood last.
  function arrange(hand) {
    var b = bestMelds(hand);
    return b.melds.concat(b.dead.length ? [b.dead] : []);
  }
  // What each discard would leave: { id, dw }.
  function discardOptions(hand) {
    return hand.map(function (c) { return { id: c, dw: deadwood(hand.filter(function (x) { return x !== c; })) }; });
  }

  // ── The computer player ─────────────────────────────────────────────────
  // Close to a card means it is a pair of the rank or a neighbour of the suit.
  var near = function (a, b) { return a !== b && (Z.rank(a) === Z.rank(b) || (Z.suit(a) === Z.suit(b) && Math.abs(Z.rank(a) - Z.rank(b)) <= 2)); };
  function wantsUp(hand, up) {
    var b = bestMelds(hand.concat([up]));
    return b.dead.indexOf(up) < 0;
  }
  function chooseDiscard(st, seat) {
    var hand = st.hands[seat], foe = st.picked[other(seat)], best = null, bestScore = Infinity;
    hand.forEach(function (c) {
      if (c === st.drawn) return;
      var rest = hand.filter(function (x) { return x !== c; }), dw = deadwood(rest);
      var potential = rest.filter(function (x) { return near(c, x); }).length, risky = foe.some(function (p) { return near(c, p); }) ? 1 : 0;
      var score = dw * 1000 + potential * 30 + risky * 50 - val(c);
      if (score < bestScore) { bestScore = score; best = { id: c, dw: dw }; }
    });
    return best;
  }
  // One move for whoever is to act, by the computer's rules.
  function aiStep(st) {
    var seat = st.turn, hand = st.hands[seat];
    if (st.phase === 'offer') return wantsUp(hand, st.discard[st.discard.length - 1]) ? takeUp(st) : passUp(st);
    if (st.phase === 'draw') {
      var up = st.discard[st.discard.length - 1];
      return canDraw(st, true) && wantsUp(hand, up) ? drawCard(st, true) : drawCard(st, false);
    }
    var pick = chooseDiscard(st, seat);
    if (pick.dw === 0 || pick.dw <= AI_KNOCK_EARLY || (pick.dw <= AI_KNOCK_LATE && st.stock.length <= LATE_STOCK)) return knock(st, pick.id);
    return discardCard(st, pick.id);
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var GROUP_GAP_SHARE = 0.55; // a clear space between melds and deadwood
  function geo(m, st) { var g = T.geometry(m, T.rowsFor(m, st.hands[0].length)); g.gapShare = GROUP_GAP_SHARE; return g; }
  var cardIn = function (list, id) { return list.indexOf(id) >= 0; };
  // Cards in group order and a lookup of which group each belongs to.
  function flatten(groups) {
    var ids = [], group = {};
    groups.forEach(function (g, gi) { g.forEach(function (c) { ids.push(c); group[c] = gi; }); });
    return { ids: ids, gap: function (a, b) { return group[a] !== group[b]; } };
  }
  function place(st, m, view) {
    var V = (view && view.viewer) || 0, O = 1 - V, faceUp = !(view && view.hideHand);
    var g = geo(m, st), slots = [], cards = [], show = st.phase === 'show', sel = view && st.hands[V].indexOf(view.sel) >= 0 ? view.sel : null;
    var sx = Math.round(g.cx - g.cw - 8), dx = Math.round(g.cx + 8), y = Math.round(g.cy - g.ch / 2), turnMine = st.turn === V && !show && faceUp;
    slots.push({ id: 'stock', x: sx, y: y, w: g.cw, h: g.ch, label: TX('gin.stock', { cards: Z.plural(st.stock.length, 'card') }) });
    slots.push({ id: 'discard', x: dx, y: y, w: g.cw, h: g.ch, label: st.discard.length ? TX('gin.discardTop', { card: Z.cardName(st.discard[st.discard.length - 1]) }) : TX('gin.discardEmpty') });
    var canStock = turnMine && canDraw(st, false), canUp = turnMine && ((st.phase === 'draw' && canDraw(st, true)) || st.phase === 'offer');
    st.stock.forEach(function (id, k) { cards.push({ id: id, pile: 'stock', idx: k, x: sx, y: y, up: false, glow: canStock && k === st.stock.length - 1 }); });
    st.discard.forEach(function (id, k) { cards.push({ id: id, pile: 'discard', idx: k, x: dx, y: y, up: true, glow: canUp && k === st.discard.length - 1, dim: turnMine && st.phase === 'draw' && st.upLocked && k === st.discard.length - 1 }); });
    var mine = show ? flatten(st.result.display[V]) : flatten(arrange(st.hands[V])), laid = show ? st.result.laid : [];
    var hand = T.handCards(g, mine.ids, function (id) {
      var chosen = id === sel;
      return { up: faceUp || show, raise: chosen, mark: chosen, glow: cardIn(laid, id) || (faceUp && st.last && st.last.seat === V && st.last.id === id && st.phase === 'discard'), dim: turnMine && st.phase === 'discard' && st.drawn === id,
        label: Z.cardName(id) + (chosen ? TX('gin.aria.chosen') : '') };
    }, mine.gap);
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    if (show) {
      var theirs = flatten(st.result.display[O]), top = Object.assign({}, g, { southY: g.northY, rows: 1 });
      var row = T.handCards(top, theirs.ids, function (id) { return { glow: cardIn(laid, id) }; }, theirs.gap, 'o');
      cards = cards.concat(row.cards); slots = slots.concat(row.slots);
    } else cards = cards.concat(T.fan(g, 2, st.hands[O], false));
    return { height: m.H, slots: slots, cards: cards };
  }

  var api = {
    NAMES: NAMES, GAME_END: GAME_END, val: val, bestMelds: bestMelds, deadwood: deadwood, canExtend: canExtend, layOff: layOff, showdown: showdown,
    dealHand: dealHand, newGame: freshGame, nextHand: nextHand, takeUp: takeUp, passUp: passUp, canDraw: canDraw, drawCard: drawCard, canDiscard: canDiscard,
    discardCard: discardCard, canKnock: canKnock, knock: knock, arrange: arrange, discardOptions: discardOptions, wantsUp: wantsUp, chooseDiscard: chooseDiscard, aiStep: aiStep,
    geo: geo, place: place
  };
  root.ZimiGin = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 700, NOTE_MS = 1400;
  function boot() {
    var t, board, session, view = { sel: null, flash: '', viewer: 0, hideHand: false };
    // Each seat is the Computer or a Person; two people share the screen behind a handoff.
    var seats = Seats.create({ id: 'gin', seats: 2, onChange: function () { if (board) board.refresh(); if (t) t.paint(); } });
    function syncView(st) { view.viewer = seats.view(); view.hideHand = seats.hotseat() && st.phase !== 'show' && st.turn !== view.viewer; }
    var who = function (s) { return seats.name(s); };
    // A line about a seat: the key's .you form is for "You".
    var said = function (s, key, vars) { var v = vars || {}; v.name = who(s); return TX(seats.isYou(s) ? key + '.you' : key, v); };
    var glyphName = function (id) { return T.short(id); };
    function noteOf(st) {
      var l = st.last;
      if (!l || seats.isYou(l.seat) || l.seat === st.turn) return '';
      var n = who(l.seat);
      return { took: TX('gin.note.took', { name: n, card: glyphName(l.id) }), drew: TX('gin.note.drew', { name: n }), discarded: TX('gin.note.discarded', { name: n, card: glyphName(l.id) }), passed: TX('euchre.passed', { name: n }), knocked: TX('gin.note.knocked', { name: n }), gin: TX('gin.note.gin', { name: n }) }[l.act] || '';
    }
    function resultLines(st) {
      var r = st.result, lines = [];
      if (r.draw) return [{ text: TX('gin.draw') }];
      var ko = 1 - r.knocker;
      lines.push({ text: r.gin ? said(r.knocker, 'gin.goGin') : said(r.knocker, 'gin.knockWith', { dw: r.kDw }) });
      if (!r.gin) lines.push({ text: r.laid.length ? said(ko, 'gin.deadwoodLaid', { before: r.oDwBefore, after: r.oDw, cards: T.shortList(r.laid) }) : said(ko, 'gin.deadwood', { n: r.oDwBefore }) });
      else lines.push({ text: said(ko, 'gin.deadwood', { n: r.oDw }) });
      lines.push({ cls: 'ct-total', text: (r.undercut ? TX('gin.undercut') + ' ' : '') + said(r.scorer, r.gin ? 'gin.scoreGin' : r.undercut ? 'gin.scoreUndercut' : 'gin.score', { points: r.points }) });
      return lines;
    }
    function hud(st) {
      syncView(st);
      var V = view.viewer, sel = st.hands[V].indexOf(view.sel) >= 0 ? view.sel : null, mine = st.phase === 'show' || view.hideHand ? null : st.hands[V];
      var dwNow = mine ? (mine.length === HAND ? deadwood(mine) : Math.min.apply(null, discardOptions(mine).filter(function (o) { return o.id !== st.drawn; }).map(function (o) { return o.dw; }))) : null;
      var chips = [0, 1].map(function (s) {
        return { name: who(s), text: String(st.scores[s]), dealer: st.dealer === s, turn: st.phase !== 'show' && st.turn === s };
      });
      var out = { chips: chips, fact: TX('gin.fact', { n: st.handNo + 1, a: st.boxes[0], b: st.boxes[1] }), text: '' }, note = noteOf(st), top = st.discard[st.discard.length - 1];
      if (st.phase === 'show') {
        out.lines = resultLines(st);
        if (st.final) { out.label = TX('crib.result'); out.action = gameOver; out.text = TX('shell.end.over'); } else { out.label = TX('cards.nextHand'); out.action = startNextHand; out.text = TX('cards.handEnd'); }
      } else if (!seats.person(st.turn)) out.text = note && st.phase !== 'offer' ? note + ' ' + TX('cards.thinking', { name: who(st.turn) }) : TX('cards.thinking', { name: who(st.turn) });
      else if (view.hideHand) out.text = TX('cards.turn.name', { name: who(st.turn) });
      else if (st.phase === 'offer') {
        out.text = (note ? note + ' ' : '') + TX('gin.takeOrPass', { card: glyphName(top) });
        out.choices = [{ label: TX('gin.take', { card: glyphName(top) }), onclick: takeNow, cls: top && Z.isRed(top) ? 'ct-red' : '' }, { label: TX('cards.pass'), onclick: passNow }];
      } else if (st.phase === 'draw') {
        out.text = (note ? note + ' ' : '') + (st.upLocked ? TX('gin.drawStock') : TX('gin.yourDraw', { card: glyphName(top) }));
      } else {
        var opts = sel !== null ? deadwood(st.hands[V].filter(function (c) { return c !== sel; })) : null, can = sel !== null && canDiscard(st, sel);
        out.text = sel === null ? TX('gin.pick', { n: dwNow }) : TX('gin.without', { card: glyphName(sel), n: opts });
        if (sel !== null) {
          out.choices = [{ label: TX('gin.discard', { card: glyphName(sel) }), onclick: discardNow, disabled: !can }];
          if (can && opts <= KNOCK_MAX) out.choices.push({ label: opts === 0 ? TX('gin.goGinBtn') : TX('gin.knock', { n: opts }), onclick: knockNow, primary: true });
        }
      }
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'show') { session.later(function () { if (session.state.phase === 'show') showEnd(); }, 0); return; }
      if (seats.person(st.turn)) seats.ensure(st.turn, refresh); else session.later(aiTurn, st.last && seats.person(st.last.seat) ? AI_MS : NOTE_MS / 2);
    }
    function refresh() { board.refresh(); t.paint(); }
    function showEnd() { /* the table and its lines stay up; the button moves on */ }
    function aiTurn() {
      var st = session.state;
      if (st.phase === 'show' || seats.person(st.turn)) return;
      session.follow(aiStep(st));
      drive();
    }
    function startNextHand() {
      var st = session.state;
      if (st.phase !== 'show' || st.final) return;
      session.history = []; view.sel = null;
      session.follow(nextHand(st, Z.shuffled(Math.random)));
      deal();
    }
    function gameOver() {
      var st = session.state, f = st.final, lines = [TX('gin.handsWon', { a: who(0), pa: st.boxes[0], b: who(1), pb: st.boxes[1] }), TX('gin.bonus', { name: who(f.winner) }), TX('gin.final', { a: who(0), pa: f.totals[0], b: who(1), pb: f.totals[1] })];
      if (seats.hotseat()) session.lose({ name: who(f.winner) }, lines);
      else if (f.winner === 0) session.win(f.totals[0]); else session.lose('', lines, f.totals[0]);
    }
    function act(next) { view.sel = null; session.commit(next); drive(); return true; }
    function takeNow() { var st = session.state; if (st.phase === 'offer' && st.turn === seats.view()) act(takeUp(st)); }
    function passNow() { var st = session.state; if (st.phase === 'offer' && st.turn === seats.view()) act(passUp(st)); }
    function discardNow() { var st = session.state; if (view.sel !== null && canDiscard(st, view.sel) && st.turn === seats.view()) act(discardCard(st, view.sel)); }
    function knockNow() { var st = session.state; if (view.sel !== null && canKnock(st, view.sel) && st.turn === seats.view()) act(knock(st, view.sel)); }
    function tap(pile) {
      var st = session.state, id = parseInt(pile.slice(1), 10);
      if (st.phase === 'show' || st.turn !== seats.view()) { if (st.phase !== 'show') t.flash(TX('cards.wait.turn')); return false; }
      if (pile === 'stock') { if (!canDraw(st, false)) { t.flash(st.phase === 'draw' ? TX('gin.stockEmpty') : TX('gin.discardFirst')); return false; } return act(drawCard(st, false)); }
      if (pile === 'discard') {
        if (st.phase === 'offer') return act(takeUp(st));
        if (st.phase !== 'draw') { t.flash(TX('gin.discardFirst')); return false; }
        if (!canDraw(st, true)) { t.flash(TX('gin.drawFirst')); return false; }
        return act(drawCard(st, true));
      }
      if (pile.charAt(0) !== 'h' || isNaN(id)) return false;
      if (st.phase !== 'discard') { t.flash(st.phase === 'offer' ? TX('gin.offerFirst') : TX('gin.drawCardFirst')); return false; }
      if (st.drawn === id) { t.flash(TX('gin.justTook')); return false; }
      view.sel = view.sel === id ? null : id; board.refresh(); t.paint();
      return true;
    }
    function newGame() {
      view.sel = null; view.flash = '';
      session.reset(freshGame(Z.shuffled(Math.random), Math.floor(Math.random() * 2)));
      deal();
    }
    // A fresh deal: nobody has seen it, so two people start at a handoff.
    function deal() { seats.begin(function () { refresh(); drive(); }, session.state.turn); }

    t = T.create({
      id: 'gin', name: 'Gin Rummy', seats: seats, view: view, geo: geo, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: newGame, tap: tap, cols: 7, heightShare: 0.11,
      canPick: function (st, pile) { return st.phase === 'discard' && st.turn === seats.view() && pile.charAt(0) === 'h'; },
      move: function (pile, idx, to) {
        var st = session.state, id = parseInt(pile.slice(1), 10);
        if ((to !== 'discard' && to !== 'stock') || pile.charAt(0) !== 'h' || !canDiscard(st, id)) return false;
        view.sel = id; return act(discardCard(st, id));
      },
      // The scores are on the table; a clock that only counts a match has no place in the bar.
      stat: function () { return ''; },
      cascadeOrder: function (st) { return st.hands[seats.view()].map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { var f = st.final; return [TX('gin.handsWon', { a: TX('cards.you'), pa: st.boxes[0], b: root.ZimiText.ZIMI, pb: st.boxes[1] }), TX('gin.bonus.you'), TX('gin.final', { a: TX('cards.you'), pa: f.totals[0], b: root.ZimiText.ZIMI, pb: f.totals[1] })]; },
      rules: TX('gin.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    newGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
