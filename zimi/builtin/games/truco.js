/* ZimiGames: Truco, the Argentine card game of bluff, you against the
   computer with the 40-card Spanish deck (drawn by ZimiCards): oros, copas,
   espadas and bastos, 1 to 7 then sota, caballo and rey. Three cards each, up
   to three tricks, the best of three wins the hand. The cards rank in their
   own order (the ace of espadas on top, then the ace of bastos, the seven of
   espadas, the seven of oros, the threes, the twos, the false aces, the
   kings...). Before the first trick ends either player may call envido
   (two cards of one suit count 20 plus their values, figures count 0; the
   higher wins; mano wins a tie): envido, real envido or falta envido, and
   the other may accept, refuse or raise. At any time on your turn you may
   call truco (the hand is worth 2), the other may accept, refuse (you take
   1) or raise to retruco (3) and then vale cuatro (4). Mazo folds the hand.
   Flor (three cards of one suit, worth 3 points) is an option and off by
   default. Play to 15 or 30.

   Card ids 0 to 39: suit = floor(id / 10) (0 oros, 1 copas, 2 espadas, 3
   bastos), k = id % 10 (0 to 6 the ace to the 7, 7 sota, 8 caballo, 9 rey).
   State: hands[2] (cards left), orig[2] (the deal), trick [{seat, id}],
   done [{plays, winner}] (winner -1 for a tie), mano, turn, truco {level,
   owner}, envido {done, points, winner, value}, call {kind, by, chain|level},
   ask (who must answer, or -1), hold (a truco call waiting for an envido),
   scores[2], target, handNo, phase ('play' | 'handEnd' | 'over'), result,
   say {seat, text}, note, moves. Seats: 0 you, 1 North. Pure functions; the
   page wiring at the bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  // The page renames the seats when two people share a device; YOU is the seat called "You" (-1: none).
  var NAMES = [TX('cards.you'), root.ZimiText.ZIMI], YOU = 0, DECK = 40, HAND = 3, FLOR_POINTS = 3, ENVIDO_BASE = 20;
  function setNames(names, youSeat) { NAMES[0] = names[0]; NAMES[1] = names[1]; YOU = youSeat; }
  var suitOf = function (id) { return Math.floor(id / 10); };
  var rankOf = function (id) { return [1, 2, 3, 4, 5, 6, 7, 10, 11, 12][id % 10]; };
  var other = function (seat) { return 1 - seat; };
  var nameOf = function (id) { return Z.spanishName(id); };
  var ESPADAS = 2, BASTOS = 3, OROS = 0, COPAS = 1;
  // The truco order, strongest 14. Keyed by rank, with the four special cards by id.
  var POWER_BY_RANK = { 3: 10, 2: 9, 12: 7, 11: 6, 10: 5, 6: 3, 5: 2, 4: 1 };
  function power(id) {
    var r = rankOf(id), s = suitOf(id);
    if (r === 1) return s === ESPADAS ? 14 : s === BASTOS ? 13 : 8;
    if (r === 7) return s === ESPADAS ? 12 : s === OROS ? 11 : 4;
    return POWER_BY_RANK[r];
  }
  var envidoValue = function (id) { return rankOf(id) <= 7 ? rankOf(id) : 0; };
  // A hand's envido: the best two cards of one suit plus 20, or the best single card.
  function envidoPoints(hand) {
    var best = 0, i, j;
    hand.forEach(function (c) { best = Math.max(best, envidoValue(c)); });
    for (i = 0; i < hand.length; i++) for (j = i + 1; j < hand.length; j++) {
      if (suitOf(hand[i]) === suitOf(hand[j])) best = Math.max(best, ENVIDO_BASE + envidoValue(hand[i]) + envidoValue(hand[j]));
    }
    return best;
  }
  var hasFlor = function (hand) { return hand.length === HAND && hand.every(function (c) { return suitOf(c) === suitOf(hand[0]); }); };

  // ── Rules ───────────────────────────────────────────────────────────────
  function dealHand(order, handNo, scores, mano, target, flor) {
    var hands = [order.slice(0, HAND), order.slice(HAND, 2 * HAND)];
    var s = {
      hands: hands, orig: [hands[0].slice(), hands[1].slice()], trick: [], done: [], mano: mano, turn: mano, truco: { level: 0, owner: -1 }, envido: { done: false },
      call: null, ask: -1, hold: null, scores: scores.slice(), target: target, flor: !!flor, handNo: handNo, phase: 'play', result: null, say: null, note: '', moves: 0
    };
    if (s.flor) {
      var fl = [hasFlor(hands[0]), hasFlor(hands[1])];
      s.florHeld = fl;
      [0, 1].forEach(function (seat) { if (fl[seat]) s.scores[seat] += FLOR_POINTS; });
      if (fl[0] || fl[1]) s.note = [0, 1].filter(function (q) { return fl[q]; }).map(function (q) { return TX(YOU === q ? 'truco.flor.you' : 'truco.flor', { name: NAMES[q], n: FLOR_POINTS }); }).join(' ') + ' ' + TX('truco.noEnvido');
      if (s.scores[0] >= target || s.scores[1] >= target) s.phase = 'over';
    }
    return s;
  }
  function newGame(order, target, mano, flor) { return dealHand(order, 0, [0, 0], mano === undefined ? 1 : mano, target || 15, flor); }
  function nextHand(st, order) { return dealHand(order, st.handNo + 1, st.scores, other(st.mano), st.target, st.flor); }

  var stake = function (st) { return st.truco.level === 0 ? 1 : st.truco.level + 1; };
  var florInPlay = function (st) { return !!(st.flor && st.florHeld && (st.florHeld[0] || st.florHeld[1])); };
  function envidoOpen(st, seat) { return !st.envido.done && st.done.length === 0 && st.truco.level === 0 && st.hands[seat].length === HAND && !florInPlay(st); }
  var ENVIDO_VALUE = { envido: 2, real: 3 };
  var has = function (chain, k) { return chain.indexOf(k) >= 0; };
  var countOf = function (chain, k) { return chain.filter(function (c) { return c === k; }).length; };
  // What may be added to an envido chain.
  function envidoRaises(chain) {
    var out = [];
    if (has(chain, 'falta')) return out;
    if (!has(chain, 'real') && countOf(chain, 'envido') < 2) out.push('envido');
    if (!has(chain, 'real')) out.push('real');
    out.push('falta');
    return out;
  }
  var faltaPoints = function (st) { return Math.max(1, st.target - Math.max(st.scores[0], st.scores[1])); };
  function chainValue(st, chain) { return has(chain, 'falta') ? faltaPoints(st) : chain.reduce(function (n, k) { return n + ENVIDO_VALUE[k]; }, 0); }
  var TRUCO_KEYS = ['truco', 'retruco', 'valeCuatro'];
  var trucoWord = function (level) { return TX('truco.word.' + TRUCO_KEYS[level]); };

  // The actions open to `seat`: [{ type, id? }].
  function actions(st, seat) {
    var out = [];
    if (st.phase !== 'play') return out;
    if (st.call) {
      if (st.ask !== seat) return out;
      out.push({ type: 'quiero' }, { type: 'noquiero' });
      if (st.call.kind === 'envido') envidoRaises(st.call.chain).forEach(function (k) { out.push({ type: k }); });
      else {
        if (st.call.level < 3) out.push({ type: 'truco' });
        if (st.truco.level === 0 && envidoOpen(st, seat)) out.push({ type: 'envido' }, { type: 'real' }, { type: 'falta' });
      }
      return out;
    }
    if (st.turn !== seat) return out;
    st.hands[seat].forEach(function (id) { out.push({ type: 'play', id: id }); });
    if (envidoOpen(st, seat)) out.push({ type: 'envido' }, { type: 'real' }, { type: 'falta' });
    if (st.truco.level < 3 && (st.truco.owner === -1 || st.truco.owner === seat)) out.push({ type: 'truco' });
    out.push({ type: 'mazo' });
    return out;
  }
  function isLegal(st, seat, type, id) {
    return actions(st, seat).some(function (a) { return a.type === type && (type !== 'play' || a.id === id); });
  }
  var sayFor = function (st, type) { return type === 'truco' ? TX('truco.shout', { word: trucoWord(st.call && st.call.kind === 'truco' ? st.call.level - 1 : 0) }) : TX('truco.say.' + type); };

  function endHand(s, winner, points, reason) {
    s.scores[winner] += points;
    s.result = { winner: winner, points: points, reason: reason };
    s.call = null; s.ask = -1; s.hold = null;
    s.phase = s.scores[winner] >= s.target ? 'over' : 'handEnd';
    return s;
  }
  // Who has won the hand from the tricks so far (-1: still going).
  function handWinner(done, mano) {
    var w = done.map(function (d) { return d.winner; }), a = w[0], b = w[1], c = w[2];
    if (done.length === 2) {
      if (a >= 0 && b >= 0) return a === b ? a : -1;
      if (a < 0 && b >= 0) return b;
      if (a >= 0 && b < 0) return a;
      return -1;
    }
    if (done.length === 3) return c >= 0 ? c : mano;
    return -1;
  }
  function resolveTrick(s) {
    var a = s.trick[0], b = s.trick[1], pa = power(a.id), pb = power(b.id), winner = pa === pb ? -1 : pa > pb ? a.seat : b.seat;
    s.done.push({ plays: s.trick, winner: winner }); s.trick = [];
    var w = handWinner(s.done, s.mano);
    if (w >= 0) return endHand(s, w, stake(s), 'tricks');
    s.turn = winner >= 0 ? winner : s.mano;
    return s;
  }
  function settleEnvido(s, accepted) {
    var c = s.call, chain = c.chain, by = c.by, resp = other(by), res;
    if (accepted) {
      var pts = [envidoPoints(s.orig[0]), envidoPoints(s.orig[1])], win = pts[0] === pts[1] ? s.mano : pts[0] > pts[1] ? 0 : 1, value = chainValue(s, chain);
      res = { done: true, points: pts, winner: win, value: value };
      s.scores[win] += value;
      s.note = TX('truco.envidoNote', { a: NAMES[0], pa: pts[0], b: NAMES[1], pb: pts[1] }) + ' ' + TX(win === YOU ? 'truco.envidoWins.you' : 'truco.envidoWins', { name: NAMES[win], n: value });
    } else {
      var prior = chain.slice(0, -1), value2 = prior.length ? chainValue(s, prior) : 1;
      res = { done: true, points: null, winner: by, value: value2 };
      s.scores[by] += value2;
      s.note = TX(resp === YOU ? 'truco.envidoRefused.you' : 'truco.envidoRefused', { name: NAMES[resp], who: by === YOU ? TX('truco.youTake') : TX('truco.nameTakes', { name: NAMES[by] }), n: value2 });
    }
    s.envido = res; s.call = s.hold; s.hold = null; s.ask = s.call ? other(s.call.by) : -1;
    if (s.scores[0] >= s.target || s.scores[1] >= s.target) { s.phase = 'over'; s.result = { winner: res.winner, points: res.value, reason: 'envido' }; s.call = null; s.ask = -1; }
    return s;
  }
  function act(st, seat, type, id) {
    if (!isLegal(st, seat, type, id)) return st;
    var s = Z.clone(st);
    s.moves++;
    s.note = '';
    if (type === 'play') {
      s.hands[seat].splice(s.hands[seat].indexOf(id), 1);
      s.trick.push({ seat: seat, id: id }); s.say = null;
      if (s.trick.length === 2) return resolveTrick(s);
      s.turn = other(seat);
      return s;
    }
    s.say = { seat: seat, text: sayFor(s, type) };
    if (type === 'mazo') return endHand(s, other(seat), stake(s), 'mazo');
    if (type === 'envido' || type === 'real' || type === 'falta') {
      if (s.call && s.call.kind === 'envido') { s.call.chain.push(type); s.call.by = seat; s.ask = other(seat); }
      else { s.hold = s.call; s.call = { kind: 'envido', by: seat, chain: [type] }; s.ask = other(seat); }
      return s;
    }
    if (type === 'truco') {
      if (s.call && s.call.kind === 'truco') { s.truco = { level: s.call.level, owner: -1 }; s.say.text = TX('truco.shout', { word: trucoWord(s.call.level) }); s.call = { kind: 'truco', by: seat, level: s.call.level + 1 }; }
      else { s.call = { kind: 'truco', by: seat, level: s.truco.level + 1 }; s.say.text = TX('truco.shout', { word: trucoWord(s.truco.level) }); }
      s.ask = other(seat);
      return s;
    }
    if (type === 'quiero') {
      if (s.call.kind === 'envido') return settleEnvido(s, true);
      s.truco = { level: s.call.level, owner: seat }; s.call = null; s.ask = -1;
      return s;
    }
    // noquiero
    if (s.call.kind === 'envido') return settleEnvido(s, false);
    return endHand(s, s.call.by, s.call.level, 'refused');
  }
  var gameWinner = function (st) { return st.scores[0] >= st.target ? 0 : st.scores[1] >= st.target ? 1 : -1; };

  // ── The computer player ─────────────────────────────────────────────────
  var topTwo = function (hand) { var p = hand.map(power).sort(function (a, b) { return b - a; }); return p.length > 1 ? (p[0] + p[1]) / 2 : p.length ? p[0] : 0; };
  // How good a hand it still is, with what the tricks so far have shown.
  function strength(st, seat) {
    var s = topTwo(st.hands[seat]), won = st.done.filter(function (d) { return d.winner === seat; }).length, lost = st.done.filter(function (d) { return d.winner === other(seat); }).length;
    return s + (won - lost) * 2;
  }
  var TRUCO_ACCEPT = [0, 7.2, 8.8, 10.2];
  function chooseCard(st, seat) {
    var hand = st.hands[seat].slice().sort(function (a, b) { return power(a) - power(b); });
    if (st.trick.length) {
      var foe = power(st.trick[0].id), beat = hand.filter(function (c) { return power(c) > foe; });
      if (beat.length) return beat[0];
      var tie = hand.filter(function (c) { return power(c) === foe; });
      return tie.length ? tie[0] : hand[0];
    }
    if (st.done.length === 0 && hand.length === 3) return hand[1];
    return hand[hand.length - 1];
  }
  // rnd() in [0,1): the bluffs and the close calls.
  function aiAct(st, seat, rnd) {
    var acts = actions(st, seat), can = function (t) { return acts.some(function (a) { return a.type === t; }); };
    var pts = envidoPoints(st.orig[seat]), s = strength(st, seat);
    if (st.call && st.ask === seat) {
      if (st.call.kind === 'envido') {
        var chain = st.call.chain, big = has(chain, 'falta') || has(chain, 'real');
        if (pts >= 33 && can('falta') && rnd() < 0.5) return { type: 'falta' };
        if (pts >= 31 && can('real') && rnd() < 0.6) return { type: 'real' };
        if (pts >= 28 || (pts >= 25 && !big && rnd() < 0.55) || (pts >= 22 && chain.length === 1 && rnd() < 0.15)) return { type: 'quiero' };
        return { type: 'noquiero' };
      }
      if (st.truco.level === 0 && can('envido') && pts >= 29 && rnd() < 0.7) return { type: pts >= 32 ? 'real' : 'envido' };
      var need = TRUCO_ACCEPT[st.call.level], lvl = st.call.level;
      if (s >= 11.5 && can('truco') && rnd() < 0.6) return { type: 'truco' };
      if (s >= need || rnd() < 0.12 * (4 - lvl)) return { type: 'quiero' };
      return { type: 'noquiero' };
    }
    if (can('envido') && pts >= 27 && rnd() < 0.85) return { type: pts >= 33 && rnd() < 0.4 ? 'falta' : pts >= 31 && rnd() < 0.5 ? 'real' : 'envido' };
    if (can('envido') && pts <= 23 && rnd() < 0.06) return { type: 'envido' };
    if (can('truco') && ((s >= 10.4 && rnd() < 0.5) || (s <= 6 && rnd() < 0.05 && st.trick.length === 0))) return { type: 'truco' };
    return { type: 'play', id: chooseCard(st, seat) };
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var COL_STEP = 1.28, ROW_DROP = 0.62, PANEL_ROOM = 128, DUEL_LIFT = 24;
  function geo(m) {
    var g = T.geometry(m, 1);
    // The tricks sit above the choices (up to two rows of buttons).
    var slack = g.statusY - PANEL_ROOM - g.yTop - g.ch * (1 + ROW_DROP);
    g.duelY = Math.round(g.yTop + Math.max(0, Math.min(slack * 0.25, DUEL_LIFT)));
    return g;
  }
  // The tricks side by side, North's card above yours.
  function place(st, m, view) {
    var V = (view && view.viewer) || 0, O = 1 - V, faceUp = !(view && view.hideHand);
    var g = geo(m), cards = [], slots = [], k, plays = st.done.map(function (d) { return d.plays; }).concat(st.trick.length ? [st.trick] : []);
    slots.push({ id: 'trick', x: g.cx - 2 * g.cw, y: g.duelY, w: 4 * g.cw, h: g.ch * (1 + ROW_DROP), quiet: true, label: TX('truco.slot.tricks') });
    var hand = T.handCards(g, st.hands[V], function (id) { return { up: faceUp, label: TX('truco.aria.worth', { card: nameOf(id), n: power(id) }) }; }, null);
    var step = Math.min(g.cw * 1.12, (g.W - 2 * g.pad - g.cw) / Math.max(1, st.hands[V].length - 1)), x0 = (g.W - (g.cw + (st.hands[V].length - 1) * step)) / 2;
    hand.cards.forEach(function (c, i) { c.x = Math.round(x0 + i * step); hand.slots[i].x = c.x; });
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    cards = cards.concat(T.fan(g, 2, st.hands[O], false).map(function (c, i, a) { c.x = Math.round((g.W - (g.cw + (a.length - 1) * g.cw * 0.5)) / 2 + i * g.cw * 0.5); return c; }));
    plays.forEach(function (pair, i) {
      var cx = g.cx - g.cw / 2 + (i - 1) * g.cw * COL_STEP, won = i < st.done.length ? st.done[i].winner : -2;
      // North's card first, so yours lies over its lower edge and is whole.
      pair.slice().sort(function (a, b) { return (a.seat === V) - (b.seat === V); }).forEach(function (p) {
        cards.push({ id: p.id, pile: 'k' + i, idx: p.seat, x: Math.round(cx + (p.seat ? 0 : 0)), y: Math.round(g.duelY + (p.seat === V ? g.ch * ROW_DROP : 0)), up: true, glow: won === p.seat, dim: won >= 0 && won !== p.seat });
      });
    });
    return { height: m.H, slots: slots, cards: cards };
  }

  var api = {
    setNames: setNames, NAMES: NAMES, DECK: DECK, power: power, rankOf: rankOf, suitOf: suitOf, envidoPoints: envidoPoints, hasFlor: hasFlor, dealHand: dealHand, newGame: newGame, nextHand: nextHand,
    stake: stake, actions: actions, isLegal: isLegal, act: act, handWinner: handWinner, envidoRaises: envidoRaises, chainValue: chainValue, faltaPoints: faltaPoints,
    gameWinner: gameWinner, aiAct: aiAct, strength: strength, geo: geo, place: place, nameOf: nameOf
  };
  root.ZimiTruco = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 650, TRICK_MS = 950, TARGET_KEY = 'truco.target', FLOR_KEY = 'truco.flor', TARGETS = [15, 30];
  function boot() {
    var d = root.document, t, board, session, view = { flash: '', sweep: false, viewer: 0, hideHand: false };
    // Each seat is the Computer or a Person; two people share the screen behind a handoff.
    var seats = Seats.create({ id: 'truco', seats: 2, onChange: function () { if (board) board.refresh(); if (t) t.paint(); } });
    // Who must act: the one asked to answer a call, else the player to play.
    var actor = function (st) { return st.call ? st.ask : st.turn; };
    function syncView(st) { view.viewer = seats.view(); view.hideHand = seats.hotseat() && st.phase === 'play' && actor(st) !== view.viewer; }
    function nameSeats() { setNames([seats.name(0), seats.name(1)], seats.isYou(0) ? 0 : seats.isYou(1) ? 1 : -1); }
    var who = function (s) { return seats.name(s); };
    var busy = function () { return view.sweep; };
    function labelFor(st, type) {
      if (type === 'truco') return st.call && st.call.kind === 'truco' ? TX('truco.quieroWord', { word: trucoWord(st.call.level) }) : TX('truco.call.' + TRUCO_KEYS[st.truco.level]);
      return TX('truco.label.' + type);
    }
    function handLines(st) {
      var r = st.result;
      return [TX('truco.why.' + r.reason, { name: who(r.winner), points: Z.plural(r.points, 'point') }), TX('truco.score', { a: who(0), pa: st.scores[0], b: who(1), pb: st.scores[1], target: st.target })];
    }
    function hud(st) {
      var V = view.viewer, mine = st.hands[actor(st)], wins = [0, 1].map(function (s) { return st.done.filter(function (x) { return x.winner === s; }).length; });
      var out = {
        chips: [0, 1].map(function (c) { return { name: who(c), text: String(st.scores[c]), turn: st.phase === 'play' && !busy() && actor(st) === c }; }).concat([
          { name: TX('truco.tricks'), text: wins[0] + '-' + wins[1] }, { name: TX('truco.hand'), text: TX('truco.worth', { n: stake(st) }) }]),
        fact: TX('truco.fact', { n: st.target }) + (!st.envido.done && st.done.length === 0 && !florInPlay(st) && !view.hideHand ? ' \u00b7 ' + TX('truco.envidoPts', { n: envidoPoints(st.orig[V]) }) : ''), text: ''
      };
      var said = st.say ? who(st.say.seat) + ': ' + st.say.text : '';
      if (st.phase === 'handEnd') { out.text = handLines(st)[0]; out.label = TX('cards.nextHand'); out.action = startNextHand; return out; }
      if (st.phase === 'over') { out.text = TX('shell.end.over'); return out; }
      if (busy()) { var tw = st.done.length ? st.done[st.done.length - 1].winner : -1; out.text = tw >= 0 ? (seats.isYou(tw) ? TX('cards.trick.you') : TX('cards.trick.name', { name: who(tw) })) : TX('truco.trickTied'); return out; }
      var me = actor(st), acts = actions(st, me), asked = st.call && seats.person(st.ask), you = seats.isYou(me), nm = who(me);
      if (asked) {
        out.text = (said ? said + ' ' : '') + TX(st.call.kind === 'envido' ? (you ? 'truco.answer.you' : 'truco.answer') : (you ? 'truco.answerWorth.you' : 'truco.answerWorth'), { name: nm, n: st.call.level + 1 });
        out.choices = acts.filter(function (a) { return a.type !== 'play'; }).map(function (a) { return { label: labelFor(st, a.type), onclick: function () { go(a.type); } }; });
      } else if (seats.person(st.turn) && !st.call) {
        out.text = (st.note ? st.note + ' ' : said ? said + ' ' : '') + TX(you ? 'truco.play.you' : 'truco.play', { name: nm });
        out.choices = acts.filter(function (a) { return a.type !== 'play'; }).map(function (a) { return { label: labelFor(st, a.type), onclick: function () { go(a.type); } }; });
        if (mine.length === 0) out.choices = [];
      } else out.text = st.note || said || TX('cards.thinking', { name: who(me) });   // what was just said stands on its own: the chip's pulse says the computer is thinking
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'over') { gameOver(); return; }
      if (st.phase === 'handEnd') { handOver(); return; }
      if (busy()) return;
      if (seats.person(actor(st))) seats.ensure(actor(st), refresh); else session.later(aiTurn, AI_MS);
    }
    function refresh() { board.refresh(); t.paint(); }
    function aiTurn() {
      var st = session.state;
      if (st.phase !== 'play' || busy() || seats.person(actor(st))) return;
      var a = aiAct(st, actor(st), Math.random);
      apply(actor(st), a.type, a.id);
    }
    // One action, then what follows: a finished trick is held a moment, a said word flashed.
    function apply(seat, type, id) {
      var st = session.state;
      if (!isLegal(st, seat, type, id)) return false;
      var next = act(st, seat, type, id), closes = type === 'play' && next.done.length > st.done.length;
      if (seats.person(seat)) session.commit(next); else session.follow(next);
      if (closes) { view.sweep = true; session.later(function () { view.sweep = false; board.refresh(); t.paint(); drive(); }, TRICK_MS); board.refresh(); t.paint(); return true; }
      drive();
      return true;
    }
    function go(type) { var st = session.state; if (st.phase === 'play' && !busy()) apply(actor(st), type); }
    function handOver() {
      var st = session.state;
      T.lineSheet(TX('cards.fact.hand', { n: st.handNo + 1 }), handLines(st), [{ label: TX('cards.nextHand'), primary: true, onclick: startNextHand }]);
    }
    function gameOver() {
      var st = session.state, w = gameWinner(st), won = seats.isYou(w), lines = (st.result ? handLines(st) : []).concat([TX(won ? 'truco.winYou' : 'truco.winName', { name: who(w), a: st.scores[w], b: st.scores[1 - w] })]);
      if (won) session.win(st.scores[0]); else session.lose(seats.hotseat() ? { name: who(w) } : '', lines, seats.hotseat() ? undefined : st.scores[0]);
    }
    var order = function () { return Z.shuffled(Math.random).filter(function (c) { return c < DECK; }); };
    function startNextHand() {
      var st = session.state;
      if (st.phase !== 'handEnd') return;
      session.history = []; view.sweep = false;
      session.follow(nextHand(st, order()));
      deal();
    }
    var idOf = function (pile) { return parseInt(pile.slice(1), 10); };
    function tap(pile) {
      var st = session.state, id = idOf(pile);
      if (pile.charAt(0) !== 'h' || isNaN(id)) return false;
      if (st.phase !== 'play') return false;
      if (busy() || st.call || st.turn !== seats.view()) { t.flash(st.call && st.ask === seats.view() ? TX('truco.answerFirst') : TX('cards.wait.turn')); return false; }
      return apply(st.turn, 'play', id);
    }
    function startGame() {
      view.sweep = false; view.flash = '';
      var target = Z.store.get(TARGET_KEY, 15), flor = Z.store.get(FLOR_KEY, 'off') === 'on';
      nameSeats();
      session.reset(newGame(order(), TARGETS.indexOf(target) >= 0 ? target : 15, Math.floor(Math.random() * 2), flor));
      deal();
    }
    // A fresh deal: nobody has seen it, so two people start at a handoff.
    function deal() { var st = session.state; seats.begin(function () { refresh(); drive(); }, actor(st)); }
    t = T.create({
      id: 'truco', name: 'Truco', liftPlay: function (st) { return st.phase === 'play' && !st.call; }, seats: seats, view: view, geo: geo, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: startGame, tap: tap, cols: 5, heightShare: 0.13, face: Z.spanishFaceMarkup,
      canPick: function () { return false; },
      stat: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.scores[0] + '-' + st.scores[1]; },
      cascadeOrder: function (st) { return st.orig[0].map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return [TX('truco.winYou', { a: st.scores[seats.view()], b: st.scores[1 - seats.view()] })]; },
      menuExtra: function () {
        return [T.choiceRow(TX('truco.playTo'), TARGET_KEY, TARGETS.map(function (n) { return { value: n, label: String(n) }; }), 15, function () {}),
          T.choiceRow(TX('truco.florRow'), FLOR_KEY, [{ value: 'off', label: TX('shell.off') }, { value: 'on', label: TX('shell.on') }], 'off', function () {}),
          Z.h('p', { class: 'zc-note', text: TX('truco.nextGame') })];
      },
      rules: TX('truco.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    startGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
