/* ZimiGames: Blackjack. You against the dealer, with a shoe of six decks (or
   one or two). Get closer to 21 than the dealer without going over. Cards
   count their pips, faces count 10, an ace 11 or 1. Blackjack (an ace and a
   ten-card on the deal) pays 3 to 2. The dealer stands on every 17, soft ones
   too. You may double (one card more, bet doubled) on any two cards, split
   a pair (each half gets its own bet; split aces take one card each) up to
   four hands, and take insurance when the dealer shows an ace (off unless
   you turn it on: it pays 2 to 1 and is a losing bet in the long run). The
   dealer checks for blackjack before you play. The hint button says what
   basic strategy would do. Chips only: you start with 1000.

   State: shoe (ids), pos, cut (reshuffle when pos passes it), chips, bet,
   hands [{cards, bet, done, doubled, split}], active, dealer [ids],
   phase ('bet' | 'insurance' | 'play'), hole (dealer's second card shown),
   insurance (chips staked), last (lines of the last round), opts.
   Pure functions; the page wiring at the bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var START_CHIPS = 1000, MIN_BET = 10, MAX_BET = 500, BET_STEPS = [10, 50, 100, 500], MAX_HANDS = 4;
  var TARGET = 21, DEALER_STANDS = 17, CUT_SHARE = 0.75, BLACKJACK_PAYS = 1.5, INSURANCE_PAYS = 2, DECK_CHOICES = [1, 2, 6], DEAL_MS = 260, DEALER_MS = 600;
  var hintName = function (a) { return TX('bj.hint.' + a); };

  // ── Rules ───────────────────────────────────────────────────────────────
  var cardValue = function (id) { var r = Z.rank(id); return r === 1 ? 11 : Math.min(r, 10); };
  var isAce = function (id) { return Z.rank(id) === 1; };
  function handValue(cards) {
    var total = 0, aces = 0;
    cards.forEach(function (c) { total += cardValue(c); if (isAce(c)) aces++; });
    while (total > TARGET && aces > 0) { total -= 10; aces--; }
    return { total: total, soft: aces > 0 };
  }
  var total = function (cards) { return handValue(cards).total; };
  var isBlackjack = function (hand) { return !hand.split && hand.cards.length === 2 && total(hand.cards) === TARGET; };
  var dealerBlackjack = function (dealer) { return dealer.length === 2 && total(dealer) === TARGET; };
  var busted = function (cards) { return total(cards) > TARGET; };

  // A shoe of `decks` decks: ids 0..51 then further copies (52 and up show the same faces).
  function newShoe(decks, rng) {
    var ids = [], i;
    for (i = 0; i < decks * 52; i++) ids.push(i);
    return { shoe: T.shuffleOf(ids, rng), pos: 0, cut: Math.floor(decks * 52 * CUT_SHARE) };
  }
  function draw(s) { return s.shoe[s.pos++]; }

  // Net chips a hand wins (negative: loses) against the dealer's finished hand,
  // not counting the stake coming back. Doubled hands carry the doubled bet.
  function net(hand, dealer) {
    var mine = total(hand.cards);
    if (mine > TARGET) return -hand.bet;
    if (isBlackjack(hand)) return dealerBlackjack(dealer) ? 0 : hand.bet * BLACKJACK_PAYS;
    var theirs = total(dealer);
    if (dealerBlackjack(dealer)) return -hand.bet;
    if (theirs > TARGET || mine > theirs) return hand.bet;
    return mine === theirs ? 0 : -hand.bet;
  }

  function freshGame(rng, opts) {
    var o = opts || {}, sh = newShoe(o.decks || 6, rng);
    return {
      shoe: sh.shoe, pos: 0, cut: sh.cut, chips: o.chips === undefined ? START_CHIPS : o.chips, bet: Math.min(o.bet || MIN_BET * 2, MAX_BET),
      hands: [], active: -1, dealer: [], phase: 'bet', hole: false, insurance: 0, last: [], round: 0, shuffled: false,
      opts: { decks: o.decks || 6, insurance: !!o.insurance }
    };
  }
  var clampBet = function (st, bet) { return Math.max(MIN_BET, Math.min(MAX_BET, st.chips, bet)); };
  function setBet(st, bet) { var s = Z.clone(st); s.bet = Math.max(0, Math.min(MAX_BET, s.chips, bet)); return s; }
  var canDeal = function (st) { return st.phase === 'bet' && st.bet >= MIN_BET && st.bet <= st.chips; };

  // Deal a round: you, dealer, you, dealer (the dealer's second card is the hole card).
  function deal(st, rng) {
    if (!canDeal(st)) return st;
    var s = Z.clone(st);
    if (s.pos >= s.cut) { var sh = newShoe(s.opts.decks, rng); s.shoe = sh.shoe; s.pos = 0; s.cut = sh.cut; s.shuffled = true; } else s.shuffled = false;
    s.chips -= s.bet; s.round++; s.last = []; s.insurance = 0; s.hole = false;
    var a = draw(s), b = draw(s), c = draw(s), d = draw(s);
    s.hands = [{ cards: [a, c], bet: s.bet, done: false, doubled: false, split: false }];
    s.dealer = [b, d]; s.active = 0;
    if (isAce(b) && s.opts.insurance && s.chips >= Math.floor(s.bet / 2)) { s.phase = 'insurance'; return s; }
    return afterPeek(s);
  }
  function takeInsurance(st, yes) {
    if (st.phase !== 'insurance') return st;
    var s = Z.clone(st), cost = Math.floor(s.hands[0].bet / 2);
    if (yes && s.chips >= cost) { s.chips -= cost; s.insurance = cost; }
    return afterPeek(s);
  }
  // The dealer peeks with an ace or ten showing: a blackjack ends the round here.
  function afterPeek(s) {
    s.phase = 'play';
    var up = cardValue(s.dealer[0]);
    if ((up === 11 || up === 10) && dealerBlackjack(s.dealer)) return settle(s);
    if (isBlackjack(s.hands[0])) return settle(s);
    return s;
  }

  function canHit(st) { return st.phase === 'play' && st.active >= 0 && !st.hands[st.active].done; }
  function canDouble(st) {
    if (!canHit(st)) return false;
    var h = st.hands[st.active];
    return h.cards.length === 2 && st.chips >= h.bet;
  }
  function canSplit(st) {
    if (!canHit(st)) return false;
    var h = st.hands[st.active];
    return h.cards.length === 2 && cardValue(h.cards[0]) === cardValue(h.cards[1]) && st.chips >= h.bet && st.hands.length < MAX_HANDS && !(h.split && isAce(h.cards[0]));
  }

  // Move to the next hand still to play; when none is left the dealer plays.
  function advance(s) {
    var i;
    for (i = s.active; i < s.hands.length; i++) {
      var h = s.hands[i];
      if (!h.done && total(h.cards) >= TARGET) h.done = true;
      if (!h.done) { s.active = i; return s; }
    }
    return dealerPlay(s);
  }
  function hit(st, rng) {
    if (!canHit(st)) return st;
    var s = Z.clone(st), h = s.hands[s.active];
    h.cards.push(draw(s));
    return advance(s);
  }
  function stand(st) {
    if (!canHit(st)) return st;
    var s = Z.clone(st);
    s.hands[s.active].done = true; s.active++;
    return advance(s);
  }
  function double(st) {
    if (!canDouble(st)) return st;
    var s = Z.clone(st), h = s.hands[s.active];
    s.chips -= h.bet; h.bet *= 2; h.doubled = true; h.cards.push(draw(s)); h.done = true;
    s.active++;
    return advance(s);
  }
  function split(st) {
    if (!canSplit(st)) return st;
    var s = Z.clone(st), h = s.hands[s.active], aces = isAce(h.cards[0]);
    var other = { cards: [h.cards.pop()], bet: h.bet, done: false, doubled: false, split: true };
    s.chips -= h.bet; h.split = true;
    h.cards.push(draw(s)); other.cards.push(draw(s));
    s.hands.splice(s.active + 1, 0, other);
    if (aces) { h.done = true; other.done = true; s.active += 2; }
    return advance(s);
  }

  // The dealer draws to 17 (standing on soft 17) unless every hand is already lost or won outright.
  function dealerPlay(s) {
    s.hole = true; s.active = -1;
    var live = s.hands.some(function (h) { return !busted(h.cards) && !isBlackjack(h); });
    if (live) while (total(s.dealer) < DEALER_STANDS) s.dealer.push(draw(s));
    return settle(s);
  }
  function resultWord(h, n) { return TX('bj.result.' + (busted(h.cards) ? 'bust' : isBlackjack(h) && n > 0 ? 'blackjack' : n > 0 ? 'win' : n < 0 ? 'lose' : 'push')); }
  function settle(s) {
    s.hole = true; s.active = -1; s.phase = 'bet';
    var lines = [], dv = total(s.dealer), dealerBJ = dealerBlackjack(s.dealer);
    s.hands.forEach(function (h, i) {
      var n = net(h, s.dealer), word = resultWord(h, n);
      s.chips += h.bet + n;
      lines.push(TX(s.hands.length > 1 ? 'bj.line.hand' : 'bj.line.you', { n: i + 1, total: total(h.cards), word: word }) + (n === 0 ? '' : ', ' + (n > 0 ? '+' : '-') + Math.abs(n)));
    });
    if (s.insurance) {
      if (dealerBJ) { s.chips += s.insurance * (1 + INSURANCE_PAYS); lines.push(TX('bj.insPays', { n: s.insurance * INSURANCE_PAYS })); } else lines.push(TX('bj.insLost', { n: s.insurance }));
    }
    lines.unshift(TX('bj.line.dealer', { what: dealerBJ ? TX('bj.result.blackjack') : dv > TARGET ? TX('bj.dealerBust', { n: dv }) : dv }));
    s.last = lines; s.insurance = 0;
    s.bet = Math.max(0, Math.min(s.bet, s.chips));
    return s;
  }
  var broke = function (st) { return st.phase === 'bet' && st.chips < MIN_BET; };

  // People sharing the device play a round each, one after another, from the same shoe.
  // `carry` is the next person's turn: their chips and bet, the shoe where the last round left it.
  function carry(st, bank) {
    var s = Z.clone(st);
    s.chips = bank.chips; s.bet = Math.max(0, Math.min(bank.bet, bank.chips, MAX_BET));
    s.hands = []; s.dealer = []; s.active = -1; s.hole = false; s.insurance = 0; s.last = []; s.phase = 'bet'; s.shuffled = false;
    return s;
  }
  // The next seat after `cur` (round the table, `cur` last) that can still afford a bet, or -1.
  function nextPlayer(people, chips, cur) {
    var after = people.filter(function (p) { return p > cur; }).concat(people.filter(function (p) { return p <= cur; }));
    var able = after.filter(function (p) { return chips[p] >= MIN_BET; });
    return able.length ? able[0] : -1;
  }

  // ── Basic strategy (dealer stands on soft 17, double after split, 4+ decks) ──
  // Returns 'hit' | 'stand' | 'double' | 'split' for what is allowed.
  function basicAction(cards, upcard, allow) {
    var up = cardValue(upcard), hv = handValue(cards), t = hv.total, a = allow || {}, pick;
    function dbl(otherwise) { return a.double ? 'double' : otherwise; }
    if (cards.length === 2 && cardValue(cards[0]) === cardValue(cards[1]) && a.split) {
      var p = cardValue(cards[0]);
      var yes = p === 11 || p === 8 || (p === 9 && up !== 7 && up < 10) || ((p === 2 || p === 3 || p === 7) && up >= 2 && up <= 7) || (p === 6 && up >= 2 && up <= 6) || (p === 4 && (up === 5 || up === 6));
      if (yes) return 'split';
    }
    if (hv.soft && t <= 21) {
      if (t >= 20) return 'stand';
      if (t === 19) return 'stand';
      if (t === 18) { if (up >= 3 && up <= 6) return dbl('stand'); return up <= 8 && up !== 9 ? 'stand' : 'hit'; }
      if (t === 17) return up >= 3 && up <= 6 ? dbl('hit') : 'hit';
      if (t === 15 || t === 16) return up >= 4 && up <= 6 ? dbl('hit') : 'hit';
      return up === 5 || up === 6 ? dbl('hit') : 'hit';
    }
    if (t >= 17) return 'stand';
    if (t >= 13) return up <= 6 ? 'stand' : 'hit';
    if (t === 12) return up >= 4 && up <= 6 ? 'stand' : 'hit';
    if (t === 11) return up === 11 ? 'hit' : dbl('hit');
    if (t === 10) return up <= 9 ? dbl('hit') : 'hit';
    if (t === 9) return up >= 3 && up <= 6 ? dbl('hit') : 'hit';
    pick = 'hit';
    return pick;
  }
  function hint(st) {
    if (!canHit(st)) return null;
    return basicAction(st.hands[st.active].cards, st.dealer[0], { double: canDouble(st), split: canSplit(st) });
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var STEP_SHARE = 0.6, ROW_GAP = 12, CHIP_ROW = 24;
  function handSpots(g, n) {
    var rows = n > 2 ? 2 : 1, perRow = rows === 2 ? 2 : n, spots = [], i;
    for (i = 0; i < n; i++) {
      var r = Math.floor(i / perRow), c = i % perRow, inRow = Math.min(perRow, n - r * perRow);
      var cell = (g.W - 2 * g.pad) / inRow;
      spots.push({ x: g.pad + c * cell, w: cell, y: g.southY - (rows - 1 - r) * (g.ch + ROW_GAP) });
    }
    return spots;
  }
  function place(st, m) {
    var g = T.geometry(m, 1), slots = [], cards = [], n = Math.max(1, st.hands.length), spots = handSpots(g, n);
    if (n > 2) { g.southY += 0; }
    slots.push({ id: 'table', x: g.pad, y: g.northY, w: g.W - 2 * g.pad, h: g.southY - g.northY + g.ch, quiet: true, label: TX('cards.slot.table') });
    function row(ids, x0, w, y, pile, upFn, glow) {
      var step = ids.length > 1 ? Math.min(g.cw * STEP_SHARE, (w - g.cw) / (ids.length - 1)) : 0, span = g.cw + (ids.length - 1) * step;
      ids.forEach(function (id, k) { cards.push({ id: id, pile: pile, idx: k, x: Math.round(x0 + (w - span) / 2 + k * step), y: Math.round(y), up: upFn(k), glow: glow }); });
    }
    row(st.dealer, g.pad, g.W - 2 * g.pad, g.northY + (n > 1 ? CHIP_ROW : 0), 'd', function (k) { return k === 0 || st.hole; });
    st.hands.forEach(function (h, i) { row(h.cards, spots[i].x, spots[i].w, spots[i].y, 'p' + i, function () { return true; }, st.active === i && st.phase === 'play'); });
    return { height: m.H, slots: slots, cards: cards };
  }
  function geo(m) { return T.geometry(m, 1); }

  var api = {
    START_CHIPS: START_CHIPS, MIN_BET: MIN_BET, MAX_BET: MAX_BET, handValue: handValue, isBlackjack: isBlackjack, net: net, newGame: freshGame, newShoe: newShoe,
    setBet: setBet, canDeal: canDeal, deal: deal, takeInsurance: takeInsurance, canHit: canHit, canDouble: canDouble, canSplit: canSplit,
    hit: hit, stand: stand, double: double, split: split, basicAction: basicAction, hint: hint, broke: broke, place: place, cardValue: cardValue, carry: carry, nextPlayer: nextPlayer
  };
  root.ZimiBlackjack = api;

  // ── The page ────────────────────────────────────────────────────────────
  var SEAT_COUNT = 3, DEFAULT_BET = MIN_BET;
  function boot() {
    var t, session, view = { flash: '' }, DECK_KEY = 'blackjack.decks', INS_KEY = 'blackjack.insurance', HINT_KEY = 'blackjack.hint', CHIPS_KEY = 'blackjack.chips', BET_KEY = 'blackjack.bet';
    var showHint = Z.store.get(HINT_KEY, false) === true;
    var rng = Math.random;
    // Seats are a Person or empty (the dealer is always the computer); people take a round each behind a handoff.
    var seats = Seats.create({ id: 'blackjack', seats: SEAT_COUNT, onChange: function () { if (t) t.paint(); } }), bank = {};
    var nm = function () { return seats.isYou(seats.view()) ? TX('cards.you') : seats.name(seats.view()); };
    var byName = function (text) { var you = TX('bj.line.you', { total: '' }).split(' ')[0]; return seats.hotseat() && text.indexOf(you) === 0 ? nm() + text.slice(you.length) : text; };
    function opts() {
      var decks = Z.store.get(DECK_KEY, 6);
      return { decks: DECK_CHOICES.indexOf(decks) >= 0 ? decks : 6, insurance: Z.store.get(INS_KEY, false) === true };
    }
    function save(st) { if (seats.hotseat()) return; Z.store.set(CHIPS_KEY, st.chips); Z.store.set(BET_KEY, st.bet); }
    function show(st) { save(st); session.follow(st); if (broke(st) && !seats.hotseat()) outOfChips(st); }
    function outOfChips(st) {
      session.lose(TX('holdem.outOfChips'), [TX('bj.outYou', { rounds: Z.plural(st.round, 'round'), n: START_CHIPS })], 0);
    }
    function handChip(st, h, i) {
      var v = handValue(h.cards), label = (st.hands.length > 1 ? TX('bj.handN', { n: i + 1 }) : nm());
      var soft = v.soft && v.total < 21, key = st.hands.length > 1 ? (soft ? 'bj.soft' : 'bj.hard') : (soft ? 'bj.soft1' : 'bj.hard1');
      return { name: label, text: TX(key, { total: v.total, bet: h.bet }), turn: st.phase === 'play' && st.active === i };
    }
    // The bet is chips on the table, under the dealer's cards.
    var pile = Z.h('div', { class: 'ct-pile' });
    root.document.getElementById('zc-table').appendChild(pile);
    function paintPile(st) {
      var m = t && t.board && t.board.metrics();
      if (!m) return;
      var g = geo(m), amount = st.phase === 'bet' ? st.bet : st.hands.reduce(function (n, h) { return n + h.bet; }, st.insurance || 0);
      pile.textContent = '';
      if (amount > 0) { pile.appendChild(T.chipStack(amount)); pile.appendChild(Z.h('span', { class: 'ct-caption', text: TX('bj.bet', { n: amount }) })); }
      pile.style.top = Math.round(g.northY + g.ch + 24) + 'px';
    }
    function tableChips(st) {
      var chips = [];
      if (st.dealer.length) chips.push({ name: TX('bj.dealer'), text: st.hole ? String(handValue(st.dealer).total) : String(cardValue(st.dealer[0]) === 11 ? 'A' : cardValue(st.dealer[0])) });
      st.hands.forEach(function (h, i) { chips.push(handChip(st, h, i)); });
      if (seats.hotseat()) seats.people().forEach(function (p) { if (p !== seats.view() && bank[p]) chips.push({ name: seats.name(p), text: TX('bj.chips', { n: bank[p].chips }) }); });
      return chips;
    }
    function hud(st) {
      var hot = seats.hotseat();
      if (stage && stage.owner !== session.state) stage = null;   // a new game or another move took over
      if (stage) {   // cards are being dealt one at a time: the table as it is now, no buttons
        paintPile(stage.frame);
        return { chips: tableChips(stage.frame), fact: TX(hot ? 'bj.fact.name' : 'bj.fact', { name: nm(), n: stage.frame.chips }), text: TX(stage.say) };
      }
      paintPile(st);
      var out = { fact: TX(hot ? 'bj.fact.name' : 'bj.fact', { name: nm(), n: st.chips }), text: '' };
      out.chips = tableChips(st);
      if (st.phase === 'bet' && hot && st.hands.length) {
        // The round is over: each person's result stays on screen until the device is passed on.
        var next = nextPlayer(seats.people(), chipsBySeat(st), seats.view());
        out.text = '';
        out.lines = st.last.map(function (x) { return { text: byName(x) }; });
        out.choices = [{ label: next < 0 ? TX('bj.finish') : next === seats.view() ? TX('bj.nextRound') : TX('bj.passTo', { name: seats.name(next) }), primary: true, onclick: passOn }];
      } else if (st.phase === 'bet') {
        out.text = st.last.length ? '' : TX(hot ? 'bj.placeBet.name' : 'bj.placeBet', { name: nm() });
        out.lines = st.last.map(function (x) { return { text: x }; });
        if (st.shuffled) out.lines.push({ text: TX('bj.shuffled') });
        out.choices = BET_STEPS.map(function (v) { return { label: '+' + v, disabled: st.bet + v > Math.min(MAX_BET, st.chips), onclick: function () { show(setBet(session.state, session.state.bet + v)); } }; });
        out.choices.push({ label: TX('canasta.clear'), disabled: st.bet === 0, onclick: function () { show(setBet(session.state, 0)); } });
        out.choices.push({ label: TX('bj.dealBet', { n: st.bet }), primary: true, disabled: !canDeal(st), onclick: dealIt });
      } else if (st.phase === 'insurance') {
        out.text = TX('bj.insurance', { n: Math.floor(st.hands[0].bet / 2) });
        out.choices = [{ label: TX('bj.insure'), onclick: function () { move(takeInsurance(session.state, true)); } }, { label: TX('bj.noThanks'), onclick: function () { move(takeInsurance(session.state, false)); } }];
      } else {
        out.text = st.hands.length > 1 ? TX('bj.playingHand', { n: st.active + 1 }) : hot ? TX('cards.turn.name', { name: nm() }) : TX('cards.turn.you');
        out.choices = [
          { label: TX('bj.hit'), onclick: function () { move(hit(session.state, rng)); } },
          { label: TX('bj.stand'), onclick: function () { move(stand(session.state)); } },
          { label: TX('bj.double'), disabled: !canDouble(st), onclick: function () { move(double(session.state)); } },
          { label: TX('bj.split'), disabled: !canSplit(st), onclick: function () { move(split(session.state)); } }
        ];
        var hn = hint(st);
        out.lines = showHint && hn ? [{ text: TX('bj.basic', { action: hintName(hn) }) }] : [];
      }
      return out;
    }
    // Everyone's chips by seat: the seat playing now is the live state, the others sit in the bank.
    function chipsBySeat(st) { var out = {}; seats.people().forEach(function (p) { out[p] = bank[p] ? bank[p].chips : START_CHIPS; }); out[seats.view()] = st.chips; return out; }
    function passOn() {
      var st = session.state, cur = seats.view(), chips = chipsBySeat(st), next = nextPlayer(seats.people(), chips, cur);
      bank[cur] = { chips: st.chips, bet: st.bet };
      if (next < 0) { session.lose(TX('holdem.outOfChips'), [TX('bj.outAll', { rounds: Z.plural(st.round, 'round'), n: START_CHIPS })], undefined); return; }
      session.follow(carry(st, bank[next] || { chips: START_CHIPS, bet: DEFAULT_BET }));
      seats.ensure(next, function () { t.paint(); });
      if (next === cur) t.paint();
    }
    // The cards go out one at a time, at a pace a person can follow: the deal (you, dealer, you, dealer's hole card), and the
    // dealer's draws after you stand. session.state stays where it was until the last card is down, so leaving in between
    // comes back to the move not yet made; the table is drawn from frames.
    var stage = null;
    function framesFor(prev, next) {
      var dealing = !prev.hands.length && next.hands.length, dealerTurn = (prev.phase === 'play' || prev.phase === 'insurance') && next.phase === 'bet' && next.hands.length;
      var live = next.hands.some(function (h) { return !busted(h.cards) && !isBlackjack(h); });
      var frame = function (mine, theirs, hole) {
        var f = Z.clone(next);
        f.phase = 'play'; f.active = -1; f.hole = hole; f.dealer = next.dealer.slice(0, theirs);
        f.hands.forEach(function (h, i) { h.cards = next.hands[i].cards.slice(0, i ? next.hands[i].cards.length : mine); });
        f.chips = prev.chips;   // the same figure the bar still shows
        return f;
      };
      var out = [], k;
      if (dealing) {
        [[1, 0], [1, 1], [2, 1], [2, 2]].forEach(function (c) { var f = frame(c[0], c[1], false); f.say = 'bj.dealing'; out.push(f); });
      } else if (dealerTurn && live) {
        for (k = 2; k <= next.dealer.length; k++) { var f = frame(99, k, true); f.say = 'bj.dealerPlays'; out.push(f); }
      }
      return out;
    }
    function present(prev, next) {
      var frames = framesFor(prev, next), gap = root.ZimiShell && root.ZimiShell.ms ? root.ZimiShell.ms(frames.length && frames[0].hole ? DEALER_MS : DEAL_MS) : 0, i = 0;
      if (!frames.length || !gap) { show(next); return; }
      (function step() {
        if (i >= frames.length) { stage = null; show(next); return; }
        var f = frames[i++];
        stage = { frame: f, say: f.say, owner: session.state };
        t.board.render(f); t.paint();
        session.later(step, gap);
      })();
    }
    function dealIt() {
      var st = session.state;
      if (stage || !canDeal(st)) return;
      present(st, deal(st, rng)); session.began();
    }
    function move(next) { if (!stage && next !== session.state) present(session.state, next); }
    function newGame() {
      var o = opts();
      o.chips = START_CHIPS; o.bet = DEFAULT_BET; bank = {};
      show(freshGame(rng, o));
      session.reset(session.state);
      seats.begin(function () { t.paint(); }, seats.people()[0]);
    }
    function start() {
      if (seats.hotseat()) { newGame(); return; }
      var o = opts(), chips = Z.store.get(CHIPS_KEY, START_CHIPS), bet = Z.store.get(BET_KEY, DEFAULT_BET);
      o.chips = typeof chips === 'number' && chips >= MIN_BET ? chips : START_CHIPS; o.bet = typeof bet === 'number' ? Math.min(bet, o.chips) : DEFAULT_BET;
      session.reset(freshGame(rng, o));
      seats.begin(function () { t.paint(); });
    }
    t = T.create({
      id: 'blackjack', name: 'Blackjack', seats: seats, seatsBlock: { cpuLabel: TX('bj.empty'), note: TX('bj.seatsNote') }, view: view, geo: geo, place: function (st, m) { return place(st, m); }, hud: hud, newGame: newGame, cols: 5, heightShare: 0.15,
      stat: function (sec, st) { return TX('bj.chips', { n: st.chips }); },
      cascadeOrder: function () { return []; }, winLines: function () { return []; },
      menuExtra: function () {
        return [
          T.choiceRow(TX('cards.hint'), HINT_KEY, [{ label: TX('shell.off'), value: false }, { label: TX('shell.on'), value: true }], false, function (v) { showHint = v === true; t.paint(); }),
          T.choiceRow(TX('bj.decks'), DECK_KEY, DECK_CHOICES.map(function (n) { return { label: String(n), value: n }; }), 6, function () { /* next shuffle */ }),
          T.choiceRow(TX('bj.insuranceRow'), INS_KEY, [{ label: TX('shell.off'), value: false }, { label: TX('shell.on'), value: true }], false, function (v) { var st = session.state; if (st) { var s = Z.clone(st); s.opts.insurance = v; session.follow(s); } }),
          Z.h('p', { class: 'zc-note', text: TX('bj.decksNote') })
        ];
      },
      rules: TX('bj.rules') + START_CHIPS + '.'
    });
    session = t.session; api.session = session; api.board = t.board;
    if (root.ResizeObserver) new root.ResizeObserver(function () { t.paint(); }).observe(root.document.getElementById('zc-table'));
    root.document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey || seats.covering || root.document.querySelector('.ar-sheet')) return;
      var st = session.state, k = e.key.toLowerCase();
      if (!st) return;
      if (st.phase === 'play') {
        if (k === 'h') move(hit(st, rng)); else if (k === 's') move(stand(st)); else if (k === 'd') move(double(st)); else if (k === 'p') move(split(st)); else return;
        e.preventDefault();
      } else if (st.phase === 'bet' && k === 'enter' && root.document.activeElement === root.document.body) { dealIt(); e.preventDefault(); }
    });
    start();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
