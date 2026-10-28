/* ZimiGames: Koi-Koi, the Japanese flower-card game, you against the computer
   with the 48-card Hanafuda deck (drawn by ZimiCards.hanafudaFaceMarkup).
   Eight cards each and eight on the table. On your turn play a card from your
   hand: if a table card of the same month is there you take both (with two to
   choose from you pick one; with three you take all four), otherwise the card
   stays on the table. Then turn the top card of the deck and do the same with
   it. When your captured cards make a new yaku (a scoring set) you choose:
   shobu, end the month and score it, or koi-koi, play on for more. If the
   other player then makes a yaku first, they score. A month that runs out of
   cards with no yaku scores nothing. A score of 7 or more doubles, and so does
   scoring after the other player called koi-koi. 6 or 12 months; the higher
   total wins.

   Card ids 0 to 47: month = floor(id / 4), see ZimiCards.hanafudaCard. State:
   deck, hands[2], table, captured[2], turn, parent, step ('hand' | 'draw'),
   phase ('play' | 'koi' | 'monthEnd' | 'over'), koi[2] (times called this
   month), seen[2] ({yaku key: points} already offered), month, months,
   scores[2], result, last {seat, played, took, drawn, drawTook}, moves.
   Seats: 0 you, 1 the computer. Pure functions; the page wiring at the bottom
   only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;
  // Two sentences, joined the way the language joins them.
  var then = function (first, next) { return first ? TX('cards.then', { first: first, then: next }) : next; };

  var NAMES = [TX('cards.you'), root.ZimiText.ZIMI], DECK = 48, HAND = 8, TABLE_START = 8, DOUBLE_AT = 7;
  var card = function (id) { return Z.hanafudaCard(id); };
  var monthOf = function (id) { return Math.floor(id / 4); };
  var other = function (seat) { return 1 - seat; };
  var nameOf = function (id) { return Z.hanafudaName(id); };
  var kindOf = function (id) { return card(id).kind; };
  var RAIN_MAN = 40, MOON = 28, CURTAIN = 8, SAKE = 32, BOAR = 24, DEER = 36, BUTTERFLIES = 20;
  var KINDS = ['bright', 'animal', 'ribbon', 'chaff'];

  // ── Rules ───────────────────────────────────────────────────────────────
  // The table cards a card of this month may take.
  function matchesOf(table, id) { return table.filter(function (c) { return monthOf(c) === monthOf(id); }); }
  function fourOfAMonth(ids) {
    var n = {};
    ids.forEach(function (c) { n[monthOf(c)] = (n[monthOf(c)] || 0) + 1; });
    return Object.keys(n).some(function (m) { return n[m] >= 4; });
  }
  function deal(order, month, months, scores, parent) {
    var o = order.slice(), tries = 0;
    var bad = function () { return fourOfAMonth(o.slice(0, HAND)) || fourOfAMonth(o.slice(HAND, 2 * HAND)) || fourOfAMonth(o.slice(2 * HAND, 2 * HAND + TABLE_START)); };
    while (bad() && tries++ < DECK) o.push(o.shift());
    return {
      deck: o.slice(2 * HAND + TABLE_START), hands: [o.slice(0, HAND), o.slice(HAND, 2 * HAND)], table: o.slice(2 * HAND, 2 * HAND + TABLE_START),
      captured: [[], []], turn: parent, parent: parent, step: 'hand', phase: 'play', koi: [0, 0], seen: [{}, {}], month: month, months: months, scores: scores.slice(),
      result: null, last: null, moves: 0
    };
  }
  function newGame(order, months, parent) { return deal(order, 0, months || 6, [0, 0], parent === undefined ? 0 : parent); }
  function nextMonth(st, order) { return deal(order, st.month + 1, st.months, st.scores, st.result && st.result.winner >= 0 ? st.result.winner : st.parent); }

  // What `id` does against `table`: the cards it takes (empty: it stays). `target` picks one of two.
  function takes(table, id, target) {
    var m = matchesOf(table, id);
    if (!m.length) return [];
    if (m.length === 1) return m;
    if (m.length === 3) return m;
    return m.indexOf(target) >= 0 ? [target] : null;
  }
  function needsTarget(table, id) { return matchesOf(table, id).length === 2; }
  function resolve(s, seat, id, target) {
    var took = takes(s.table, id, target);
    if (took === null) return null;
    if (took.length) { s.table = s.table.filter(function (c) { return took.indexOf(c) < 0; }); s.captured[seat] = s.captured[seat].concat(took, [id]); }
    else s.table.push(id);
    return took;
  }
  function isLegal(st, seat, id, target) {
    return st.phase === 'play' && st.step === 'hand' && st.turn === seat && st.hands[seat].indexOf(id) >= 0 && takes(st.table, id, target) !== null;
  }
  function playHand(st, seat, id, target) {
    if (!isLegal(st, seat, id, target)) return st;
    var s = Z.clone(st);
    s.hands[seat].splice(s.hands[seat].indexOf(id), 1);
    var took = resolve(s, seat, id, target);
    s.last = { seat: seat, played: id, took: took, drawn: null, drawTook: [] };
    s.step = 'draw'; s.moves++;
    return s;
  }
  var peek = function (st) { return st.deck.length ? st.deck[0] : null; };
  function canDraw(st, seat, target) { return st.phase === 'play' && st.step === 'draw' && st.turn === seat && peek(st) !== null && takes(st.table, peek(st), target) !== null; }
  function draw(st, seat, target) {
    if (!canDraw(st, seat, target)) return st;
    var s = Z.clone(st), id = s.deck.shift(), took = resolve(s, seat, id, target);
    s.last = { seat: seat, played: s.last.played, took: s.last.took, drawn: id, drawTook: took };
    s.moves++;
    return endTurn(s, seat);
  }

  // ── Yaku ────────────────────────────────────────────────────────────────
  // The scoring sets in a pile of captured cards: [{ key, name, pts }].
  function yakuOf(ids) {
    var out = [], has = function (c) { return ids.indexOf(c) >= 0; }, of = function (kind) { return ids.filter(function (c) { return kindOf(c) === kind; }); };
    var add = function (key, name, pts) { out.push({ key: key, name: name, pts: pts }); };
    var brights = of('bright'), animals = of('animal'), ribbons = of('ribbon'), chaff = of('chaff').concat(has(SAKE) ? [SAKE] : []);
    if (brights.length === 5) add('goko', TX('koikoi.yaku.goko'), 10);
    else if (brights.length === 4) { if (has(RAIN_MAN)) add('ame', TX('koikoi.yaku.ame'), 7); else add('shiko', TX('koikoi.yaku.shiko'), 8); }
    else if (brights.length === 3 && !has(RAIN_MAN)) add('sanko', TX('koikoi.yaku.sanko'), 5);
    if (has(BOAR) && has(DEER) && has(BUTTERFLIES)) add('ino', TX('koikoi.yaku.ino'), 5 + animals.length - 3);
    if (animals.length >= 5) add('tane', TX('koikoi.yaku.tane'), animals.length - 4);
    var ribbonOf = function (kind) { return ribbons.filter(function (c) { return card(c).ribbon === kind; }); };
    if (ribbonOf('poetry').length === 3) add('akatan', TX('koikoi.yaku.akatan'), 5);
    if (ribbonOf('blue').length === 3) add('aotan', TX('koikoi.yaku.aotan'), 5);
    if (ribbons.length >= 5) add('tan', TX('koikoi.yaku.tan'), ribbons.length - 4);
    if (chaff.length >= 10) add('kasu', TX('koikoi.yaku.kasu'), chaff.length - 9);
    if (has(MOON) && has(SAKE)) add('tsuki', TX('koikoi.yaku.tsuki'), 5);
    if (has(CURTAIN) && has(SAKE)) add('hanami', TX('koikoi.yaku.hanami'), 5);
    return out;
  }
  var yakuTotal = function (list) { return list.reduce(function (n, y) { return n + y.pts; }, 0); };
  function snapshot(list) { var o = {}; list.forEach(function (y) { o[y.key] = y.pts; }); return o; }
  // Is there a yaku (or a bigger one) the player has not yet been offered?
  function isNewYaku(list, seen) { return list.some(function (y) { return seen[y.key] === undefined || y.pts > seen[y.key]; }); }
  function multiplier(base, calledByOther) { return (base >= DOUBLE_AT ? 2 : 1) * (calledByOther ? 2 : 1); }

  // ── Turns ───────────────────────────────────────────────────────────────
  function endTurn(s, seat) {
    var list = yakuOf(s.captured[seat]);
    if (list.length && isNewYaku(list, s.seen[seat])) { s.phase = 'koi'; s.turn = seat; return s; }
    return advance(s, seat);
  }
  function advance(s, seat) {
    if (!s.hands[0].length && !s.hands[1].length) { s.phase = 'monthEnd'; s.result = { winner: -1, points: 0, base: 0, mult: 1, yaku: [], note: TX('koikoi.noYaku') }; return finishMonth(s); }
    s.turn = other(seat); s.step = 'hand';
    return s;
  }
  // The player chose: koi-koi (play on) or shobu (score it).
  function decide(st, seat, koi) {
    if (st.phase !== 'koi' || st.turn !== seat) return st;
    var s = Z.clone(st), list = yakuOf(s.captured[seat]);
    s.moves++;
    if (koi) { s.koi[seat]++; s.seen[seat] = snapshot(list); s.phase = 'play'; return advance(s, seat); }
    var base = yakuTotal(list), mult = multiplier(base, s.koi[other(seat)] > 0);
    s.result = { winner: seat, points: base * mult, base: base, mult: mult, yaku: list, note: '' };
    s.phase = 'monthEnd';
    return finishMonth(s);
  }
  function finishMonth(s) {
    var r = s.result;
    if (r.winner >= 0) s.scores[r.winner] += r.points;
    s.phase = s.month + 1 >= s.months ? 'over' : 'monthEnd';
    return s;
  }
  function gameWinner(scores) { return scores[0] === scores[1] ? -1 : scores[0] > scores[1] ? 0 : 1; }

  // ── The computer player ─────────────────────────────────────────────────
  var VALUE = { bright: 12, animal: 7, ribbon: 5, chaff: 1 };
  function worth(id) {
    var c = card(id);
    return VALUE[c.kind] + (c.ribbon === 'poetry' || c.ribbon === 'blue' ? 1.5 : 0) + (c.sake ? 2 : 0) + (id === RAIN_MAN ? -3 : 0);
  }
  // The value of ending up with `got` more cards: their worth, and what they do for a yaku.
  function gainOf(st, seat, got) {
    var mine = st.captured[seat];
    var v = got.reduce(function (n, c) { return n + worth(c); }, 0);
    v += 6 * (yakuTotal(yakuOf(mine.concat(got))) - yakuTotal(yakuOf(mine)));
    return v;
  }
  // The best (card, target) for the hand step.
  function aiHand(st, seat) {
    var best = null, bv = -1e9;
    st.hands[seat].forEach(function (id) {
      var m = matchesOf(st.table, id), opts = m.length === 2 ? m.map(function (t) { return [t]; }) : [m];
      opts.forEach(function (set) {
        // Playing a card to the table gives it away: the worse it is to lose, the less it is wanted.
        var v = set.length ? gainOf(st, seat, set.concat([id])) : -worth(id) * 0.7;
        if (v > bv) { bv = v; best = { id: id, target: set.length === 1 && m.length === 2 ? set[0] : undefined }; }
      });
    });
    return best;
  }
  function aiTarget(st, seat) {
    var id = peek(st), m = matchesOf(st.table, id);
    return m.length === 2 ? T.maxBy(m, function (t) { return gainOf(st, seat, [t, id]); }) : undefined;
  }
  // Koi-koi when the score is small, there are cards left to play and the other side has nothing yet.
  function aiKoi(st, seat) {
    var pts = yakuTotal(yakuOf(st.captured[seat])), foe = yakuTotal(yakuOf(st.captured[other(seat)]));
    var theirBrights = st.captured[other(seat)].filter(function (c) { return kindOf(c) === 'bright'; }).length;
    return pts < 5 && st.hands[seat].length >= 3 && foe === 0 && theirBrights < 2 && st.koi[seat] < 2;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var ROW_GAP = 8, TABLE_GAP_SHARE = 0.1, STRIP_H = 28, REST_ROWS = 3;
  function geo(m) {
    var g = T.geometry(m, 1);
    g.showY = g.yTop;
    g.tableTop = g.yTop + g.ch + 14;
    g.tableBottom = g.statusY - STRIP_H;
    g.gap = Math.round(g.cw * TABLE_GAP_SHARE);
    g.perRow = Math.max(1, Math.floor((g.W - 2 * g.pad + g.gap) / (g.cw + g.gap)));
    return g;
  }
  function tablePos(g, n) {
    var out = [], rows = Math.max(1, Math.ceil(n / g.perRow)), room = g.tableBottom - g.tableTop, rowStep = Math.min(g.ch + ROW_GAP, rows > 1 ? (room - g.ch) / (rows - 1) : g.ch);
    // A usual table is three rows: sit that block in the middle of the room, so a row more or less does not move the rest.
    var lift = Math.max(0, Math.round((room - (REST_ROWS - 1) * (g.ch + ROW_GAP) - g.ch) / 2));
    for (var k = 0; k < n; k++) {
      var r = Math.floor(k / g.perRow), inRow = Math.min(g.perRow, n - r * g.perRow), at = k - r * g.perRow;
      out.push({ x: Math.round((g.W - (inRow * g.cw + (inRow - 1) * g.gap)) / 2 + at * (g.cw + g.gap)), y: Math.round(g.tableTop + lift + r * rowStep) });
    }
    return out;
  }
  // view: { sel, show: {moves, stage, row, seat}, pick (drawn card waiting for a choice) }
  function place(st, m, view) {
    var V = (view && view.viewer) || 0, O = 1 - V, faceUp = !(view && view.hideHand);
    var g = geo(m), cards = [], slots = [], sh = view && view.show && view.show.moves === st.moves ? view.show : null;
    var sel = view && view.sel !== null && view.sel !== undefined ? view.sel : null;
    var drawn = view && view.pick && st.step === 'draw' ? peek(st) : null;
    var lit = sel !== null ? matchesOf(st.table, sel) : drawn !== null ? matchesOf(st.table, drawn) : [];
    var pickable = drawn !== null || sel !== null;
    slots.push({ id: 'deck', x: g.W - g.pad - g.cw, y: g.northY, w: g.cw, h: g.ch, quiet: true, label: TX('scopa.slot.deck') });
    slots.push({ id: 'table', x: g.pad, y: g.tableTop, w: g.W - 2 * g.pad, h: g.tableBottom - g.tableTop, quiet: true, label: TX('cards.slot.table') });
    var hand = T.handCards(g, st.hands[V], function (id) {
      var on = sel === id && faceUp;
      return { up: faceUp, raise: on, mark: on, label: nameOf(id) + (on ? ', ' + TX('cards.selected') : '') };
    }, null);
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    cards = cards.concat(T.fan(g, 2, st.hands[O], false));
    st.deck.slice(drawn !== null ? 1 : 0, drawn !== null ? 3 : 2).forEach(function (id, k) { cards.push({ id: id, pile: 'deck', idx: k, x: g.W - g.pad - g.cw + k * 2, y: g.northY + k * 2, up: false }); });
    if (drawn !== null) cards.push({ id: drawn, pile: 'drawn', idx: 0, x: g.W - g.pad - 2.2 * g.cw, y: g.northY, up: true, mark: true });
    var pos = tablePos(g, st.table.length);
    st.table.forEach(function (id, k) {
      var hot = lit.indexOf(id) >= 0, fresh = sh && sh.stage === 0 && sh.row.indexOf(id) >= 0;
      cards.push({ id: id, pile: 't' + id, idx: 0, x: pos[k].x, y: pos[k].y, up: true, glow: hot || !!fresh, dim: pickable && !hot });
      slots.push({ id: 't' + id, x: pos[k].x, y: pos[k].y, w: g.cw, h: g.ch, label: nameOf(id) + (hot ? TX('koikoi.aria.canTake') : '') });
    });
    // What was just taken, held up for a moment and swept to its owner.
    if (sh && sh.row.length) {
      var n = sh.row.length, rs = n > 1 ? Math.min(g.cw * 0.7, (g.W - 2 * g.pad - g.cw) / (n - 1)) : 0, rx = (g.W - (g.cw + (n - 1) * rs)) / 2, away = T.seatSpot(g, sh.seat === V ? 0 : 2);
      sh.row.forEach(function (id, k) {
        var gone = sh.stage === 1;
        cards.push({ id: id, pile: 'show', idx: k, x: Math.round(gone ? away.x : rx + k * rs), y: Math.round(gone ? away.y : g.showY), up: true, glow: !gone });
      });
    }
    return { height: m.H, slots: slots, cards: cards };
  }

  // ── Words ───────────────────────────────────────────────────────────────
  // The page renames the seats when two people share a device; `youSeat` is the one called "You" (-1: none).
  var YOU = 0;
  function setNames(names, youSeat) { NAMES[0] = names[0]; NAMES[1] = names[1]; YOU = youSeat; }
  var count = function (ids, kind) { return ids.filter(function (c) { return kindOf(c) === kind; }).length; };
  function describeTurn(st) {
    var l = st.last;
    if (!l) return '';
    var who = NAMES[l.seat], you = l.seat === YOU;
    var part = function (verb, id, took) {
      var vars = { name: who, card: nameOf(id).split(',')[0], taken: took.map(function (c) { return nameOf(c).split(',')[0]; }).join(', ') };
      return TX('koikoi.told.' + verb + (took.length ? '.take' : '.table') + (you ? '.you' : ''), vars);
    };
    var out = part('play', l.played, l.took || []);
    if (l.drawn !== null && l.drawn !== undefined) out = then(out, part('draw', l.drawn, l.drawTook || []));
    return out;
  }
  function resultLines(st) {
    var r = st.result, lines = [];
    if (r.winner < 0) lines.push(r.note);
    else {
      r.yaku.forEach(function (y) { lines.push(y.name + ' ' + y.pts); });
      lines.push(TX(r.winner === YOU ? 'koikoi.score.you' : 'koikoi.score', { name: NAMES[r.winner], points: r.points }) + (r.mult > 1 ? ' (' + TX(r.mult > 2 ? 'koikoi.doubledTwice' : 'koikoi.doubled', { base: r.base }) + ')' : ''));
    }
    lines.push(TX('koikoi.total', { a: NAMES[0], pa: st.scores[0], b: NAMES[1], pb: st.scores[1] }));
    return lines;
  }

  var api = {
    setNames: setNames, NAMES: NAMES, DECK: DECK, matchesOf: matchesOf, takes: takes, needsTarget: needsTarget, isLegal: isLegal, deal: deal, newGame: newGame, nextMonth: nextMonth,
    playHand: playHand, draw: draw, canDraw: canDraw, peek: peek, decide: decide, yakuOf: yakuOf, yakuTotal: yakuTotal, isNewYaku: isNewYaku, multiplier: multiplier,
    gameWinner: gameWinner, aiHand: aiHand, aiTarget: aiTarget, aiKoi: aiKoi, geo: geo, place: place, worth: worth, resultLines: resultLines
  };
  root.ZimiKoiKoi = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 700, HOLD_MS = 1000, HOLD_YOU_MS = 480, SWEEP_MS = 380, DRAW_MS = 420, MONTH_KEY = 'koikoi.months', MONTH_CHOICES = [6, 12];
  function boot() {
    var d = root.document, t, board, session, view = { sel: null, show: null, pick: false, flash: '', viewer: 0, hideHand: false };
    // Each seat is the Computer or a Person; two people share the screen behind a handoff.
    var seats = Seats.create({ id: 'koikoi', seats: 2, onChange: function () { if (board) board.refresh(); if (t) t.paint(); } });
    function syncView(st) { view.viewer = seats.view(); view.hideHand = seats.hotseat() && (st.phase === 'play' || st.phase === 'koi') && st.turn !== view.viewer; }
    function nameSeats() { setNames([seats.name(0), seats.name(1)], seats.isYou(0) ? 0 : seats.isYou(1) ? 1 : -1); }
    var who = function (s) { return seats.name(s); };
    var strip = Z.h('div', { class: 'kk-strip' }), pills = [Z.h('button', { class: 'kk-pill', type: 'button' }), Z.h('button', { class: 'kk-pill', type: 'button' })];
    pills.forEach(function (p, seat) { strip.appendChild(p); p.addEventListener('click', function () { showCaptured(seat); }); });
    Z.pageEls().table.appendChild(strip);
    var HANA_MONTH = function (m) { return root.ZimiText.month(m, 'short'); };
    var busy = function () { var st = session.state; return !!(view.show && view.show.moves === st.moves); };
    var badgeSvg = function (kind) {
      var shape = { bright: '<circle cx="6" cy="6" r="5" fill="#e09400"/>', animal: '<path d="M6 .6 10.4 6 6 11.4 1.6 6z" fill="currentColor"/>', ribbon: '<path d="M3.4 .6H8.6V11.4L6 9.6 3.4 11.4z" fill="#c62828"/>', chaff: '<circle cx="6" cy="6" r="2.6" fill="currentColor"/>' }[kind];
      return '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' + shape + '</svg>';
    };
    var KIND_WORD = function (k) { return TX('koikoi.kind.' + k); };
    function paintPills(g, st) {
      [0, 1].forEach(function (seat) {
        var cap = st.captured[seat], p = pills[seat], aria = [];
        p.innerHTML = '<b>' + who(seat) + '</b>' + KINDS.map(function (k) { return '<span class="kk-n">' + badgeSvg(k) + count(cap, k) + '</span>'; }).join('');
        KINDS.forEach(function (k) { aria.push(count(cap, k) + ' ' + KIND_WORD(k)); });
        p.setAttribute('aria-label', TX(seats.isYou(seat) ? 'koikoi.pill.you' : 'koikoi.pill', { name: who(seat), list: aria.join(', ') }));
      });
      strip.style.top = Math.round(g.statusY - STRIP_H + 2) + 'px';
      strip.hidden = st.phase === 'koi' && seats.person(st.turn); // the choices sit where it does
    }
    function showCaptured(seat) {
      var st = session.state, cap = st.captured[seat], body = [];
      KINDS.forEach(function (k) {
        var ids = cap.filter(function (c) { return kindOf(c) === k; });
        var row = Z.h('div', { class: 'kk-capgroup' }, [Z.h('div', { class: 'kk-caphead', text: KIND_WORD(k).charAt(0).toUpperCase() + KIND_WORD(k).slice(1) + ' ' + ids.length })]);
        var cards = Z.h('div', { class: 'kk-capcards' });
        ids.forEach(function (id) {
          var c = Z.h('div', { class: 'zc-card kk-mini', role: 'img', 'aria-label': nameOf(id) });
          c.innerHTML = '<div class="zc-face">' + Z.hanafudaFaceMarkup(id, false) + '</div>';
          cards.appendChild(c);
        });
        if (!ids.length) cards.appendChild(Z.h('span', { class: 'kk-none', text: TX('koikoi.none') }));
        row.appendChild(cards); body.push(row);
      });
      var list = yakuOf(cap);
      body.push(Z.h('p', { class: 'zc-note', text: list.length ? list.map(function (y) { return y.name + ' ' + y.pts; }).join(' · ') : TX('koikoi.noYakuYet') }));
      Z.sheet({ title: TX('koikoi.captured', { name: who(seat) }), body: body, actions: [{ label: TX('shell.close'), primary: true }] });
    }

    function hud(st) {
      var g = geo(board.metrics());
      paintPills(g, st);
      var mine = busy();
      var out = {
        chips: [0, 1].map(function (c) { return { name: who(c), text: String(st.scores[c]), dealer: st.parent === c, turn: st.phase === 'play' && st.turn === c && !mine }; }).concat([
          { name: TX('koikoi.month'), text: HANA_MONTH(st.month) }, { name: TX('scopa.deck'), text: String(st.deck.length) }]),
        fact: TX('koikoi.fact', { n: st.month + 1, of: st.months }), text: ''
      };
      var told = describeTurn(st);
      if (st.phase === 'koi') {
        var list = yakuOf(st.captured[st.turn]), pts = yakuTotal(list);
        if (seats.person(st.turn)) {
          out.text = TX('koikoi.made', { name: seats.isYou(st.turn) ? TX('cards.you') : who(st.turn), yaku: list.map(function (y) { return y.name + ' ' + y.pts; }).join(', '), points: pts });
          out.choices = [{ label: TX('koikoi.shobu', { points: pts }), onclick: function () { choose(false); } }, { label: TX('koikoi.koikoi'), onclick: function () { choose(true); } }];
        } else out.text = TX('euchre.deciding', { name: who(st.turn) });
      } else if (st.phase === 'play') {
        if (mine) out.text = told;
        else if (seats.person(st.turn)) {
          if (st.step === 'draw' && view.pick) out.text = TX('koikoi.drew', { name: seats.isYou(st.turn) ? TX('cards.you') : who(st.turn), card: nameOf(peek(st)).split(',')[0] });
          else if (view.sel !== null) out.text = TX('koikoi.tapTable');
          else out.text = then(told, seats.isYou(st.turn) ? TX('scopa.yourPlay') : TX('scopa.namePlay', { name: who(st.turn) }));
        } else out.text = then(told, TX('cards.thinking', { name: who(st.turn) }));
      } else if (st.phase === 'monthEnd') { out.text = TX('koikoi.monthOver'); out.label = TX('koikoi.nextMonth'); out.action = startNextMonth; }
      else if (st.phase === 'over') out.text = TX('shell.end.over');
      return out;
    }

    // ── The flow ──
    function drive() {
      var st = session.state;
      if (st.phase === 'koi') { if (seats.person(st.turn)) seats.ensure(st.turn, refresh); else session.later(aiDecide, AI_MS); return; }
      if (st.phase !== 'play') return;
      if (st.step === 'draw') { driveDraw(); return; }
      if (seats.person(st.turn)) seats.ensure(st.turn, refresh); else session.later(aiTurn, AI_MS);
    }
    function refresh() { board.refresh(); t.paint(); }
    function driveDraw() {
      var st = session.state;
      if (seats.person(st.turn) && needsTarget(st.table, peek(st))) { view.pick = true; board.refresh(); t.paint(); return; }
      session.later(function () { doDraw(st.turn, seats.person(st.turn) ? undefined : aiTarget(st, st.turn)); }, DRAW_MS);
    }
    function aiTurn() {
      var st = session.state;
      if (st.phase !== 'play' || st.step !== 'hand' || seats.person(st.turn) || busy()) return;
      var mv = aiHand(st, st.turn);
      doHand(st.turn, mv.id, mv.target);
    }
    function aiDecide() {
      var st = session.state;
      if (st.phase !== 'koi' || seats.person(st.turn)) return;
      choose(aiKoi(st, st.turn), st.turn);
    }
    function reveal(st, seat, row, hold, then) {
      view.show = { moves: st.moves, stage: 0, row: row, seat: seat };
      board.refresh(); t.paint();
      session.later(function () {
        if (!view.show) return;
        view.show.stage = 1; board.refresh();
        session.later(function () { view.show = null; board.refresh(); t.paint(); if (session.state.moves === st.moves) then(); }, SWEEP_MS); // a choice made meanwhile drives on its own
      }, hold);
    }
    function doHand(seat, id, target) {
      var st = session.state;
      if (!isLegal(st, seat, id, target)) return;
      var next = playHand(st, seat, id, target), took = next.last.took;
      view.sel = null;
      if (seats.person(seat)) session.commit(next); else session.follow(next);
      var quick = seats.person(seat) && !seats.hotseat();
      if (took.length) reveal(next, seat, [id].concat(took), quick ? HOLD_YOU_MS : HOLD_MS, drive);
      else { t.paint(); board.refresh(); session.later(drive, quick ? 120 : 520); }
    }
    function doDraw(seat, target) {
      var st = session.state;
      if (!canDraw(st, seat, target)) return;
      view.pick = false;
      var next = draw(st, seat, target), l = next.last;
      session.follow(next);
      var after = function () {
        var cur = session.state;
        if (cur.phase === 'koi' && seats.person(cur.turn)) { board.refresh(); t.paint(); drive(); }
        else if (cur.phase === 'over' || cur.phase === 'monthEnd') monthOver(); else drive();
      };
      if (l.drawTook.length) reveal(next, seat, [l.drawn].concat(l.drawTook), seats.person(seat) && !seats.hotseat() ? HOLD_YOU_MS : HOLD_MS, after);
      else { t.paint(); board.refresh(); session.later(after, 520); }
    }
    function choose(koi, seat) {
      var st = session.state, by = seat === undefined ? st.turn : seat;
      if (st.phase !== 'koi' || st.turn !== by) return;
      var next = decide(st, by, koi);
      if (seats.person(by)) session.commit(next); else session.follow(next);
      if (next.phase === 'monthEnd' || next.phase === 'over') monthOver();
      else if (koi) { t.flash(seats.isYou(by) ? TX('koikoi.playOn') : TX('koikoi.calls', { name: who(by) })); drive(); }
      else monthOver();
    }
    function monthOver() {
      var st = session.state;
      if (st.phase === 'over') { gameOver(); return; }
      T.lineSheet(TX('koikoi.fact', { n: st.month + 1, of: st.months }), resultLines(st), [{ label: TX('koikoi.nextMonth'), primary: true, onclick: startNextMonth }]);
    }
    function gameOver() {
      var st = session.state, w = gameWinner(st.scores), lines = resultLines(st);
      lines.push(w < 0 ? TX('koikoi.tie') : TX(seats.isYou(w) ? 'cards.result.you' : 'koikoi.result.name', { name: who(w), a: st.scores[w], b: st.scores[1 - w] }));
      if (seats.isYou(w)) session.win(st.scores[w]); else session.lose(w < 0 ? 'draw' : seats.hotseat() ? { name: who(w) } : '', lines, seats.hotseat() ? undefined : st.scores[0]);
    }
    var order = function () { return Z.shuffled(Math.random).filter(function (c) { return c < DECK; }); };
    function startNextMonth() {
      var st = session.state;
      if (st.phase !== 'monthEnd') return;
      session.history = []; view.sel = null; view.pick = false;
      session.follow(nextMonth(st, order()));
      deal();
    }
    var idOf = function (pile) { return parseInt(pile.slice(1), 10); };
    function tap(pile) {
      var st = session.state, id = idOf(pile), kind = pile.charAt(0);
      if (st.phase !== 'play' || isNaN(id)) return false;
      if (st.turn !== seats.view() || busy()) { t.flash(TX('cards.wait.turn')); return false; }
      if (st.step === 'draw') {
        if (kind !== 't' || !view.pick) return false;
        if (matchesOf(st.table, peek(st)).indexOf(id) < 0) { t.flash(TX('koikoi.notMonth')); return false; }
        doDraw(st.turn, id); return true;
      }
      if (kind === 'h') {
        // Lift, then play: the first tap lifts the card; the second plays it (with two matching table cards it puts it back: pick one of those).
        if (view.sel === id) {
          if (needsTarget(st.table, id)) { view.sel = null; board.refresh(); t.paint(); return true; }
          doHand(st.turn, id, undefined); return true;
        }
        view.sel = id; board.refresh(); t.paint(); return true;
      }
      if (kind === 't') {
        if (view.sel === null) { t.flash(TX('scopa.chooseFirst')); return false; }
        if (matchesOf(st.table, view.sel).indexOf(id) < 0) { t.flash(TX('koikoi.notMonth')); return false; }
        doHand(st.turn, view.sel, id); return true;
      }
      return false;
    }
    function startGame() {
      view.sel = null; view.show = null; view.pick = false; view.flash = '';
      var months = Z.store.get(MONTH_KEY, 6);
      nameSeats();
      session.reset(newGame(order(), MONTH_CHOICES.indexOf(months) >= 0 ? months : 6, Math.floor(Math.random() * 2)));
      deal();
    }
    // A fresh deal: nobody has seen it, so two people start at a handoff.
    function deal() { seats.begin(function () { refresh(); drive(); }, session.state.turn); }
    t = T.create({
      id: 'koikoi', name: 'Koi-Koi', seats: seats, view: view, geo: geo, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: startGame, tap: tap, cols: 6, heightShare: 0.12, face: Z.hanafudaFaceMarkup,
      canPick: function () { return false; },
      // The scores are on the table; a clock that only counts a match has no place in the bar.
      stat: function () { return ''; },
      cascadeOrder: function (st) { return st.captured[0].slice(0, 24).map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return resultLines(st).concat([TX('koikoi.result.won', { a: st.scores[seats.view()], b: st.scores[1 - seats.view()], months: Z.plural(st.months, 'month') })]); },
      menuExtra: function () {
        return [T.choiceRow(TX('koikoi.length'), MONTH_KEY, MONTH_CHOICES.map(function (n) { return { value: n, label: TX('koikoi.months', { n: n }) }; }), 6, function () { /* read at the next game */ }),
          Z.h('p', { class: 'zc-note', text: TX('koikoi.lengthNote') })];
      },
      rules: TX('koikoi.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    startGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
