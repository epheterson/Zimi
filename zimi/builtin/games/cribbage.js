/* ZimiGames: Cribbage. You (south) against North, to 121 points on a peg
   board drawn here. Each hand: six cards each, two go to the dealer's crib,
   the starter is cut (a jack gives the dealer 2: his heels), then the
   pegging: play cards by turns to a count of 31 (15 and 31 score 2, pairs
   2/6/12, runs of three or more 3 and up, a go or the last card 1), then the
   show: the player who did not deal counts first, then the dealer's hand,
   then the crib. Fifteens 2 each, pairs 2, runs 1 a card, a flush of four 4
   (five with the starter 5; the crib needs all five), nobs 1 (a jack in hand
   of the starter's suit).

   State: hands[2] (before the discard), crib, dealer, starter, cut, kept[2]
   (the four each keeps, for the show), pegHands[2] (still to play), seq
   [{seat, id}] (the count so far), count, goes, turn, lastPlayer, roundOver
   (null | '31' | 'go'), phase ('discard' | 'cut' | 'peg' | 'show' | 'over'),
   scores[2], prev[2] (the back pegs), showStep (0 pone, 1 dealer, 2 crib),
   showWho, showRes, handNo, msg, winner. Seats: 0 you, 1 North. Pure
   functions; the page wiring at the bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;
  // Two sentences, joined the way the language joins them.
  var then = function (first, next) { return first ? TX('cards.then', { first: first, then: next }) : next; };

  var NAMES = [TX('cards.you'), root.ZimiText.ZIMI], GOAL = 121, KEPT = 4, DEAL = 6, TARGET = 31, FIFTEEN = 15, HEELS_RANK = 11, SKUNK = 91;
  var cardVal = function (id) { return Math.min(10, Z.rank(id)); };
  var byRank = function (ids) { return ids.slice().sort(function (a, b) { return Z.rank(a) - Z.rank(b) || a - b; }); };
  var other = function (seat) { return 1 - seat; };

  // ── Scoring a hand ──────────────────────────────────────────────────────
  function subsets(list, size) {
    var out = [];
    (function pick(start, chosen) {
      if (chosen.length === size) { out.push(chosen.slice()); return; }
      for (var i = start; i < list.length; i++) { chosen.push(list[i]); pick(i + 1, chosen); chosen.pop(); }
    })(0, []);
    return out;
  }
  function isRunOf(ids) {
    var r = ids.map(Z.rank).sort(function (a, b) { return a - b; });
    for (var i = 1; i < r.length; i++) if (r[i] !== r[i - 1] + 1) return false;
    return true;
  }
  // The hand's points with the reasons, line by line. `cards` are the four held
  // (or the crib's four), `starter` the cut card.
  function scoreHand(cards, starter, isCrib) {
    var all = cards.concat([starter]), items = [], i, k;
    for (k = 2; k <= 5; k++) subsets(all, k).forEach(function (c) {
      if (c.reduce(function (n, x) { return n + cardVal(x); }, 0) === FIFTEEN) items.push({ kind: 'fifteen', cards: byRank(c), pts: 2 });
    });
    subsets(all, 2).forEach(function (c) { if (Z.rank(c[0]) === Z.rank(c[1])) items.push({ kind: 'pair', cards: c, pts: 2 }); });
    for (k = 5; k >= 3; k--) {
      var runs = subsets(all, k).filter(isRunOf);
      if (runs.length) { runs.forEach(function (c) { items.push({ kind: 'run', cards: byRank(c), pts: k }); }); break; }
    }
    var suit = Z.suit(cards[0]);
    if (cards.every(function (c) { return Z.suit(c) === suit; })) {
      if (Z.suit(starter) === suit) items.push({ kind: 'flush', cards: all, pts: 5 });
      else if (!isCrib) items.push({ kind: 'flush', cards: cards.slice(), pts: 4 });
    }
    for (i = 0; i < cards.length; i++) if (Z.rank(cards[i]) === HEELS_RANK && Z.suit(cards[i]) === Z.suit(starter)) items.push({ kind: 'nobs', cards: [cards[i]], pts: 1 });
    return { total: items.reduce(function (n, x) { return n + x.pts; }, 0), items: items };
  }
  function itemText(it) {
    var label = it.kind === 'run' || it.kind === 'flush' ? TX('crib.item.' + it.kind, { n: it.cards.length }) : TX('crib.item.' + it.kind);
    return TX('crib.itemLine', { label: label, pts: it.pts, cards: T.shortList(it.cards) });
  }

  // Pegging: the points for the card just played, `seq` being the ids played
  // since the count last restarted (the new one last).
  function pegScore(seq) {
    var count = seq.reduce(function (n, c) { return n + cardVal(c); }, 0), pts = 0, parts = [], k, n = seq.length;
    if (count === FIFTEEN) { pts += 2; parts.push(TX('crib.part.fifteen')); }
    if (count === TARGET) { pts += 2; parts.push(TX('crib.part.thirtyOne')); }
    var same = 1;
    while (same < n && Z.rank(seq[n - 1 - same]) === Z.rank(seq[n - 1])) same++;
    if (same > 1) { var p = [0, 0, 2, 6, 12][same]; pts += p; parts.push(['', '', TX('crib.part.pair'), TX('crib.part.three'), TX('crib.part.four')][same]); }
    for (k = n; k >= 3; k--) {
      if (isRunOf(seq.slice(n - k))) { pts += k; parts.push(TX('crib.part.run', { n: k })); break; }
    }
    return { pts: pts, count: count, parts: parts };
  }

  // ── The game ────────────────────────────────────────────────────────────
  function deal(order, handNo, scores, prev, dealer) {
    return {
      hands: [byRank(order.slice(0, DEAL)), byRank(order.slice(DEAL, 2 * DEAL))], crib: [], dealer: dealer, starter: order[2 * DEAL], cut: false,
      kept: [[], []], pegHands: [[], []], seq: [], count: 0, goes: [false, false], turn: other(dealer), lastPlayer: -1, roundOver: null,
      phase: 'discard', scores: scores.slice(), prev: prev.slice(), showStep: -1, showWho: -1, showRes: null, handNo: handNo, msg: '', winner: -1, moves: 0
    };
  }
  function newGame(order, dealer) { return deal(order, 0, [0, 0], [0, 0], dealer === undefined ? 1 : dealer); }
  function nextHand(st, order) { return deal(order, st.handNo + 1, st.scores, st.prev, other(st.dealer)); }

  function award(s, seat, pts) {
    if (pts <= 0 || s.phase === 'over') return;
    s.prev[seat] = s.scores[seat];
    s.scores[seat] = Math.min(GOAL, s.scores[seat] + pts);
    if (s.scores[seat] >= GOAL) { s.winner = seat; s.phase = 'over'; }
  }
  function discard(st, seat, picks) {
    var s = Z.clone(st);
    s.hands[seat] = s.hands[seat].filter(function (c) { return picks.indexOf(c) < 0; });
    s.crib = s.crib.concat(picks); s.moves++;
    if (s.hands[0].length === KEPT && s.hands[1].length === KEPT) s.phase = 'cut';
    return s;
  }
  function cutStarter(st) {
    var s = Z.clone(st);
    s.cut = true; s.kept = [s.hands[0].slice(), s.hands[1].slice()]; s.pegHands = [s.hands[0].slice(), s.hands[1].slice()];
    s.phase = 'peg'; s.turn = other(s.dealer); s.msg = TX('crib.starter', { card: T.short(s.starter) });
    if (Z.rank(s.starter) === HEELS_RANK) { s.msg = then(s.msg, TX(s.dealer === YOU ? 'crib.heels.you' : 'crib.heels', { name: NAMES[s.dealer] })); award(s, s.dealer, 2); }
    return s;
  }

  var canPlay = function (s, seat) { return legalPeg(s, seat).length > 0; };
  function legalPeg(st, seat) { return st.pegHands[seat].filter(function (c) { return st.count + cardVal(c) <= TARGET; }); }
  function isLegalPeg(st, seat, id) { return st.phase === 'peg' && !st.roundOver && st.turn === seat && legalPeg(st, seat).indexOf(id) >= 0; }
  // The page can rename the seats (two people on one device) and say which seat, if any, is "You".
  var YOU = 0;
  function setNames(names, youSeat) { NAMES[0] = names[0]; NAMES[1] = names[1]; YOU = youSeat; }
  // A line about a seat: the key's .you form is for "You" ("You play"), the plain one for a name ("North plays").
  var said = function (seat, key, vars) { var v = vars || {}; v.name = NAMES[seat]; return TX(seat === YOU ? key + '.you' : key, v); };

  function playPeg(st, seat, id) {
    var s = Z.clone(st), o = other(seat);
    s.pegHands[seat].splice(s.pegHands[seat].indexOf(id), 1);
    s.seq.push({ seat: seat, id: id });
    var r = pegScore(s.seq.map(function (x) { return x.id; }));
    s.count = r.count; s.lastPlayer = seat; s.moves++;
    // The count is said once: "plays 7♠, fifteen for 2", not "plays 7♠, 15: fifteen for 2".
    var saysCount = r.pts && (s.count === FIFTEEN || s.count === TARGET);
    var msg = saysCount ? said(seat, 'crib.playsBare', { card: T.short(id) }) : said(seat, 'crib.plays', { card: T.short(id), count: s.count });
    if (r.pts) { msg += (saysCount ? ', ' : ': ') + TX('crib.scoring', { parts: r.parts.join(' ' + TX('crib.and') + ' '), pts: r.pts }); award(s, seat, r.pts); }
    if (s.count === TARGET) { s.roundOver = '31'; }
    else if (canPlay(s, o)) s.turn = o;
    else if (canPlay(s, seat)) { s.turn = seat; s.goes[o] = true; msg = then(msg, said(o, 'crib.says')); }
    else {
      s.roundOver = 'go';
      var last = !s.pegHands[0].length && !s.pegHands[1].length;
      msg = then(then(msg, said(o, 'crib.says')), said(seat, last ? 'crib.takesLast' : 'crib.takesGo'));
      award(s, seat, 1);
    }
    s.msg = msg;
    return s;
  }
  // After a restart, the one who did not play last leads; with no cards left, the show.
  function nextRound(st) {
    var s = Z.clone(st);
    s.seq = []; s.count = 0; s.goes = [false, false]; s.roundOver = null; s.msg = '';
    if (!s.pegHands[0].length && !s.pegHands[1].length) { s.phase = 'show'; return s; }
    var lead = other(s.lastPlayer);
    s.turn = s.pegHands[lead].length ? lead : s.lastPlayer;
    return s;
  }
  function enterShow(st, step) {
    var s = Z.clone(st), pone = other(s.dealer), who = step === 0 ? pone : s.dealer;
    var cards = step === 2 ? s.crib : s.kept[who];
    s.showStep = step; s.showWho = who; s.showRes = scoreHand(cards, s.starter, step === 2);
    award(s, who, s.showRes.total);
    return s;
  }

  // ── The computer player ─────────────────────────────────────────────────
  function cribValue(pair) {
    var a = Z.rank(pair[0]), b = Z.rank(pair[1]), v = 0;
    if (a === b) v += 2;
    if (cardVal(pair[0]) + cardVal(pair[1]) === FIFTEEN) v += 2;
    if (a === 5 || b === 5) v += 0.9;
    if (Math.abs(a - b) === 1) v += 0.6;
    if (Z.suit(pair[0]) === Z.suit(pair[1])) v += 0.3;
    return v;
  }
  function aiDiscard(hand, isDealer) {
    var unseen = [], c, best = null, bestV = -1e9;
    for (c = 0; c < 52; c++) if (hand.indexOf(c) < 0) unseen.push(c);
    subsets(hand, 2).forEach(function (pair) {
      var keep = hand.filter(function (x) { return pair.indexOf(x) < 0; }), sum = 0;
      unseen.forEach(function (st) { sum += scoreHand(keep, st, false).total; });
      var v = sum / unseen.length + (isDealer ? 1 : -1) * cribValue(pair);
      if (v > bestV) { bestV = v; best = pair; }
    });
    return best;
  }
  function aiPeg(st, seat) {
    var legal = legalPeg(st, seat), seqIds = st.seq.map(function (x) { return x.id; });
    return T.maxBy(legal, function (c) {
      var r = pegScore(seqIds.concat([c])), nc = r.count, v = r.pts * 10 + cardVal(c) * 0.1;
      if (nc === 5 || nc === 21) v -= 3;
      else if (nc === 10 || nc === 20) v -= 1;
      if (!seqIds.length) v += Z.rank(c) === 5 ? -4 : (cardVal(c) <= 4 ? 1.5 : 0);
      if (nc === 30 || nc === 29) v += 0.5;
      return v;
    });
  }

  // ── The peg board, drawn here ───────────────────────────────────────────
  // Two lanes of 121 holes: rows of 60 with a gap every five, out along the
  // top and back along the bottom. Returns SVG markup.
  var BW = 360, BH = 78, BX0 = 26, PITCH = 4.9, GROUP_GAP = 2.4, ROWS = [[15, 26], [50, 61]]; // [you, them] y for the out row and the back row
  var LANE_COLORS = ['#f59e0b', '#38bdf8'];
  function holeX(i) { return BX0 + i * PITCH + Math.floor(i / 5) * GROUP_GAP; }
  function holePos(n, lane) {
    if (n <= 0) return [BX0 - 11, ROWS[0][lane]];
    if (n >= GOAL) return [BX0 - 11, ROWS[1][lane]];
    if (n <= 60) return [holeX(n - 1), ROWS[0][lane]];
    return [holeX(120 - n), ROWS[1][lane]];
  }
  // A name a person typed goes into an attribute: no quote or angle bracket of theirs may end it.
  function attrText(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function boardSvg(scores, prev) {
    var out = '<svg viewBox="0 0 ' + BW + ' ' + BH + '" class="cb-svg" role="img" aria-label="' + attrText(TX('crib.pegAria', { a: NAMES[0], pa: scores[0], b: NAMES[1], pb: scores[1] })) + '">';
    out += '<rect class="cb-wood" x="0.5" y="0.5" width="' + (BW - 1) + '" height="' + (BH - 1) + '" rx="9"/>';
    [0, 1].forEach(function (lane) {
      var i, hole = '';
      for (i = 0; i < 60; i++) {
        hole += '<circle cx="' + holeX(i).toFixed(1) + '" cy="' + ROWS[0][lane] + '" r="1.6"/><circle cx="' + holeX(i).toFixed(1) + '" cy="' + ROWS[1][lane] + '" r="1.6"/>';
      }
      out += '<g class="cb-holes">' + hole + '</g>';
      out += '<circle class="cb-start" cx="' + (BX0 - 11) + '" cy="' + ROWS[0][lane] + '" r="2.4" fill="' + LANE_COLORS[lane] + '" opacity=".5"/>';
      out += '<circle class="cb-finish" cx="' + (BX0 - 11) + '" cy="' + ROWS[1][lane] + '" r="2.8" fill="none" stroke="' + LANE_COLORS[lane] + '" stroke-width="1.2"/>';
    });
    [['30', 29], ['60', 59]].forEach(function (t) { out += '<text class="cb-tick" x="' + holeX(t[1]).toFixed(1) + '" y="40" text-anchor="middle">' + t[0] + '</text>'; });
    out += '<text class="cb-tick" x="' + holeX(29).toFixed(1) + '" y="76" text-anchor="middle">90</text><text class="cb-tick" x="' + (BX0 - 11) + '" y="40" text-anchor="middle">0</text>';
    [0, 1].forEach(function (lane) {
      [prev[lane], scores[lane]].forEach(function (n, k) {
        var p = holePos(n, lane);
        out += '<circle class="cb-peg' + (k ? ' cb-front' : '') + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1] + '" r="' + (k ? 4.2 : 3.2) + '" fill="' + LANE_COLORS[lane] + '"/>';
      });
    });
    return out + '</svg>';
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var BOARD_MAX_W = 560, BOARD_GAP = 6, ROW_GAP = 22, PILE_JOG = 1.5;
  function geo(m) {
    var g = T.geometry(m, 1);
    g.boardW = Math.min(m.W - 2 * m.pad, BOARD_MAX_W); g.boardH = Math.round(g.boardW * BH / BW);
    g.boardTop = m.pad + T.SCORE_BAR_H; g.boardLeft = Math.round((m.W - g.boardW) / 2);
    g.northY = g.boardTop + g.boardH + BOARD_GAP;
    g.yTop = g.northY + g.ch + 10;
    g.cy = (g.yTop + g.statusY) / 2;
    var block = 3 * g.ch + 2 * ROW_GAP;
    g.rowA = Math.round(Math.max(g.yTop, g.cy - block / 2));
    g.rowB = g.rowA + g.ch + ROW_GAP; g.rowC = g.rowB + g.ch + ROW_GAP;
    g.cribX = Math.round(g.cx - g.cw * 1.35); g.starterX = Math.round(g.cx + g.cw * 0.35);
    return g;
  }
  // A centred row of non-interactive cards.
  function row(g, ids, y, step, up, pile, extra) {
    var n = ids.length, st = n > 1 ? Math.min(step, (g.W - 2 * g.pad - g.cw) / (n - 1)) : 0, x0 = (g.W - (g.cw + (n - 1) * st)) / 2;
    return ids.map(function (id, k) { return Object.assign({ id: id, pile: pile, idx: k, x: Math.round(x0 + k * st), y: y, up: up }, extra || {}); });
  }
  function place(st, m, view) {
    var V = (view && view.viewer) || 0, O = 1 - V, faceUp = !(view && view.hideHand);
    var g = geo(m), cards = [], slots = [], chosen = (view && view.chosen) || [], showing = st.phase === 'show' || (st.phase === 'over' && st.showStep >= 0);
    slots.push({ id: 'deck', x: g.starterX, y: g.rowA, w: g.cw, h: g.ch, quiet: true, label: TX('crib.slot.starter') });
    slots.push({ id: 'table', x: g.pad, y: g.rowB - 4, w: g.W - 2 * g.pad, h: 2 * g.ch + ROW_GAP + 8, quiet: true, label: TX('cards.slot.table') });
    var myTurn = st.phase === 'peg' && st.turn === V && !st.roundOver && faceUp, hand, opp;
    var info = function (id) {
      if (st.phase === 'discard') { var on = chosen.indexOf(id) >= 0; return { up: faceUp, raise: on, mark: on, label: Z.cardName(id) + (on ? TX('crib.aria.chosen') : '') }; }
      return { up: faceUp || showing, dim: myTurn && !isLegalPeg(st, V, id), glow: showing && st.showStep < 2 && st.showWho === V };
    };
    if (showing) {
      cards = cards.concat(row(g, st.kept[V], g.southY, g.cw * 0.95, true, 'k0', { glow: st.showStep < 2 && st.showWho === V }));
      cards = cards.concat(row(g, st.kept[O], g.northY, g.cw * 0.95, true, 'k1', { glow: st.showStep < 2 && st.showWho === O }));
    } else {
      var mine = st.phase === 'peg' ? st.pegHands[V] : st.hands[V], theirs = st.phase === 'peg' ? st.pegHands[O] : st.hands[O];
      hand = T.handCards(g, mine, info, null);
      slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
      opp = T.fan(g, 2, theirs, false); cards = cards.concat(opp);
    }
    // The crib pile, face down, until the show reaches it.
    var cribUp = showing && st.showStep === 2;
    if (cribUp) cards = cards.concat(row(g, st.crib, g.rowB, g.cw * 0.95, true, 'crib', { glow: true }));
    else st.crib.forEach(function (id, k) { cards.push({ id: id, pile: 'crib', idx: k, x: g.cribX + Math.round(k * PILE_JOG), y: g.rowA + Math.round(k * PILE_JOG), up: false }); });
    cards.push({ id: st.starter, pile: 'starter', idx: 0, x: cribUp ? Math.round(g.cx - g.cw / 2) : g.starterX, y: g.rowA, up: st.cut, glow: showing });
    // The count so far, a staircase: North's plays above, yours below.
    var step = Math.min(g.cw * 0.6, (g.W - 2 * g.pad - g.cw) / 7), x0 = (g.W - (g.cw + 7 * step)) / 2;
    if (st.phase === 'peg') st.seq.forEach(function (p, k) {
      cards.push({ id: p.id, pile: 'seq', idx: k, x: Math.round(x0 + k * step), y: p.seat === V ? g.rowC : g.rowB, up: true });
    });
    return { height: m.H, slots: slots, cards: cards };
  }

  var api = {
    NAMES: NAMES, GOAL: GOAL, cardVal: cardVal, scoreHand: scoreHand, itemText: itemText, pegScore: pegScore, deal: deal, newGame: newGame, nextHand: nextHand,
    discard: discard, cutStarter: cutStarter, legalPeg: legalPeg, isLegalPeg: isLegalPeg, playPeg: playPeg, nextRound: nextRound, enterShow: enterShow,
    setNames: setNames, aiDiscard: aiDiscard, aiPeg: aiPeg, boardSvg: boardSvg, holePos: holePos, geo: geo, place: place
  };
  root.ZimiCribbage = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 700, HOLD_MS = 1300, CUT_MS = 800, OVER_MS = 1500, PEG_STEP_MS = 140, PEG_WALK_MAX_MS = 900;
  function boot() {
    var d = root.document, t, board, session, view = { chosen: [], flash: '', viewer: 0, hideHand: false, chooser: 0 };
    // Each seat is the Computer or a Person; two people share the screen behind a handoff.
    var seats = Seats.create({ id: 'cribbage', seats: 2, onChange: function () { if (board) board.refresh(); if (t) t.paint(); } });
    function syncView(st) {
      view.viewer = seats.view();
      var actor = st.phase === 'discard' ? view.chooser : st.phase === 'peg' ? st.turn : view.viewer;
      view.hideHand = seats.hotseat() && actor !== view.viewer;
    }
    function nameSeats() { setNames([seats.name(0), seats.name(1)], seats.isYou(0) ? 0 : seats.isYou(1) ? 1 : -1); }
    var who = function (s) { return seats.name(s); };
    var poss = function (s) { return seats.isYou(s) ? TX('crib.your') : TX('crib.poss', { name: who(s) }); };
    var boardEl = Z.h('div', { class: 'cb-board' }), tagCrib = Z.h('div', { class: 'cb-tag' }), tagStarter = Z.h('div', { class: 'cb-tag', text: TX('crib.starterTag') });
    var tableEl = Z.pageEls().table;
    tableEl.appendChild(boardEl); tableEl.appendChild(tagCrib); tableEl.appendChild(tagStarter);
    var lastBoard = '', shown = null, walkTimer = 0;
    var anim = function () { return !(root.ZimiShell && root.ZimiShell.anim() === 'off') && !(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); };

    // A peg moves hole by hole to its new score, slowly enough to count along; the back peg hops to where the front one was.
    function walkPegs(from, st) {
      var pegs = boardEl.querySelectorAll('.cb-peg'), todo = [];
      [0, 1].forEach(function (lane) {
        if (st.scores[lane] <= from[lane]) return;
        var back = pegs[lane * 2], front = pegs[lane * 2 + 1], at = holePos(from[lane], lane);
        back.setAttribute('cx', at[0].toFixed(1)); back.setAttribute('cy', at[1]);
        front.setAttribute('cx', at[0].toFixed(1)); front.setAttribute('cy', at[1]);
        todo.push({ lane: lane, front: front, n: from[lane], to: st.scores[lane] });
      });
      if (!todo.length) return;
      var step = Math.min(PEG_STEP_MS, Math.floor(PEG_WALK_MAX_MS / Math.max.apply(null, todo.map(function (w) { return w.to - w.n; }))));
      walkTimer = root.setInterval(function () {
        var busy = false;
        todo.forEach(function (w) {
          if (w.n >= w.to) return;
          w.n++; busy = true;
          var p = holePos(w.n, w.lane);
          w.front.setAttribute('cx', p[0].toFixed(1)); w.front.setAttribute('cy', p[1]);
        });
        if (!busy) { root.clearInterval(walkTimer); walkTimer = 0; }
      }, step);
    }
    function drawBoard(st, g) {
      var key = JSON.stringify([st.scores, st.prev, g.boardW, g.boardTop]);
      if (key === lastBoard) return;
      var sameSpot = boardEl.firstChild && boardEl.style.width === g.boardW + 'px' && boardEl.style.top === g.boardTop + 'px';
      lastBoard = key;
      root.clearInterval(walkTimer); walkTimer = 0;
      boardEl.innerHTML = boardSvg(st.scores, st.prev);
      boardEl.style.top = g.boardTop + 'px'; boardEl.style.left = g.boardLeft + 'px'; boardEl.style.width = g.boardW + 'px';
      if (sameSpot && shown && anim()) walkPegs(shown, st);
      shown = st.scores.slice();
    }
    function tags(st, g) {
      var showing = st.phase === 'show' || st.showStep >= 0;
      tagCrib.textContent = showing && st.showStep === 2 ? '' : TX(seats.isYou(st.dealer) ? 'crib.tag.you' : 'crib.tag', { name: who(st.dealer) });
      tagCrib.style.left = g.cribX + 'px'; tagCrib.style.top = (g.rowA + g.ch + 3) + 'px'; tagCrib.style.width = g.cw + 'px';
      tagStarter.hidden = showing; tagStarter.style.left = g.starterX + 'px'; tagStarter.style.top = (g.rowA + g.ch + 3) + 'px'; tagStarter.style.width = g.cw + 'px';
      tagCrib.hidden = showing && st.showStep >= 2;
    }
    function itemLines(res, title) {
      var lines = [{ text: title }];
      if (!res.items.length) lines.push({ text: TX('crib.nineteen') });
      res.items.forEach(function (it) { lines.push({ text: itemText(it) }); });
      lines.push({ text: TX('crib.total', { n: res.total }), cls: 'ct-total' });
      return lines;
    }
    var showTitle = function (st) {
      var w = poss(st.showWho);
      if (seats.isYou(st.showWho)) return TX(st.showStep === 2 ? 'crib.tag.you' : 'crib.hand.you');
      return TX(st.showStep === 2 ? 'crib.cribOf' : 'crib.handOf', { whose: w });
    };
    function hud(st) {
      var g = geo(board.metrics());
      drawBoard(st, g); tags(st, g);
      var chips = [0, 1].map(function (seat) {
        return { name: who(seat), text: String(st.scores[seat]), dealer: st.dealer === seat, turn: st.phase === 'peg' && st.turn === seat && !st.roundOver };
      });
      if (st.phase === 'peg') chips.push({ name: TX('crib.count'), text: String(st.count) });
      var out = { chips: chips, fact: TX('scopa.fact', { n: st.handNo + 1, goal: GOAL }), text: '' };
      if (st.phase === 'discard') {
        var left = 2 - view.chosen.length;
        out.text = (seats.hotseat() ? who(view.chooser) + ': ' : '') + (left > 0 ? TX('crib.chooseMore', { n: left, whose: poss(st.dealer) }) : TX('crib.sendTwo'));
        out.label = TX('crib.toCrib'); out.action = left === 0 ? sendCrib : null;
      } else if (st.phase === 'cut') out.text = TX('crib.cutting');
      else if (st.phase === 'peg') {
        if (st.roundOver) out.text = st.msg;
        else out.text = then(st.msg, !seats.person(st.turn) ? TX('cards.thinking', { name: who(st.turn) }) : seats.isYou(st.turn) ? TX('scopa.yourPlay') : TX('scopa.namePlay', { name: who(st.turn) }));
      } else if (st.showStep >= 0) {
        out.lines = itemLines(st.showRes, TX('crib.showTitle', { title: showTitle(st), card: T.short(st.starter) }));
        out.text = st.phase === 'over' ? TX('shell.end.over') : '';
        out.label = st.phase === 'over' ? TX('crib.result') : st.showStep === 2 ? TX('cards.nextHand') : TX('crib.continue');
        out.action = st.phase === 'over' ? gameOver : continueShow;
      }
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'over') { if (st.showStep < 0) session.later(gameOver, OVER_MS); return; }
      if (st.phase === 'cut') { session.later(doCut, CUT_MS); return; }
      if (st.phase === 'discard') { seats.ensure(view.chooser, refresh); return; }
      if (st.phase === 'peg') {
        if (st.roundOver) { session.later(endRound, HOLD_MS); return; }
        if (seats.person(st.turn)) seats.ensure(st.turn, refresh); else session.later(aiTurn, AI_MS);
      }
    }
    function refresh() { board.refresh(); t.paint(); }
    function doCut() { var st = session.state; if (st.phase !== 'cut') return; session.follow(cutStarter(st)); drive(); }
    function aiTurn() {
      var st = session.state;
      if (st.phase !== 'peg' || seats.person(st.turn) || st.roundOver) return;
      session.follow(playPeg(st, st.turn, aiPeg(st, st.turn)));
      drive();
    }
    function endRound() {
      var st = session.state;
      if (st.phase !== 'peg' || !st.roundOver) return;
      var nx = nextRound(st);
      if (nx.phase === 'show') { session.follow(enterShow(nx, 0)); if (session.state.phase === 'over') drive(); return; }
      session.follow(nx); drive();
    }
    function continueShow() {
      var st = session.state;
      if (st.phase !== 'show') return;
      if (st.showStep < 2) { session.follow(enterShow(st, st.showStep + 1)); drive(); return; }
      startNextHand();
    }
    function startNextHand() {
      var st = session.state;
      session.history = []; view.chosen = [];
      session.follow(nextHand(st, Z.shuffled(Math.random)));
      deal();
    }
    function sendCrib() {
      var st = session.state;
      if (st.phase !== 'discard' || view.chosen.length !== 2) return;
      var mine = view.chosen.slice(), s = discard(st, view.chooser, mine);
      view.chosen = [];
      session.commit(s);
      // The next person chooses behind a handoff; the computer discards once the people have.
      var more = seats.people().filter(function (p) { return p > view.chooser; })[0];
      if (more !== undefined) { view.chooser = more; refresh(); drive(); return; }
      [0, 1].forEach(function (c) {
        if (!seats.person(c) && session.state.phase === 'discard') session.follow(discard(session.state, c, aiDiscard(session.state.hands[c], st.dealer === c)));
      });
      view.chooser = seats.people()[0];
      drive();
    }
    function gameOver() {
      var st = session.state, won = seats.isYou(st.winner), lines = [who(0) + ' ' + st.scores[0] + ', ' + who(1) + ' ' + st.scores[1] + '.'];
      if (st.scores[other(st.winner)] < SKUNK) lines.push(TX('crib.skunk', { n: SKUNK }));
      if (won) session.win(st.scores[st.winner]); else session.lose(seats.hotseat() ? { name: who(st.winner) } : '', lines, seats.hotseat() ? undefined : st.scores[0]);
    }
    var idOf = function (pile) { return parseInt(pile.slice(1), 10); };
    function play(id) {
      var st = session.state;
      if (!isLegalPeg(st, st.turn, id) || st.turn !== seats.view()) return false;
      session.commit(playPeg(st, st.turn, id));
      drive();
      return true;
    }
    function tap(pile) {
      var st = session.state, id = idOf(pile);
      if (pile.charAt(0) !== 'h' || isNaN(id)) return false;
      if (st.phase === 'discard') {
        var at = view.chosen.indexOf(id);
        if (at >= 0) view.chosen.splice(at, 1);
        else if (view.chosen.length < 2) view.chosen.push(id);
        else { t.flash(TX('crib.twoCards')); return true; }
        board.refresh(); t.paint();
        return true;
      }
      if (st.phase !== 'peg') return false;
      if (st.turn !== seats.view() || st.roundOver) { t.flash(TX('cards.wait.turn')); return false; }
      if (!isLegalPeg(st, st.turn, id)) { t.flash(TX('crib.past31')); return false; }
      return play(id);
    }
    function startGame() {
      view.chosen = []; view.flash = '';
      nameSeats();
      session.reset(api.newGame(Z.shuffled(Math.random), Math.floor(Math.random() * 2)));
      deal();
    }
    // A fresh deal: nobody has seen it, so two people start at a handoff.
    function deal() { view.chooser = seats.people()[0]; seats.begin(function () { refresh(); drive(); }, view.chooser); }

    t = T.create({
      id: 'cribbage', name: 'Cribbage', liftPlay: function (st) { return st.phase === 'peg'; }, seats: seats, view: view, geo: geo, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: startGame, tap: tap, cols: 6, heightShare: 0.11,
      canPick: function (st, pile) { return st.phase === 'peg' && pile.charAt(0) === 'h' && isLegalPeg(st, seats.view(), idOf(pile)); },
      move: function (pile, idx, to) { return (to === 'table' || to === 'deck') && pile.charAt(0) === 'h' ? play(idOf(pile)) : false; },
      // The scores are on the table; a clock that only counts a match has no place in the bar.
      stat: function () { return ''; },
      winLines: function (sec, st) { return [TX('crib.finalScore', { a: who(0), pa: st.scores[0], b: who(1), pb: st.scores[1], hands: Z.plural(st.handNo + 1, 'hand') })].concat(st.scores[1] < SKUNK ? [TX('crib.skunkNorth', { n: SKUNK })] : []); },
      rules: TX('crib.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    startGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
