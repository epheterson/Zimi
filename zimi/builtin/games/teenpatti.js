/* ZimiGames: Teen Patti, the Indian three-card game, you and three computer
   players (Asha, Dev and Rani) with chips and a standard 52-card deck.
   Everyone pays a boot into the pot and gets three cards face down. A player
   may play blind (without looking) or look at the cards and play seen. The
   stake is the blind bet: a blind player pays the stake (or double it to raise
   it), a seen player pays double the stake (or four times it to raise it, which
   doubles the stake). Pack folds. A seen player may ask the seen player before
   him for a side show (paying a chaal): if accepted the weaker hand packs, and
   a tie sends the asker out. With two players left either may ask for a show:
   pay a bet and both hands are turned over; a tie goes to the player who did
   not ask. Hands, best first: trail (three of a kind), pure sequence (a straight
   flush), sequence (a straight), colour (a flush), pair, high card. In a
   sequence A-2-3 is the highest, then A-K-Q, K-Q-J down to 4-3-2. If a bet is
   more than a player has, they go all in and the hands are shown. Reach
   1500 chips to win, or play until the others are out; you lose when you cannot pay the boot.

   State: hands[4], chips[4], paid[4], pot, stake, boot, seen[4], folded[4],
   out[4] (out of the match), allIn[4], dealer, turn, phase ('bet' | 'side' |
   'handEnd' | 'over'), side {from, to}, result {winner, kind, ...}, say {seat,
   text}, round, moves. Seats clockwise: 0 you, 1 West (Asha), 2 North (Dev),
   3 East (Rani). Pure functions; the page wiring at the bottom only runs in a
   browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var SEATS = 4, HAND = 3, START_CHIPS = 1000, BOOT = 10, MAX_STAKE = 160, TARGET = 1500;
  var cpu = function (n) { return TX('seats.cpu.' + n); };
  var NAMES = [TX('cards.you'), cpu(1), cpu(2), cpu(3)], STYLES = [null, 'careful', 'bold', 'bluffer'];
  var CATEGORIES = ['highCard', 'pair', 'colour', 'sequence', 'pureSequence', 'trail'];
  var rankValue = function (id) { return Z.rank(id) === 1 ? 14 : Z.rank(id); };
  var suitOf = Z.suit;

  // ── Hands ───────────────────────────────────────────────────────────────
  // A hand as a list to compare: [category, tie-breakers...]; higher wins.
  function evaluate(cards) {
    var v = cards.map(rankValue).sort(function (a, b) { return b - a; }), flush = cards.every(function (c) { return suitOf(c) === suitOf(cards[0]); });
    var trail = v[0] === v[2], pair = v[0] === v[1] || v[1] === v[2];
    var lowAce = v[0] === 14 && v[1] === 3 && v[2] === 2; // A-2-3, the highest sequence
    var run = v[0] - 1 === v[1] && v[1] - 1 === v[2], seqTop = lowAce ? 15 : v[0];
    if (trail) return [5, v[0]];
    if (lowAce || run) return [flush ? 4 : 3, seqTop];
    if (flush) return [2].concat(v);
    if (pair) { var p = v[0] === v[1] ? v[0] : v[1], k = v[0] === v[1] ? v[2] : v[0]; return [1, p, k]; }
    return [0].concat(v);
  }
  function compare(a, b) {
    for (var i = 0; i < Math.max(a.length, b.length); i++) { var d = (a[i] || 0) - (b[i] || 0); if (d) return d; }
    return 0;
  }
  var describe = function (cards) { return TX('tp.cat.' + CATEGORIES[evaluate(cards)[0]]); };

  // ── Rules ───────────────────────────────────────────────────────────────
  function deal(order, round, chips, dealer) {
    var cards = order.filter(function (c) { return c < 52; }), out = chips.map(function (c) { return c < BOOT; }), hands = [], i, pot = 0, paid = [0, 0, 0, 0], nc = chips.slice();
    var k = 0;
    for (i = 0; i < SEATS; i++) {
      if (out[i]) { hands.push([]); continue; }
      hands.push(cards.slice(k * HAND, (k + 1) * HAND)); k++;
      nc[i] -= BOOT; pot += BOOT; paid[i] = BOOT;
    }
    var s = {
      hands: hands, chips: nc, paid: paid, pot: pot, stake: BOOT, seen: [false, false, false, false], folded: out.slice(), out: out, allIn: [false, false, false, false], dealer: dealer, turn: 0, phase: 'bet',
      side: null, result: null, say: null, round: round, moves: 0
    };
    s.turn = nextSeat(s, dealer);
    return s;
  }
  function newGame(order, dealer) { return deal(order, 0, [START_CHIPS, START_CHIPS, START_CHIPS, START_CHIPS], dealer === undefined ? 3 : dealer); }
  function nextHand(st, order) {
    var dealer = st.dealer;
    do dealer = (dealer + 1) % SEATS; while (st.chips[dealer] < BOOT && dealer !== st.dealer);
    var ns = deal(order, st.round + 1, st.chips, dealer);
    if (st.people) ns.people = st.people;
    return ns;
  }
  var active = function (s) { return [0, 1, 2, 3].filter(function (i) { return !s.folded[i] && !s.out[i]; }); };
  // The next player after `seat` who can still act.
  function nextSeat(s, seat) {
    for (var i = 1; i <= SEATS; i++) { var n = (seat + i) % SEATS; if (!s.folded[n] && !s.out[n] && !s.allIn[n]) return n; }
    return seat;
  }
  function prevActive(s, seat) {
    for (var i = 1; i < SEATS; i++) { var n = (seat - i + SEATS) % SEATS; if (!s.folded[n] && !s.out[n]) return n; }
    return -1;
  }

  // What a bet costs `seat` now.
  function cost(s, seat, type) {
    var st = s.stake;
    return { blind: st, blindRaise: 2 * st, chaal: 2 * st, raise: 4 * st, sideshow: 2 * st, show: s.seen[seat] ? 2 * st : st }[type];
  }
  // The actions open to `seat`: [{ type, cost }].
  function actions(s, seat) {
    var out = [], push = function (type) { out.push({ type: type, cost: type === 'see' || type === 'pack' ? 0 : cost(s, seat, type) }); };
    if (s.phase !== 'bet' || s.turn !== seat || s.folded[seat] || s.out[seat]) return out;
    var raise = s.stake * 2 <= MAX_STAKE, many = active(s).length > 2;
    if (!s.seen[seat]) { push('see'); push('blind'); if (raise) push('blindRaise'); }
    else {
      push('chaal'); if (raise) push('raise');
      var prev = prevActive(s, seat);
      if (many && prev >= 0 && s.seen[prev]) push('sideshow');
    }
    if (!many) push('show');
    push('pack');
    return out;
  }
  function isLegal(s, seat, type) { return actions(s, seat).some(function (a) { return a.type === type; }); }
  function pay(s, seat, amount) {
    var a = Math.min(amount, s.chips[seat]);
    s.chips[seat] -= a; s.pot += a; s.paid[seat] += a;
    if (s.chips[seat] === 0) s.allIn[seat] = true;
    return a;
  }
  function endHand(s, winner, kind, extra) {
    s.chips[winner] += s.pot;
    s.result = Object.assign({ winner: winner, pot: s.pot, kind: kind }, extra || {});
    s.pot = 0; s.phase = gameWinner(s) !== -1 ? 'over' : 'handEnd';
    return s;
  }
  // The best hand among `seats`; on a tie the seat in `loses` (the one who asked) gives way.
  function showdown(s, seats, asker) {
    var best = null;
    seats.forEach(function (i) {
      if (best === null) { best = i; return; }
      var c = compare(evaluate(s.hands[i]), evaluate(s.hands[best]));
      if (c > 0 || (c === 0 && best === asker)) best = i;
    });
    return best;
  }
  // After a bet: one left wins; if nobody can bet on, the hands are shown.
  function settle(s) {
    var act = active(s);
    if (act.length === 1) return endHand(s, act[0], 'fold');
    var movers = act.filter(function (i) { return !s.allIn[i]; });
    if (movers.length <= 1 && act.some(function (i) { return s.allIn[i]; })) return endHand(s, showdown(s, act, -1), 'showdown', { seats: act });
    s.turn = nextSeat(s, s.turn);
    return s;
  }
  var sayWord = function (type) { return TX('tp.say.' + type); };
  function act(st, seat, type) {
    if (!isLegal(st, seat, type)) return st;
    var s = Z.clone(st), c = cost(s, seat, type);
    s.moves++;
    s.say = { seat: seat, type: type, text: sayWord(type), amount: 0 };
    if (type === 'see') { s.seen[seat] = true; return s; }
    if (type === 'pack') { s.folded[seat] = true; return settle(s); }
    s.say.amount = pay(s, seat, c);
    if (type === 'blindRaise') s.stake = Math.min(MAX_STAKE, s.stake * 2);
    if (type === 'raise') s.stake = Math.min(MAX_STAKE, s.stake * 2);
    if (type === 'show') {
      var act2 = active(s), w = showdown(s, act2, seat);
      return endHand(s, w, 'show', { seats: act2, asker: seat });
    }
    if (type === 'sideshow') { s.side = { from: seat, to: prevActive(s, seat) }; s.phase = 'side'; return s; }
    return settle(s);
  }
  // The answer to a side show: accepted, the weaker hand packs; refused, play goes on.
  function respondSide(st, seat, accept) {
    if (st.phase !== 'side' || !st.side || st.side.to !== seat) return st;
    var s = Z.clone(st), from = s.side.from, to = s.side.to;
    s.moves++; s.phase = 'bet'; s.side = null;
    if (!accept) { s.say = { seat: seat, type: 'refuse', text: TX('tp.say.refuse'), amount: 0 }; s.turn = from; return settle(s); }
    var c = compare(evaluate(s.hands[from]), evaluate(s.hands[to])), loser = c > 0 ? to : from;
    s.folded[loser] = true;
    s.say = { seat: seat, type: 'accept', text: TX(loser === 0 ? 'tp.acceptsPack.you' : 'tp.acceptsPack', { name: NAMES[loser] }), amount: 0, loser: loser };
    s.turn = from;
    return settle(s);
  }
  // You win with TARGET chips or the table out of chips; you lose when you cannot pay the boot.
  // st.people (set by the page) lists the seats a person plays: with several, the match runs
  // until one seat holds TARGET chips or is the only one able to pay the boot.
  var gameWinner = function (st) {
    var P = st.people, h = P && P.length === 1 ? P[0] : 0, solvent;
    if (P && P.length > 1) {
      var top = [0, 1, 2, 3].filter(function (i) { return st.chips[i] >= TARGET; });
      if (top.length) return top[0];
      solvent = [0, 1, 2, 3].filter(function (i) { return st.chips[i] >= BOOT; });
      return solvent.length === 1 ? solvent[0] : -1;
    }
    return st.chips[h] < BOOT ? (h === 0 ? 1 : 0) : st.chips[h] >= TARGET || [0, 1, 2, 3].every(function (i) { return i === h || st.chips[i] < BOOT; }) ? h : -1;
  };

  // ── The computer players ────────────────────────────────────────────────
  // 0..1: how good a hand is.
  function strength(cards) {
    var e = evaluate(cards), cat = e[0];
    if (cat === 5) return 1;
    if (cat === 4) return 0.93 + e[1] / 400;
    if (cat === 3) return 0.8 + e[1] / 300;
    if (cat === 2) return 0.62 + e[1] / 100;
    if (cat === 1) return 0.38 + e[1] / 60;
    return 0.08 + e[1] / 60 + e[2] / 300;
  }
  // Per style: how soon it looks, how much it bluffs, how high a stake it plays, how it raises.
  var PROFILE = {
    careful: { look: 0.55, bluff: 0.02, fold: 0.42, push: 0.08, raise: 0.74, side: 0.5 },
    bold: { look: 0.16, bluff: 0.1, fold: 0.25, push: 0.2, raise: 0.52, side: 0.8 },
    bluffer: { look: 0.3, bluff: 0.28, fold: 0.34, push: 0.14, raise: 0.62, side: 0.4 }
  };
  function aiAct(s, seat, rnd) {
    var p = PROFILE[STYLES[seat]] || PROFILE.careful, acts = actions(s, seat), can = function (t) { return acts.some(function (a) { return a.type === t; }); };
    var str = strength(s.hands[seat]), pressure = Math.log(s.stake / BOOT) / Math.log(2), bluffing = rnd() < p.bluff;
    var afford = s.chips[seat];
    if (!s.seen[seat]) {
      var lookP = p.look * (0.5 + pressure * 0.5);
      if (can('see') && rnd() < lookP) return { type: 'see' };
      if (can('show') && rnd() < 0.3) return { type: 'show' };
      if (can('blindRaise') && rnd() < (0.9 - p.raise) * 0.5) return { type: 'blindRaise' };
      return { type: can('blind') ? 'blind' : 'pack' };
    }
    var eff = bluffing ? Math.max(str, 0.8) : str, need = p.fold + pressure * p.push;
    if (eff < need && !(can('show') && eff > need - 0.12)) return { type: 'pack' };
    if (can('sideshow') && eff > 0.45 && rnd() < p.side * 0.6) return { type: 'sideshow' };
    if (can('raise') && eff > p.raise && rnd() < 0.7) return { type: 'raise' };
    if (can('show') && (eff > 0.55 || bluffing || rnd() < 0.15) && afford > cost(s, seat, 'show')) return { type: 'show' };
    return { type: can('chaal') ? 'chaal' : 'pack' };
  }
  // Accept a side show when the hand is good.
  function aiRespond(s, seat, rnd) {
    var p = PROFILE[STYLES[seat]] || PROFILE.careful, str = strength(s.hands[seat]);
    return str > 0.55 || (str > 0.42 && rnd() < p.side * 0.5) || rnd() < p.bluff;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var HAND_STEP = 1.1;
  function geo(m) { return T.geometry(m, 1); }
  // view: { reveal: bool } cards of the players still in are shown at the end of a showdown.
  function place(st, m, view) {
    var g = geo(m), cards = [], slots = [], ended = st.phase === 'handEnd' || st.phase === 'over', shown = ended && st.result && (st.result.kind === 'show' || st.result.kind === 'showdown');
    var V = (view && view.viewer) || 0, hide = !!(view && view.hideHand), look = st.seen[V] && !hide;
    slots.push({ id: 'pot', x: g.cx - g.cw, y: g.cy - g.ch / 2, w: 2 * g.cw, h: g.ch, quiet: true, label: TX('holdem.pot0', { n: st.pot }) });
    if (!st.out[V]) {
      var hand = T.handCards(g, st.hands[V], function (id) { return { up: look || shown, label: look || shown ? Z.cardName(id) : TX('cards.hidden') }; }, null);
      var step = Math.min(g.cw * HAND_STEP, (g.W - 2 * g.pad - g.cw) / Math.max(1, HAND - 1)), x0 = (g.W - (g.cw + (HAND - 1) * step)) / 2;
      hand.cards.forEach(function (c, k) { c.x = Math.round(x0 + k * step); hand.slots[k].x = c.x; if (st.folded[V]) c.dim = true; });
      slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    }
    [1, 2, 3].forEach(function (pos) {
      var seat = (V + pos) % SEATS;
      if (st.out[seat]) return;
      var up = shown && st.result.seats && st.result.seats.indexOf(seat) >= 0;
      T.fan(g, pos, st.hands[seat], up).forEach(function (c) { if (st.folded[seat]) c.dim = true; cards.push(c); });
    });
    return { height: m.H, slots: slots, cards: cards };
  }

  var api = {
    NAMES: NAMES, STYLES: STYLES, BOOT: BOOT, START_CHIPS: START_CHIPS, MAX_STAKE: MAX_STAKE, evaluate: evaluate, compare: compare, describe: describe, strength: strength, deal: deal, newGame: newGame,
    nextHand: nextHand, actions: actions, isLegal: isLegal, cost: cost, act: act, respondSide: respondSide, prevActive: prevActive, active: active, gameWinner: gameWinner, aiAct: aiAct, aiRespond: aiRespond,
    geo: geo, place: place
  };
  root.ZimiTeenPatti = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 700, END_MS = 700;
  function boot() {
    var d = root.document, t, board, session, view = { flash: '' };
    // Seats are the Computer or a Person. The computer players keep their own names and styles.
    var seats = Seats.create({ id: 'teenpatti', seats: SEATS, cpuNames: [cpu(4), cpu(1), cpu(2), cpu(3)], onChange: function () { if (t) t.paint(); if (board) board.refresh(); } });
    var who = function (seat) { return seats.name(seat); };
    // The seat acting now: whoever must answer a side show, else the player to bet.
    var actor = function (st) { return st.phase === 'side' ? st.side.to : st.turn; };
    var mine = function (seat) { return seats.person(seat) && seat === seats.view(); };
    function syncView(st) { view.viewer = seats.view(); view.hideHand = seats.hotseat() && actor(st) !== view.viewer; }
    function repaint() { board.refresh(); t.paint(); }
    // A line about a seat: the key's .you form is for "You".
    var said = function (seat, key, vars) { var v = vars || {}; v.name = who(seat); return TX(seats.isYou(seat) ? key + '.you' : key, v); };
    // What each computer player is doing (blind, seen, packed), under its cards.
    var tags = [null, Z.h('div', { class: 'tp-tag' }), Z.h('div', { class: 'tp-tag' }), Z.h('div', { class: 'tp-tag' })];
    [1, 2, 3].forEach(function (seat) { Z.pageEls().table.appendChild(tags[seat]); });
    // The pot is chips in the middle of the table.
    var pile = Z.h('div', { class: 'ct-pile' });
    Z.pageEls().table.appendChild(pile);
    function paintTags(g, st, over) {
      pile.textContent = '';
      if (st.pot > 0) { pile.appendChild(T.chipStack(st.pot)); pile.appendChild(Z.h('span', { class: 'ct-caption', text: TX('tp.potLine', { pot: st.pot, stake: st.stake }) })); }
      pile.style.top = Math.round(g.cy - 20) + 'px';
      var sideH = g.ch + (HAND - 1) * T.sideStep(g, HAND);
      [1, 2, 3].forEach(function (pos) {
        var seat = (seats.view() + pos) % SEATS, p = T.posOf(pos, SEATS), el = tags[pos];
        el.textContent = who(seat) + '\n' + TX(st.out[seat] ? 'holdem.out' : st.folded[seat] && !over ? 'tp.tag.packed' : st.seen[seat] ? 'tp.tag.seen' : 'tp.tag.blind');
        el.style.left = Math.round(p === 2 ? g.cx : (p === 1 ? g.westX : g.eastX) + g.cw / 2) + 'px';
        el.style.top = Math.round(p === 2 ? g.northY + g.ch + 4 : g.yTop + sideH + 4) + 'px';
      });
    }
    var labelOf = function (type) { return TX('tp.label.' + type); };
    function sayLine(st) {
      var y = st.say;
      if (!y) return '';
      if (y.type === 'accept') return said(y.seat, 'tp.accepts', { loser: who(y.loser), pack: TX(seats.isYou(y.loser) ? 'tp.pack.you' : 'tp.pack') });
      return said(y.seat, 'tp.line.' + y.type, { amount: y.amount ? ' (' + y.amount + ')' : '' });
    }
    function resultLines(st) {
      var r = st.result, lines = [];
      if (r.kind === 'fold') lines.push(said(r.winner, 'tp.takesPot', { pot: r.pot }));
      else {
        var list = (r.seats || []).map(function (i) { return TX('holdem.loser', { name: who(i), hand: describe(st.hands[i]) }); });
        lines.push(list.join(', ') + '.');
        lines.push(said(r.winner, 'tp.winsPot', { pot: r.pot }));
      }
      lines.push(TX('tp.chipsLine', { list: [0, 1, 2, 3].map(function (i) { return who(i) + ' ' + st.chips[i]; }).join(', ') }));
      return lines;
    }
    function hud(st) {
      var over = st.phase === 'handEnd' || st.phase === 'over';
      paintTags(geo(board.metrics()), st, over);
      var chips = [0, 1, 2, 3].map(function (i) { return (seats.view() + i) % SEATS; }).map(function (seat) {
        return { name: who(seat), text: String(st.chips[seat]), turn: !over && st.phase === 'bet' && st.turn === seat || (st.phase === 'side' && st.side.to === seat) };
      });
      var out = { chips: chips, fact: TX('tp.fact', { chips: st.chips[seats.view()] }), text: '' };
      var say = sayLine(st);
      if (st.phase === 'handEnd') { out.text = resultLines(st)[st.result.kind === 'fold' ? 0 : 1]; out.label = TX('cards.nextHand'); out.action = startNextHand; return out; }
      if (st.phase === 'over') { out.text = TX('shell.end.over'); return out; }
      if (st.phase === 'side') {
        if (mine(st.side.to)) {
          out.text = TX(seats.isYou(st.side.to) ? 'tp.asksYou' : 'tp.asks', { from: who(st.side.from), to: who(st.side.to) });
          out.choices = [{ label: TX('tp.accept'), onclick: function () { respond(true); } }, { label: TX('tp.refuse'), onclick: function () { respond(false); } }];
        } else out.text = (say ? say + ' ' : '') + TX('euchre.deciding', { name: who(st.side.to) });
        return out;
      }
      if (mine(st.turn)) {
        var acts = actions(st, st.turn), hot = seats.hotseat();
        out.text = (say ? say + ' ' : '') + (hot ? TX('holdem.nameColon', { name: who(st.turn) }) + ' ' : '') + TX(st.seen[st.turn] ? (hot ? 'tp.yourBet.hot' : 'tp.yourBet') : (hot ? 'tp.blindOrLook.hot' : 'tp.blindOrLook'));
        out.choices = acts.map(function (a) {
          return { label: labelOf(a.type) + (a.cost ? ' ' + a.cost : ''), aria: a.cost ? TX('tp.costAria', { label: labelOf(a.type), n: a.cost }) : labelOf(a.type), onclick: function () { go(a.type); }, disabled: false };
        });
      } else out.text = (say ? say + ' ' : '') + TX(seats.person(st.turn) ? 'ce.next' : 'cards.thinking', { name: who(st.turn) });
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'over') { gameOver(); return; }
      if (st.phase === 'handEnd') { session.later(handOver, END_MS); return; }
      if (st.phase === 'side') { if (seats.person(st.side.to)) seats.ensure(st.side.to, repaint); else session.later(aiRespondTurn, AI_MS); return; }
      if (seats.person(st.turn)) seats.ensure(st.turn, repaint); else session.later(aiTurn, AI_MS);
    }
    function aiTurn() {
      var st = session.state;
      if (st.phase !== 'bet' || seats.person(st.turn)) return;
      var seat = st.turn, a = aiAct(st, seat, Math.random);
      session.follow(act(st, seat, a.type));
      announce(a.type);
      drive();
    }
    function aiRespondTurn() {
      var st = session.state;
      if (st.phase !== 'side' || seats.person(st.side.to)) return;
      session.follow(respondSide(st, st.side.to, aiRespond(st, st.side.to, Math.random)));
      drive();
    }
    function announce(type) { if (session.state.say && type !== 'see') t.flash(sayLine(session.state)); }
    function go(type) {
      var st = session.state;
      if (st.phase !== 'bet' || !mine(st.turn) || !isLegal(st, st.turn, type)) return;
      var next = act(st, st.turn, type);
      if (type === 'see') session.follow(next); else session.commit(next);
      drive();
    }
    function respond(accept) {
      var st = session.state;
      if (st.phase !== 'side' || !mine(st.side.to)) return;
      session.commit(respondSide(st, st.side.to, accept));
      drive();
    }
    function handOver() {
      var st = session.state;
      if (st.phase !== 'handEnd') return;
      T.lineSheet(TX('cards.fact.hand', { n: st.round + 1 }), resultLines(st), [{ label: TX('cards.nextHand'), primary: true, onclick: startNextHand }]);
    }
    function gameOver() {
      var st = session.state, me = seats.view(), hot = seats.hotseat(), w = gameWinner(st), won = w === me && !hot;
      var lines = (st.result ? resultLines(st) : []).concat([hot ? TX('tp.hasTable', { name: who(w), n: st.chips[w] }) : won ? TX('tp.tableYours', { n: st.chips[me] }) : TX('holdem.youOut') + '.']);
      if (hot) { session.lose({ name: who(w) }, lines); return; }
      session.stats.scored(st.chips[me]);
      if (won) session.win(st.chips[me]); else session.lose(TX('holdem.outOfChips'), lines, st.chips[me]);
    }
    var order = function () { return Z.shuffled(Math.random); };
    function startNextHand() {
      var st = session.state;
      if (st.phase !== 'handEnd') return;
      if (!seats.hotseat()) session.stats.scored(Math.max(st.chips[seats.view()], 0));
      session.history = [];
      session.follow(nextHand(st, order()));
      deal();
    }
    function startGame() {
      view.flash = '';
      var fresh = newGame(order(), Math.floor(Math.random() * SEATS));
      fresh.people = seats.people();
      session.reset(fresh);
      deal();
    }
    // A fresh deal: nobody has seen it, so a table of people starts at a handoff.
    function deal() { seats.begin(function () { repaint(); drive(); }, actor(session.state)); }
    t = T.create({
      id: 'teenpatti', name: 'Teen Patti', seats: seats, view: view, geo: geo, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: startGame, tap: function () { return false; }, cols: 6, heightShare: 0.13,
      canPick: function () { return false; },
      // The scores are on the table; a clock that only counts a match has no place in the bar.
      stat: function () { return ''; },
      cascadeOrder: function (st) { return st.hands[seats.view()].map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return [TX('tp.allChips', { n: st.chips[seats.view()] })]; },
      rules: TX('tp.rules', { a: cpu(1), b: cpu(2), c: cpu(3) })
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    startGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
